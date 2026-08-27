import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl } from "@std/path";

const FIXTURE = fromFileUrl(new URL("./fixtures/stdio_server.ts", import.meta.url));
const REPOSITORY = fromFileUrl(new URL("..", import.meta.url));
const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const KIT_SOURCE_URI = "casys://modelica/kits/coffee-machine-v1/0.1.0/model.mo";
const VIEWER_URI = "ui://mcp-modelica/results-viewer";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

Deno.test("stdio accepts legacy initialize and serves qualified resources", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-stdio-legacy-" });
  const process = startFixture(directory);
  try {
    const initialized = await process.request(request(1, "initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "modelica-legacy-test", version: "1.0.0" },
    }));
    assertEquals(initialized.result?.protocolVersion, LEGACY_PROTOCOL_VERSION);
    await process.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await process.request(request(2, "resources/list"));
    const resources = listed.result?.resources as Array<{ uri: string }>;
    assert(resources.some((resource) => resource.uri === KIT_SOURCE_URI));
    assert(resources.some((resource) => resource.uri === VIEWER_URI));

    const source = await process.request(request(3, "resources/read", { uri: KIT_SOURCE_URI }));
    const sourceText = (source.result?.contents as Array<{ text: string }>)[0].text;
    assert(sourceText.includes("model CoffeeMachine"));
  } finally {
    await process.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("stdio modern flow publishes and reads dynamic recorded evidence", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-stdio-modern-" });
  const process = startFixture(directory);
  try {
    const discovered = await process.request(modernRequest(1, "server/discover"));
    assertEquals(discovered.result?.supportedVersions, [PROTOCOL_VERSION]);

    const viewer = await process.request(
      modernRequest(2, "resources/read", { uri: VIEWER_URI }),
    );
    const viewerText = (viewer.result?.contents as Array<{ text: string }>)[0].text;
    assert(viewerText.includes("Modelica simulation results"));

    const simulated = await process.request(modernRequest(3, "tools/call", {
      name: "modelica_simulate_recorded",
      arguments: { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" },
    }));
    assertEquals(simulated.error, undefined);
    const run = (simulated.result?.structuredContent as {
      run: { status: string; artifacts: Array<{ kind: string; uri: string }> };
    }).run;
    assertEquals(run.status, "succeeded");
    const result = run.artifacts.find((artifact) => artifact.kind === "result");
    assertExists(result);

    const listed = await process.request(modernRequest(4, "resources/list"));
    const resources = listed.result?.resources as Array<{ uri: string }>;
    assert(resources.some((resource) => resource.uri === result.uri));

    const read = await process.request(
      modernRequest(5, "resources/read", { uri: result.uri }),
    );
    const csv = (read.result?.contents as Array<{ text: string }>)[0].text;
    assert(csv.includes("waterTemperatureC"));
  } finally {
    await process.close();
    await Deno.remove(directory, { recursive: true });
  }
});

function startFixture(runsDirectory: string): StdioProcess {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      `--allow-read=${REPOSITORY},${runsDirectory}`,
      `--allow-write=${runsDirectory}`,
      "--allow-run=perl",
      FIXTURE,
      runsDirectory,
    ],
    cwd: REPOSITORY,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return new StdioProcess(child);
}

class StdioProcess {
  readonly notifications: JsonRpc[] = [];
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<string>;
  readonly #stderr: Promise<string>;
  #buffer = "";
  #pending: JsonRpc[] = [];

  constructor(child: Deno.ChildProcess) {
    this.#child = child;
    this.#writer = child.stdin.getWriter();
    this.#reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    this.#stderr = new Response(child.stderr).text();
  }

  async request(message: JsonRpc): Promise<JsonRpc> {
    assertExists(message.id);
    await this.#send(message);
    while (true) {
      const response = await this.#readNext();
      if (response.id === message.id) {
        this.#collectPendingNotifications();
        return response;
      }
      if (typeof response.method === "string") this.notifications.push(response);
    }
  }

  notify(message: JsonRpc): Promise<void> {
    return this.#send(message);
  }

  async close(): Promise<void> {
    await this.#writer.close();
    const status = await this.#child.status;
    const stderr = await this.#stderr;
    await this.#reader.cancel();
    assertEquals(status.success, true, `stdio fixture failed:\n${stderr}`);
  }

  async #send(message: JsonRpc): Promise<void> {
    await this.#writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  async #readNext(): Promise<JsonRpc> {
    while (this.#pending.length === 0) {
      const { done, value } = await this.#reader.read();
      if (done) {
        const stderr = await this.#stderr;
        throw new Error(`stdio fixture exited before replying:\n${stderr}`);
      }
      this.#buffer += value;
      const lines = this.#buffer.split("\n");
      this.#buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        this.#pending.push(JSON.parse(line) as JsonRpc);
      }
    }
    return this.#pending.shift()!;
  }

  #collectPendingNotifications(): void {
    this.#pending = this.#pending.filter((message) => {
      if (typeof message.method !== "string") return true;
      this.notifications.push(message);
      return false;
    });
  }
}

function request(id: number, method: string, params: Record<string, unknown> = {}): JsonRpc {
  return { jsonrpc: "2.0", id, method, params } as JsonRpc;
}

function modernRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): JsonRpc {
  return request(id, method, {
    ...params,
    _meta: {
      [PROTOCOL_VERSION_KEY]: PROTOCOL_VERSION,
      [CLIENT_INFO_KEY]: { name: "modelica-modern-test", version: "1.0.0" },
      [CLIENT_CAPABILITIES_KEY]: {},
    },
  });
}
