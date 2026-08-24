import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { McpApp } from "@casys/mcp-server";
import { createModelicaServer, createResultsViewerFileSystem } from "../server.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { ValidationError } from "../src/domain/errors.ts";
import { stableJson } from "../src/domain/hashing.ts";
import {
  kitParameterSchemaUri,
  kitScenarioUri,
  kitSourceUri,
  ModelicaEvidenceResources,
} from "../src/resources/modelica-evidence-resources.ts";
import { FakeRunner, installLegacyRunFixture, LEGACY_RUN_ID } from "./test-helpers.ts";

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
  const moduleUrl = "https://jsr.io/@casys/mcp-modelica/0.4.1/server.ts";
  const expectedResultsViewerUrl =
    "https://jsr.io/@casys/mcp-modelica/0.4.1/src/ui/dist/results-viewer/index.html";
  const expectedRunListViewerUrl =
    "https://jsr.io/@casys/mcp-modelica/0.4.1/src/ui/dist/run-list-viewer/index.html";
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
      const discovered = await rpc(port, "server/discover", {});
      assertEquals(discovered.result.serverInfo, {
        name: "mcp-modelica",
        version: "0.4.1",
      });
      const listed = await rpc(port, "tools/list", {});
      const tools = listed.result.tools as Array<Record<string, unknown>>;
      assertEquals(tools.map((tool) => tool.name).sort(), [
        "modelica_kit_list",
        "modelica_kit_list_recorded",
        "modelica_run_get",
        "modelica_run_get_recorded",
        "modelica_run_list",
        "modelica_run_list_recorded",
        "modelica_simulate",
        "modelica_simulate_recorded",
        "modelica_simulation_manifest_get",
        "modelica_simulation_request_get",
        "modelica_simulation_submit",
      ]);
      for (
        const name of [
          "modelica_simulate",
          "modelica_run_get",
          "modelica_simulate_recorded",
          "modelica_run_get_recorded",
        ]
      ) {
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
      const manifestTool = tools.find((candidate) =>
        candidate.name === "modelica_simulation_manifest_get"
      );
      const submitTool = tools.find((candidate) => candidate.name === "modelica_simulation_submit");
      const requestGetTool = tools.find((candidate) =>
        candidate.name === "modelica_simulation_request_get"
      );
      for (const tool of [manifestTool, submitTool, requestGetTool]) {
        const output = tool?.outputSchema as {
          properties?: { schemaVersion?: { const?: string } };
          additionalProperties?: boolean;
        };
        assertEquals(output.additionalProperties, false);
        assertEquals(output.properties?.schemaVersion?.const, "2.1");
      }
      assertEquals(
        (submitTool?.inputSchema as { additionalProperties?: boolean }).additionalProperties,
        false,
      );

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
      assertEquals("record_schema_version" in simulationResult.structuredContent.run, false);

      const recorded = await rpc(port, "tools/call", {
        name: "modelica_simulate_recorded",
        arguments: { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" },
      });
      const recordedRun = recorded.result.structuredContent as {
        schemaVersion: string;
        run: Record<string, unknown>;
      };
      assertEquals(recordedRun.schemaVersion, "2.0");
      assertEquals(recordedRun.run.record_schema_version, "2.0");
      assertEquals(recordedRun.run.result_normalizer, {
        id: "coffee-machine-result-normalizer",
        version: "1.0.0",
      });

      const manifestResponse = await rpc(port, "tools/call", {
        name: "modelica_simulation_manifest_get",
        arguments: {
          model_id: "coffee-machine-v1",
          model_version: "0.1.0",
          scenario_id: "heat-up-nominal",
        },
      });
      const manifest =
        ((manifestResponse.result.structuredContent as Record<string, unknown>).manifest) as {
          schemaVersion: string;
          manifest_sha256: string;
          lowering: Record<string, unknown>;
          scenario: { public: { start_time_s: number } };
          parameters: Array<{ modelica_name: string; conversion: Record<string, unknown> }>;
        };
      assertEquals(manifest.schemaVersion, "2.1");
      assertEquals(manifest.lowering, { id: "modelica-omc-lowering", version: "1.0.0" });
      assertEquals(manifest.scenario.public.start_time_s, 0);
      assertEquals(typeof manifest.parameters[0].modelica_name, "string");
      assertEquals(typeof manifest.parameters[0].conversion.from, "string");
      const resumable = await rpc(port, "tools/call", {
        name: "modelica_simulation_submit",
        arguments: {
          request_id: "wire-resumable-request",
          manifest_sha256: manifest.manifest_sha256,
          model_id: "coffee-machine-v1",
          model_version: "0.1.0",
          scenario_id: "heat-up-nominal",
          parameters: Object.fromEntries(
            service.listKits()[0].parameters.map((parameter) => [parameter.id, parameter.default]),
          ),
          timeout_ms: 30_000,
        },
      });
      const resumableRequest = (resumable.result.structuredContent as Record<string, unknown>)
        .request as {
          status: string;
          run: { run_json: { uri: string; mediaType: string } };
        };
      assertEquals(resumableRequest.status, "completed");
      assertEquals(resumableRequest.run.run_json.mediaType, "application/json");
      const resumableLedger = await rpc(port, "resources/read", {
        uri: resumableRequest.run.run_json.uri,
      });
      assertEquals(
        (resumableLedger.result.contents as Array<{ text: string }>)[0].text.includes(
          "simulation-run",
        ),
        true,
      );

      const rejectedManifestResponse = await rpc(port, "tools/call", {
        name: "modelica_simulation_manifest_get",
        arguments: {
          model_id: "coffee-machine-v1",
          model_version: "0.1.0",
          scenario_id: "heat-up-nominal",
        },
      });
      const rejectedManifest = (rejectedManifestResponse.result.structuredContent as {
        manifest: { manifest_sha256: string };
      }).manifest;
      const originalRuntimeIdentity = service.getRuntimeEngineIdentity.bind(service);
      service.getRuntimeEngineIdentity = async () => {
        const identity = await originalRuntimeIdentity();
        return { ...identity, version: `${identity.version}-wire-drift` };
      };
      const rejectedInput = {
        request_id: "wire-rejected-request",
        manifest_sha256: rejectedManifest.manifest_sha256,
        model_id: "coffee-machine-v1",
        model_version: "0.1.0",
        scenario_id: "heat-up-nominal",
        parameters: Object.fromEntries(
          service.listKits()[0].parameters.map((parameter) => [parameter.id, parameter.default]),
        ),
        timeout_ms: 30_000,
      };
      const rejected = await rpc(port, "tools/call", {
        name: "modelica_simulation_submit",
        arguments: rejectedInput,
      });
      const rejectedContent = rejected.result.structuredContent as {
        request: { status: string; rejection: string };
      };
      assertEquals(rejectedContent.request.status, "rejected");
      assertEquals(rejectedContent.request.rejection, "manifest_mismatch");
      const rejectedAgain = await rpc(port, "tools/call", {
        name: "modelica_simulation_request_get",
        arguments: { request_id: rejectedInput.request_id },
      });
      assertEquals(rejectedAgain.result.structuredContent, rejectedContent);
    } finally {
      await http.shutdown();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("qualified kit and historical run resources attest the verified byte size", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-size-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, evidenceResources } = await createModelicaServer({
      service,
      logger: () => {},
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });
    const model = await service.readQualifiedModelSource("coffee-machine-v1", "0.1.0");
    const scenario = await service.readQualifiedScenarioSource(
      "coffee-machine-v1",
      "0.1.0",
      "heat-up-nominal",
    );
    const schema = await service.readQualifiedParameterSchema("coffee-machine-v1", "0.1.0");
    assertEquals(
      server.getResourceInfo(kitSourceUri("coffee-machine-v1", "0.1.0"))?.size,
      model.bytes,
    );
    assertEquals(
      server.getResourceInfo(kitScenarioUri("coffee-machine-v1", "0.1.0", "heat-up-nominal"))
        ?.size,
      scenario.bytes,
    );
    assertEquals(
      server.getResourceInfo(kitParameterSchemaUri("coffee-machine-v1", "0.1.0"))?.size,
      schema.bytes,
    );

    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    await evidenceResources.publishRun(run);
    for (const artifact of run.artifacts) {
      const verified = await service.readRunArtifact(run.run_id, artifact.uri);
      assertEquals(verified.bytes, artifact.bytes);
      assertEquals(server.getResourceInfo(artifact.uri)?.size, verified.bytes);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("HTTP MCP wire lists and reads only identity-bound Modelica sources and run artifacts", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-wire-" });
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
      const initial = await rpc(port, "resources/list", {});
      const initialResources = initial.result.resources as Array<Record<string, unknown>>;
      const sourceUri = "casys://modelica/kits/coffee-machine-v1/0.1.0/model.mo";
      const scenarioUri =
        "casys://modelica/kits/coffee-machine-v1/0.1.0/scenarios/heat-up-nominal.json";
      const schemaUri = "casys://modelica/kits/coffee-machine-v1/0.1.0/parameter-schema.json";
      const source = initialResources.find((resource) => resource.uri === sourceUri);
      assertEquals(source?.mimeType, "text/x-modelica");
      const sourceRead = await rpc(port, "resources/read", { uri: sourceUri });
      const sourceText = (sourceRead.result.contents as Array<Record<string, unknown>>)[0].text;
      assertEquals(typeof sourceText, "string");
      assertEquals((sourceText as string).includes("model CoffeeMachine"), true);
      assertEquals(source?.size, new TextEncoder().encode(sourceText as string).byteLength);
      assertEquals(
        initialResources.find((resource) => resource.uri === scenarioUri)?.mimeType,
        "application/json",
      );
      assertEquals(
        initialResources.find((resource) => resource.uri === schemaUri)?.mimeType,
        "application/json",
      );
      assertEquals(
        initialResources.some((resource) => String(resource.uri).includes("/runs/")),
        false,
      );

      const scenarioRead = await rpc(port, "resources/read", { uri: scenarioUri });
      const scenarioText = (scenarioRead.result.contents as Array<Record<string, unknown>>)[0]
        .text as string;
      assertEquals(scenarioText.includes("heat-up-nominal"), true);
      assertEquals(
        initialResources.find((resource) => resource.uri === scenarioUri)?.size,
        new TextEncoder().encode(scenarioText).byteLength,
      );
      const schemaRead = await rpc(port, "resources/read", { uri: schemaUri });
      const schemaText = (schemaRead.result.contents as Array<Record<string, unknown>>)[0]
        .text as string;
      assertEquals(schemaText.includes("getModelInstance"), true);
      assertEquals(
        initialResources.find((resource) => resource.uri === schemaUri)?.size,
        new TextEncoder().encode(schemaText).byteLength,
      );

      const simulated = await rpc(port, "tools/call", {
        name: "modelica_simulate_recorded",
        arguments: { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" },
      });
      const run = ((simulated.result.structuredContent as Record<string, unknown>).run) as {
        run_id: string;
        artifacts: Array<{ uri: string; kind: string }>;
      };
      const after = await rpc(port, "resources/list", {});
      const afterResources = after.result.resources as Array<Record<string, unknown>>;
      assertEquals(
        run.artifacts.every((artifact) =>
          afterResources.some((resource) => resource.uri === artifact.uri)
        ),
        true,
      );
      const resultArtifact = run.artifacts.find((artifact) => artifact.kind === "result");
      const parameterSchemaArtifact = run.artifacts.find((artifact) =>
        artifact.kind === "parameter_schema"
      );
      if (!parameterSchemaArtifact) {
        throw new Error("Simulation did not persist its parameter schema.");
      }
      if (!resultArtifact) throw new Error("Fake simulation did not publish a CSV artifact.");
      const resultRead = await rpc(port, "resources/read", { uri: resultArtifact.uri });
      const resultCsv = (resultRead.result.contents as Array<Record<string, unknown>>)[0];
      assertEquals(resultCsv.mimeType, "text/csv");
      assertEquals((resultCsv.text as string).includes("time"), true);
      assertEquals(
        afterResources.find((resource) => resource.uri === resultArtifact.uri)?.size,
        new TextEncoder().encode(resultCsv.text as string).byteLength,
      );
      const runSchema = await rpc(port, "resources/read", { uri: parameterSchemaArtifact.uri });
      assertEquals(
        ((runSchema.result.contents as Array<Record<string, unknown>>)[0].text as string)
          .includes("getModelInstance"),
        true,
      );
    } finally {
      await http.shutdown();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("durable simulation survives an injected registration failure and run_get republishes it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-retry-" });
  try {
    const warnings: string[] = [];
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, toolsClient } = await createModelicaServer({
      service,
      logger: (message) => warnings.push(message),
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });
    const registerResources = server.registerResources.bind(server);
    let injectFailure = true;
    server.registerResources = (resources, handlers) => {
      if (injectFailure && resources.some((resource) => resource.uri.includes("/runs/"))) {
        injectFailure = false;
        throw new Error("injected registerResources failure");
      }
      registerResources(resources, handlers);
    };
    const handlers = toolsClient.buildHandlersMap();
    const simulated = await handlers.get("modelica_simulate")!({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    }) as {
      structuredContent: {
        run: { run_id: string; status: string; artifacts: Array<{ uri: string }> };
      };
    };
    const run = simulated.structuredContent.run;
    assertEquals(run.status, "succeeded");
    assertEquals((await service.getRun(run.run_id)).status, "succeeded");
    const recordedRun = await service.getRecordedRun(run.run_id);
    assertEquals(
      recordedRun.artifacts.some((artifact) => server.hasResource(artifact.uri)),
      false,
    );
    assertEquals(warnings.some((message) => message.includes("modelica_run_get will retry")), true);

    const recovered = await handlers.get("modelica_run_get")!({ run_id: run.run_id }) as {
      structuredContent: { run: { status: string } };
    };
    assertEquals(recovered.structuredContent.run.status, "succeeded");
    assertEquals(
      recordedRun.artifacts.every((artifact) => server.hasResource(artifact.uri)),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a rejected middle artifact publishes neither a partial run surface nor a list-changed notification", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-batch-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const app = new McpApp({
      name: "mcp-modelica-resource-batch-test",
      version: "0.0.0",
      transport: "stateless",
      expectResources: true,
      logger: () => {},
    });
    const evidenceResources = new ModelicaEvidenceResources(app, service);
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    const http = await app.startHttp({ port, hostname: "127.0.0.1", onListen: () => {} });
    const subscription = await subscribeToResourceChanges(port);
    try {
      await waitUntil(
        () =>
          subscription.events.some((frame) =>
            frame.includes("notifications/subscriptions/acknowledged")
          ),
        "resource subscription acknowledgement",
      );
      assertEquals(resourceChangeCount(subscription.events), 0);

      const registerResources = app.registerResources.bind(app);
      app.registerResources = (resources, handlers) => {
        const middle = Math.floor(resources.length / 2);
        registerResources(
          resources.map((resource, index) =>
            index === middle ? { ...resource, size: -1 } : resource
          ),
          handlers,
        );
      };

      await assertRejects(
        () => evidenceResources.publishRun(run),
        Error,
        "size must be a non-negative safe integer",
      );
      assertEquals(
        run.artifacts.some((artifact) => app.hasResource(artifact.uri)),
        false,
      );
      const listed = await rpc(port, "resources/list", {});
      assertEquals(listed.result.resources, []);
      await assertResourceChangeCountStays(subscription.events, 0);

      app.registerResources = registerResources;
      await evidenceResources.publishRun(run);
      await waitUntil(
        () => resourceChangeCount(subscription.events) >= 1,
        "the successful run batch list-change notification",
      );
      await assertResourceChangeCountStays(subscription.events, 1);
      assertEquals(
        run.artifacts.every((artifact) => app.hasResource(artifact.uri)),
        true,
      );
    } finally {
      await subscription.close();
      await http.shutdown();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Modelica evidence resources fail closed for unknown, missing, and tampered run artifacts", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-integrity-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const result = run.artifacts.find((artifact) => artifact.kind === "result");
    if (!result) throw new Error("Fake simulation did not publish a CSV artifact.");
    const { server } = await createModelicaServer({
      service,
      logger: () => {},
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });

    assertEquals(
      await server.readResourceContent(
        "casys://modelica/runs/run_00000000-0000-4000-8000-000000000000/nope.csv",
      ),
      null,
    );
    await Deno.writeTextFile(join(directory, run.run_id, "result.csv"), "tampered\n");
    await assertRejects(
      () => server.readResourceContent(result.uri),
      Error,
      "no longer matches its persisted bytes and SHA-256 ledger",
    );
    const canonical = new TextEncoder().encode("tampered\n");
    await Deno.writeFile(
      join(directory, run.run_id, "result.csv"),
      new Uint8Array([0xef, 0xbb, 0xbf, ...canonical]),
    );
    await assertRejects(
      () => server.readResourceContent(result.uri),
      ValidationError,
      "is not canonical UTF-8",
    );
    await Deno.remove(join(directory, run.run_id, "result.csv"));
    await assertRejects(
      () => server.readResourceContent(result.uri),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("startup fails closed without injecting resources from a malformed persisted ledger", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-bad-ledger-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const malformed = structuredClone(run);
    malformed.artifacts[0].uri = `casys://modelica/runs/${run.run_id}/../request.json`;
    await Deno.writeTextFile(
      join(directory, run.run_id, "run.json"),
      stableJson(malformed),
    );
    const app = new McpApp({
      name: "mcp-modelica-bad-ledger-test",
      version: "0.0.0",
      transport: "stateless",
      expectResources: true,
      logger: () => {},
    });
    const resources = new ModelicaEvidenceResources(app, service);
    await assertRejects(
      () => resources.publishInitial(),
      ValidationError,
      "is not the canonical URI",
    );
    assertEquals(run.artifacts.some((artifact) => app.hasResource(artifact.uri)), false);
    await assertRejects(
      () => createModelicaServer({ service, logger: () => {} }),
      ValidationError,
      "is not the canonical URI",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run resource publication rejects noncanonical UTF-8 atomically at startup", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-bom-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const result = run.artifacts.find((artifact) => artifact.kind === "result");
    if (!result) throw new Error("Expected result artifact.");
    const resultPath = join(directory, run.run_id, "result.csv");
    const exact = await Deno.readFile(resultPath);
    await Deno.writeFile(resultPath, new Uint8Array([0xef, 0xbb, 0xbf, ...exact]));

    const app = new McpApp({
      name: "mcp-modelica-bom-test",
      version: "0.0.0",
      transport: "stateless",
      expectResources: true,
      logger: () => {},
    });
    await assertRejects(
      () => new ModelicaEvidenceResources(app, service).publishInitial(),
      ValidationError,
      "is not canonical UTF-8",
    );
    assertEquals(run.artifacts.some((artifact) => app.hasResource(artifact.uri)), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("legacy startup publishes only resources attested by the frozen v1 ledger", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-v1-" });
  try {
    const fixture = await installLegacyRunFixture(directory);
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server } = await createModelicaServer({
      service,
      logger: () => {},
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });
    const runPrefix = `casys://modelica/runs/${LEGACY_RUN_ID}/`;
    for (const artifact of fixture.run.artifacts) {
      assertEquals(server.hasResource(artifact.uri), true);
      assertEquals(server.getResourceInfo(artifact.uri)?.size, artifact.bytes);
    }
    assertEquals(server.hasResource(`${runPrefix}scenario.json`), false);
    assertEquals(server.hasResource(`${runPrefix}parameter-schema.json`), false);
    const evidence = await server.readResourceContent(`${runPrefix}evidence.json`);
    assertEquals(evidence?.mimeType, "application/json");
    assertEquals(evidence?.text, stableJson({ legacy_fixture: true }));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Modelica resource registration recovers bounded persisted runs after restart", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resource-restart-" });
  try {
    const firstService = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await firstService.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const request = run.artifacts.find((artifact) => artifact.kind === "request");
    if (!request) throw new Error("Simulation did not persist its request artifact.");

    const restartedService = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server } = await createModelicaServer({
      service: restartedService,
      logger: () => {},
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });
    assertEquals(server.hasResource(request.uri), true);
    const restored = await server.readResourceContent(request.uri);
    assertEquals(restored?.mimeType, "application/json");
    assertEquals(
      typeof restored?.text === "string" && restored.text.includes("coffee-machine-v1"),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

async function rpc(
  port: number,
  method:
    | "server/discover"
    | "tools/list"
    | "tools/call"
    | "resources/list"
    | "resources/read",
  params: Record<string, unknown>,
): Promise<{ result: Record<string, unknown> }> {
  const name = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
    ? params.uri
    : undefined;
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

async function subscribeToResourceChanges(port: number): Promise<{
  events: string[];
  close: () => Promise<void>;
}> {
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    signal: abort.signal,
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "modelica-resource-changes",
      method: "subscriptions/listen",
      params: {
        notifications: { resourcesListChanged: true },
        _meta: {
          [PROTOCOL_VERSION_KEY]: PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_KEY]: {},
        },
      },
    }),
  });
  assertEquals(response.status, 200);
  if (!response.body) throw new Error("Resource subscription response has no body.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: string[] = [];
  let buffered = "";
  let pumpFailure: unknown;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        events.push(...frames.filter((frame) => frame.length > 0));
      }
    } catch (error) {
      if (!abort.signal.aborted) pumpFailure = error;
    }
  })();
  return {
    events,
    close: async () => {
      abort.abort();
      await reader.cancel().catch(() => {});
      await pump;
      if (pumpFailure !== undefined) throw pumpFailure;
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function resourceChangeCount(events: string[]): number {
  return events.filter((frame) => frame.includes("notifications/resources/list_changed")).length;
}

async function assertResourceChangeCountStays(
  events: string[],
  expected: number,
  windowMs = 75,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  assertEquals(resourceChangeCount(events), expected);
}
