import { parseResultsEnvelope, type ResultsEnvelope } from "./model.ts";
import { PACKAGE_VERSION } from "../../../release-identity.ts";
import { isDenseJsonArray } from "./strict-json.ts";
import {
  MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
  MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
} from "./admitted-recorded-session.ts";
import { VIEW_APP_MANIFEST_SCHEMA, VIEWER_SESSION_APPLY_ACTION } from "@casys/mcp-view-contracts";

/** Re-exported from the shared contract so these identities have a single source. */
export { VIEW_APP_MANIFEST_SCHEMA, VIEWER_SESSION_APPLY_ACTION };
export const MODELICA_RECORDED_VIEW_SESSION_SCHEMA =
  "io.casys.mcp-modelica.recorded-results-session/1.0" as const;

export const MODELICA_RESULTS_VIEWER_URI = "ui://mcp-modelica/results-viewer" as const;
export const MODELICA_RUN_LIST_VIEWER_URI = "ui://mcp-modelica/run-list-viewer" as const;

/** Stable identities for the exact structured-result contracts rendered by this App. */
export const MODELICA_RESULT_SCHEMA_IDS = {
  legacyRun: "io.casys.mcp-modelica.run-result/1.0",
  recordedRun: "io.casys.mcp-modelica.run-result/2.0",
  admittedExecutionCapture: MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
  legacyRunList: "io.casys.mcp-modelica.run-list-result/1.0",
  recordedRunList: "io.casys.mcp-modelica.run-list-result/2.0",
} as const;

export const MODELICA_RECORDED_OPERATIONS = [
  "simulate.run-qualified-modelica-kit@1",
  "simulate.run-admitted-modelica@1",
] as const;

export type ModelicaRecordedOperation = (typeof MODELICA_RECORDED_OPERATIONS)[number];

export const MODELICA_VIEW_APP_MANIFEST = {
  schemaVersion: VIEW_APP_MANIFEST_SCHEMA,
  app: {
    id: "io.casys.mcp-modelica.results",
    title: "Modelica results",
    version: PACKAGE_VERSION,
  },
  resources: [
    {
      uri: MODELICA_RESULTS_VIEWER_URI,
      ownership: "whole-view",
      resultSchemas: [
        MODELICA_RESULT_SCHEMA_IDS.legacyRun,
        MODELICA_RESULT_SCHEMA_IDS.recordedRun,
        MODELICA_RESULT_SCHEMA_IDS.admittedExecutionCapture,
      ],
      acceptedActions: [VIEWER_SESSION_APPLY_ACTION],
      sessionSchemas: [
        MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
        MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
      ],
    },
    {
      uri: MODELICA_RUN_LIST_VIEWER_URI,
      ownership: "whole-view",
      resultSchemas: [
        MODELICA_RESULT_SCHEMA_IDS.legacyRunList,
        MODELICA_RESULT_SCHEMA_IDS.recordedRunList,
      ],
      acceptedActions: [VIEWER_SESSION_APPLY_ACTION],
      sessionSchemas: [MODELICA_RECORDED_VIEW_SESSION_SCHEMA],
    },
  ],
} as const;

/** MCP Apps handshake identity derived from, and therefore identical to, the public manifest. */
export const MODELICA_VIEW_APP_INFO = {
  name: MODELICA_VIEW_APP_MANIFEST.app.id,
  version: MODELICA_VIEW_APP_MANIFEST.app.version,
} as const;

export type ModelicaRecordedSessionStatus =
  | "pending"
  | "running"
  | "rejected"
  | "recovery_required"
  | "unavailable"
  | "unresolved";

interface PendingProjection {
  readonly status: "pending" | "running";
}

interface UnavailableProjection {
  readonly status: "rejected" | "recovery_required" | "unavailable" | "unresolved";
  readonly reason: string;
}

export type ModelicaRecordedRunDetailProjection =
  | {
    readonly run_id: string;
    readonly status: "available";
    readonly result: Extract<ResultsEnvelope, { kind: "run" }>;
  }
  | ({ readonly run_id: string } & PendingProjection)
  | ({ readonly run_id: string } & UnavailableProjection);

