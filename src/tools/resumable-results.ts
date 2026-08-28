import type { StructuredToolResult } from "@casys/mcp-server";
import type {
  ResumableRequestResult,
  SealedResultSeriesResult,
  SimulationRequestTemplateResult,
} from "../application/resumable-simulation-service.ts";
import type { SimulationManifest } from "../domain/simulation-manifest.ts";

export const MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION = "2.1" as const;

type JsonSchema = Record<string, unknown>;

const digest: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const requestId: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
};
const runId: JsonSchema = {
  type: "string",
  pattern: "^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const quantity: JsonSchema = closed({
  value: { type: "number" },
  unit: { type: "string", minLength: 1 },
}, [
  "value",
  "unit",
]);
const conversion: JsonSchema = closed({
  from: { type: "string", minLength: 1 },
  to: { type: "string", minLength: 1 },
  factor: { type: "number" },
  offset: { type: "number" },
}, ["from", "to", "factor", "offset"]);
const resource: JsonSchema = closed({
  uri: { type: "string", minLength: 1 },
  mediaType: { type: "string", minLength: 1 },
  bytes: { type: "integer", minimum: 0 },
  sha256: digest,
  qualification: { enum: ["qualified-kit", "compiler-derived-verified"] },
}, ["uri", "mediaType", "bytes", "sha256", "qualification"]);
const publicScenario: JsonSchema = closed({
  id: { type: "string", minLength: 1 },
  description: { type: "string" },
  start_time_s: { type: "number" },
  stop_time_s: { type: "number" },
  number_of_intervals: { type: "integer", minimum: 1 },
  solver: { type: "string", minLength: 1 },
  target_temperature: quantity,
}, [
  "id",
  "description",
  "start_time_s",
  "stop_time_s",
  "number_of_intervals",
  "solver",
  "target_temperature",
]);
const manifestParameter: JsonSchema = closed({
  id: { type: "string", minLength: 1 },
  modelica_name: { type: "string", minLength: 1 },
  modelica_type: { type: "string", minLength: 1 },
  description: { type: "string" },
  unit: { type: "string", minLength: 1 },
  minimum: { type: "number" },
  maximum: { type: "number" },
  conversion,
}, [
  "id",
  "modelica_name",
  "modelica_type",
  "description",
  "unit",
  "minimum",
  "maximum",
  "conversion",
]);
const metric: JsonSchema = closed({
  id: { type: "string", minLength: 1 },
  unit: { type: "string", minLength: 1 },
  description: { type: "string" },
  required: { type: "boolean" },
}, ["id", "unit", "description", "required"]);
const identity: JsonSchema = closed({
  id: { type: "string", minLength: 1 },
  version: { type: "string", minLength: 1 },
}, [
  "id",
  "version",
]);
const engine: JsonSchema = closed({
  name: { type: "string", minLength: 1 },
  version: { type: "string", minLength: 1 },
  msl_version: { type: "string", minLength: 1 },
}, ["name", "version", "msl_version"]);

const manifest: JsonSchema = closed({
  schemaVersion: { const: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION },
  fingerprint: digest,
  manifest_sha256: digest,
  model: closed({
    id: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    source: resource,
  }, ["id", "version", "name", "source"]),
  scenario: closed({
    id: { type: "string", minLength: 1 },
    source: resource,
    public: publicScenario,
    projection_sha256: digest,
  }, ["id", "source", "public", "projection_sha256"]),
  parameter_schema: resource,
  parameters: { type: "array", items: manifestParameter },
  produced_metrics: { type: "array", items: metric },
  result_normalizer: identity,
  lowering: identity,
  engine,
}, [
  "schemaVersion",
  "fingerprint",
  "manifest_sha256",
  "model",
  "scenario",
  "parameters",
  "produced_metrics",
  "result_normalizer",
  "lowering",
  "engine",
], ["parameter_schema"]);

