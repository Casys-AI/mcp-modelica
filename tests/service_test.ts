import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createModelicaService } from "../src/domain/service.ts";
import { ValidationError } from "../src/domain/errors.ts";
import type { SimulationRunner } from "../src/domain/types.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("modelica_kit_list data exposes one approved CoffeeMachine kit", async () => {
  await withService((service) => {
    const kits = service.listKits();
    assertEquals(kits.length, 1);
    assertEquals(kits[0].id, "coffee-machine-v1");
    assertEquals(kits[0].scenarios[0].id, "heat-up-nominal");
    assertEquals(
      kits[0].parameters.find((parameter) => parameter.id === "heater_power")?.unit,
      "W",
    );
    assertEquals("modelSource" in kits[0], false);
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
      "script",
      "diagnostics",
      "result",
      "evidence",
    ]);
    for (const artifact of run.artifacts) {
      assertMatch(artifact.sha256, /^[0-9a-f]{64}$/);
      assertMatch(artifact.uri, new RegExp(`^casys://modelica/runs/${run.run_id}/`));
    }

    const saved = await service.getRun(run.run_id);
    assertEquals(saved.run_id, run.run_id);
    assertEquals(saved.started_at, run.started_at);
    assertEquals(saved.completed_at, run.completed_at);
    assertEquals(saved.fingerprint, run.fingerprint);
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
  });
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

Deno.test("run list remains compatible with a persisted legacy record without timestamps", async () => {
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

    const [listed] = await service.listRuns();
    assertEquals(listed.run_id, run.run_id);
    assertEquals("started_at" in listed, false);
    assertEquals("completed_at" in listed, false);
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
