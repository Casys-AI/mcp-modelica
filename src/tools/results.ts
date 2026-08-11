import type { StructuredToolResult } from "@casys/mcp-server";
import type {
  LegacyModelicaRunSummary,
  LegacyPublicKit,
  LegacySimulationRun,
  ModelicaRunSummary,
  PublicKit,
  SimulationRun,
} from "../domain/types.ts";

export const MODELICA_RESULTS_VIEWER_URI = "ui://mcp-modelica/results-viewer";
export const MODELICA_RUN_LIST_VIEWER_URI = "ui://mcp-modelica/run-list-viewer";
export const MODELICA_RESULTS_SCHEMA_VERSION = "1.0" as const;
export const MODELICA_RECORDED_RESULTS_SCHEMA_VERSION = "2.0" as const;

/** Stable structured content consumed by the Modelica results MCP App. */
export interface ModelicaRunResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RESULTS_SCHEMA_VERSION;
  kind: "run";
  run: LegacySimulationRun;
}

/** Stable structured content for the bounded, deterministic run index. */
export interface ModelicaRunListResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RESULTS_SCHEMA_VERSION;
  kind: "run-list";
  runs: LegacyModelicaRunSummary[];
}

/**
 * Stable structured content for the approved kit catalogue.
 *
 * WHY AN ENVELOPE — every other tool of this server answers with
 * `{schemaVersion, kind, ...}` structured content. A bare array carried only in
 * the text content forced each caller to re-parse prose and gave conformant MCP
 * clients nothing to bind to; the catalogue now follows the same shape as its
 * siblings.
 */
export interface ModelicaKitListResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RESULTS_SCHEMA_VERSION;
  kind: "kit-list";
  kits: LegacyPublicKit[];
}

export type ModelicaResultsEnvelope =
  | ModelicaRunResultEnvelope
  | ModelicaRunListResultEnvelope
  | ModelicaKitListResultEnvelope;

export interface ModelicaRecordedRunResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RECORDED_RESULTS_SCHEMA_VERSION;
  kind: "run";
  run: SimulationRun;
}

export interface ModelicaRecordedRunListResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RECORDED_RESULTS_SCHEMA_VERSION;
  kind: "run-list";
  runs: ModelicaRunSummary[];
}

export interface ModelicaRecordedKitListResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RECORDED_RESULTS_SCHEMA_VERSION;
  kind: "kit-list";
  kits: PublicKit[];
}

export type ModelicaRecordedResultsEnvelope =
  | ModelicaRecordedRunResultEnvelope
  | ModelicaRecordedRunListResultEnvelope
  | ModelicaRecordedKitListResultEnvelope;

const quantitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "number" },
    unit: { type: "string" },
  },
  required: ["value", "unit"],
};

const recordedArtifactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
    uri: { type: "string" },
    sha256: { type: "string" },
    bytes: { type: "integer", minimum: 0 },
    qualification: { enum: ["qualified-kit", "compiler-derived-verified"] },
  },
  required: ["kind", "uri", "sha256", "bytes"],
};

const recordedRunSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    record_schema_version: { const: "2.0" },
    status: { enum: ["succeeded", "failed", "timed_out"] },
    run_id: { type: "string" },
    started_at: { type: "string" },
    completed_at: { type: "string" },
    fingerprint: { type: "string" },
    model: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        version: { type: "string" },
        name: { type: "string" },
        source_sha256: { type: "string" },
      },
      required: ["id", "version", "name", "source_sha256"],
    },
    scenario: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        source_sha256: { type: "string" },
        projection_sha256: { type: "string" },
      },
      required: ["id", "source_sha256", "projection_sha256"],
    },
    parameter_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_sha256: { type: "string" },
        model_source_sha256: { type: "string" },
        qualification: { const: "compiler-derived-verified" },
      },
      required: ["source_sha256", "model_source_sha256", "qualification"],
    },
    result_normalizer: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        version: { type: "string" },
      },
      required: ["id", "version"],
    },
    engine: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        msl_version: { type: "string" },
      },
      required: ["name", "version", "msl_version"],
    },
    resolved_parameters: {
      type: "object",
      additionalProperties: quantitySchema,
    },
    metrics: {
      type: "object",
      additionalProperties: quantitySchema,
    },
    artifacts: { type: "array", items: recordedArtifactSchema },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "status",
    "record_schema_version",
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
  ],
};

const recordedRunSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    record_schema_version: { const: "2.0" },
    status: { enum: ["succeeded", "failed", "timed_out"] },
    run_id: { type: "string" },
    started_at: { type: "string" },
    completed_at: { type: "string" },
    fingerprint: { type: "string" },
    model: recordedRunSchema.properties.model,
    scenario: recordedRunSchema.properties.scenario,
  },
  required: [
    "record_schema_version",
    "status",
    "run_id",
    "started_at",
    "completed_at",
    "fingerprint",
    "model",
    "scenario",
  ],
};

// Frozen 1.0 schemas. Keep these shapes byte-for-byte compatible with the
// original public tools; richer provenance belongs only to recorded tools.
const legacyArtifactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      enum: [
        "request",
        "resolved_parameters",
        "model",
        "script",
        "diagnostics",
        "result",
        "evidence",
      ],
    },
    uri: { type: "string" },
    sha256: { type: "string" },
    bytes: { type: "integer", minimum: 0 },
  },
  required: ["kind", "uri", "sha256", "bytes"],
};

const legacyRunSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["succeeded", "failed", "timed_out"] },
    run_id: { type: "string" },
    started_at: { type: "string" },
    completed_at: { type: "string" },
    fingerprint: { type: "string" },
    model: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        version: { type: "string" },
        sha256: { type: "string" },
      },
      required: ["id", "version", "sha256"],
    },
    scenario: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        sha256: { type: "string" },
      },
      required: ["id", "sha256"],
    },
    engine: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        msl_version: { type: "string" },
      },
      required: ["name", "version", "msl_version"],
    },
    resolved_parameters: {
      type: "object",
      additionalProperties: quantitySchema,
    },
    metrics: {
      type: "object",
      additionalProperties: quantitySchema,
    },
    artifacts: { type: "array", items: legacyArtifactSchema },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
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
  ],
};

const legacyRunSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["succeeded", "failed", "timed_out"] },
    run_id: { type: "string" },
    started_at: { type: "string" },
    completed_at: { type: "string" },
    fingerprint: { type: "string" },
    model: legacyRunSchema.properties.model,
    scenario: legacyRunSchema.properties.scenario,
  },
  required: ["status", "run_id", "fingerprint", "model", "scenario"],
};

const publicParameterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    unit: { type: "string" },
    default: quantitySchema,
    minimum: { type: "number" },
    maximum: { type: "number" },
  },
  required: ["id", "description", "unit", "default", "minimum", "maximum"],
};

const publicScenarioSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    stop_time_s: { type: "number" },
    number_of_intervals: { type: "integer" },
    solver: { type: "string" },
    target_temperature: quantitySchema,
  },
  required: [
    "id",
    "description",
    "stop_time_s",
    "number_of_intervals",
    "solver",
    "target_temperature",
  ],
};

const publicKitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    version: { type: "string" },
    description: { type: "string" },
    parameters: { type: "array", items: publicParameterSchema },
    scenarios: { type: "array", items: publicScenarioSchema },
    produced_metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          unit: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "unit", "description"],
      },
    },
  },
  required: [
    "id",
    "version",
    "description",
    "parameters",
    "scenarios",
    "produced_metrics",
  ],
};

const recordedPublicKitSchema = {
  ...publicKitSchema,
  properties: {
    ...publicKitSchema.properties,
    produced_metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          unit: { type: "string" },
          description: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["id", "unit", "description", "required"],
      },
    },
  },
};

export const kitListOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RESULTS_SCHEMA_VERSION },
    kind: { const: "kit-list" },
    kits: { type: "array", items: publicKitSchema },
  },
  required: ["schemaVersion", "kind", "kits"],
};

