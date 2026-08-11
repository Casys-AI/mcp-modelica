import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createModelicaService } from "../src/domain/service.ts";
import { ValidationError } from "../src/domain/errors.ts";
import { sha256, stableJson } from "../src/domain/hashing.ts";
import type { ModelicaKit, SimulationRunner } from "../src/domain/types.ts";
import { KitRegistry } from "../src/kits/registry.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";
import { FakeRunner, installLegacyRunFixture, LEGACY_RUN_ID } from "./test-helpers.ts";

Deno.test("modelica_kit_list exposes the physical kit and the honest solver-conformance kit", async () => {
  await withService((service) => {
    const kits = service.listKits();
    assertEquals(kits.length, 2);
    assertEquals(kits[0].id, "coffee-machine-v1");
    assertEquals(kits[0].scenarios[0].id, "heat-up-nominal");
    assertEquals(
      kits[0].parameters.find((parameter) => parameter.id === "heater_power")?.unit,
      "W",
    );
    assertEquals("modelSource" in kits[0], false);
    assertEquals(
      kits[0].produced_metrics.every((metric) => typeof metric.required === "boolean"),
      true,
    );
    assertEquals(kits[1].id, "linear-thermal-ramp-v1");
    assertEquals(kits[1].description.includes("not a physical thermal oracle"), true);
  });
});

Deno.test("simulate returns observations and hashed evidence, never a requirement verdict", async () => {
  await withService(async (service) => {
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
      parameter_overrides: {
        heater_power: { value: 1500, unit: "W" },
      },
    });

    assertEquals(run.status, "succeeded");
    assertMatch(run.started_at ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assertMatch(run.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert(
      new Date(run.completed_at ?? "").getTime() >= new Date(run.started_at ?? "").getTime(),
      "completed_at must not precede started_at",
    );
    assertEquals(run.metrics.water_temperature_max, { value: 94, unit: "degC" });
    assertEquals(run.metrics.time_to_target_temperature, { value: 200, unit: "s" });
    assertEquals(run.metrics.heater_energy, { value: 315000, unit: "J" });
    assertEquals("pass" in run, false);
    assertEquals("fail" in run, false);
    assertEquals(run.artifacts.map((artifact) => artifact.kind), [
      "request",
      "resolved_parameters",
      "model",
      "scenario",
      "parameter_schema",
      "script",
      "diagnostics",
      "result",
      "evidence",
    ]);
    for (const artifact of run.artifacts) {
      assertMatch(artifact.sha256, /^[0-9a-f]{64}$/);
      assertMatch(artifact.uri, new RegExp(`^casys://modelica/runs/${run.run_id}/`));
    }
    assertEquals(
      run.artifacts.find((artifact) => artifact.kind === "scenario")?.qualification,
      "qualified-kit",
    );
    assertEquals(
      run.artifacts.find((artifact) => artifact.kind === "parameter_schema")?.qualification,
      "compiler-derived-verified",
    );
    assertEquals(
      run.model.source_sha256,
      run.artifacts.find((artifact) => artifact.kind === "model")?.sha256,
    );
    assertEquals(
      run.scenario.source_sha256,
      run.artifacts.find((artifact) => artifact.kind === "scenario")?.sha256,
    );
    assertEquals(
      run.parameter_schema?.source_sha256,
      run.artifacts.find((artifact) => artifact.kind === "parameter_schema")?.sha256,
    );
    assertEquals(run.parameter_schema?.model_source_sha256, run.model.source_sha256);
    assertMatch(run.scenario.projection_sha256, /^[0-9a-f]{64}$/);

    const saved = await service.getRun(run.run_id);
    assertEquals(saved.run_id, run.run_id);
    assertEquals(saved.started_at, run.started_at);
    assertEquals(saved.completed_at, run.completed_at);
    assertEquals(
      saved.fingerprint,
      await sha256(stableJson({
        engine: saved.engine,
        model: saved.model,
        resolved_parameters: saved.resolved_parameters,
        scenario: saved.scenario,
      })),
    );
    assertEquals(saved.fingerprint === run.fingerprint, false);
  });
});

Deno.test("identical approved requests have the same proof fingerprint", async () => {
  await withService(async (service) => {
    const request = {
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
      parameter_overrides: {
        water_mass: { value: 0.6, unit: "kg" },
        heater_power: { value: 1500, unit: "W" },
      },
    };
    const first = await service.simulate(request);
    const second = await service.simulate(request);
    assertEquals(first.fingerprint, second.fingerprint);
    assertEquals(first.run_id === second.run_id, false);
  });
});

