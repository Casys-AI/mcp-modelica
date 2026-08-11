import { assertEquals, assertRejects } from "@std/assert";
import { McpApp } from "@casys/mcp-server";
import { createModelicaServer } from "../server.ts";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { ResumableEvidenceResources } from "../src/resources/resumable-evidence-resources.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("2.1 post-commit projection failure preserves success and request_get retries", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-projection-" });
  try {
    const warnings: string[] = [];
    const method = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const { server, resumableToolsClient } = await createModelicaServer({
      service: method,
      logger: (message) => warnings.push(message),
      viewerFileSystem: { exists: () => false, readFile: () => "unreachable" },
    });
    const registerResources = server.registerResources.bind(server);
    let injectFailure = true;
    server.registerResources = (resources, handlers) => {
      if (injectFailure && resources.some((resource) => resource.uri.includes("/requests/"))) {
        injectFailure = false;
        throw new Error("injected resumable projection failure");
      }
      registerResources(resources, handlers);
    };
    const handlers = resumableToolsClient.buildHandlersMap();
    const manifestResult = await handlers.get("modelica_simulation_manifest_get")!({
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    }) as { structuredContent: { manifest: { manifest_sha256: string } } };
    const requestId = "postcommit-projection-retry";
    const input = explicitInput(method, requestId, manifestResult.structuredContent.manifest);
    const submitted = await handlers.get("modelica_simulation_submit")!(input) as {
      structuredContent: {
        request: {
          status: string;
          run: {
            artifacts: Array<{ uri: string }>;
            run_json: { uri: string };
          };
        };
      };
    };
    const completed = submitted.structuredContent.request;
    assertEquals(completed.status, "completed");
    const uris = [
      ...completed.run.artifacts.map((artifact) => artifact.uri),
      completed.run.run_json.uri,
    ];
    assertEquals(uris.some((uri) => server.hasResource(uri)), false);
    assertEquals(
      warnings.some((message) => message.includes("modelica_simulation_request_get will retry")),
      true,
    );

    const recovered = await handlers.get("modelica_simulation_request_get")!({
      request_id: requestId,
    }) as { structuredContent: { request: { status: string } } };
    assertEquals(recovered.structuredContent.request.status, "completed");
    assertEquals(uris.every((uri) => server.hasResource(uri)), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 resources publish atomically and every read revalidates the sealed ledger", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-resources-" });
  try {
    const { method, service, store } = await fixture(directory);
    const manifest = await service.getManifest({
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    });
    const requestId = "resource-batch-and-tamper";
    const completed = await service.submit(explicitInput(method, requestId, manifest));
    const run = (completed.request as {
      run: {
        artifacts: Array<{ uri: string; bytes: number; kind: string }>;
        run_json: { uri: string };
      };
    }).run;
    const app = new McpApp({
      name: "mcp-modelica-resumable-resource-test",
      version: "0.0.0",
      transport: "stateless",
      expectResources: true,
      logger: () => {},
    });
    const publisher = new ResumableEvidenceResources(app, service);
    const registerResources = app.registerResources.bind(app);
    app.registerResources = (resources, handlers) => {
      const middle = Math.floor(resources.length / 2);
      registerResources(
        resources.map((resource, index) => index === middle ? { ...resource, size: -1 } : resource),
        handlers,
      );
    };
    await assertRejects(
      () => publisher.publishRequest(requestId),
      Error,
      "size must be a non-negative safe integer",
    );
    assertEquals(run.artifacts.some((artifact) => app.hasResource(artifact.uri)), false);
    assertEquals(app.hasResource(run.run_json.uri), false);

    app.registerResources = registerResources;
    await publisher.publishRequest(requestId);
    assertEquals(run.artifacts.every((artifact) => app.hasResource(artifact.uri)), true);
    assertEquals(app.hasResource(run.run_json.uri), true);
    const result = run.artifacts.find((artifact) => artifact.kind === "result");
    if (!result) throw new Error("expected result.csv in the completed artifact ledger");
    assertEquals(app.getResourceInfo(result.uri)?.size, result.bytes);

    const historicalResult = await app.readResourceContent(result.uri);
    const historicalRunJson = await app.readResourceContent(run.run_json.uri);
    const getRuntimeIdentity = method.getRuntimeEngineIdentity.bind(method);
    let runtimeProbes = 0;
    method.getRuntimeEngineIdentity = async () => {
      runtimeProbes++;
      const current = await getRuntimeIdentity();
      return { ...current, version: `${current.version}-future-image` };
    };
    method.getQualifiedKit = () => {
      throw new Error("historical replay must not resolve the current kit");
    };
    assertEquals(
      (await service.getRequest({ request_id: requestId }).then((value) => value.request) as {
        status: string;
      }).status,
      "completed",
    );
    await service.getCompletedEvidence(requestId);
    assertEquals(await app.readResourceContent(result.uri), historicalResult);
    assertEquals(await app.readResourceContent(run.run_json.uri), historicalRunJson);
    assertEquals(runtimeProbes, 0, "historical replay and resources must not probe current OMC");

    const exactRunJson = await store.readRunRecord(requestId);
    if (!exactRunJson) throw new Error("expected durable run.json");
    await Deno.writeTextFile(store.runRecordPath(requestId), `${exactRunJson.source} `);
    await assertRejects(
      () => app.readResourceContent(run.run_json.uri),
      Error,
      "not canonical stable JSON",
    );
    await store.writeRunRecord(requestId, exactRunJson.record);

    const resultArtifact = (await service.getCompletedEvidence(requestId)).artifacts.find(
      (artifact) => artifact.kind === "result",
    );
    if (!resultArtifact?.run_id) throw new Error("expected typed result artifact");
    await Deno.writeTextFile(`${directory}/${resultArtifact.run_id}/result.csv`, "tampered\n");
    await assertRejects(
      () => app.readResourceContent(result.uri),
      Error,
      "no longer matches its persisted ledger",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function fixture(directory: string) {
  const runner = new FakeRunner();
  const method = await createModelicaService({ runsDirectory: directory, runner });
  const store = new RequestStore(directory);
  return {
    method,
    store,
    service: new ResumableSimulationService(
      method,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    ),
  };
}

function explicitInput(
  method: Awaited<ReturnType<typeof createModelicaService>>,
  requestId: string,
  manifest: { manifest_sha256: string },
) {
  const kit = method.getQualifiedKit("coffee-machine-v1", "0.1.0");
  return {
    request_id: requestId,
    manifest_sha256: manifest.manifest_sha256,
    model_id: "coffee-machine-v1",
    model_version: "0.1.0",
    scenario_id: "heat-up-nominal",
    parameters: Object.fromEntries(
      kit.parameters.map((parameter) => [
        parameter.id,
        { value: parameter.defaultValue, unit: parameter.unit },
      ]),
    ),
    timeout_ms: 30_000,
  };
}
