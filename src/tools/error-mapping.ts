import { RunNotFoundError, ValidationError } from "../domain/errors.ts";
import { stableJson } from "../domain/hashing.ts";

export const MODELICA_TOOL_ERROR_SCHEMA = "modelica-mcp-error/1.0";

/**
 * Stable, text-encoded MCP business error.
 *
 * The pinned MCP framework's `toolErrorMapper` can mark a tool result as an
 * error but only accepts text content. Canonical JSON keeps the established
 * framework behaviour while giving agents fixed fields to branch on.
 */
interface ModelicaToolErrorResult {
  schema: typeof MODELICA_TOOL_ERROR_SCHEMA;
  code: string;
  message: string;
  field: string;
  context: Record<string, string | number | boolean>;
  recovery: string;
}

export function mapModelicaToolError(error: unknown, toolName: string): string | null {
  const result = toToolErrorResult(error, toolName);
  return result === null ? null : stableJson(result);
}

function toToolErrorResult(error: unknown, toolName: string): ModelicaToolErrorResult | null {
  if (error instanceof ValidationError) {
    return {
      schema: MODELICA_TOOL_ERROR_SCHEMA,
      code: error.details?.code ?? "modelica.validation_failed",
      message: error.message,
      field: error.details?.field ?? "input",
      context: { tool: toolName, ...(error.details?.context ?? {}) },
      recovery: error.details?.recovery ??
        "Correct the bounded qualified input and retry the same operation.",
    };
  }
  if (error instanceof RunNotFoundError) {
    return {
      schema: MODELICA_TOOL_ERROR_SCHEMA,
      code: "run.not_found",
      message: error.message,
      field: "run_id",
      context: { tool: toolName, run_id: error.runId },
      recovery: "Use modelica_run_list or modelica_run_list_recorded to select a persisted run_id.",
    };
  }
  if (error instanceof Error && error.message.startsWith(`Invalid arguments for ${toolName}:`)) {
    return {
      schema: MODELICA_TOOL_ERROR_SCHEMA,
      code: "input.schema_invalid",
      message: `Input does not match the qualified schema for ${toolName}.`,
      field: "input",
      context: { tool: toolName },
      recovery:
        "Use the advertised inputSchema and retry with one qualified kit/version/scenario branch.",
    };
  }
  return null;
}