const artifactCommon: JsonSchema = {
  kind: {
    enum: [
      "request",
      "resolved_parameters",
      "model",
      "scenario",
      "parameter_schema",
      "script",
      "diagnostics",
      "result",
      "evidence",
    ],
  },
  file_name: { type: "string", minLength: 1 },
  run_id: runId,
  uri: { type: "string", minLength: 1 },
  mediaType: { type: "string", minLength: 1 },
  sha256: digest,
  bytes: { type: "integer", minimum: 0 },
  qualification: { enum: ["qualified-kit", "compiler-derived-verified"] },
  source_resource: resource,
};
const requestArtifact: JsonSchema = closed({
  kind: { const: "request" },
  file_name: { const: "request.json" },
  uri: { type: "string", minLength: 1 },
  mediaType: { const: "application/json" },
  sha256: digest,
  bytes: { type: "integer", minimum: 0 },
}, ["kind", "file_name", "uri", "mediaType", "sha256", "bytes"]);
const runArtifact: JsonSchema = closed({ ...artifactCommon }, [
  "kind",
  "file_name",
  "run_id",
  "uri",
  "mediaType",
  "sha256",
  "bytes",
], ["qualification", "source_resource"]);
const runJson: JsonSchema = closed({
  uri: { type: "string", minLength: 1 },
  mediaType: { const: "application/json" },
  sha256: digest,
  bytes: { type: "integer", minimum: 0 },
}, [
  "uri",
  "mediaType",
  "sha256",
  "bytes",
]);
const run: JsonSchema = closed({
  schemaVersion: { const: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION },
  kind: { const: "simulation-run" },
  request_id: { type: "string", minLength: 1 },
  request_sha256: digest,
  manifest,
  run_id: runId,
  status: { enum: ["succeeded", "failed", "timed_out"] },
  started_at: { type: "string" },
  completed_at: { type: "string" },
  resolved_parameters: { type: "object", additionalProperties: quantity },
  metrics: { type: "object", additionalProperties: quantity },
  artifacts: { type: "array", items: { oneOf: [requestArtifact, runArtifact] } },
  warnings: { type: "array", items: { type: "string" } },
  run_json: runJson,
}, [
  "schemaVersion",
  "kind",
  "request_id",
  "request_sha256",
  "manifest",
  "run_id",
  "status",
  "started_at",
  "completed_at",
  "resolved_parameters",
  "metrics",
  "artifacts",
  "warnings",
  "run_json",
]);

const requestBase: JsonSchema = {
  request_id: { type: "string", minLength: 1 },
  request_sha256: digest,
  manifest_sha256: digest,
  status: { enum: ["pending", "running", "completed", "rejected", "recovery_required"] },
};
const submit: JsonSchema = closed({
  request_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
  manifest_sha256: digest,
  model_id: { type: "string", minLength: 1 },
  model_version: { type: "string", minLength: 1 },
  scenario_id: { type: "string", minLength: 1 },
  parameters: { type: "object", additionalProperties: quantity },
  timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
}, [
  "request_id",
  "manifest_sha256",
  "model_id",
  "model_version",
  "scenario_id",
  "parameters",
  "timeout_ms",
]);
const resultArtifact: JsonSchema = closed({
  uri: {
    type: "string",
    pattern: "^casys://modelica/requests/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/artifacts/result\\.csv$",
  },
  mediaType: { const: "text/csv" },
  sha256: digest,
  bytes: { type: "integer", minimum: 1 },
}, ["uri", "mediaType", "sha256", "bytes"]);
const seriesColumn: JsonSchema = closed({
  name: { type: "string", minLength: 1 },
  minimum: { type: "number" },
  maximum: { type: "number" },
  final: { type: "number" },
}, ["name", "minimum", "maximum", "final"]);
const seriesSample: JsonSchema = closed({
  row_index: { type: "integer", minimum: 0 },
  values: { type: "object", additionalProperties: { type: "number" } },
}, ["row_index", "values"]);
const seriesSampling: JsonSchema = closed({
  strategy: { const: "evenly-spaced-including-endpoints" },
  requested_max_samples: { type: "integer", minimum: 1, maximum: 128 },
  returned_samples: { type: "integer", minimum: 1, maximum: 128 },
}, ["strategy", "requested_max_samples", "returned_samples"]);
const sealedSeries: JsonSchema = closed({
  row_count: { type: "integer", minimum: 1 },
  columns: { type: "array", minItems: 1, maxItems: 128, items: seriesColumn },
  sampling: seriesSampling,
  samples: { type: "array", minItems: 1, maxItems: 128, items: seriesSample },
}, ["row_count", "columns", "sampling", "samples"]);
const pendingRequest: JsonSchema = closed({ ...requestBase, status: { const: "pending" } }, [
  "request_id",
  "request_sha256",
  "manifest_sha256",
  "status",
]);
const runningRequest: JsonSchema = closed({ ...requestBase, status: { const: "running" } }, [
  "request_id",
  "request_sha256",
  "manifest_sha256",
  "status",
]);
const recoveryRequest: JsonSchema = closed({
  ...requestBase,
  status: { const: "recovery_required" },
  recovery: { type: "string", minLength: 1 },
}, [
  "request_id",
  "request_sha256",
  "manifest_sha256",
  "status",
  "recovery",
]);
const completedRequest: JsonSchema = closed(
  { ...requestBase, status: { const: "completed" }, run },
  [
    "request_id",
    "request_sha256",
    "manifest_sha256",
    "status",
    "run",
  ],
);
const rejectedRequest: JsonSchema = closed({
  ...requestBase,
  status: { const: "rejected" },
  rejection: { const: "manifest_mismatch" },
}, [
  "request_id",
  "request_sha256",
  "manifest_sha256",
  "status",
  "rejection",
]);

