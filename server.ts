/**
 * MCP bootstrap for approved OpenModelica simulation kits.
 *
 * Stateless HTTP is the only transport. It is loopback-only by default and
 * Compose passes --hostname=0.0.0.0 inside the dedicated container.
 */
import { McpApp, type RegisterViewersSummary } from "@casys/mcp-server";
import { ModelicaToolsClient } from "./src/client.ts";
import { createModelicaService, type ModelicaService } from "./src/domain/service.ts";

const DEFAULT_HTTP_PORT = 3016;

export interface CreateModelicaServerOptions {
  service?: ModelicaService;
  logger?: (message: string) => void;
  viewerFileSystem?: ResultsViewerFileSystem;
  viewerModuleUrl?: string;
}

export interface ResultsViewerFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string | Promise<string>;
}

export interface ModelicaServer {
  server: McpApp;
  toolsClient: ModelicaToolsClient;
  viewerRegistration: RegisterViewersSummary;
}

export async function createModelicaServer(
  options: CreateModelicaServerOptions = {},
): Promise<ModelicaServer> {
  const service = options.service ?? await createModelicaService();
  const toolsClient = new ModelicaToolsClient(service);
  const server = new McpApp({
    name: "mcp-modelica",
    version: "0.2.0",
    maxConcurrent: 1,
    backpressureStrategy: "queue",
    transport: "stateless",
    validateSchema: true,
    logger: options.logger ?? ((message) => console.error(`[mcp-modelica] ${message}`)),
  });
  server.registerTools(toolsClient.toMCPFormat(), toolsClient.buildHandlersMap());
  const viewerRegistration = registerResultsViewer(
    server,
    options.viewerFileSystem,
    options.viewerModuleUrl,
  );
  return { server, toolsClient, viewerRegistration };
}

/**
 * Registers the build output when present. A source checkout may not have a
 * UI build yet, in which case McpApp reports `results-viewer` as skipped and
 * the text/structured tool results remain fully usable.
 */
export function registerResultsViewer(
  server: McpApp,
  fileSystem: ResultsViewerFileSystem = defaultViewerFileSystem,
  moduleUrl = import.meta.url,
): RegisterViewersSummary {
  return server.registerViewers({
    prefix: "mcp-modelica",
    viewers: ["results-viewer"],
    moduleUrl,
    exists: fileSystem.exists,
    readFile: fileSystem.readFile,
    humanName: () => "Modelica Results Viewer",
  });
}

export function createResultsViewerFileSystem(
  fetchViewer: (url: string) => Promise<Response> = (url) => fetch(url),
): ResultsViewerFileSystem {
  return {
    exists(path) {
      if (isRemoteViewerUrl(path)) return true;
      try {
        return Deno.statSync(path).isFile;
      } catch (error) {
        // The optional npm-style `ui-dist` path may sit outside the process's
        // narrow source read permission. It is indistinguishable from an absent
        // viewer for registration purposes and must not prevent text MCP tools
        // from starting.
        if (
          error instanceof Deno.errors.NotFound ||
          error instanceof Deno.errors.PermissionDenied ||
          (error instanceof Error && error.name === "NotCapable")
        ) {
          return false;
        }
        throw error;
      }
    },
    async readFile(path) {
      if (!isRemoteViewerUrl(path)) return await Deno.readTextFile(path);
      let response: Response;
      try {
        response = await fetchViewer(path);
      } catch (error) {
        throw new Error(`Unable to fetch Modelica results viewer from ${path}.`, { cause: error });
      }
      if (!response.ok) {
        throw new Error(
          `Unable to fetch Modelica results viewer from ${path}: HTTP ${response.status} ${response.statusText}.`,
        );
      }
      return await response.text();
    },
  };
}

const defaultViewerFileSystem = createResultsViewerFileSystem();

function isRemoteViewerUrl(path: string): boolean {
  try {
    const protocol = new URL(path).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const cli = parseCli(Deno.args);
  const { server, toolsClient } = await createModelicaServer();
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
  console.error(`[mcp-modelica] Server ready (${toolsClient.count} tools).`);
}

interface CliOptions {
  port: number;
  hostname: string;
}

function parseCli(args: readonly string[]): CliOptions {
  let port = DEFAULT_HTTP_PORT;
  let hostname = "127.0.0.1";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith("--port=")) {
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
  return { port, hostname };
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
