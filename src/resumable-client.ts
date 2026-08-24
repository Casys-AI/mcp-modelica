import type { ResumableSimulationService } from "./application/resumable-simulation-service.ts";
import { createResumableSimulationTools } from "./tools/resumable.ts";
import type { MCPToolWireFormat } from "./client.ts";
import type { ModelicaTool, ModelicaToolHandler } from "./tools/types.ts";
import type { ResumableRequestResult } from "./application/resumable-simulation-service.ts";

export interface ResumableSimulationToolsClientHooks {
  onCompletedRequest?: (requestId: string) => void | Promise<void>;
  onProjectionError?: (error: unknown, requestId: string) => void;
}

/** Separate client keeps the frozen legacy 1.0/2.0 adapter byte-stable. */
export class ResumableSimulationToolsClient {
  private readonly tools: readonly ModelicaTool[];

  constructor(
    private readonly service: ResumableSimulationService,
    private readonly hooks: ResumableSimulationToolsClientHooks = {},
  ) {
    this.tools = createResumableSimulationTools(service);
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
        if (
          tool.name === "modelica_simulation_submit" ||
          tool.name === "modelica_simulation_request_get"
        ) {
          const structured =
            (result as { structuredContent?: ResumableRequestResult }).structuredContent;
          const request = structured?.request as Record<string, unknown> | undefined;
          if (request?.status === "completed" && typeof request.request_id === "string") {
            try {
              await this.hooks.onCompletedRequest?.(request.request_id);
            } catch (error) {
              try {
                this.hooks.onProjectionError?.(error, request.request_id);
              } catch {
                // Durable ledger status always remains primary over projection.
              }
            }
          }
        }
        return result;
      },
    ]));
  }

  get count(): number {
    return this.tools.length;
  }
}