export type ModelicaRecordedViewProjection =
  | {
    readonly status: "available";
    readonly result: ResultsEnvelope;
    readonly details: readonly ModelicaRecordedRunDetailProjection[];
  }
  | PendingProjection
  | UnavailableProjection;

export interface ModelicaRecordedViewSession {
  readonly schemaVersion: typeof MODELICA_RECORDED_VIEW_SESSION_SCHEMA;
  readonly kind: "modelica.results";
  readonly basis: {
    readonly projectId: string;
    readonly projectRevision: number;
    readonly subjectId: string;
    readonly thread: {
      readonly id: string;
      readonly revision: number;
    };
  };
  readonly anchor: {
    readonly kind: "modelica-run" | "modelica-run-list";
    readonly id: string;
  };
  readonly provenance: {
    readonly recordedOperation: ModelicaRecordedOperation;
    readonly recordedArtifacts: readonly {
      readonly artifactId: string;
      readonly runId: string;
      readonly runFingerprint: string;
    }[];
    /** SHA-256 of the session's raw projection using sorted-key canonical JSON. */
    readonly projectionSha256: string;
  };
  readonly projection: ModelicaRecordedViewProjection;
}

/** Raw action payload after synchronous exact-shape and resource validation. */
export type ModelicaRecordedViewSessionInput = Readonly<Record<string, unknown>>;

const MAX_RECORDED_RUN_DETAILS = 20;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Synchronous ingress guard for `viewer.session.apply`.
 *
 * It validates the full closed structure, authority joins, and target resource. The asynchronous
 * parser still verifies the raw projection fingerprint with WebCrypto before applying any state.
 */
export function isModelicaRecordedViewSessionInputForResource(
  value: unknown,
  resource: "run" | "run-list",
): value is ModelicaRecordedViewSessionInput {
  try {
    return modelicaSessionResource(parseModelicaRecordedViewSessionStructure(value)) === resource;
  } catch {
    return false;
  }
}

/** Validate and fingerprint a host-supplied read model without acquiring MCP or solver authority. */
export async function parseModelicaRecordedViewSession(
  value: unknown,
): Promise<ModelicaRecordedViewSession> {
  const session = parseModelicaRecordedViewSessionStructure(value);
  const actualProjectionSha256 = await modelicaProjectionSha256(
    (value as Record<string, unknown>).projection,
  );
  if (session.provenance.projectionSha256 !== actualProjectionSha256) {
    throw new TypeError(
      "Modelica recorded viewer session projectionSha256 does not match its raw projection.",
    );
  }
  return session;
}

function parseModelicaRecordedViewSessionStructure(value: unknown): ModelicaRecordedViewSession {
  if (
    !isExactRecord(value, [
      "schemaVersion",
      "kind",
      "basis",
      "anchor",
      "provenance",
      "projection",
    ])
  ) {
    throw new TypeError("Modelica recorded viewer session has an invalid top-level shape.");
  }
  if (value.schemaVersion !== MODELICA_RECORDED_VIEW_SESSION_SCHEMA) {
    throw new TypeError(
      `Modelica recorded viewer session schema must be ${MODELICA_RECORDED_VIEW_SESSION_SCHEMA}.`,
    );
  }
  if (value.kind !== "modelica.results") {
    throw new TypeError("Modelica recorded viewer session kind must be modelica.results.");
  }
  const basis = parseBasis(value.basis);
  const anchor = parseAnchor(value.anchor);
  const provenance = parseProvenance(value.provenance);
  const projection = parseProjection(value.projection);
  assertProjectionMatchesAnchor(projection, anchor);
  assertProvenanceMatchesProjection(provenance, projection);
  return {
    schemaVersion: MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
    kind: "modelica.results",
    basis,
    anchor,
    provenance,
    projection,
  };
}

/** Select recorded detail locally. Absence is a literal unavailable state. */
export function resolveModelicaRecordedRunDetail(
  session: ModelicaRecordedViewSession,
  runId: string,
): ModelicaRecordedRunDetailProjection {
  const projection = session.projection;
  if (projection.status !== "available") {
    return "reason" in projection
      ? { run_id: runId, status: projection.status, reason: projection.reason }
      : { run_id: runId, status: projection.status };
  }
  if (projection.result.kind === "run") {
    return projection.result.run.run_id === runId
      ? { run_id: runId, status: "available", result: projection.result }
      : unavailableDetail(runId, "The recorded session contains a different run detail.");
  }
  return projection.details.find((detail) => detail.run_id === runId) ??
    unavailableDetail(runId, "Recorded detail was not supplied by the host.");
}

