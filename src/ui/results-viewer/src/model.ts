import { isDenseJsonArray } from "./strict-json.ts";

export type RunStatus = "succeeded" | "failed" | "timed_out";

export interface Quantity {
  value: number;
  unit: string;
}

/** Normalized viewer model; legacy absences stay explicitly absent. */
export interface RunSummary {
  record_schema_version: "1.0" | "2.0";
  status: RunStatus;
  run_id: string;
  started_at?: string;
  completed_at?: string;
  fingerprint: string;
  model: { id: string; version: string; name?: string; source_sha256: string };
  scenario: { id: string; source_sha256?: string; projection_sha256: string };
}

export interface SimulationRun extends RunSummary {
  parameter_schema?: {
    source_sha256: string;
    model_source_sha256: string;
    qualification: "compiler-derived-verified";
  };
  result_normalizer?: { id: string; version: string };
  engine: { name: string; version: string; msl_version: string };
  resolved_parameters: Record<string, Quantity>;
  metrics: Record<string, Quantity>;
  artifacts: Array<{
    kind:
      | "request"
      | "resolved_parameters"
      | "model"
      | "scenario"
      | "parameter_schema"
      | "script"
      | "diagnostics"
      | "result"
      | "evidence";
    uri: string;
    sha256: string;
    bytes: number;
    qualification?: "qualified-kit" | "compiler-derived-verified";
  }>;
  warnings: string[];
}

interface LegacyRunSummary {
  status: RunStatus;
  run_id: string;
  started_at?: string;
  completed_at?: string;
  fingerprint: string;
  model: { id: string; version: string; sha256: string };
  scenario: { id: string; sha256: string };
}

interface LegacySimulationRun extends LegacyRunSummary {
  engine: SimulationRun["engine"];
  resolved_parameters: Record<string, Quantity>;
  metrics: Record<string, Quantity>;
  artifacts: Array<{
    kind:
      | "request"
      | "resolved_parameters"
      | "model"
      | "script"
      | "diagnostics"
      | "result"
      | "evidence";
    uri: string;
    sha256: string;
    bytes: number;
  }>;
  warnings: string[];
}

export type ResultsEnvelope =
  | { schemaVersion: "1.0" | "2.0"; kind: "run"; run: SimulationRun }
  | { schemaVersion: "1.0" | "2.0"; kind: "run-list"; runs: RunSummary[] };

export type DisplayState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | {
    kind: "recorded-status";
    status:
      | "pending"
      | "running"
      | "rejected"
      | "recovery_required"
      | "unavailable"
      | "unresolved";
    message: string;
  }
  | ResultsEnvelope;

export function parseResultsEnvelope(value: unknown): ResultsEnvelope {
  if (!isRecord(value) || (value.schemaVersion !== "1.0" && value.schemaVersion !== "2.0")) {
    throw new TypeError("Expected a Modelica results envelope with schemaVersion 1.0 or 2.0.");
  }
  if (value.schemaVersion === "2.0") {
    if (
      value.kind === "run" && hasExactKeys(value, ["schemaVersion", "kind", "run"]) &&
      isRecordedSimulationRun(value.run)
    ) {
      return { schemaVersion: "2.0", kind: "run", run: value.run };
    }
    if (
      value.kind === "run-list" && hasExactKeys(value, ["schemaVersion", "kind", "runs"]) &&
      isDenseJsonArray(value.runs) &&
      value.runs.every(isRecordedRunSummary)
    ) {
      return { schemaVersion: "2.0", kind: "run-list", runs: value.runs };
    }
  } else {
    if (
      value.kind === "run" && hasExactKeys(value, ["schemaVersion", "kind", "run"]) &&
      isLegacySimulationRun(value.run)
    ) {
      return { schemaVersion: "1.0", kind: "run", run: normalizeLegacyRun(value.run) };
    }
    if (
      value.kind === "run-list" && hasExactKeys(value, ["schemaVersion", "kind", "runs"]) &&
      isDenseJsonArray(value.runs) &&
      value.runs.every(isLegacyRunSummary)
    ) {
      return {
        schemaVersion: "1.0",
        kind: "run-list",
        runs: value.runs.map(normalizeLegacySummary),
      };
    }
  }
  throw new TypeError("Expected a Modelica run or run-list envelope.");
}

