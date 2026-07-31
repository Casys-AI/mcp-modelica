import { assertEquals, assertThrows } from "@std/assert";
import { errorMessage, parseResultsEnvelope, type SimulationRun } from "./model.ts";
import { escapeHtml, formatQuantity, renderRunPanels } from "./render.ts";

const run: SimulationRun = {
  status: "succeeded",
  run_id: "run_00000000-0000-4000-8000-000000000000",
  started_at: "2026-07-31T08:00:00.000Z",
  completed_at: "2026-07-31T08:00:03.000Z",
  fingerprint: "a".repeat(64),
  model: { id: "coffee-machine-v1", version: "1.0.0", sha256: "b".repeat(64) },
  scenario: { id: "heat-up-nominal", sha256: "c".repeat(64) },
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

Deno.test("results viewer parses exactly the v1 run and run-list envelopes", () => {
  assertEquals(parseResultsEnvelope({ schemaVersion: "1.0", kind: "run", run }), {
    schemaVersion: "1.0",
    kind: "run",
    run,
  });
  assertEquals(parseResultsEnvelope({ schemaVersion: "1.0", kind: "run-list", runs: [] }), {
    schemaVersion: "1.0",
    kind: "run-list",
    runs: [],
  });
  assertThrows(
    () => parseResultsEnvelope({ schemaVersion: "1.0", kind: "legacy-run", run }),
    TypeError,
    "Expected a Modelica run or run-list envelope",
  );
});

Deno.test("results viewer renders real measurements and evidence safely", () => {
  const rendered = renderRunPanels(run);
  assertEquals(formatQuantity({ value: 1500, unit: "W" }), "1,500 W");
  assertEquals(rendered.includes("water_temperature_max"), true);
  assertEquals(rendered.includes("94 degC"), true);
  assertEquals(rendered.includes("OpenModelica 1.27"), true);
  assertEquals(rendered.includes("casys://modelica/runs/"), true);
  assertEquals(rendered.includes("pass"), false);
  assertEquals(escapeHtml("<unsafe>"), "&lt;unsafe&gt;");
  assertEquals(
    errorMessage({ content: [{ type: "text", text: "Runner unavailable" }] }),
    "Runner unavailable",
  );

  const hostile = structuredClone(run);
  hostile.model.id = `<img src=x onerror="alert(1)">`;
  hostile.artifacts[0].uri = `"><script>alert(1)</script>`;
  hostile.warnings = [`<svg onload="alert(1)">`];
  const escaped = renderRunPanels(hostile);
  assertEquals(escaped.includes("<script>"), false);
  assertEquals(escaped.includes("<img"), false);
  assertEquals(escaped.includes("<svg"), false);
  assertEquals(escaped.includes("&lt;script&gt;"), true);
});
