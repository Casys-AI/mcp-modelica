import { assertEquals } from "@std/assert";
import { ModelicaToolsClient } from "../src/client.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("MCP surface freezes four v1 tools and adds four explicit recorded successors", async () => {
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
      "modelica_kit_list_recorded",
      "modelica_simulate_recorded",
      "modelica_run_list_recorded",
      "modelica_run_get_recorded",
    ]);
    for (
      const name of [
        "modelica_simulate",
        "modelica_run_get",
        "modelica_simulate_recorded",
        "modelica_run_get_recorded",
      ]
    ) {
      const tool = wireTools.find((candidate) => candidate.name === name);
      assertEquals(tool?._meta?.ui.resourceUri, "ui://mcp-modelica/results-viewer");
      assertEquals(tool?.outputSchema?.type, "object");
    }
    for (
      const name of [
        "modelica_kit_list",
        "modelica_simulate",
        "modelica_run_list",
        "modelica_run_get",
      ]
    ) {
      const schema = wireTools.find((candidate) => candidate.name === name)?.outputSchema as {
        properties: { schemaVersion: { const: string } };
      };
      assertEquals(schema.properties.schemaVersion.const, "1.0");
    }
    for (
      const name of [
        "modelica_kit_list_recorded",
        "modelica_simulate_recorded",
        "modelica_run_list_recorded",
        "modelica_run_get_recorded",
      ]
    ) {
      const schema = wireTools.find((candidate) => candidate.name === name)?.outputSchema as {
        properties: { schemaVersion: { const: string } };
      };
      assertEquals(schema.properties.schemaVersion.const, "2.0");
    }
    const runListTool = wireTools.find((candidate) => candidate.name === "modelica_run_list");
    assertEquals(runListTool?._meta?.ui.resourceUri, "ui://mcp-modelica/run-list-viewer");
    assertEquals(runListTool?.outputSchema?.type, "object");
    const kitListTool = wireTools.find((tool) => tool.name === "modelica_kit_list");
    assertEquals(kitListTool?._meta, undefined);
    // The catalogue answers with the same envelope shape as every other tool:
    // a conformant MCP client binds structuredContent, never parsed prose.
    assertEquals(kitListTool?.outputSchema?.type, "object");
    const handlers = client.buildHandlersMap();
    const catalog = await handlers.get("modelica_kit_list")!({}) as {
      content: string;
      structuredContent: {
        schemaVersion: string;
        kind: string;
        kits: Array<{ id: string; produced_metrics: Array<Record<string, unknown>> }>;
      };
    };
    assertEquals(catalog.content, "Found 2 approved Modelica kits.");
    assertEquals(catalog.structuredContent.schemaVersion, "1.0");
    assertEquals(catalog.structuredContent.kind, "kit-list");
    assertEquals(catalog.structuredContent.kits[0].id, "coffee-machine-v1");
    assertEquals(
      catalog.structuredContent.kits[0].produced_metrics.some((metric) => "required" in metric),
      false,
    );
    assertEquals(await handlers.get("modelica_run_list")!({}), {
      content: "Found 0 persisted simulation runs.",
      structuredContent: { schemaVersion: "1.0", kind: "run-list", runs: [] },
    });
    const recordedCatalog = await handlers.get("modelica_kit_list_recorded")!({}) as {
      structuredContent: {
        schemaVersion: string;
        kits: Array<{ produced_metrics: Array<{ required: boolean }> }>;
      };
    };
    assertEquals(recordedCatalog.structuredContent.schemaVersion, "2.0");
    assertEquals(recordedCatalog.structuredContent.kits[0].produced_metrics[0].required, true);

    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const legacyResult = await handlers.get("modelica_run_get")!({ run_id: run.run_id }) as {
      content: string;
      structuredContent: { schemaVersion: string; run: Record<string, unknown> };
    };
    assertEquals(
      legacyResult.content,
      `Persisted simulation run ${run.run_id}: succeeded; 4 metrics and 7 artifacts.`,
    );
    assertEquals(legacyResult.structuredContent.schemaVersion, "1.0");
    assertEquals("record_schema_version" in legacyResult.structuredContent.run, false);
    assertEquals("source_sha256" in (legacyResult.structuredContent.run.model as object), false);
    const legacyRun = legacyResult.structuredContent.run as {
      model: { sha256: string };
      scenario: { sha256: string };
      artifacts: Array<{ kind: string; qualification?: string }>;
    };
    assertEquals(legacyRun.model.sha256, run.model.source_sha256);
    assertEquals(legacyRun.scenario.sha256, run.scenario.projection_sha256);
    assertEquals(legacyRun.artifacts.map((artifact) => artifact.kind), [
      "request",
      "resolved_parameters",
      "model",
      "script",
      "diagnostics",
      "result",
      "evidence",
    ]);
    assertEquals(legacyRun.artifacts.some((artifact) => "qualification" in artifact), false);

    const recordedResult = await handlers.get("modelica_run_get_recorded")!({
      run_id: run.run_id,
    }) as { structuredContent: { schemaVersion: string; run: unknown } };
    assertEquals(recordedResult.structuredContent.schemaVersion, "2.0");
    assertEquals(recordedResult.structuredContent.run, run);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("post-commit resource projection failure preserves the durable result and run_get retries", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-post-commit-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    let attempts = 0;
    let reported = 0;
    const client = new ModelicaToolsClient(service, {
      onPersistedRun: () => {
        attempts++;
        if (attempts === 1) throw new Error("injected resource registration failure");
      },
      onPersistedRunProjectionError: () => reported++,
    });
    const handlers = client.buildHandlersMap();
    const simulated = await handlers.get("modelica_simulate")!({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    }) as { structuredContent: { kind: string; run: { run_id: string; status: string } } };
    assertEquals(simulated.structuredContent.kind, "run");
    assertEquals(simulated.structuredContent.run.status, "succeeded");
    assertEquals(attempts, 1);
    assertEquals(reported, 1);
    assertEquals((await service.listRuns()).length, 1);

    const recovered = await handlers.get("modelica_run_get")!({
      run_id: simulated.structuredContent.run.run_id,
    }) as { structuredContent: { kind: string; run: { status: string } } };
    assertEquals(recovered.structuredContent.run.status, "succeeded");
    assertEquals(attempts, 2);
    assertEquals(reported, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
