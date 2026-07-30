import type { ModelicaService } from "../domain/service.ts";
import type { ModelicaTool } from "./types.ts";

export function createModelicaTools(service: ModelicaService): ModelicaTool[] {
  return [
    {
      name: "modelica_kit_list",
      description:
        "List approved, versioned Modelica kits, scenarios, bounded parameter overrides and produced metrics. " +
        "Use this before modelica_simulate. This server never accepts Modelica source, scripts or file paths from callers.",
      category: "catalog",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      handler: () => service.listKits(),
    },
    {
      name: "modelica_simulate",
      description:
        "Run an approved Modelica kit/scenario with typed, bounded parameter overrides. " +
        "Returns computed observations and hashed artifacts; it never returns requirement pass/fail. " +
        "Pass/fail remains the responsibility of mcp-syson and @casys/constraint-solver.",
      category: "simulation",
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
      name: "modelica_run_get",
      description:
        "Read the immutable record, metrics and artifact hashes for a run returned by modelica_simulate. " +
        "This does not rerun or delete anything.",
      category: "simulation",
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
  ];
}

export type { ModelicaTool, ModelicaToolCategory, ModelicaToolHandler } from "./types.ts";
