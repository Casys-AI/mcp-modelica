import { assertEquals } from "@std/assert";
import { ModelicaToolsClient } from "../src/client.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("MCP surface is a small closed set of three Modelica tools", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-tools-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const client = new ModelicaToolsClient(service);
    assertEquals(client.toMCPFormat().map((tool) => tool.name), [
      "modelica_kit_list",
      "modelica_simulate",
      "modelica_run_get",
    ]);
    const handlers = client.buildHandlersMap();
    const catalog = await handlers.get("modelica_kit_list")!({});
    assertEquals((catalog as Array<{ id: string }>)[0].id, "coffee-machine-v1");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
