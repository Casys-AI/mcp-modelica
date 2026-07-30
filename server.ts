/**
 * MCP bootstrap for approved OpenModelica simulation kits.
 *
 * Stdio is the default transport. HTTP mode is loopback-only by default and
 * Compose passes --hostname=0.0.0.0 inside the dedicated container.
 */
import { ConcurrentMCPServer } from "@casys/mcp-server";
import { ModelicaToolsClient } from "./src/client.ts";
import { createModelicaService, type ModelicaService } from "./src/domain/service.ts";

const DEFAULT_HTTP_PORT = 3016;

export interface CreateModelicaServerOptions {
  service?: ModelicaService;
  logger?: (message: string) => void;
}

export async function createModelicaServer(
  options: CreateModelicaServerOptions = {},
): Promise<{ server: ConcurrentMCPServer; toolsClient: ModelicaToolsClient }> {
  const service = options.service ?? await createModelicaService();
  const toolsClient = new ModelicaToolsClient(service);
  const server = new ConcurrentMCPServer({
    name: "mcp-modelica",
    version: "0.1.5",
    maxConcurrent: 1,
    backpressureStrategy: "queue",
    validateSchema: true,
    logger: options.logger ?? ((message) => console.error(`[mcp-modelica] ${message}`)),
  });
  server.registerTools(toolsClient.toMCPFormat(), toolsClient.buildHandlersMap());
  return { server, toolsClient };
}

if (import.meta.main) {
  const cli = parseCli(Deno.args);
  const { server, toolsClient } = await createModelicaServer();
  if (cli.http) {
    await server.startHttp({
      port: cli.port,
      hostname: cli.hostname,
      cors: true,
      onListen: (info) => {
        console.error(
          `[mcp-modelica] HTTP server listening on http://${info.hostname}:${info.port}`,
        );
      },
    });
  } else {
    await server.start();
  }
  console.error(`[mcp-modelica] Server ready (${toolsClient.count} tools).`);
}

interface CliOptions {
  http: boolean;
  port: number;
  hostname: string;
}

function parseCli(args: readonly string[]): CliOptions {
  let http = false;
  let transportWasExplicit = false;
  let port = DEFAULT_HTTP_PORT;
  let hostname = "127.0.0.1";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--http") {
      if (transportWasExplicit && !http) {
        throw new TypeError("Choose either --http or --stdio, not both.");
      }
      http = true;
      transportWasExplicit = true;
    } else if (argument === "--stdio") {
      if (transportWasExplicit && http) {
        throw new TypeError("Choose either --http or --stdio, not both.");
      }
      http = false;
      transportWasExplicit = true;
    } else if (argument.startsWith("--port=")) {
      port = positivePort(argument.slice("--port=".length));
    } else if (argument === "--port") {
      port = positivePort(args[++index]);
    } else if (argument.startsWith("--hostname=")) {
      hostname = nonEmpty(argument.slice("--hostname=".length), "--hostname");
    } else if (argument === "--hostname") {
      hostname = nonEmpty(args[++index], "--hostname");
    } else {
      throw new TypeError(`Unknown argument '${argument}'.`);
    }
  }
  return { http, port, hostname };
}

function positivePort(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("--port must be an integer between 1 and 65535.");
  }
  return parsed;
}

function nonEmpty(value: string | undefined, label: string): string {
  if (!value || value.trim().length === 0) throw new TypeError(`${label} must not be empty.`);
  return value;
}