/**
 * Keep standalone tool-result drill-down while proving recorded mode never invokes its loader.
 */
export async function loadModelicaRunDetail(
  session: ModelicaRecordedViewSession | undefined,
  runId: string,
  standaloneLoader: () => Promise<ResultsEnvelope>,
): Promise<ModelicaRecordedRunDetailProjection> {
  if (session !== undefined) return resolveModelicaRecordedRunDetail(session, runId);
  const result = await standaloneLoader();
  if (result.kind !== "run") {
    throw new TypeError("The server returned a run list instead of one run.");
  }
  if (result.run.run_id !== runId) {
    throw new TypeError("The server returned a different Modelica run.");
  }
  return { run_id: runId, status: "available", result };
}

export function modelicaSessionResource(
  session: ModelicaRecordedViewSession,
): "run" | "run-list" {
  return session.anchor.kind === "modelica-run" ? "run" : "run-list";
}

function parseBasis(value: unknown): ModelicaRecordedViewSession["basis"] {
  if (!isExactRecord(value, ["projectId", "projectRevision", "subjectId", "thread"])) {
    throw new TypeError("Modelica recorded viewer session basis is invalid.");
  }
  if (!isExactRecord(value.thread, ["id", "revision"])) {
    throw new TypeError("Modelica recorded viewer session thread basis is invalid.");
  }
  return {
    projectId: requireNonEmpty(value.projectId, "basis.projectId"),
    projectRevision: requireRevision(value.projectRevision, "basis.projectRevision"),
    subjectId: requireNonEmpty(value.subjectId, "basis.subjectId"),
    thread: {
      id: requireNonEmpty(value.thread.id, "basis.thread.id"),
      revision: requireRevision(value.thread.revision, "basis.thread.revision"),
    },
  };
}

function parseAnchor(value: unknown): ModelicaRecordedViewSession["anchor"] {
  if (!isExactRecord(value, ["kind", "id"])) {
    throw new TypeError("Modelica recorded viewer session anchor is invalid.");
  }
  if (value.kind !== "modelica-run" && value.kind !== "modelica-run-list") {
    throw new TypeError("Modelica recorded viewer session anchor kind is invalid.");
  }
  return { kind: value.kind, id: requireNonEmpty(value.id, "anchor.id") };
}

function parseProvenance(value: unknown): ModelicaRecordedViewSession["provenance"] {
  if (!isExactRecord(value, ["recordedOperation", "recordedArtifacts", "projectionSha256"])) {
    throw new TypeError("Modelica recorded viewer session provenance is invalid.");
  }
  if (!MODELICA_RECORDED_OPERATIONS.includes(value.recordedOperation as never)) {
    throw new TypeError("Modelica recorded viewer session operation is not compatible.");
  }
  if (
    !isDenseJsonArray(value.recordedArtifacts) ||
    value.recordedArtifacts.length > MAX_RECORDED_RUN_DETAILS
  ) {
    throw new TypeError(
      `Modelica recorded viewer session provenance recordedArtifacts must be a dense JSON array with at most ${MAX_RECORDED_RUN_DETAILS} entries.`,
    );
  }
  const recordedArtifacts = value.recordedArtifacts.map(parseRecordedArtifactIdentity);
  const projectionSha256 = requireDigest(
    value.projectionSha256,
    "provenance.projectionSha256",
  );
  if (
    new Set(recordedArtifacts.map((artifact) => artifact.artifactId)).size !==
      recordedArtifacts.length
  ) {
    throw new TypeError("Modelica recorded viewer session artifact identities must be unique.");
  }
  return {
    recordedOperation: value.recordedOperation as ModelicaRecordedOperation,
    recordedArtifacts,
    projectionSha256,
  };
}

