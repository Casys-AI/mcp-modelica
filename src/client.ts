import { createModelicaTools } from "./tools/mod.ts";
import {
  toRecordedRunListResult,
  toRecordedRunResult,
  toRunListResult,
  toRunResult,
} from "./tools/results.ts";
import type { ModelicaTool, ModelicaToolHandler } from "./tools/types.ts";
import type { ModelicaService } from "./domain/service.ts";
import { projectRecordedRunToLegacy } from "./domain/run-record.ts";
import type { PersistedSimulationRun, SimulationRun } from "./domain/types.ts";

export interface ModelicaToolsClientHooks {
  /** Best-effort projection after run.json has been committed. */
  onPersistedRun?: (run: PersistedSimulationRun) => void | Promise<void>;
  onPersistedRunProjectionError?: (error: unknown, run: PersistedSimulationRun) => void;
}

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

  constructor(
    private readonly service: ModelicaService,
    private readonly hooks: ModelicaToolsClientHooks = {},
  ) {
    this.tools = createModelicaTools(this.service);
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
        if (tool.name === "modelica_simulate" || tool.name === "modelica_simulate_recorded") {
          const recorded = result as SimulationRun;
          await this.projectPersistedRunBestEffort(recorded);
          return tool.name === "modelica_simulate"
            ? toRunResult(await projectRecordedRunToLegacy(recorded))
            : toRecordedRunResult(recorded);
        }
        if (tool.name === "modelica_run_list") {
          return toRunListResult(result as Awaited<ReturnType<ModelicaService["listRuns"]>>);
        }
        if (tool.name === "modelica_run_list_recorded") {
          return toRecordedRunListResult(
            result as Awaited<ReturnType<ModelicaService["listRecordedRuns"]>>,
          );
        }
        if (tool.name === "modelica_run_get") {
          const persisted = await this.service.readPersistedRun(args.run_id);
          await this.projectPersistedRunBestEffort(persisted);
          return toRunResult(result as Awaited<ReturnType<ModelicaService["getRun"]>>);
        }
        if (tool.name === "modelica_run_get_recorded") {
          const recorded = result as Awaited<ReturnType<ModelicaService["getRecordedRun"]>>;
          await this.projectPersistedRunBestEffort(recorded);
          return toRecordedRunResult(recorded);
        }
        return result;
      },
    ]));
  }

  private async projectPersistedRunBestEffort(run: PersistedSimulationRun): Promise<void> {
    try {
      await this.hooks.onPersistedRun?.(run);
    } catch (error) {
      // A resource projection is downstream of the durable run commit. Its
      // failure must never rewrite a succeeded simulation into an MCP error;
      // modelica_run_get retries this same hook on the next read.
      try {
        this.hooks.onPersistedRunProjectionError?.(error, run);
      } catch {
        // Diagnostics are best-effort too; the durable result stays primary.
      }
    }
  }
}
