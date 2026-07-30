import { assert, assertEquals } from "@std/assert";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("--stdio serves a real MCP initialize and tools/list exchange", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-read=models,scenarios,src",
      "--allow-env=MODELICA_RUN_DIR",
      "server.ts",
      "--stdio",
    ],
    cwd: new URL("../", import.meta.url),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(encoder.encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-modelica-test", version: "0.0.0" },
        },
      }) + "\n",
    ));
    await writer.write(encoder.encode(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    ));
    await writer.write(encoder.encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) + "\n",
    ));
  } finally {
    await writer.close();
  }

  const output = await completeWithin(child, 5_000);
  assertEquals(output.code, 0, decoder.decode(output.stderr));
  const responses = decoder.decode(output.stdout).trim().split("\n").map((line) =>
    JSON.parse(line) as { id?: number; result?: unknown }
  );
  const initialized = responses.find((response) => response.id === 1)?.result as {
    serverInfo?: { name?: string };
  };
  const tools = responses.find((response) => response.id === 2)?.result as {
    tools?: Array<{ name: string }>;
  };

  assertEquals(initialized.serverInfo?.name, "mcp-modelica");
  assertEquals(tools.tools?.map((tool) => tool.name), [
    "modelica_kit_list",
    "modelica_simulate",
    "modelica_run_get",
  ]);
  assert(
    !decoder.decode(output.stderr).includes("HTTP server listening"),
    "--stdio must not start the HTTP transport.",
  );
});

async function completeWithin(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<Deno.CommandOutput> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.output(),
      new Promise<Deno.CommandOutput>((_resolve, reject) => {
        timeout = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // The process may have completed immediately before the timeout.
          }
          reject(new Error(`MCP stdio smoke did not complete within ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
