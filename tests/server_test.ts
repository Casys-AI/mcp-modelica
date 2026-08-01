import { assertEquals, assertRejects } from "@std/assert";
import { createModelicaServer, createResultsViewerFileSystem } from "../server.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("MCP App resource registration is skipped until the viewer build exists", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-server-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, viewerRegistration } = await createModelicaServer({
      service,
      logger: () => {},
      viewerFileSystem: {
        exists: () => false,
        readFile: () => "unreachable",
      },
    });

    assertEquals(viewerRegistration, {
      registered: [],
      skipped: ["results-viewer", "run-list-viewer"],
    });
    assertEquals(server.hasResource("ui://mcp-modelica/results-viewer"), false);
    assertEquals(server.hasResource("ui://mcp-modelica/run-list-viewer"), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("MCP App resource registration serves the built results viewer fixture", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-server-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, viewerRegistration } = await createModelicaServer({
      service,
      logger: () => {},
      viewerFileSystem: {
        exists: (path) => path.endsWith("src/ui/dist/results-viewer/index.html"),
        readFile: () => "<!doctype html><title>Modelica results</title>",
      },
    });

    assertEquals(viewerRegistration, {
      registered: ["results-viewer"],
      skipped: ["run-list-viewer"],
    });
    assertEquals(server.getResourceInfo("ui://mcp-modelica/results-viewer"), {
      uri: "ui://mcp-modelica/results-viewer",
      name: "Modelica Results Viewer",
      description: "MCP App: results-viewer",
      mimeType: "text/html;profile=mcp-app",
    });
    assertEquals(
      (await server.readResourceContent("ui://mcp-modelica/results-viewer"))?.text,
      "<!doctype html><title>Modelica results</title>",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("built Modelica results viewer is registered as the MCP App resource", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-server-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, viewerRegistration } = await createModelicaServer({
      service,
      logger: () => {},
    });

    assertEquals(viewerRegistration, {
      registered: ["results-viewer", "run-list-viewer"],
      skipped: [],
    });
    for (
      const uri of [
        "ui://mcp-modelica/results-viewer",
        "ui://mcp-modelica/run-list-viewer",
      ]
    ) {
      const html = (await server.readResourceContent(uri))?.text;
      assertEquals(html?.includes("Modelica simulation results"), true);
      assertEquals(html?.includes("@casys/mcp-view"), false);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("MCP App viewer resolves the exact published JSR dist URL", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-server-" });
  const moduleUrl = "https://jsr.io/@casys/mcp-modelica/0.2.0/server.ts";
  const expectedResultsViewerUrl =
    "https://jsr.io/@casys/mcp-modelica/0.2.0/src/ui/dist/results-viewer/index.html";
  const expectedRunListViewerUrl =
    "https://jsr.io/@casys/mcp-modelica/0.2.0/src/ui/dist/run-list-viewer/index.html";
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, viewerRegistration } = await createModelicaServer({
      service,
      logger: () => {},
      viewerModuleUrl: moduleUrl,
      viewerFileSystem: {
        exists: (path) => path === expectedResultsViewerUrl || path === expectedRunListViewerUrl,
        readFile: (path) => {
          if (path === expectedResultsViewerUrl) {
            return "<!doctype html><title>Remote Modelica results</title>";
          }
          assertEquals(path, expectedRunListViewerUrl);
          return "<!doctype html><title>Remote Modelica run list</title>";
        },
      },
    });

    assertEquals(viewerRegistration, {
      registered: ["results-viewer", "run-list-viewer"],
      skipped: [],
    });
    assertEquals(
      (await server.readResourceContent("ui://mcp-modelica/results-viewer"))?.text,
      "<!doctype html><title>Remote Modelica results</title>",
    );
    assertEquals(
      (await server.readResourceContent("ui://mcp-modelica/run-list-viewer"))?.text,
      "<!doctype html><title>Remote Modelica run list</title>",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("remote viewer files are accepted then fetched with an actionable failure", async () => {
  const viewerUrl = "https://example.test/mcp-modelica/results-viewer/index.html";
  const fileSystem = createResultsViewerFileSystem((url) => {
    assertEquals(url, viewerUrl);
    return Promise.resolve(new Response("not published", { status: 404, statusText: "Not Found" }));
  });

  assertEquals(fileSystem.exists(viewerUrl), true);
  await assertRejects(
    () => Promise.resolve(fileSystem.readFile(viewerUrl)),
    Error,
    "Unable to fetch Modelica results viewer",
  );
});

Deno.test("HTTP MCP wire exposes result viewer metadata and structured simulation evidence", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-wire-" });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server } = await createModelicaServer({
      service,
      logger: () => {},
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });
    const http = await server.startHttp({ port, hostname: "127.0.0.1", onListen: () => {} });
    try {
      const listed = await rpc(port, "tools/list", {});
      const tools = listed.result.tools as Array<Record<string, unknown>>;
      assertEquals(tools.map((tool) => tool.name).sort(), [
        "modelica_kit_list",
        "modelica_run_get",
        "modelica_run_list",
        "modelica_simulate",
      ]);
      for (const name of ["modelica_simulate", "modelica_run_get"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        assertEquals(
          (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri,
          "ui://mcp-modelica/results-viewer",
        );
        assertEquals((tool?.outputSchema as { type?: string } | undefined)?.type, "object");
      }
      const runListTool = tools.find((candidate) => candidate.name === "modelica_run_list");
      assertEquals(
        (runListTool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri,
        "ui://mcp-modelica/run-list-viewer",
      );
      assertEquals((runListTool?.outputSchema as { type?: string } | undefined)?.type, "object");

      const simulated = await rpc(port, "tools/call", {
        name: "modelica_simulate",
        arguments: { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" },
      });
      const simulationResult = simulated.result as {
        content: Array<{ type: string }>;
        structuredContent: {
          schemaVersion: string;
          kind: string;
          run: {
            status: string;
            metrics: Record<string, unknown>;
          };
        };
      };
      assertEquals(simulationResult.content[0].type, "text");
      assertEquals(simulationResult.structuredContent.schemaVersion, "1.0");
      assertEquals(simulationResult.structuredContent.kind, "run");
      assertEquals(simulationResult.structuredContent.run.status, "succeeded");
      assertEquals(simulationResult.structuredContent.run.metrics.water_temperature_max, {
        value: 94,
        unit: "degC",
      });
      assertEquals("pass" in simulationResult.structuredContent.run, false);
      assertEquals("fail" in simulationResult.structuredContent.run, false);
    } finally {
      await http.shutdown();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

async function rpc(
  port: number,
  method: "tools/list" | "tools/call",
  params: Record<string, unknown>,
): Promise<{ result: Record<string, unknown> }> {
  const name = typeof params.name === "string" ? params.name : undefined;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        _meta: {
          [PROTOCOL_VERSION_KEY]: PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_KEY]: {},
        },
        ...params,
      },
    }),
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("mcp-protocol-version"), PROTOCOL_VERSION);
  assertEquals(response.headers.get("mcp-session-id"), null);
  return await response.json() as { result: Record<string, unknown> };
}