Deno.test("simulation derives the server-owned model filename and loadFile from a second kit", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-second-kit-" });
  try {
    const scenarioSource = JSON.stringify(
      {
        id: "second-nominal",
        description: "Second qualified test scenario.",
        start_time_s: 0,
        stop_time_s: 300,
        number_of_intervals: 300,
        solver: "dassl",
        target_temperature: { value: 90, unit: "degC" },
      },
      null,
      2,
    ) + "\n";
    const secondKit: ModelicaKit = {
      id: "second-plant-v1",
      version: "1.0.0",
      description: "Independent second Modelica kit used to prove generic source naming.",
      modelName: "SecondPlant",
      modelSource: "model SecondPlant\n  Real x;\nend SecondPlant;\n",
      parameters: [],
      scenarios: [{
        id: "second-nominal",
        description: "Second qualified test scenario.",
        startTimeS: 0,
        stopTimeS: 300,
        numberOfIntervals: 300,
        solver: "dassl",
        targetTemperature: { value: 90, unit: "degC" },
        source: scenarioSource,
      }],
      producedMetrics: [{
        id: "second_signal_peak",
        unit: "1",
        description: "Peak value of the second kit's own solver signal.",
        required: true,
      }],
      resultNormalizer: {
        id: "second-plant-result-normalizer",
        version: "1.0.0",
        normalize: (csv) => {
          const values = csv.trim().split("\n").slice(1).map((row) => Number(row.split(",")[1]));
          if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
            throw new Error("SecondPlant result is missing its secondSignal column.");
          }
          return {
            metrics: { second_signal_peak: { value: Math.max(...values), unit: "1" } },
            warnings: [],
          };
        },
      },
    };
    const service = await createModelicaService({
      registry: new KitRegistry([await loadCoffeeMachineKit(), secondKit]),
      runsDirectory: directory,
      runner: new FakeRunner({
        status: "succeeded",
        diagnostics: "SecondPlant fake solver completed.",
        resultCsv: "time,secondSignal\n0,2\n1,7\n",
      }),
    });
    const run = await service.simulate({
      model_id: secondKit.id,
      scenario_id: "second-nominal",
    });
    const modelArtifact = run.artifacts.find((artifact) => artifact.kind === "model");
    assertEquals(modelArtifact?.uri.endsWith(`/${secondKit.modelName}.mo`), true);
    const script = await Deno.readTextFile(`${directory}/${run.run_id}/run.mos`);
    assertEquals(script.includes('loadFile("SecondPlant.mo");'), true);
    assertEquals(script.includes("CoffeeMachine.mo"), false);
    assertEquals((await service.getRecordedRun(run.run_id)).model.name, "SecondPlant");
    assertEquals(run.result_normalizer, {
      id: "second-plant-result-normalizer",
      version: "1.0.0",
    });
    assertEquals(run.metrics, { second_signal_peak: { value: 7, unit: "1" } });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run list reads persisted summaries in deterministic run_id order and respects its bound", async () => {
  await withService(async (service) => {
    const first = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const second = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
      parameter_overrides: {
        heater_power: { value: 1500, unit: "W" },
      },
    });
    const expected = [first.run_id, second.run_id].sort();

    const listed = await service.listRuns();
    assertEquals(listed.map((run) => run.run_id), expected);
    assertEquals((await service.listRuns(1)).map((run) => run.run_id), expected.slice(0, 1));
    assertEquals(Object.keys(listed[0]).sort(), [
      "completed_at",
      "fingerprint",
      "model",
      "run_id",
      "scenario",
      "started_at",
      "status",
    ]);
    assertEquals((await service.listRecordedRuns()).map((run) => run.run_id), expected);
    assertEquals((await service.listRecordedRuns())[0].record_schema_version, "2.0");
  });
});