function parseRecordedArtifactIdentity(
  value: unknown,
): ModelicaRecordedViewSession["provenance"]["recordedArtifacts"][number] {
  if (!isExactRecord(value, ["artifactId", "runId", "runFingerprint"])) {
    throw new TypeError("Modelica recorded viewer session artifact identity is invalid.");
  }
  return {
    artifactId: requireNonEmpty(value.artifactId, "provenance.recordedArtifacts.artifactId"),
    runId: requireNonEmpty(value.runId, "provenance.recordedArtifacts.runId"),
    runFingerprint: requireDigest(
      value.runFingerprint,
      "provenance.recordedArtifacts.runFingerprint",
    ),
  };
}

function parseProjection(value: unknown): ModelicaRecordedViewProjection {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new TypeError("Modelica recorded viewer session projection is invalid.");
  }
  if (value.status === "available") {
    if (!hasExactKeys(value, ["status", "result", "details"])) {
      throw new TypeError("Available Modelica projection contains unsupported fields.");
    }
    const result = parseResultsEnvelope(value.result);
    if (!isDenseJsonArray(value.details) || value.details.length > MAX_RECORDED_RUN_DETAILS) {
      throw new TypeError(
        `Modelica recorded viewer session details must be a dense JSON array with at most ${MAX_RECORDED_RUN_DETAILS} entries.`,
      );
    }
    if (result.kind === "run-list" && result.runs.length > MAX_RECORDED_RUN_DETAILS) {
      throw new TypeError(
        `Modelica recorded viewer session run list must contain at most ${MAX_RECORDED_RUN_DETAILS} entries.`,
      );
    }
    if (
      result.kind === "run-list" &&
      new Set(result.runs.map((run) => run.run_id)).size !== result.runs.length
    ) {
      throw new TypeError("Modelica recorded viewer session run list contains duplicate run ids.");
    }
    const details = value.details.map(parseDetailProjection);
    if (new Set(details.map((detail) => detail.run_id)).size !== details.length) {
      throw new TypeError("Modelica recorded viewer session details contain duplicate run ids.");
    }
    assertDetailsMatchResult(details, result);
    return { status: "available", result, details };
  }
  return parseUnavailableProjection(value);
}

function parseDetailProjection(value: unknown): ModelicaRecordedRunDetailProjection {
  if (!isRecord(value) || typeof value.run_id !== "string" || !value.run_id.trim()) {
    throw new TypeError("Modelica recorded run detail projection must name a run_id.");
  }
  if (value.status === "available") {
    if (!hasExactKeys(value, ["run_id", "status", "result"])) {
      throw new TypeError("Available Modelica run detail contains unsupported fields.");
    }
    const result = parseResultsEnvelope(value.result);
    if (result.kind !== "run") {
      throw new TypeError("Available Modelica run detail must contain one run envelope.");
    }
    if (result.run.run_id !== value.run_id) {
      throw new TypeError("Available Modelica run detail does not match its run_id.");
    }
    return { run_id: value.run_id, status: "available", result };
  }
  const projection = parseUnavailableProjection(value, true);
  return "reason" in projection
    ? { run_id: value.run_id, status: projection.status, reason: projection.reason }
    : { run_id: value.run_id, status: projection.status };
}

function parseUnavailableProjection(value: Record<string, unknown>, withRunId = false) {
  const prefix = withRunId ? ["run_id"] : [];
  if (value.status === "pending" || value.status === "running") {
    if (!hasExactKeys(value, [...prefix, "status"])) {
      throw new TypeError(`Modelica ${value.status} projection contains unsupported fields.`);
    }
    return { status: value.status } as PendingProjection;
  }
  if (
    value.status === "rejected" || value.status === "recovery_required" ||
    value.status === "unavailable" || value.status === "unresolved"
  ) {
    if (!hasExactKeys(value, [...prefix, "status", "reason"])) {
      throw new TypeError(`Modelica ${value.status} projection contains unsupported fields.`);
    }
    return {
      status: value.status,
      reason: requireNonEmpty(value.reason, `projection.${value.status}.reason`),
    } as UnavailableProjection;
  }
  throw new TypeError("Modelica recorded viewer session projection status is invalid.");
}

