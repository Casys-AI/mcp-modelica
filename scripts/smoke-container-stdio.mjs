import { spawn, spawnSync } from "node:child_process";

const [image, expectedVersion] = process.argv.slice(2);
if (!image) {
  throw new Error("usage: smoke-container-stdio.mjs <image> [expected-version]");
}

const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const KIT_SOURCE_URI = "casys://modelica/kits/coffee-machine-v1/0.1.0/model.mo";
const VIEWER_URI = "ui://mcp-modelica/results-viewer";
const RESPONSE_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 120_000;

const containerName = `mcp-modelica-stdio-${process.pid}-${Date.now()}`;
const server = startServer(image, containerName);
let completed = false;
let failure;
const totalTimeout = setTimeout(() => {
  server.abort(new Error(`container stdio smoke exceeded ${TOTAL_TIMEOUT_MS}ms`));
}, TOTAL_TIMEOUT_MS);

try {
  const discovered = await server.request(modernRequest(1, "server/discover"));
  expectEqual(
    discovered.result?.supportedVersions,
    [PROTOCOL_VERSION],
    "supported protocol versions",
  );

  const initialized = await server.request(request(2, "initialize", {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "modelica-container-stdio-smoke", version: "1.0.0" },
  }));
  expectEqual(
    initialized.result?.protocolVersion,
    LEGACY_PROTOCOL_VERSION,
    "legacy protocol version",
  );
  if (expectedVersion) {
    expectEqual(initialized.result?.serverInfo?.version, expectedVersion, "server version");
  }
  await server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const qualified = await server.request(request(3, "resources/list"));
  const qualifiedResources = qualified.result?.resources;
  expect(Array.isArray(qualifiedResources), "resources/list did not return resources");
  expect(
    qualifiedResources.some((resource) => resource?.uri === KIT_SOURCE_URI),
    "qualified Modelica source was not registered",
  );
  expect(
    qualifiedResources.some((resource) => resource?.uri === VIEWER_URI),
    "qualified Modelica viewer was not registered",
  );

  const source = await server.request(request(4, "resources/read", { uri: KIT_SOURCE_URI }));
  const sourceText = source.result?.contents?.[0]?.text;
  expect(
    typeof sourceText === "string" && sourceText.includes("model CoffeeMachine"),
    "source unreadable",
  );

  const simulated = await server.request(request(5, "tools/call", {
    name: "modelica_simulate_recorded",
    arguments: {
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
      timeout_ms: 30_000,
    },
  }));
  expect(
    simulated.error === undefined,
    `simulation returned JSON-RPC error: ${describe(simulated.error)}`,
  );
  const run = simulated.result?.structuredContent?.run;
  expect(run?.status === "succeeded", `recorded simulation did not succeed: ${describe(run)}`);
  const result = run.artifacts?.find((artifact) => artifact?.kind === "result");
  expect(typeof result?.uri === "string", "recorded simulation omitted its result artifact URI");

  const dynamic = await server.request(request(6, "resources/list"));
  const dynamicResources = dynamic.result?.resources;
  expect(Array.isArray(dynamicResources), "post-run resources/list did not return resources");
  expect(
    dynamicResources.some((resource) => resource?.uri === result.uri),
    "recorded result artifact was not published as a resource",
  );

  const evidence = await server.request(request(7, "resources/read", { uri: result.uri }));
  const evidenceText = evidence.result?.contents?.[0]?.text;
  expect(
    typeof evidenceText === "string" && evidenceText.includes("waterTemperatureC"),
    "recorded result resource was unreadable",
  );

  await server.close();
  completed = true;
} catch (error) {
  failure = error;
  throw error;
} finally {
  clearTimeout(totalTimeout);
  try {
    if (!completed) await server.terminate();
  } finally {
    if (failure && server.stderr) {
      process.stderr.write(`mcp-modelica container stderr:\n${server.stderr}\n`);
    }
  }
}

function startServer(image, containerName) {
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--interactive",
      "--name",
      containerName,
      image,
      "--stdio",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  let stdoutBuffer = "";
  let stderr = "";
  let fatal;
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal }))
  );

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop();
    for (const line of lines) consumeLine(line);
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
    stdoutBuffer = "";
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => abort(error));
  child.on("close", () => {
    if (!fatal && pending.size > 0) {
      abort(new Error("container stdio server exited before replying"));
    }
  });

  function consumeLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      abort(new Error(`container stdout was not JSON-RPC JSON: ${line}`, { cause: error }));
      return;
    }
    if (message?.jsonrpc !== "2.0") {
      abort(new Error(`container stdout was not a JSON-RPC 2.0 envelope: ${line}`));
      return;
    }
    const response = pending.get(message.id);
    if (response) {
      pending.delete(message.id);
      clearTimeout(response.timeout);
      response.resolve(message);
    }
  }

  function abort(error) {
    if (fatal) return;
    fatal = error instanceof Error ? error : new Error(String(error));
    for (const response of pending.values()) {
      clearTimeout(response.timeout);
      response.reject(fatal);
    }
    pending.clear();
    if (!child.killed) child.kill("SIGTERM");
  }

  async function send(message) {
    if (fatal) throw fatal;
    await new Promise((resolve, reject) => {
      child.stdin.write(
        `${JSON.stringify(message)}\n`,
        (error) => error ? reject(error) : resolve(),
      );
    });
  }

  async function request(message) {
    if (typeof message.id !== "number") throw new Error("JSON-RPC requests must have numeric ids");
    if (fatal) throw fatal;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(message.id);
        const error = new Error(
          `container stdio did not reply to ${message.method} within ${RESPONSE_TIMEOUT_MS}ms`,
        );
        abort(error);
        reject(error);
      }, RESPONSE_TIMEOUT_MS);
      pending.set(message.id, { resolve, reject, timeout });
    });
    try {
      await send(message);
    } catch (error) {
      const pendingResponse = pending.get(message.id);
      if (pendingResponse) {
        pending.delete(message.id);
        clearTimeout(pendingResponse.timeout);
        pendingResponse.reject(error);
      }
      throw error;
    }
    return await response;
  }

  async function close() {
    child.stdin.end();
    const status = await withTimeout(
      closed,
      SHUTDOWN_TIMEOUT_MS,
      `container stdio server did not stop after stdin EOF within ${SHUTDOWN_TIMEOUT_MS}ms`,
    );
    if (fatal) throw fatal;
    if (status.code !== 0 || status.signal !== null) {
      throw new Error(
        `container stdio server exited with code=${status.code} signal=${status.signal}`,
      );
    }
  }

  async function terminate() {
    if (!child.killed) child.kill("SIGTERM");
    try {
      await withTimeout(closed, SHUTDOWN_TIMEOUT_MS, "container stdio server ignored SIGTERM");
    } catch {
      if (!child.killed) child.kill("SIGKILL");
      await withTimeout(closed, SHUTDOWN_TIMEOUT_MS, "container stdio server ignored SIGKILL");
    } finally {
      spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
    }
  }

  return {
    close,
    abort,
    request,
    send,
    terminate,
    get stderr() {
      return stderr;
    },
  };
}

function request(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function modernRequest(id, method, params = {}) {
  return request(id, method, {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": {
        name: "modelica-container-stdio-smoke",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
}

function expect(value, message) {
  if (!value) throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} was ${describe(actual)}, expected ${describe(expected)}`);
  }
}

function describe(value) {
  return JSON.stringify(value);
}

async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