export const simulationManifestOutputSchema: JsonSchema = closed({
  schemaVersion: { const: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION },
  kind: { const: "simulation-manifest" },
  manifest,
}, ["schemaVersion", "kind", "manifest"]);

export const simulationRequestOutputSchema: JsonSchema = closed({
  schemaVersion: { const: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION },
  kind: { const: "simulation-request" },
  request: {
    oneOf: [pendingRequest, runningRequest, completedRequest, rejectedRequest, recoveryRequest],
  },
}, ["schemaVersion", "kind", "request"]);

export const simulationRequestTemplateOutputSchema: JsonSchema = closed({
  schemaVersion: { const: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION },
  kind: { const: "simulation-request-template" },
  submit,
  request_sha256: digest,
}, ["schemaVersion", "kind", "submit", "request_sha256"]);

export const sealedResultSeriesOutputSchema: JsonSchema = closed({
  schemaVersion: { const: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION },
  kind: { const: "sealed-result-series" },
  request_id: requestId,
  result: resultArtifact,
  series: sealedSeries,
}, ["schemaVersion", "kind", "request_id", "result", "series"]);

export function toSimulationManifestResult(
  manifestValue: SimulationManifest,
): StructuredToolResult {
  return {
    content:
      `Qualified simulation manifest ${manifestValue.manifest_sha256} for ${manifestValue.model.id}@${manifestValue.model.version}.`,
    structuredContent: {
      schemaVersion: MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION,
      kind: "simulation-manifest",
      manifest: manifestValue,
    },
  };
}

export function toSimulationRequestResult(result: ResumableRequestResult): StructuredToolResult {
  const request = result.request as { request_id: string; status: string };
  return {
    content: `Simulation request ${request.request_id}: ${request.status}.`,
    structuredContent: result,
  };
}

export function toSimulationRequestTemplateResult(
  result: SimulationRequestTemplateResult,
): StructuredToolResult {
  return {
    content:
      `Prepared a non-executing simulation submission template for ${result.submit.request_id}.`,
    structuredContent: result,
  };
}

export function toSealedResultSeriesResult(result: SealedResultSeriesResult): StructuredToolResult {
  return {
    content:
      `Read ${result.series.row_count} rows from the sealed result series for ${result.request_id}; ` +
      `${result.series.sampling.returned_samples} deterministic samples returned.`,
    structuredContent: result,
  };
}

function closed(
  properties: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: required.filter((field) => !optional.includes(field)),
  };
}
