import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { PACKAGE_VERSION } from "../../../release-identity.ts";
import {
  MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
} from "./admitted-recorded-session.ts";
import {
  compactRunMetricEntries,
  compactRunWarnings,
  executionStatusTone,
  MODELICA_COMPACT_READING_LIMIT,
  MODELICA_COMPACT_WARNING_LIMIT,
  MODELICA_COMPONENTS,
  MODELICA_RUN_CATALOG,
  MODELICA_RUN_DEFAULT_SURFACE,
  MODELICA_RUN_LIST_CATALOG,
  MODELICA_RUN_LIST_DEFAULT_SURFACE,
  MODELICA_RUN_LIST_PATH_ID,
  modelicaRunListPath,
  modelicaRunReference,
  recordedSessionStatusPresentation,
} from "./component-catalog.ts";
import { errorMessage, parseResultsEnvelope, type SimulationRun } from "./model.ts";
import {
  isModelicaRecordedViewSessionInputForResource,
  loadModelicaRunDetail,
  MODELICA_RECORDED_OPERATIONS,
  MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
  MODELICA_RESULT_SCHEMA_IDS,
  MODELICA_VIEW_APP_MANIFEST,
  modelicaProjectionSha256,
  parseModelicaRecordedViewSession,
  resolveModelicaRecordedRunDetail,
  VIEWER_SESSION_APPLY_ACTION,
} from "./recorded-session.ts";
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

