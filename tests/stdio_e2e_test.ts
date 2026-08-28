import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { runtimeIdentityInstructions } from "../src/release-identity.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/stdio_server.ts", import.meta.url));
const REPOSITORY = fromFileUrl(new URL("..", import.meta.url));
const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const KIT_SOURCE_URI = "casys://modelica/kits/coffee-machine-v1/0.1.0/model.mo";
const VIEWER_URI = "ui://mcp-modelica/results-viewer";
const RUNS_DIRECTORY = join(REPOSITORY, "runs");
const NATIVE_STDIO_ENABLED = Deno.env.get("RUN_OMC_INTEGRATION") === "1";
const RESPONSE_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

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
    assertEquals(initialized.result?.instructions, runtimeIdentityInstructions());
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
    assertEquals(discovered.result?.instructions, runtimeIdentityInstructions());

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

Deno.test("stdio modern flow builds a non-executing template and reads a sealed series", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-stdio-series-" });
  const process = startFixture(directory);
  try {
    const manifestResponse = await process.request(modernRequest(1, "tools/call", {
      name: "modelica_simulation_manifest_get",
      arguments: {
        model_id: "coffee-machine-v1",
        model_version: "0.1.0",
        scenario_id: "heat-up-nominal",
      },
    }));
    const manifest = (manifestResponse.result?.structuredContent as {
      manifest: { manifest_sha256: string };
    }).manifest;
    const templateResponse = await process.request(modernRequest(2, "tools/call", {
      name: "modelica_simulation_request_template_get",
      arguments: {
        request_id: "stdio-template-series",
        manifest_sha256: manifest.manifest_sha256,
        model_id: "coffee-machine-v1",
        model_version: "0.1.0",
        scenario_id: "heat-up-nominal",
      },
    }));
    const template = templateResponse.result?.structuredContent as {
      kind: string;
      submit: Record<string, unknown>;
    };
    assertEquals(template.kind, "simulation-request-template");
    assertEquals((template.submit.parameters as Record<string, unknown>).water_mass, {
      value: 0.5,
      unit: "kg",
    });

    const submitted = await process.request(modernRequest(3, "tools/call", {
      name: "modelica_simulation_submit",
      arguments: template.submit,
    }));
    const submittedRequest = (submitted.result?.structuredContent as {
      request: { status: string };
    }).request;
    assertEquals(submittedRequest.status, "completed");

    const seriesResponse = await process.request(modernRequest(3, "tools/call", {
      name: "modelica_simulation_series_get",
      arguments: { request_id: "stdio-template-series", max_samples: 2 },
    }));
    const series = seriesResponse.result?.structuredContent as {
      kind: string;
      result: { mediaType: string };
      series: { row_count: number; samples: Array<{ row_index: number }> };
    };
    assertEquals(series.kind, "sealed-result-series");
    assertEquals(series.result.mediaType, "text/csv");
    assertEquals(series.series.row_count, 4);
    assertEquals(series.series.samples.map((sample) => sample.row_index), [0, 3]);
  } finally {
    await process.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "deno task serve:stdio serves discovery, legacy initialization, and recorded evidence",
  ignore: !NATIVE_STDIO_ENABLED,
  fn: async () => {
    await Deno.mkdir(RUNS_DIRECTORY, { recursive: true });
    const directory = await Deno.makeTempDir({
      dir: RUNS_DIRECTORY,
      prefix: "mcp-modelica-serve-stdio-",
    });
    const process = startNativeServer(directory);
    try {
      const discovered = await process.request(modernRequest(1, "server/discover"));
      assertEquals(discovered.result?.supportedVersions, [PROTOCOL_VERSION]);
      assertEquals(discovered.result?.instructions, runtimeIdentityInstructions());

      const initialized = await process.request(request(2, "initialize", {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "modelica-legacy-serve-stdio-test", version: "1.0.0" },
      }));
      assertEquals(initialized.result?.protocolVersion, LEGACY_PROTOCOL_VERSION);
      await process.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

      const listed = await process.request(request(3, "resources/list"));
      const qualifiedResources = listed.result?.resources as Array<{ uri: string }>;
      assert(qualifiedResources.some((resource) => resource.uri === KIT_SOURCE_URI));
      assert(qualifiedResources.some((resource) => resource.uri === VIEWER_URI));

      const source = await process.request(request(4, "resources/read", { uri: KIT_SOURCE_URI }));
      const sourceText = (source.result?.contents as Array<{ text: string }>)[0].text;
      assert(sourceText.includes("model CoffeeMachine"));

      const simulated = await process.request(request(5, "tools/call", {
        name: "modelica_simulate_recorded",
        arguments: {
          model_id: "coffee-machine-v1",
          scenario_id: "heat-up-nominal",
          timeout_ms: 30_000,
        },
      }));
      assertEquals(simulated.error, undefined);
      const run = (simulated.result?.structuredContent as {
        run: { status: string; artifacts: Array<{ kind: string; uri: string }> };
      }).run;
      assertEquals(run.status, "succeeded");
      const result = run.artifacts.find((artifact) => artifact.kind === "result");
      assertExists(result);

      const dynamicResources = await process.request(request(6, "resources/list"));
      const resources = dynamicResources.result?.resources as Array<{ uri: string }>;
      assert(resources.some((resource) => resource.uri === result.uri));

      const evidence = await process.request(
        request(7, "resources/read", { uri: result.uri }),
      );
      const csv = (evidence.result?.contents as Array<{ text: string }>)[0].text;
      assert(csv.includes("waterTemperatureC"));
    } finally {
      try {
        await process.close();
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }
  },
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
  return new StdioProcess(child, "stdio fixture");
}

function startNativeServer(runsDirectory: string): StdioProcess {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["task", "serve:stdio"],
    cwd: REPOSITORY,
    env: { ...Deno.env.toObject(), MODELICA_RUN_DIR: runsDirectory },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return new StdioProcess(child, "deno task serve:stdio");
}

class StdioProcess {
  readonly notifications: JsonRpc[] = [];
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<string>;
  readonly #stderr: Promise<string>;
  readonly #name: string;
  #buffer = "";
  #pending: JsonRpc[] = [];
  #closed = false;

  constructor(child: Deno.ChildProcess, name: string) {
    this.#child = child;
    this.#name = name;
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
    if (this.#closed) return;
    this.#closed = true;
    let status: Deno.CommandStatus | undefined;
    try {
      await withTimeout(
        this.#writer.close(),
        SHUTDOWN_TIMEOUT_MS,
        `${this.#name} stdin did not close`,
      );
      status = await withTimeout(
        this.#child.status,
        SHUTDOWN_TIMEOUT_MS,
        `${this.#name} did not stop after stdin EOF`,
      );
      await this.#drainStdout();
      const stderr = await withTimeout(
        this.#stderr,
        SHUTDOWN_TIMEOUT_MS,
        `${this.#name} did not finish draining stderr`,
      );
      assertEquals(status.success, true, `${this.#name} failed:\n${stderr}`);
    } finally {
      if (status === undefined) await this.#terminate();
      await this.#reader.cancel().catch(() => undefined);
    }
  }

  async #send(message: JsonRpc): Promise<void> {
    await withTimeout(
      this.#writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`)),
      RESPONSE_TIMEOUT_MS,
      `${this.#name} did not accept a JSON-RPC frame`,
    );
  }

  async #readNext(): Promise<JsonRpc> {
    while (this.#pending.length === 0) {
      const { done, value } = await withTimeout(
        this.#reader.read(),
        RESPONSE_TIMEOUT_MS,
        `${this.#name} did not reply within ${RESPONSE_TIMEOUT_MS}ms`,
      );
      if (done) {
        const stderr = await withTimeout(
          this.#stderr,
          SHUTDOWN_TIMEOUT_MS,
          `${this.#name} did not finish draining stderr`,
        );
        throw new Error(`${this.#name} exited before replying:\n${stderr}`);
      }
      this.#buffer += value;
      this.#queueFrames();
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

  async #drainStdout(): Promise<void> {
    while (true) {
      const { done, value } = await withTimeout(
        this.#reader.read(),
        SHUTDOWN_TIMEOUT_MS,
        `${this.#name} did not close stdout after stdin EOF`,
      );
      if (done) {
        if (this.#buffer.trim().length > 0) {
          throw new Error(`${this.#name} closed stdout with a partial JSON-RPC frame`);
        }
        return;
      }
      this.#buffer += value;
      this.#queueFrames();
    }
  }

  #queueFrames(): void {
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      this.#pending.push(JSON.parse(line) as JsonRpc);
    }
  }

  async #terminate(): Promise<void> {
    try {
      this.#child.kill("SIGTERM");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    try {
      await withTimeout(this.#child.status, SHUTDOWN_TIMEOUT_MS, `${this.#name} ignored SIGTERM`);
      return;
    } catch {
      // Escalate only if the normal EOF shutdown failed and SIGTERM did not stop the child.
    }
    try {
      this.#child.kill("SIGKILL");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await withTimeout(this.#child.status, SHUTDOWN_TIMEOUT_MS, `${this.#name} ignored SIGKILL`);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