export function errorMessage(value: unknown): string {
  if (!isRecord(value) || !isDenseJsonArray(value.content)) {
    return "The Modelica tool reported an error.";
  }
  const content = value.content.find((item) => isRecord(item) && item.type === "text");
  const text = isRecord(content) ? content.text : undefined;
  return typeof text === "string" && text.trim() ? text : "The Modelica tool reported an error.";
}

function normalizeLegacySummary(run: LegacyRunSummary): RunSummary {
  return {
    record_schema_version: "1.0",
    status: run.status,
    run_id: run.run_id,
    ...(run.started_at === undefined ? {} : { started_at: run.started_at }),
    ...(run.completed_at === undefined ? {} : { completed_at: run.completed_at }),
    fingerprint: run.fingerprint,
    model: {
      id: run.model.id,
      version: run.model.version,
      source_sha256: run.model.sha256,
    },
    scenario: {
      id: run.scenario.id,
      projection_sha256: run.scenario.sha256,
    },
  };
}

function normalizeLegacyRun(run: LegacySimulationRun): SimulationRun {
  return {
    ...normalizeLegacySummary(run),
    engine: run.engine,
    resolved_parameters: run.resolved_parameters,
    metrics: run.metrics,
    artifacts: run.artifacts,
    warnings: run.warnings,
  };
}

function isRecordedSimulationRun(value: unknown): value is SimulationRun {
  if (
    !isRecord(value) || !hasExactKeys(value, [
      "record_schema_version",
      "status",
      "run_id",
      "started_at",
      "completed_at",
      "fingerprint",
      "model",
      "scenario",
      "result_normalizer",
      "engine",
      "resolved_parameters",
      "metrics",
      "artifacts",
      "warnings",
    ], ["parameter_schema"])
  ) return false;
  return isRecordedRunSummaryFields(value) && isEngine(value.engine) &&
    isResultNormalizer(value.result_normalizer) &&
    (value.parameter_schema === undefined || isParameterSchema(value.parameter_schema)) &&
    isQuantityMap(value.resolved_parameters) && isQuantityMap(value.metrics) &&
    isDenseJsonArray(value.artifacts) && value.artifacts.every(isRecordedArtifact) &&
    isDenseJsonArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string");
}

function isRecordedRunSummary(
  value: unknown,
): value is RunSummary & { record_schema_version: "2.0" } {
  if (
    !isRecord(value) || !hasExactKeys(value, [
      "record_schema_version",
      "status",
      "run_id",
      "started_at",
      "completed_at",
      "fingerprint",
      "model",
      "scenario",
    ])
  ) return false;
  return isRecordedRunSummaryFields(value);
}

function isRecordedRunSummaryFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RunSummary & { record_schema_version: "2.0" } {
  return isRunStatus(value.status) && value.record_schema_version === "2.0" &&
    typeof value.run_id === "string" && typeof value.started_at === "string" &&
    typeof value.completed_at === "string" && typeof value.fingerprint === "string" &&
    isRecordedModel(value.model) && isRecordedScenario(value.scenario);
}

function isLegacySimulationRun(value: unknown): value is LegacySimulationRun {
  if (
    !isRecord(value) || !hasExactKeys(value, [
      "status",
      "run_id",
      "fingerprint",
      "model",
      "scenario",
      "engine",
      "resolved_parameters",
      "metrics",
      "artifacts",
      "warnings",
    ], ["started_at", "completed_at"])
  ) return false;
  return isLegacyRunSummaryFields(value) && isEngine(value.engine) &&
    isQuantityMap(value.resolved_parameters) &&
    isQuantityMap(value.metrics) && isDenseJsonArray(value.artifacts) &&
    value.artifacts.every(isLegacyArtifact) && isDenseJsonArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string");
}

function isLegacyRunSummary(value: unknown): value is LegacyRunSummary {
  if (
    !isRecord(value) || !hasExactKeys(value, [
      "status",
      "run_id",
      "fingerprint",
      "model",
      "scenario",
    ], ["started_at", "completed_at"])
  ) return false;
  return isLegacyRunSummaryFields(value);
}

function isLegacyRunSummaryFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & LegacyRunSummary {
  return isRunStatus(value.status) && typeof value.run_id === "string" &&
    (value.started_at === undefined || typeof value.started_at === "string") &&
    (value.completed_at === undefined || typeof value.completed_at === "string") &&
    typeof value.fingerprint === "string" && isLegacyModel(value.model) &&
    isLegacyScenario(value.scenario);
}

function isRecordedModel(value: unknown): value is RunSummary["model"] {
  return isRecord(value) && hasExactKeys(value, ["id", "version", "name", "source_sha256"]) &&
    typeof value.id === "string" && typeof value.version === "string" &&
    typeof value.name === "string" && typeof value.source_sha256 === "string";
}

function isLegacyModel(value: unknown): value is LegacyRunSummary["model"] {
  return isRecord(value) && hasExactKeys(value, ["id", "version", "sha256"]) &&
    typeof value.id === "string" && typeof value.version === "string" &&
    typeof value.sha256 === "string";
}

function isRecordedScenario(value: unknown): value is RunSummary["scenario"] {
  return isRecord(value) &&
    hasExactKeys(value, ["id", "source_sha256", "projection_sha256"]) &&
    typeof value.id === "string" &&
    typeof value.source_sha256 === "string" && typeof value.projection_sha256 === "string";
}

function isLegacyScenario(value: unknown): value is LegacyRunSummary["scenario"] {
  return isRecord(value) && hasExactKeys(value, ["id", "sha256"]) &&
    typeof value.id === "string" && typeof value.sha256 === "string";
}

function isEngine(value: unknown): value is SimulationRun["engine"] {
  return isRecord(value) && hasExactKeys(value, ["name", "version", "msl_version"]) &&
    typeof value.name === "string" && typeof value.version === "string" &&
    typeof value.msl_version === "string";
}

function isParameterSchema(
  value: unknown,
): value is NonNullable<SimulationRun["parameter_schema"]> {
  return isRecord(value) &&
    hasExactKeys(value, ["source_sha256", "model_source_sha256", "qualification"]) &&
    typeof value.source_sha256 === "string" &&
    typeof value.model_source_sha256 === "string" &&
    value.qualification === "compiler-derived-verified";
}

function isResultNormalizer(
  value: unknown,
): value is NonNullable<SimulationRun["result_normalizer"]> {
  return isRecord(value) && hasExactKeys(value, ["id", "version"]) &&
    typeof value.id === "string" && typeof value.version === "string";
}

function isQuantityMap(value: unknown): value is Record<string, Quantity> {
  return isRecord(value) && Object.values(value).every(isQuantity);
}

function isQuantity(value: unknown): value is Quantity {
  return isRecord(value) && hasExactKeys(value, ["value", "unit"]) &&
    typeof value.value === "number" && Number.isFinite(value.value) &&
    typeof value.unit === "string";
}

const LEGACY_ARTIFACT_KINDS = [
  "request",
  "resolved_parameters",
  "model",
  "script",
  "diagnostics",
  "result",
  "evidence",
] as const;

function isLegacyArtifact(value: unknown): value is LegacySimulationRun["artifacts"][number] {
  return isArtifactBase(value) && hasExactKeys(value, ["kind", "uri", "sha256", "bytes"]) &&
    LEGACY_ARTIFACT_KINDS.includes(
      value.kind as (typeof LEGACY_ARTIFACT_KINDS)[number],
    );
}

function isRecordedArtifact(value: unknown): value is SimulationRun["artifacts"][number] {
  return isArtifactBase(value) &&
    hasExactKeys(value, ["kind", "uri", "sha256", "bytes"], ["qualification"]) &&
    [...LEGACY_ARTIFACT_KINDS, "scenario", "parameter_schema"].includes(value.kind as never) &&
    (value.qualification === undefined || value.qualification === "qualified-kit" ||
      value.qualification === "compiler-derived-verified");
}

function isArtifactBase(value: unknown): value is Record<string, unknown> & {
  kind: string;
  uri: string;
  sha256: string;
  bytes: number;
} {
  return isRecord(value) && typeof value.kind === "string" && typeof value.uri === "string" &&
    typeof value.sha256 === "string" && typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "succeeded" || value === "failed" || value === "timed_out";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key));
}
