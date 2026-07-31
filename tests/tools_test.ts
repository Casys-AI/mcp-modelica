import { assertEquals } from "@std/assert";
import { ModelicaToolsClient } from "../src/client.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("MCP surface is a small closed set of four Modelica tools", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-tools-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const client = new ModelicaToolsClient(service);
    const wireTools = client.toMCPFormat();
    assertEquals(wireTools.map((tool) => tool.name), [
      "modelica_kit_list",
      "modelica_simulate",
      "modelica_run_list",
      "modelica_run_get",
    ]);
    for (const name of ["modelica_simulate", "modelica_run_list", "modelica_run_get"]) {
      const tool = wireTools.find((candidate) => candidate.name === name);
      assertEquals(tool?._meta?.ui.resourceUri, "ui://mcp-modelica/results-viewer");
      assertEquals(tool?.outputSchema?.type, "object");
    }
    assertEquals(wireTools.find((tool) => tool.name === "modelica_kit_list")?._meta, undefined);
    const handlers = client.buildHandlersMap();
    const catalog = await handlers.get("modelica_kit_list")!({});
    assertEquals((catalog as Array<{ id: string }>)[0].id, "coffee-machine-v1");
    assertEquals(await handlers.get("modelica_run_list")!({}), {
      content: "Found 0 persisted simulation runs.",
      structuredContent: { schemaVersion: "1.0", kind: "run-list", runs: [] },
    });

    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    assertEquals(await handlers.get("modelica_run_get")!({ run_id: run.run_id }), {
      content: `Persisted simulation run ${run.run_id}: succeeded; 4 metrics and 7 artifacts.`,
      structuredContent: { schemaVersion: "1.0", kind: "run", run },
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