Deno.test("results parser rejects sparse and adorned arrays before iteration", () => {
  const sparseRuns = new Array(1);
  assertThrows(
    () => parseResultsEnvelope({ schemaVersion: "2.0", kind: "run-list", runs: sparseRuns }),
    TypeError,
    "Expected a Modelica run or run-list envelope",
  );

  const adornedArtifacts = [...run.artifacts] as SimulationRun["artifacts"] & {
    source?: string;
  };
  adornedArtifacts.source = "host-decoration";
  assertThrows(
    () =>
      parseResultsEnvelope({
        schemaVersion: "2.0",
        kind: "run",
        run: { ...run, artifacts: adornedArtifacts },
      }),
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

Deno.test("results parser rejects derived curves on a direct run envelope", () => {
  assertThrows(
    () =>
      parseResultsEnvelope({
        schemaVersion: "2.0",
        kind: "run",
        run: { ...run, curves: [{ source: run.fingerprint }] },
      }),
    TypeError,
    "Expected a Modelica run or run-list envelope",
  );
});

Deno.test("default run surface is one compact SemanticElement, not the full catalog", () => {
  assertEquals(
    MODELICA_RUN_DEFAULT_SURFACE.components.map((item) => item.component),
    [MODELICA_COMPONENTS.runSummary],
  );
  assertEquals(MODELICA_RUN_DEFAULT_SURFACE.components.length, 1);
  assertEquals(
    MODELICA_RUN_CATALOG,
    [
      MODELICA_COMPONENTS.runSummary,
      MODELICA_COMPONENTS.runIdentity,
      MODELICA_COMPONENTS.executionStatus,
      MODELICA_COMPONENTS.metrics,
      MODELICA_COMPONENTS.parameters,
      MODELICA_COMPONENTS.provenance,
      MODELICA_COMPONENTS.artifacts,
      MODELICA_COMPONENTS.warnings,
    ],
  );
  assertEquals(MODELICA_RUN_CATALOG.length > MODELICA_RUN_DEFAULT_SURFACE.components.length, true);
});

Deno.test("compact run readings are deterministic across provider and persisted key order", () => {
  const bounded = compactRunMetricEntries({
    d: 4,
    b: 2,
    e: 5,
    a: 1,
    c: 3,
  });
  const persistedOrder = compactRunMetricEntries({ a: 1, b: 2, c: 3, d: 4, e: 5 });
  assertEquals(MODELICA_COMPACT_READING_LIMIT, 3);
  assertEquals(bounded.entries, [["a", 1], ["b", 2], ["c", 3]]);
  assertEquals(bounded, persistedOrder);
  assertEquals(bounded.omitted, 2);
});

Deno.test("compact run warnings are bounded without hiding the omitted count", () => {
  const bounded = compactRunWarnings(["first", "second", "third", "fourth"]);
  assertEquals(MODELICA_COMPACT_WARNING_LIMIT, 2);
  assertEquals(bounded.entries, ["first", "second"]);
  assertEquals(bounded.omitted, 2);
});

Deno.test("default run-list surface is one navigable list, not every list component", () => {
  assertEquals(
    MODELICA_RUN_LIST_DEFAULT_SURFACE.components.map((item) => item.component),
    [MODELICA_COMPONENTS.runList],
  );
  assertEquals(
    MODELICA_RUN_LIST_CATALOG,
    [
      MODELICA_COMPONENTS.runList,
      MODELICA_COMPONENTS.runListSummary,
      MODELICA_COMPONENTS.runTable,
    ],
  );
});

Deno.test("solver execution status is not a pass or proof verdict", () => {
  assertEquals(executionStatusTone("succeeded"), "neutral");
  assertEquals(executionStatusTone("timed_out"), "warning");
  assertEquals(executionStatusTone("failed"), "danger");
});

Deno.test("recorded session states keep their literal labels and mapped StateMessage tone/busy", () => {
  assertEquals(recordedSessionStatusPresentation("pending"), { tone: "info", busy: true });
  assertEquals(recordedSessionStatusPresentation("running"), { tone: "info", busy: true });
  assertEquals(recordedSessionStatusPresentation("rejected"), { tone: "danger", busy: false });
  assertEquals(
    recordedSessionStatusPresentation("recovery_required"),
    { tone: "warning", busy: false },
  );
  assertEquals(recordedSessionStatusPresentation("unavailable"), { tone: "neutral", busy: false });
  assertEquals(recordedSessionStatusPresentation("unresolved"), { tone: "neutral", busy: false });
});

Deno.test("run semantic reference carries exact identity and fingerprint", () => {
  assertEquals(modelicaRunReference(run), {
    domain: "simulation",
    kind: "run",
    id: run.run_id,
    basisFingerprint: run.fingerprint,
  });
  assertEquals(
    modelicaRunReference({ run_id: run.run_id, fingerprint: "not-a-digest" }).basisFingerprint,
    undefined,
  );
});

Deno.test("PathBar exists only for All runs to run navigation", () => {
  assertEquals(modelicaRunListPath(run.run_id), {
    items: [
      { id: MODELICA_RUN_LIST_PATH_ID, label: "All runs" },
      { id: run.run_id, label: run.run_id },
    ],
    currentId: run.run_id,
  });
  assertThrows(() => modelicaRunListPath("  "), TypeError, "Run path requires a run id");
});

Deno.test("component sources keep detailed catalog, compact defaults, and no synthetic traces", async () => {
  const components = await Deno.readTextFile(new URL("./components.tsx", import.meta.url));
  const app = await Deno.readTextFile(new URL("./app.ts", import.meta.url));
  assertStringIncludes(components, "SemanticElement");
  assertStringIncludes(components, "ElementIdent");
  assertStringIncludes(components, "ElementReading");
  assertStringIncludes(components, "ElementBody");
  assertStringIncludes(components, "ElementProvenance");
  assertStringIncludes(components, "ArtifactRow");
  assertStringIncludes(components, "<Row>");
  assertStringIncludes(components, "SemanticList");
  assertStringIncludes(components, "InlineCode");
  assertStringIncludes(components, "<Message");
  assertStringIncludes(components, "defaultSurface: MODELICA_RUN_DEFAULT_SURFACE");
  assertStringIncludes(components, "defaultSurface: MODELICA_RUN_LIST_DEFAULT_SURFACE");
  assertEquals(components.includes("ElementVerdict"), false);
  assertEquals(components.includes("LimitGauge"), false);
  assertEquals(components.includes("curves"), false);
  assertEquals(components.includes('class="mcp-view-row"'), false);
  assertEquals(components.includes("modelica-run-list"), false);
  assertEquals(components.includes("modelica-notes"), false);
  assertEquals(components.includes("<code>"), false);
  assertEquals(/\bproof\b|\bpass\b/.test(components), false);
  assertStringIncludes(app, "PathBar");
  assertStringIncludes(app, "modelicaRunListPath");
  assertStringIncludes(app, "if (data.runId) addListPathBar(ctx, node, masthead, data.runId)");
  assertStringIncludes(app, "Card");
  assertStringIncludes(app, "StateMessage");
  assertStringIncludes(app, "recordedSessionStatusPresentation");
  assertEquals(app.includes("‹ All runs"), false);
  assertEquals(app.includes("modelica-recorded-state"), false);
  assertEquals(app.includes('class="spinner"'), false);
  assertEquals(app.includes('class="mcp-view-card'), false);
  assertEquals(app.includes('class="mcp-view-state'), false);
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
  assertStringIncludes(styles, "var(--font-sans");
  assertEquals(styles.includes("Inter"), false);
  assertEquals(styles.includes("data-casys-projection"), false);
  assertEquals(styles.includes("glance"), false);
  assertEquals(styles.includes(".modelica-run-list"), false);
  assertEquals(styles.includes(".modelica-notes"), false);
  assertEquals(styles.includes(".modelica-recorded-state"), false);
  assertEquals(styles.includes(".spinner"), false);
});

Deno.test("Modelica publishes whole-view recorded-session declarations", () => {
  assertEquals(MODELICA_VIEW_APP_MANIFEST.schemaVersion, "io.casys.mcp.view-app-manifest/1.0");
  assertEquals(MODELICA_VIEW_APP_MANIFEST.app, {
    id: "io.casys.mcp-modelica.results",
    title: "Modelica results",
    version: PACKAGE_VERSION,
  });
  assertEquals(
    MODELICA_VIEW_APP_MANIFEST.resources.map((resource) => ({
      uri: resource.uri,
      ownership: resource.ownership,
      acceptedActions: resource.acceptedActions,
      sessionSchemas: resource.sessionSchemas,
    })),
    [
      {
        uri: "ui://mcp-modelica/results-viewer",
        ownership: "whole-view",
        acceptedActions: [VIEWER_SESSION_APPLY_ACTION],
        sessionSchemas: [
          MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
          MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
        ],
      },
      {
        uri: "ui://mcp-modelica/run-list-viewer",
        ownership: "whole-view",
        acceptedActions: [VIEWER_SESSION_APPLY_ACTION],
        sessionSchemas: [MODELICA_RECORDED_VIEW_SESSION_SCHEMA],
      },
    ],
  );
  assertEquals(MODELICA_VIEW_APP_MANIFEST.resources[0].resultSchemas, [
    MODELICA_RESULT_SCHEMA_IDS.legacyRun,
    MODELICA_RESULT_SCHEMA_IDS.recordedRun,
    MODELICA_RESULT_SCHEMA_IDS.admittedExecutionCapture,
  ]);
  assertEquals(MODELICA_VIEW_APP_MANIFEST.resources[1].resultSchemas, [
    MODELICA_RESULT_SCHEMA_IDS.legacyRunList,
    MODELICA_RESULT_SCHEMA_IDS.recordedRunList,
  ]);
});

Deno.test("recorded session accepts exact 2.0 list detail and never calls the standalone loader", async () => {
  const session = await parseModelicaRecordedViewSession(
    await recordedListSession({
      result: {
        schemaVersion: "2.0",
        kind: "run-list",
        runs: [recordedSummary(run)],
      },
      details: [{
        run_id: run.run_id,
        status: "available",
        result: { schemaVersion: "2.0", kind: "run", run },
      }],
    }),
  );
  let loaderCalls = 0;
  const detail = await loadModelicaRunDetail(session, run.run_id, () => {
    loaderCalls++;
    throw new Error("recorded mode must not call the Modelica server");
  });
  assertEquals(loaderCalls, 0);
  assertEquals(detail.status, "available");
  if (detail.status !== "available") throw new Error("Expected recorded detail.");
  assertEquals(detail.result.schemaVersion, "2.0");
  assertEquals(detail.result.run, run);
});

Deno.test("recorded session accepts an exact 1.0 detail without inventing 2.0 provenance", async () => {
  const legacyRun = legacyRunEnvelopeValue();
  const session = await parseModelicaRecordedViewSession(
    await recordedListSession({
      result: {
        schemaVersion: "1.0",
        kind: "run-list",
        runs: [legacySummary(legacyRun)],
      },
      details: [{
        run_id: run.run_id,
        status: "available",
        result: { schemaVersion: "1.0", kind: "run", run: legacyRun },
      }],
    }),
  );
  const detail = resolveModelicaRecordedRunDetail(session, run.run_id);
  assertEquals(detail.status, "available");
  if (detail.status !== "available") throw new Error("Expected recorded detail.");
  assertEquals(detail.result.schemaVersion, "1.0");
  assertEquals(detail.result.run.scenario.source_sha256, undefined);
  assertEquals(detail.result.run.parameter_schema, undefined);
  assertEquals(detail.result.run.result_normalizer, undefined);
});

Deno.test("recorded session preserves terminal and in-flight states literally", async () => {
  const projections = [
    { status: "pending" },
    { status: "running" },
    { status: "rejected", reason: "manifest_mismatch" },
    { status: "recovery_required", reason: "writer acknowledgement is uncertain" },
    { status: "unavailable", reason: "detail was not recorded" },
  ] as const;
  for (const projection of projections) {
    const parsed = await parseModelicaRecordedViewSession(await recordedSession(projection));
    assertEquals(parsed.projection.status, projection.status);
  }
});

Deno.test("recorded list drill-down fails visibly unavailable when detail is absent", async () => {
  const session = await parseModelicaRecordedViewSession(
    await recordedListSession({
      result: {
        schemaVersion: "2.0",
        kind: "run-list",
        runs: [recordedSummary(run)],
      },
      details: [],
    }),
  );
  let loaderCalls = 0;
  const detail = await loadModelicaRunDetail(session, run.run_id, () => {
    loaderCalls++;
    return Promise.resolve({ schemaVersion: "2.0", kind: "run", run });
  });
  assertEquals(loaderCalls, 0);
  assertEquals(detail, {
    run_id: run.run_id,
    status: "unavailable",
    reason: "Recorded detail was not supplied by the host.",
  });
});

Deno.test("recorded session rejects derived curves and hash-only pseudo-detail", async () => {
  const withCurves = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [],
  });
  (withCurves.projection as Record<string, unknown>).curves = [{ source: run.fingerprint }];
  await assertRejects(
    () => parseModelicaRecordedViewSession(withCurves),
    TypeError,
    "unsupported fields",
  );

  const detailWithCurves = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [{
      run_id: run.run_id,
      status: "available",
      result: {
        schemaVersion: "2.0",
        kind: "run",
        run: { ...run, curves: [{ source: run.fingerprint }] },
      },
    }],
  });
  await assertRejects(
    () => parseModelicaRecordedViewSession(detailWithCurves),
    TypeError,
    "Expected a Modelica run or run-list envelope",
  );

  const hashOnly = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [{
      run_id: run.run_id,
      status: "available",
      result: {
        schemaVersion: "2.0",
        kind: "run",
        run: { run_id: run.run_id, fingerprint: run.fingerprint },
      },
    }],
  });
  await assertRejects(
    () => parseModelicaRecordedViewSession(hashOnly),
    TypeError,
    "Expected a Modelica run or run-list envelope",
  );
});

