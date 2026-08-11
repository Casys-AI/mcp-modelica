import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { errorMessage, parseResultsEnvelope, type SimulationRun } from "./model.ts";
import { escapeHtml, formatQuantity, formatTimestamp } from "./render.ts";

const run: SimulationRun = {
  record_schema_version: "2.0",
  status: "succeeded",
  run_id: "run_00000000-0000-4000-8000-000000000000",
  started_at: "2026-07-31T08:00:00.000Z",
  completed_at: "2026-07-31T08:00:03.000Z",
  fingerprint: "a".repeat(64),
  model: {
    id: "coffee-machine-v1",
    version: "1.0.0",
    name: "CoffeeMachine",
    source_sha256: "b".repeat(64),
  },
  scenario: {
    id: "heat-up-nominal",
    source_sha256: "c".repeat(64),
    projection_sha256: "e".repeat(64),
  },
  result_normalizer: { id: "coffee-machine-result-normalizer", version: "1.0.0" },
  engine: { name: "OpenModelica", version: "1.27", msl_version: "4.1.0" },
  resolved_parameters: { heater_power: { value: 1500, unit: "W" } },
  metrics: { water_temperature_max: { value: 94, unit: "degC" } },
  artifacts: [{
    kind: "result",
    uri: "casys://modelica/runs/run_00000000-0000-4000-8000-000000000000/result.csv",
    sha256: "d".repeat(64),
    bytes: 512,
  }],
  warnings: [],
};

Deno.test("results viewer parses the explicit v2 run and run-list envelopes", () => {
  assertEquals(parseResultsEnvelope({ schemaVersion: "2.0", kind: "run", run }), {
    schemaVersion: "2.0",
    kind: "run",
    run,
  });
  assertEquals(parseResultsEnvelope({ schemaVersion: "2.0", kind: "run-list", runs: [] }), {
    schemaVersion: "2.0",
    kind: "run-list",
    runs: [],
  });
  assertThrows(
    () => parseResultsEnvelope({ schemaVersion: "2.0", kind: "legacy-run", run }),
    TypeError,
    "Expected a Modelica run or run-list envelope",
  );
});

Deno.test("results viewer normalizes v1 without inventing native scenario provenance", () => {
  const legacy = {
    status: run.status,
    run_id: run.run_id,
    started_at: run.started_at,
    completed_at: run.completed_at,
    fingerprint: run.fingerprint,
    model: { id: run.model.id, version: run.model.version, sha256: run.model.source_sha256 },
    scenario: { id: run.scenario.id, sha256: run.scenario.projection_sha256 },
    engine: run.engine,
    resolved_parameters: run.resolved_parameters,
    metrics: run.metrics,
    artifacts: run.artifacts,
    warnings: run.warnings,
  };
  const parsed = parseResultsEnvelope({ schemaVersion: "1.0", kind: "run", run: legacy });
  if (parsed.kind !== "run") throw new Error("Expected normalized legacy run.");
  assertEquals(parsed.run.record_schema_version, "1.0");
  assertEquals(parsed.run.model.source_sha256, run.model.source_sha256);
  assertEquals(parsed.run.scenario.projection_sha256, run.scenario.projection_sha256);
  assertEquals(parsed.run.scenario.source_sha256, undefined);
  assertEquals(parsed.run.parameter_schema, undefined);
  assertEquals(parsed.run.result_normalizer, undefined);
});

Deno.test("results viewer formatting is truthful and HTML-safe", () => {
  assertEquals(formatQuantity({ value: 1500, unit: "W" }), "1,500 W");
  assertStringIncludes(formatTimestamp(run.completed_at), "2026");
  assertEquals(
    escapeHtml(`<img src=x onerror="alert(1)">`),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
  assertEquals(
    errorMessage({ content: [{ type: "text", text: "Runner unavailable" }] }),
    "Runner unavailable",
  );
  assertEquals(errorMessage({ content: [] }), "The Modelica tool reported an error.");
});

Deno.test("component styles contain no projection-mode selectors", async () => {
  const styles = await Deno.readTextFile(new URL("./styles.css", import.meta.url));
  assertStringIncludes(styles, ".component-surface-host");
  assertEquals(styles.includes("data-casys-projection"), false);
  assertEquals(styles.includes("glance"), false);
});
