export type RunStatus = "succeeded" | "failed" | "timed_out";

export interface Quantity {
  value: number;
  unit: string;
}

export interface RunSummary {
  status: RunStatus;
  run_id: string;
  started_at?: string;
  completed_at?: string;
  fingerprint: string;
  model: { id: string; version: string; sha256: string };
  scenario: { id: string; sha256: string };
}

export interface SimulationRun extends RunSummary {
  engine: { name: string; version: string; msl_version: string };
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
  | { schemaVersion: "1.0"; kind: "run"; run: SimulationRun }
  | { schemaVersion: "1.0"; kind: "run-list"; runs: RunSummary[] };

export type DisplayState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | ResultsEnvelope;

export function parseResultsEnvelope(value: unknown): ResultsEnvelope {
  if (!isRecord(value) || value.schemaVersion !== "1.0") {
    throw new TypeError("Expected a Modelica results envelope with schemaVersion 1.0.");
  }
  if (value.kind === "run" && isSimulationRun(value.run)) {
    return { schemaVersion: "1.0", kind: "run", run: value.run };
  }
  if (value.kind === "run-list" && Array.isArray(value.runs) && value.runs.every(isRunSummary)) {
    return { schemaVersion: "1.0", kind: "run-list", runs: value.runs };
  }
  throw new TypeError("Expected a Modelica run or run-list envelope.");
}

export function errorMessage(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "The Modelica tool reported an error.";
  }
  const text = value.content.find((item) => isRecord(item) && item.type === "text")?.text;
  return typeof text === "string" && text.trim() ? text : "The Modelica tool reported an error.";
}

function isSimulationRun(value: unknown): value is SimulationRun {
  if (!isRunSummary(value) || !isRecord(value)) return false;
  return isEngine(value.engine) &&
    isQuantityMap(value.resolved_parameters) &&
    isQuantityMap(value.metrics) &&
    Array.isArray(value.artifacts) && value.artifacts.every(isArtifact) &&
    Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string");
}

function isRunSummary(value: unknown): value is RunSummary {
  if (!isRecord(value)) return false;
  return isRunStatus(value.status) &&
    typeof value.run_id === "string" &&
    optionalString(value.started_at) &&
    optionalString(value.completed_at) &&
    typeof value.fingerprint === "string" &&
    isModel(value.model) &&
    isScenario(value.scenario);
}

function isModel(value: unknown): value is RunSummary["model"] {
  return isRecord(value) && typeof value.id === "string" && typeof value.version === "string" &&
    typeof value.sha256 === "string";
}

function isScenario(value: unknown): value is RunSummary["scenario"] {
  return isRecord(value) && typeof value.id === "string" && typeof value.sha256 === "string";
}

function isEngine(value: unknown): value is SimulationRun["engine"] {
  return isRecord(value) && typeof value.name === "string" && typeof value.version === "string" &&
    typeof value.msl_version === "string";
}

function isQuantityMap(value: unknown): value is Record<string, Quantity> {
  return isRecord(value) && Object.values(value).every(isQuantity);
}

function isQuantity(value: unknown): value is Quantity {
  return isRecord(value) && typeof value.value === "number" && Number.isFinite(value.value) &&
    typeof value.unit === "string";
}

function isArtifact(value: unknown): value is SimulationRun["artifacts"][number] {
  return isRecord(value) &&
    ["request", "resolved_parameters", "model", "script", "diagnostics", "result", "evidence"]
      .includes(value.kind as string) &&
    typeof value.uri === "string" && typeof value.sha256 === "string" &&
    typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "succeeded" || value === "failed" || value === "timed_out";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