Deno.test("recorded session rejects foreign operations and unbound artifact identities", async () => {
  assertEquals(MODELICA_RECORDED_OPERATIONS, [
    "simulate.run-qualified-modelica-kit@1",
    "simulate.run-admitted-modelica@1",
  ]);

  const foreignOperation = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [],
  });
  foreignOperation.provenance.recordedOperation = "verify.run-fea-static-proof@3";
  await assertRejects(
    () => parseModelicaRecordedViewSession(foreignOperation),
    TypeError,
    "operation is not compatible",
  );

  const missingArtifact = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [],
  });
  missingArtifact.provenance.recordedArtifacts = [];
  await assertRejects(
    () => parseModelicaRecordedViewSession(missingArtifact),
    TypeError,
    "exactly one artifact per projected run",
  );

  const surplusArtifact = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [],
  });
  surplusArtifact.provenance.recordedArtifacts.push({
    artifactId: "artifact-surplus",
    runId: "run-surplus",
    runFingerprint: "8".repeat(64),
  });
  await assertRejects(
    () => parseModelicaRecordedViewSession(surplusArtifact),
    TypeError,
    "exactly one artifact per projected run",
  );

  const mismatchedArtifact = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [],
  });
  mismatchedArtifact.provenance.recordedArtifacts[0]!.runFingerprint = "9".repeat(64);
  await assertRejects(
    () => parseModelicaRecordedViewSession(mismatchedArtifact),
    TypeError,
    "artifact identity differs",
  );
});

