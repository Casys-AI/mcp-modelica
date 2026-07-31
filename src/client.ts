import { createModelicaTools } from "./tools/mod.ts";
import { toRunListResult, toRunResult } from "./tools/results.ts";
import type { ModelicaTool, ModelicaToolHandler } from "./tools/types.ts";
import type { ModelicaService } from "./domain/service.ts";

export interface MCPToolWireFormat {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: ModelicaTool["_meta"];
}

/** Adapts the approved-kit service to the MCP wire format. */
export class ModelicaToolsClient {
  private readonly tools: readonly ModelicaTool[];

  constructor(service: ModelicaService) {
    this.tools = createModelicaTools(service);
  }

  listTools(): readonly ModelicaTool[] {
    return this.tools;
  }

  get count(): number {
    return this.tools.length;
  }

  toMCPFormat(): MCPToolWireFormat[] {
    return this.tools.map(({ name, description, inputSchema, outputSchema, _meta }) => ({
      name,
      description,
      inputSchema,
      outputSchema,
      _meta,
    }));
  }

  buildHandlersMap(): Map<string, ModelicaToolHandler> {
    return new Map(this.tools.map((tool) => [
      tool.name,
      async (args: Record<string, unknown>) => {
        const result = await tool.handler(args);
        if (tool.name === "modelica_run_list") {
          return toRunListResult(result as Awaited<ReturnType<ModelicaService["listRuns"]>>);
        }
        if (tool.name === "modelica_simulate" || tool.name === "modelica_run_get") {
          return toRunResult(result as Awaited<ReturnType<ModelicaService["getRun"]>>);
        }
        return result;
      },
    ]));
  }
}