Deno.test("shared store bi-reads v1 and v2 while recorded APIs exclude/refuse v1", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-biread-" });
  try {
    const fixture = await installLegacyRunFixture(directory);
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });

    assertEquals(await service.getRun(LEGACY_RUN_ID), fixture.run);
    assertEquals((await service.listRuns()).map((run) => run.run_id), [LEGACY_RUN_ID]);
    assertEquals(await service.listRecordedRuns(), []);
    await assertRejects(
      () => service.getRecordedRun(LEGACY_RUN_ID),
      ValidationError,
      "legacy ledger",
    );

    const recorded = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const projected = await service.getRun(recorded.run_id);
    assertEquals(projected.model.sha256, recorded.model.source_sha256);
    assertEquals(projected.scenario.sha256, recorded.scenario.projection_sha256);
    assertEquals(
      projected.artifacts.map((artifact) => artifact.kind),
      ["request", "resolved_parameters", "model", "script", "diagnostics", "result", "evidence"],
    );
    assertEquals((await service.listRuns()).length, 2);
    assertEquals((await service.listRecordedRuns()).map((run) => run.run_id), [recorded.run_id]);
    assertEquals(
      await Deno.readTextFile(`${directory}/${LEGACY_RUN_ID}/run.json`),
      fixture.source,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run list rejects invalid bounds and treats a missing run directory as empty", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-missing-" });
  try {
    const service = await createModelicaService({
      runsDirectory: `${directory}/runs`,
      runner: new FakeRunner(),
    });
    assertEquals(await service.listRuns(), []);
    await assertRejects(() => service.listRuns(0), ValidationError, "between 1 and 20");
    await assertRejects(() => service.listRuns(21), ValidationError, "between 1 and 20");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run list ignores a staged record until its final run.json is atomically published", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-staged-" });
  try {
    const runId = `run_${crypto.randomUUID()}`;
    await Deno.mkdir(`${directory}/${runId}`);
    await Deno.writeTextFile(`${directory}/${runId}/run.json.tmp`, "{}");
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });

    assertEquals(await service.listRuns(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run list fails closed on a noncanonical persisted record", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-legacy-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const legacyRun = { ...run } as Record<string, unknown>;
    delete legacyRun.started_at;
    delete legacyRun.completed_at;
    await Deno.writeTextFile(
      `${directory}/${run.run_id}/run.json`,
      JSON.stringify(legacyRun),
    );

    await assertRejects(
      () => service.listRuns(),
      ValidationError,
      "run.json is not encoded as canonical stable JSON",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("simulate rejects unknown code-like fields and unapproved parameters", async () => {
  await withService(async (service) => {
    await assertRejects(
      () =>
        service.simulate({
          model_id: "coffee-machine-v1",
          scenario_id: "heat-up-nominal",
          script: 'loadFile("evil.mo")',
        }),
      ValidationError,
      "Unknown input field 'script'",
    );
    await assertRejects(
      () =>
        service.simulate({
          model_id: "coffee-machine-v1",
          scenario_id: "heat-up-nominal",
          parameter_overrides: {
            model_path: { value: 1, unit: "1" },
          },
        }),
      ValidationError,
      "not an approved parameter",
    );
  });
});

Deno.test("simulate rejects incompatible units, invalid bounds and non-finite values", async () => {
  await withService(async (service) => {
    const base = { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" };
    await assertRejects(
      () =>
        service.simulate({
          ...base,
          parameter_overrides: { heater_power: { value: 1.5, unit: "kW" } },
        }),
      ValidationError,
      "expected 'W'",
    );
    await assertRejects(
      () =>
        service.simulate({
          ...base,
          parameter_overrides: { water_mass: { value: 20, unit: "kg" } },
        }),
      ValidationError,
      "between 0.1 and 3 kg",
    );
    await assertRejects(
      () =>
        service.simulate({
          ...base,
          parameter_overrides: { water_mass: { value: Number.NaN, unit: "kg" } },
        }),
      ValidationError,
      "finite number",
    );
  });
});

Deno.test("runner failure is an honest execution state with no computed metrics", async () => {
  const failingRunner: SimulationRunner = new FakeRunner({
    status: "failed",
    diagnostics: "OpenModelica compilation failed in test.",
  });
  await withService(async (service) => {
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    assertEquals(run.status, "failed");
    assertEquals(run.metrics, {});
    assertEquals(run.artifacts.some((artifact) => artifact.kind === "result"), false);
  }, failingRunner);
});

Deno.test("run storage refuses new simulations instead of silently consuming unbounded disk", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-capacity-" });
  try {
    for (let index = 0; index < 20; index++) {
      await Deno.mkdir(`${directory}/run_${crypto.randomUUID()}`);
    }
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    await assertRejects(
      () =>
        service.simulate({
          model_id: "coffee-machine-v1",
          scenario_id: "heat-up-nominal",
        }),
      ValidationError,
      "limit 20",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function withService(
  callback: (service: Awaited<ReturnType<typeof createModelicaService>>) => void | Promise<void>,
  runner: SimulationRunner = new FakeRunner(),
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-test-" });
  try {
    const service = await createModelicaService({ runsDirectory: directory, runner });
    await callback(service);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