Deno.test("recorded session verifies the fingerprint of the raw projection", async () => {
  const session = await recordedSession({ status: "pending" });
  session.projection = { status: "running" };
  await assertRejects(
    () => parseModelicaRecordedViewSession(session),
    TypeError,
    "projectionSha256 does not match",
  );
});

Deno.test("viewer.session.apply ingress rejects foreign shapes and resources", async () => {
  const session = await recordedSession({ status: "pending" });
  assertEquals(isModelicaRecordedViewSessionInputForResource(session, "run-list"), true);
  assertEquals(isModelicaRecordedViewSessionInputForResource(session, "run"), false);
  assertEquals(
    isModelicaRecordedViewSessionInputForResource({ ...session, unexpected: true }, "run-list"),
    false,
  );
  assertEquals(
    isModelicaRecordedViewSessionInputForResource({
      ...session,
      provenance: {
        ...session.provenance,
        recordedOperation: "verify.run-fea-static-proof@3",
      },
    }, "run-list"),
    false,
  );
});

Deno.test("recorded parser and projection hash reject sparse or adorned arrays", async () => {
  const sparseDetails = new Array(1);
  const sparseSession = await recordedListSession({
    result: { schemaVersion: "2.0", kind: "run-list", runs: [] },
    details: [],
  });
  (sparseSession.projection as { details: unknown[] }).details = sparseDetails;
  await assertRejects(
    () => parseModelicaRecordedViewSession(sparseSession),
    TypeError,
    "details must be a dense JSON array",
  );
  await assertRejects(
    () => modelicaProjectionSha256({ values: sparseDetails }),
    TypeError,
    "dense JSON arrays only",
  );

  const adornedArtifacts = [] as
    & Array<{
      artifactId: string;
      runId: string;
      runFingerprint: string;
    }>
    & { source?: string };
  adornedArtifacts.source = "host-decoration";
  const adornedSession = await recordedSession({ status: "pending" });
  adornedSession.provenance.recordedArtifacts = adornedArtifacts;
  await assertRejects(
    () => parseModelicaRecordedViewSession(adornedSession),
    TypeError,
    "provenance recordedArtifacts must be a dense JSON array",
  );
  await assertRejects(
    () => modelicaProjectionSha256({ values: adornedArtifacts }),
    TypeError,
    "dense JSON arrays only",
  );
});

