import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ValidationError } from "../src/domain/errors.ts";
import { stableJson } from "../src/domain/hashing.ts";
import { createModelicaService } from "../src/domain/service.ts";
import type {
  ModelicaKit,
  SimulationResultNormalization,
  SimulationScenario,
} from "../src/domain/types.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";
import { KitRegistry } from "../src/kits/registry.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("kit registry rejects ambiguous metric and normalizer contracts", async () => {
  const kit = await loadCoffeeMachineKit();
  assertThrows(
    () =>
      new KitRegistry([{
        ...kit,
        producedMetrics: [kit.producedMetrics[0], { ...kit.producedMetrics[0] }],
      }]),
    ValidationError,
    "duplicate produced metric",
  );
  assertThrows(
    () =>
      new KitRegistry([{
        ...kit,
        resultNormalizer: { ...kit.resultNormalizer, id: " " },
      }]),
    ValidationError,
    "resultNormalizer.id must be a non-empty canonical string",
  );
  assertThrows(
    () =>
      new KitRegistry([{
        ...kit,
        producedMetrics: [{ ...kit.producedMetrics[0], unit: "" }],
      }]),
    ValidationError,
    "unit must be a non-empty canonical string",
  );
  assertThrows(
    () =>
      new KitRegistry([{
        ...kit,
        producedMetrics: [{
          ...kit.producedMetrics[0],
          required: undefined,
        }] as unknown as ModelicaKit["producedMetrics"],
      }]),
    ValidationError,
    "required must be explicitly boolean",
  );
});

Deno.test("normalizer output refuses undeclared, wrong-unit, and missing required metrics", async () => {
  const base = await loadCoffeeMachineKit();
  const cases: Array<{
    name: string;
    normalize: (csv: string, scenario: SimulationScenario) => SimulationResultNormalization;
    expected: string;
  }> = [
    {
      name: "undeclared",
      normalize(csv, scenario) {
        const result = base.resultNormalizer.normalize(csv, scenario);
        return {
          ...result,
          metrics: { ...result.metrics, invented_efficiency: { value: 1, unit: "1" } },
        };
      },
      expected: "emitted undeclared metric 'invented_efficiency'",
    },
    {
      name: "wrong-unit",
      normalize(csv, scenario) {
        const result = base.resultNormalizer.normalize(csv, scenario);
        return {
          ...result,
          metrics: {
            ...result.metrics,
            water_temperature_max: { value: 367.15, unit: "K" },
          },
        };
      },
      expected: "metric 'water_temperature_max' uses unit 'K'; expected 'degC'",
    },
    {
      name: "missing-required",
      normalize(csv, scenario) {
        const result = base.resultNormalizer.normalize(csv, scenario);
        const metrics = { ...result.metrics };
        delete metrics.heater_energy;
        return { ...result, metrics };
      },
      expected: "missing required metric 'heater_energy'",
    },
  ];

  for (const testCase of cases) {
    const directory = await Deno.makeTempDir({ prefix: `mcp-modelica-metrics-${testCase.name}-` });
    try {
      const kit: ModelicaKit = {
        ...base,
        resultNormalizer: {
          id: `test-${testCase.name}-normalizer`,
          version: "1.0.0",
          normalize: testCase.normalize,
        },
      };
      const service = await createModelicaService({
        registry: new KitRegistry([kit]),
        runner: new FakeRunner(),
        runsDirectory: directory,
      });
      const run = await service.simulate({
        model_id: kit.id,
        scenario_id: "heat-up-nominal",
      });
      assertEquals(run.status, "failed", testCase.name);
      assertEquals(run.metrics, {}, testCase.name);
      assertStringIncludes(run.warnings.join("\n"), testCase.expected, testCase.name);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("an absent optional metric is admitted after normalization", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-optional-metric-" });
  try {
    const base = await loadCoffeeMachineKit();
    const kit: ModelicaKit = {
      ...base,
      resultNormalizer: {
        id: "coffee-machine-optional-absence-test",
        version: "1.0.0",
        normalize(csv, scenario) {
          const result = base.resultNormalizer.normalize(csv, scenario);
          const metrics = { ...result.metrics };
          delete metrics.time_to_target_temperature;
          return { ...result, metrics };
        },
      },
    };
    const service = await createModelicaService({
      registry: new KitRegistry([kit]),
      runner: new FakeRunner(),
      runsDirectory: directory,
    });
    const run = await service.simulate({
      model_id: kit.id,
      scenario_id: "heat-up-nominal",
    });
    assertEquals(run.status, "succeeded");
    assertEquals("time_to_target_temperature" in run.metrics, false);
    assertEquals((await service.getRecordedRun(run.run_id)).status, "succeeded");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("replay rejects undeclared, wrong-unit, and missing required persisted metrics", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-metric-replay-" });
  try {
    const service = await createModelicaService({
      runner: new FakeRunner(),
      runsDirectory: directory,
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const runPath = join(directory, run.run_id, "run.json");
    const cases: Array<{ mutate: (candidate: typeof run) => void; expected: string }> = [
      {
        mutate: (candidate) => {
          candidate.metrics.invented_efficiency = { value: 1, unit: "1" };
        },
        expected: "emitted undeclared metric 'invented_efficiency'",
      },
      {
        mutate: (candidate) => {
          candidate.metrics.water_temperature_max.unit = "K";
        },
        expected: "metric 'water_temperature_max' uses unit 'K'; expected 'degC'",
      },
      {
        mutate: (candidate) => {
          delete candidate.metrics.heater_energy;
        },
        expected: "missing required metric 'heater_energy'",
      },
    ];
    for (const testCase of cases) {
      const candidate = structuredClone(run);
      testCase.mutate(candidate);
      await Deno.writeTextFile(runPath, stableJson(candidate));
      await assertRejects(
        () => service.getRecordedRun(run.run_id),
        ValidationError,
        testCase.expected,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
