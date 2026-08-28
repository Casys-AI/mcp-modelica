import { assertEquals, assertRejects } from "@std/assert";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { stableJson } from "../src/domain/hashing.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("2.1 request template is non-executing and sealed series output is bounded", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-template-series-" });
  try {
    const runner = new FakeRunner();
    let executions = 0;
    let identityProbes = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      executions++;
      return await execute(input);
    };
    const getRuntimeEngineIdentity = runner.getRuntimeEngineIdentity.bind(runner);
    runner.getRuntimeEngineIdentity = async () => {
      identityProbes++;
      return await getRuntimeEngineIdentity();
    };
    const method = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      method,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );

    let durableWrites = 0;
    const writeClaim = store.writeClaim.bind(store);
    store.writeClaim = async (claim) => {
      durableWrites++;
      await writeClaim(claim);
    };
    await assertRejects(
      () =>
        service.getRequestTemplate({
          request_id: "template-without-manifest",
          manifest_sha256: "0".repeat(64),
          model_id: "coffee-machine-v1",
          model_version: "0.1.0",
          scenario_id: "heat-up-nominal",
        }),
      Error,
      "Call that operation first and pass its exact digest",
    );
    assertEquals(executions, 0);
    assertEquals(identityProbes, 0);
    assertEquals(durableWrites, 0);

    const manifest = await service.getManifest({
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    });
    assertEquals(identityProbes, 1);
    await assertRejects(
      () =>
        service.getRequestTemplate({
          request_id: "template-wrong-manifest",
          manifest_sha256: "0".repeat(64),
          model_id: "coffee-machine-v1",
          model_version: "0.1.0",
          scenario_id: "heat-up-nominal",
        }),
      Error,
      "manifest most recently issued",
    );
    assertEquals(executions, 0);
    assertEquals(identityProbes, 1);
    assertEquals(durableWrites, 0);
    const template = await service.getRequestTemplate({
      request_id: "template-no-execution",
      manifest_sha256: manifest.manifest_sha256,
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    });
    assertEquals(template.schemaVersion, "2.1");
    assertEquals(template.kind, "simulation-request-template");
    assertEquals(template.submit.timeout_ms, 30_000);
    assertEquals(template.submit.parameters.water_mass, { value: 0.5, unit: "kg" });
    assertEquals(executions, 0);
    assertEquals(identityProbes, 1);
    assertEquals(durableWrites, 0);
    assertEquals(await store.readClaim(template.submit.request_id), undefined);

    const completed = await service.submit(template.submit);
    assertEquals((completed.request as { status: string }).status, "completed");
    assertEquals(executions, 1);

    const series = await service.getSealedResultSeries({
      request_id: template.submit.request_id,
      max_samples: 3,
    });
    assertEquals(series.schemaVersion, "2.1");
    assertEquals(series.kind, "sealed-result-series");
    assertEquals(series.result.mediaType, "text/csv");
    assertEquals(series.series.row_count, 4);
    assertEquals(series.series.columns, [
      { name: "time", minimum: 0, maximum: 300, final: 300 },
      { name: "waterTemperatureC", minimum: 20, maximum: 94, final: 94 },
      { name: "heaterPowerW", minimum: 0, maximum: 1500, final: 0 },
      { name: "heaterEnergyJ", minimum: 0, maximum: 315000, final: 315000 },
      { name: "heaterOn", minimum: 0, maximum: 1, final: 0 },
    ]);
    assertEquals(series.series.sampling, {
      strategy: "evenly-spaced-including-endpoints",
      requested_max_samples: 3,
      returned_samples: 3,
    });
    assertEquals(series.series.samples.map((sample) => sample.row_index), [0, 2, 3]);
    assertEquals(series.series.samples.at(-1)?.values.waterTemperatureC, 94);

    const completedClaim = await store.readClaim(template.submit.request_id);
    if (!completedClaim || completedClaim.state !== "completed") {
      throw new Error("Expected completed test claim.");
    }
    const { run_json_sha256: _sha, run_json_bytes: _bytes, ...identity } = completedClaim;
    const runningClaim = { ...identity, state: "running", slot_reserved: false } as const;
    await store.capacity.updateRequestClaim(runningClaim.request_id, stableJson(runningClaim));
    const writesBeforePureRead = durableWrites;
    const probesBeforePureRead = identityProbes;
    let lockCalls = 0;
    const pureReader = new ResumableSimulationService(
      method,
      store,
      {
        acquire: () => {
          lockCalls++;
          return Promise.resolve(undefined);
        },
        isHeld: () => {
          lockCalls++;
          return Promise.resolve(false);
        },
      },
      new FileSimulationWorkspace(directory, runner),
    );
    await assertRejects(
      () => pureReader.getSealedResultSeries({ request_id: template.submit.request_id }),
      Error,
      "does not have a sealed completed evidence ledger",
    );
    assertEquals((await store.readClaim(template.submit.request_id))?.state, "running");
    assertEquals(durableWrites, writesBeforePureRead);
    assertEquals(identityProbes, probesBeforePureRead);
    assertEquals(executions, 1);
    assertEquals(lockCalls, 0);
    await store.capacity.updateRequestClaim(completedClaim.request_id, stableJson(completedClaim));

    await assertRejects(
      () => service.getSealedResultSeries({ request_id: template.submit.request_id, uri: "x" }),
      Error,
      "accepts only request_id and optional max_samples",
    );
    await Deno.writeTextFile(
      `${directory}/${(completed.request as { run: { run_id: string } }).run.run_id}/result.csv`,
      "time,waterTemperatureC,heaterPowerW,heaterEnergyJ,heaterOn\n0,0,0,0,0\n",
    );
    await assertRejects(
      () => service.getSealedResultSeries({ request_id: template.submit.request_id }),
      Error,
      "no longer matches its persisted ledger",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