function assertProjectionMatchesAnchor(
  projection: ModelicaRecordedViewProjection,
  anchor: ModelicaRecordedViewSession["anchor"],
): void {
  if (projection.status !== "available") return;
  const expectedKind = anchor.kind === "modelica-run" ? "run" : "run-list";
  if (projection.result.kind !== expectedKind) {
    throw new TypeError("Modelica recorded viewer session anchor does not match its projection.");
  }
  if (projection.result.kind === "run" && projection.result.run.run_id !== anchor.id) {
    throw new TypeError("Modelica recorded viewer session run anchor does not match its run id.");
  }
}

function assertDetailsMatchResult(
  details: readonly ModelicaRecordedRunDetailProjection[],
  result: ResultsEnvelope,
): void {
  if (result.kind === "run") {
    if (details.length !== 0) {
      throw new TypeError("A single-run Modelica session must not carry unrelated details.");
    }
    return;
  }
  const summaries = new Map(result.runs.map((run) => [run.run_id, run]));
  for (const detail of details) {
    const summary = summaries.get(detail.run_id);
    if (!summary) {
      throw new TypeError("Modelica recorded viewer session detail is absent from its run list.");
    }
    if (detail.status === "available") {
      if (detail.result.schemaVersion !== summary.record_schema_version) {
        throw new TypeError(
          "Modelica recorded viewer session detail contract differs from its summary.",
        );
      }
      if (!sameRunSummaryFacts(summary, detail.result.run)) {
        throw new TypeError(
          "Modelica recorded viewer session detail facts differ from its run-list summary.",
        );
      }
    }
  }
}

function sameRunSummaryFacts(
  summary: Extract<ResultsEnvelope, { kind: "run-list" }>["runs"][number],
  detail: Extract<ResultsEnvelope, { kind: "run" }>["run"],
): boolean {
  return summary.record_schema_version === detail.record_schema_version &&
    summary.run_id === detail.run_id && summary.status === detail.status &&
    summary.fingerprint === detail.fingerprint && summary.started_at === detail.started_at &&
    summary.completed_at === detail.completed_at && summary.model.id === detail.model.id &&
    summary.model.version === detail.model.version && summary.model.name === detail.model.name &&
    summary.model.source_sha256 === detail.model.source_sha256 &&
    summary.scenario.id === detail.scenario.id &&
    summary.scenario.source_sha256 === detail.scenario.source_sha256 &&
    summary.scenario.projection_sha256 === detail.scenario.projection_sha256;
}

function assertProvenanceMatchesProjection(
  provenance: ModelicaRecordedViewSession["provenance"],
  projection: ModelicaRecordedViewProjection,
): void {
  const projectedRuns = projection.status !== "available"
    ? []
    : projection.result.kind === "run"
    ? [projection.result.run]
    : projection.result.runs;
  if (provenance.recordedArtifacts.length !== projectedRuns.length) {
    throw new TypeError(
      "Modelica recorded viewer session must identify exactly one artifact per projected run.",
    );
  }
  const artifactsByRun = new Map(
    provenance.recordedArtifacts.map((artifact) => [artifact.runId, artifact]),
  );
  if (artifactsByRun.size !== provenance.recordedArtifacts.length) {
    throw new TypeError("Modelica recorded viewer session artifact run identities must be unique.");
  }
  for (const run of projectedRuns) {
    const artifact = artifactsByRun.get(run.run_id);
    if (!artifact || artifact.runFingerprint !== run.fingerprint) {
      throw new TypeError(
        "Modelica recorded viewer session artifact identity differs from its projected run.",
      );
    }
  }
}

/** Compute the App-owned fingerprint over a raw projection with recursively sorted object keys. */
export async function modelicaProjectionSha256(projection: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(projection));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Projection numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (!isDenseJsonArray(value)) {
      throw new TypeError("Modelica recorded projection must contain dense JSON arrays only.");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")
    }}`;
  }
  throw new TypeError("Modelica recorded projection must contain JSON values only.");
}

function unavailableDetail(runId: string, reason: string): ModelicaRecordedRunDetailProjection {
  return { run_id: runId, status: "unavailable", reason };
}

function requireRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative integer.`);
  }
  return value as number;
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireDigest(value: unknown, path: string): string {
  const digest = requireNonEmpty(value, path);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