Deno.test("recorded detail must repeat every run-list summary fact exactly", async () => {
  const drifts: Array<[string, (detail: SimulationRun) => void]> = [
    ["status", (detail) => detail.status = "failed"],
    ["fingerprint", (detail) => detail.fingerprint = "9".repeat(64)],
    ["model", (detail) => detail.model = { ...detail.model, id: "foreign-model" }],
    ["scenario", (detail) => detail.scenario = { ...detail.scenario, id: "foreign-scenario" }],
    ["started_at", (detail) => detail.started_at = "2026-07-31T07:59:59.000Z"],
    ["completed_at", (detail) => detail.completed_at = "2026-07-31T08:00:04.000Z"],
  ];
  for (const [field, mutate] of drifts) {
    const detail = structuredClone(run);
    mutate(detail);
    const session = await recordedListSession({
      result: {
        schemaVersion: "2.0",
        kind: "run-list",
        runs: [recordedSummary(run)],
      },
      details: [{
        run_id: run.run_id,
        status: "available",
        result: { schemaVersion: "2.0", kind: "run", run: detail },
      }],
    });
    await assertRejects(
      () => parseModelicaRecordedViewSession(session),
      TypeError,
      "detail facts differ",
      field,
    );
  }

  const foreignRunId = structuredClone(run);
  foreignRunId.run_id = "run_11111111-1111-4111-8111-111111111111";
  const session = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run)],
    },
    details: [{
      run_id: foreignRunId.run_id,
      status: "available",
      result: { schemaVersion: "2.0", kind: "run", run: foreignRunId },
    }],
  });
  await assertRejects(
    () => parseModelicaRecordedViewSession(session),
    TypeError,
    "detail is absent from its run list",
  );
});

