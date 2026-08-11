import type { ModelicaService } from "../domain/service.ts";
import {
  kitListOutputSchema,
  MODELICA_RESULTS_VIEWER_URI,
  MODELICA_RUN_LIST_VIEWER_URI,
  recordedKitListOutputSchema,
  recordedRunListOutputSchema,
  recordedRunOutputSchema,
  runListOutputSchema,
  runOutputSchema,
  toKitListResult,
  toRecordedKitListResult,
} from "./results.ts";
import type { ModelicaTool } from "./types.ts";

export function createModelicaTools(service: ModelicaService): ModelicaTool[] {
  return [
    {
      name: "modelica_kit_list",
      description:
        "List approved, versioned Modelica kits, scenarios, bounded parameter overrides and produced metrics. " +
        "Use this before modelica_simulate. This server never accepts Modelica source, scripts or file paths from callers.",
      category: "catalog",
      outputSchema: kitListOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      handler: () => toKitListResult(service.listLegacyKits()),
    },
    {
      name: "modelica_simulate",
      description:
        "Run an approved Modelica kit/scenario with typed, bounded parameter overrides. " +
        "Returns computed observations and hashed artifacts; it never returns requirement pass/fail. " +
        "Pass/fail remains the responsibility of mcp-syson and @casys/constraint-solver.",
      category: "simulation",
      outputSchema: runOutputSchema,
      _meta: { ui: { resourceUri: MODELICA_RESULTS_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          model_id: { type: "string", minLength: 1 },
          scenario_id: { type: "string", minLength: 1 },
          parameter_overrides: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                value: { type: "number" },
                unit: { type: "string", minLength: 1 },
              },
              required: ["value", "unit"],
            },
          },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
        },
        required: ["model_id", "scenario_id"],
      },
      handler: async (args) => await service.simulate(args),
    },
    {
      name: "modelica_run_list",
      description:
        "List up to 20 persisted Modelica run summaries in deterministic run_id order. " +
        "Use modelica_run_get for the metrics and artifact ledger. This is read-only: it does not " +
        "rerun, alter, or delete simulation evidence.",
      category: "simulation",
      outputSchema: runListOutputSchema,
      _meta: { ui: { resourceUri: MODELICA_RUN_LIST_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      handler: async (args) => await service.listRuns(args.limit),
    },
    {
      name: "modelica_run_get",
      description:
        "Read the immutable record, metrics and artifact hashes for a run returned by modelica_simulate. " +
        "This does not rerun or delete anything.",
      category: "simulation",
      outputSchema: runOutputSchema,
      _meta: { ui: { resourceUri: MODELICA_RESULTS_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          run_id: { type: "string", minLength: 1 },
        },
        required: ["run_id"],
      },
      handler: async (args) => await service.getRun(args.run_id),
    },
    {
      name: "modelica_kit_list_recorded",
      description:
        "List approved Modelica kits for the recorded 2.0 contract. Exact qualified model, " +
        "scenario and compiler-derived schema bytes are exposed through identity-bound MCP resources.",
      category: "catalog",
      outputSchema: recordedKitListOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      handler: () => toRecordedKitListResult(service.listKits()),
    },
    {
      name: "modelica_simulate_recorded",
      description:
        "Run an approved kit and return the recorded 2.0 ledger with separately hashed native " +
        "scenario, public projection, compiler schema and exact artifact resource URIs.",
      category: "simulation",
      outputSchema: recordedRunOutputSchema,
      _meta: { ui: { resourceUri: MODELICA_RESULTS_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          model_id: { type: "string", minLength: 1 },
          scenario_id: { type: "string", minLength: 1 },
          parameter_overrides: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: {
                value: { type: "number" },
                unit: { type: "string", minLength: 1 },
              },
              required: ["value", "unit"],
            },
          },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
        },
        required: ["model_id", "scenario_id"],
      },
      handler: async (args) => await service.simulate(args),
    },
    {
      name: "modelica_run_list_recorded",
      description:
        "List only recorded 2.0 run summaries from the shared bounded store. Legacy 1.0 ledgers " +
        "remain available through modelica_run_list and are deliberately excluded here.",
      category: "simulation",
      outputSchema: recordedRunListOutputSchema,
      _meta: { ui: { resourceUri: MODELICA_RUN_LIST_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
      handler: async (args) => await service.listRecordedRuns(args.limit),
    },
    {
      name: "modelica_run_get_recorded",
      description:
        "Read one immutable recorded 2.0 run and its exact resource ledger. A legacy 1.0 run is " +
        "refused explicitly and is still readable with modelica_run_get.",
      category: "simulation",
      outputSchema: recordedRunOutputSchema,
      _meta: { ui: { resourceUri: MODELICA_RESULTS_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          run_id: { type: "string", minLength: 1 },
        },
        required: ["run_id"],
      },
      handler: async (args) => await service.getRecordedRun(args.run_id),
    },
  ];
}

export type { ModelicaTool, ModelicaToolCategory, ModelicaToolHandler } from "./types.ts";