export const runOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RESULTS_SCHEMA_VERSION },
    kind: { const: "run" },
    run: legacyRunSchema,
  },
  required: ["schemaVersion", "kind", "run"],
};

export const runListOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RESULTS_SCHEMA_VERSION },
    kind: { const: "run-list" },
    runs: { type: "array", items: legacyRunSummarySchema },
  },
  required: ["schemaVersion", "kind", "runs"],
};

export const recordedKitListOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RECORDED_RESULTS_SCHEMA_VERSION },
    kind: { const: "kit-list" },
    kits: { type: "array", items: recordedPublicKitSchema },
  },
  required: ["schemaVersion", "kind", "kits"],
};

export const recordedRunOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RECORDED_RESULTS_SCHEMA_VERSION },
    kind: { const: "run" },
    run: recordedRunSchema,
  },
  required: ["schemaVersion", "kind", "run"],
};

export const recordedRunListOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RECORDED_RESULTS_SCHEMA_VERSION },
    kind: { const: "run-list" },
    runs: { type: "array", items: recordedRunSummarySchema },
  },
  required: ["schemaVersion", "kind", "runs"],
};

export function toRunResult(run: LegacySimulationRun): StructuredToolResult {
  const structuredContent: ModelicaRunResultEnvelope = {
    schemaVersion: MODELICA_RESULTS_SCHEMA_VERSION,
    kind: "run",
    run,
  };
  return {
    content: `Persisted simulation run ${run.run_id}: ${run.status}; ${
      Object.keys(run.metrics).length
    } metrics and ${run.artifacts.length} artifacts.`,
    structuredContent,
  };
}

export function toKitListResult(kits: LegacyPublicKit[]): StructuredToolResult {
  const structuredContent: ModelicaKitListResultEnvelope = {
    schemaVersion: MODELICA_RESULTS_SCHEMA_VERSION,
    kind: "kit-list",
    kits,
  };
  return {
    content: `Found ${kits.length} approved Modelica kit${kits.length === 1 ? "" : "s"}.`,
    structuredContent,
  };
}

export function toRunListResult(runs: LegacyModelicaRunSummary[]): StructuredToolResult {
  const structuredContent: ModelicaRunListResultEnvelope = {
    schemaVersion: MODELICA_RESULTS_SCHEMA_VERSION,
    kind: "run-list",
    runs,
  };
  return {
    content: `Found ${runs.length} persisted simulation run${runs.length === 1 ? "" : "s"}.`,
    structuredContent,
  };
}

export function toRecordedRunResult(run: SimulationRun): StructuredToolResult {
  const structuredContent: ModelicaRecordedRunResultEnvelope = {
    schemaVersion: MODELICA_RECORDED_RESULTS_SCHEMA_VERSION,
    kind: "run",
    run,
  };
  return {
    content: `Persisted recorded simulation run ${run.run_id}: ${run.status}; ${
      Object.keys(run.metrics).length
    } metrics and ${run.artifacts.length} artifacts.`,
    structuredContent,
  };
}

export function toRecordedKitListResult(kits: PublicKit[]): StructuredToolResult {
  const structuredContent: ModelicaRecordedKitListResultEnvelope = {
    schemaVersion: MODELICA_RECORDED_RESULTS_SCHEMA_VERSION,
    kind: "kit-list",
    kits,
  };
  return {
    content: `Found ${kits.length} approved recorded Modelica kit${kits.length === 1 ? "" : "s"}.`,
    structuredContent,
  };
}

export function toRecordedRunListResult(runs: ModelicaRunSummary[]): StructuredToolResult {
  const structuredContent: ModelicaRecordedRunListResultEnvelope = {
    schemaVersion: MODELICA_RECORDED_RESULTS_SCHEMA_VERSION,
    kind: "run-list",
    runs,
  };
  return {
    content: `Found ${runs.length} persisted recorded simulation run${
      runs.length === 1 ? "" : "s"
    }.`,
    structuredContent,
  };
}