Deno.test("recorded run-list rejects duplicate run identities", async () => {
  const session = await recordedListSession({
    result: {
      schemaVersion: "2.0",
      kind: "run-list",
      runs: [recordedSummary(run), recordedSummary(run)],
    },
    details: [],
  });
  await assertRejects(
    () => parseModelicaRecordedViewSession(session),
    TypeError,
    "run list contains duplicate run ids",
  );
});

async function recordedSession(projection: unknown) {
  const projectedRuns = projectedRunFacts(projection);
  return {
    schemaVersion: MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
    kind: "modelica.results",
    basis: {
      projectId: "project-1",
      projectRevision: 7,
      subjectId: "thermal-behaviour",
      thread: { id: "thread-1", revision: 19 },
    },
    anchor: { kind: "modelica-run-list", id: "modelica-runs-at-r19" },
    provenance: {
      recordedOperation: "simulate.run-qualified-modelica-kit@1",
      recordedArtifacts: projectedRuns.map((projectedRun, index) => ({
        artifactId: `artifact-modelica-run-${index + 1}`,
        runId: projectedRun.run_id,
        runFingerprint: projectedRun.fingerprint,
      })),
      projectionSha256: await modelicaProjectionSha256(projection),
    },
    projection,
  };
}

async function recordedListSession(
  projection: { result: unknown; details: unknown[] },
) {
  return await recordedSession({ status: "available", ...projection });
}

function projectedRunFacts(projection: unknown): Array<{ run_id: string; fingerprint: string }> {
  if (
    typeof projection !== "object" || projection === null ||
    (projection as { status?: unknown }).status !== "available"
  ) return [];
  const result = (projection as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return [];
  if ((result as { kind?: unknown }).kind === "run-list") {
    const runs = (result as { runs?: unknown }).runs;
    return Array.isArray(runs)
      ? runs.filter(hasRunFingerprint).map((value) => ({
        run_id: value.run_id,
        fingerprint: value.fingerprint,
      }))
      : [];
  }
  const value = (result as { run?: unknown }).run;
  return hasRunFingerprint(value) ? [{ run_id: value.run_id, fingerprint: value.fingerprint }] : [];
}

function hasRunFingerprint(value: unknown): value is { run_id: string; fingerprint: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { run_id?: unknown }).run_id === "string" &&
    typeof (value as { fingerprint?: unknown }).fingerprint === "string";
}

function recordedSummary(value: SimulationRun) {
  return {
    record_schema_version: value.record_schema_version,
    status: value.status,
    run_id: value.run_id,
    started_at: value.started_at,
    completed_at: value.completed_at,
    fingerprint: value.fingerprint,
    model: value.model,
    scenario: value.scenario,
  };
}

function legacyRunEnvelopeValue() {
  return {
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
    artifacts: run.artifacts.map(({ qualification: _qualification, ...artifact }) => artifact),
    warnings: run.warnings,
  };
}

function legacySummary(value: ReturnType<typeof legacyRunEnvelopeValue>) {
  return {
    status: value.status,
    run_id: value.run_id,
    started_at: value.started_at,
    completed_at: value.completed_at,
    fingerprint: value.fingerprint,
    model: value.model,
    scenario: value.scenario,
  };
}
