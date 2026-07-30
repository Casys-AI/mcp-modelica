import { assertEquals } from "@std/assert";
import { extractCoffeeMachineMetrics } from "../src/domain/metrics.ts";
import type { SimulationScenario } from "../src/domain/types.ts";
import { NOMINAL_CSV } from "./test-helpers.ts";

const scenario: SimulationScenario = {
  id: "test",
  description: "test",
  startTimeS: 0,
  stopTimeS: 300,
  numberOfIntervals: 3,
  solver: "dassl",
  targetTemperature: { value: 90, unit: "degC" },
};

Deno.test("metrics are extracted from declared output variables", () => {
  const result = extractCoffeeMachineMetrics(NOMINAL_CSV, scenario);
  assertEquals(result.metrics, {
    water_temperature_max: { value: 94, unit: "degC" },
    heater_energy: { value: 315000, unit: "J" },
    heater_power_peak: { value: 1500, unit: "W" },
    time_to_target_temperature: { value: 200, unit: "s" },
  });
  assertEquals(result.warnings, []);
});

Deno.test("unreached target remains absent rather than becoming a fictional value", () => {
  const result = extractCoffeeMachineMetrics(
    NOMINAL_CSV.replace("90.5", "89.5").replace("94", "89.9"),
    scenario,
  );
  assertEquals("time_to_target_temperature" in result.metrics, false);
  assertEquals(result.warnings.length, 1);
});
