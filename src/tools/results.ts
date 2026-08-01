import type { StructuredToolResult } from "@casys/mcp-server";
import type { ModelicaRunSummary, SimulationRun } from "../domain/types.ts";

export const MODELICA_RESULTS_VIEWER_URI = "ui://mcp-modelica/results-viewer";
export const MODELICA_RUN_LIST_VIEWER_URI = "ui://mcp-modelica/run-list-viewer";
export const MODELICA_RESULTS_SCHEMA_VERSION = "1.0" as const;

/** Stable structured content consumed by the Modelica results MCP App. */
export interface ModelicaRunResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RESULTS_SCHEMA_VERSION;
  kind: "run";
  run: SimulationRun;
}

/** Stable structured content for the bounded, deterministic run index. */
export interface ModelicaRunListResultEnvelope extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RESULTS_SCHEMA_VERSION;
  kind: "run-list";
  runs: ModelicaRunSummary[];
}

export type ModelicaResultsEnvelope = ModelicaRunResultEnvelope | ModelicaRunListResultEnvelope;

const quantitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "number" },
    unit: { type: "string" },
  },
  required: ["value", "unit"],
};

const artifactSchema = {
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

const runSchema = {
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
    artifacts: { type: "array", items: artifactSchema },
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

const runSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["succeeded", "failed", "timed_out"] },
    run_id: { type: "string" },
    started_at: { type: "string" },
    completed_at: { type: "string" },
    fingerprint: { type: "string" },
    model: runSchema.properties.model,
    scenario: runSchema.properties.scenario,
  },
  required: ["status", "run_id", "fingerprint", "model", "scenario"],
};

export const runOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RESULTS_SCHEMA_VERSION },
    kind: { const: "run" },
    run: runSchema,
  },
  required: ["schemaVersion", "kind", "run"],
};

export const runListOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: MODELICA_RESULTS_SCHEMA_VERSION },
    kind: { const: "run-list" },
    runs: { type: "array", items: runSummarySchema },
  },
  required: ["schemaVersion", "kind", "runs"],
};

export function toRunResult(run: SimulationRun): StructuredToolResult {
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

export function toRunListResult(runs: ModelicaRunSummary[]): StructuredToolResult {
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
