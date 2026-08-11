import { assert, assertEquals, assertRejects } from "@std/assert";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { sha256, stableJson } from "../src/domain/hashing.ts";
import type { ManifestResource } from "../src/domain/simulation-manifest.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("2.1 uses a real OS request lock and persists one idempotent qualified run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-" });
  try {
    const legacy = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const store = new RequestStore(directory);
    const locks = new FileRequestLockPort(store.locksDirectory);
    const first = await locks.acquire("os-lock-smoke");
    assert(first, "the configured Perl helper must acquire a kernel OS lock");
    assertEquals(await locks.acquire("os-lock-smoke"), undefined);
    await first.release();

    const service = new ResumableSimulationService(
      legacy,
      store,
      locks,
      new FileSimulationWorkspace(directory, legacy.getSimulationRunner()),
    );
    const manifest = await service.getManifest({
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    });
    const parameters = Object.fromEntries(
      legacy.listKits()[0].parameters.map((parameter) => [parameter.id, parameter.default]),
    );
    const input = {
      request_id: "docker-lock-smoke",
      manifest_sha256: manifest.manifest_sha256,
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
      parameters,
      timeout_ms: 30_000,
    };
    const completed = await service.submit(input);
    const run = (completed.request as { status: string; run: { run_id: string } }).run;
    assertEquals((completed.request as { status: string }).status, "completed");
    assert(typeof run.run_id === "string");
    const retried = await service.submit(input);
    assertEquals((retried.request as { run: { run_id: string } }).run.run_id, run.run_id);
    await assertRejects(
      () =>
        service.submit({
          ...input,
          parameters: { ...parameters, water_mass: { value: 0.7, unit: "kg" } },
        }),
      Error,
      "different canonical request bytes",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 rejects every pre-claim validation failure without a claim or run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-preclaim-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "preclaim-rejected");
    await assertRejects(
      () => service.submit({ ...input, manifest_sha256: "not-a-digest" }),
      Error,
      "manifest_sha256 must be a lowercase SHA-256 digest",
    );
    assertEquals(await store.readClaim(input.request_id), undefined);
    await assertRejects(
      () => service.submit({ ...input, parameters: { water_mass: { value: 0.5, unit: "kg" } } }),
      Error,
      "every qualified parameter",
    );
    assertEquals(await store.readClaim(input.request_id), undefined);
    const entries: string[] = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry.name);
    assertEquals(entries.filter((name) => name.startsWith("run_")).length, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("manifest drift after claim is an immutable rejected request and releases capacity", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-rejected-" });
  try {
    for (let index = 0; index < 19; index++) {
      await Deno.mkdir(`${directory}/run_${crypto.randomUUID()}`);
    }
    const runner = new FakeRunner();
    let executions = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (runnerInput) => {
      executions++;
      return await execute(runnerInput);
    };
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const runtimeIdentity = legacy.getRuntimeEngineIdentity.bind(legacy);
    let engine = await runtimeIdentity();
    let probes = 0;
    legacy.getRuntimeEngineIdentity = () => {
      probes++;
      return Promise.resolve({ ...engine });
    };
    const input = await explicitInput(legacy, service, "postclaim-manifest-drift");
    const canonical = await importCanonical(input);
    probes = 0;
    engine = { ...engine, version: `${engine.version}-drifted` };

    const rejected = await service.submit(input);
    assertEquals(rejected.request, {
      request_id: input.request_id,
      request_sha256: canonical.request_sha256,
      manifest_sha256: input.manifest_sha256,
      status: "rejected",
      rejection: "manifest_mismatch",
    });
    assertEquals(probes, 1);
    assertEquals(executions, 0);
    const sealed = await store.readClaim(input.request_id);
    assertEquals(sealed?.state, "rejected");
    assertEquals(sealed?.slot_reserved, false);

    assertEquals(await service.submit(input), rejected);
    assertEquals(await service.getRequest({ request_id: input.request_id }), rejected);
    assertEquals(probes, 1, "exact rejected retry/request_get must not probe OMC");
    assertEquals(executions, 0);
    assertEquals(await store.readClaim(input.request_id), sealed);
    await assertRejects(
      () => service.submit({ ...input, timeout_ms: input.timeout_ms - 1 }),
      Error,
      "different canonical request bytes",
    );
    assertEquals(probes, 1, "request-id collision must fail before probing OMC");
    assertEquals(await store.readClaim(input.request_id), sealed);

    const releasedSlot = await store.capacity.reserve("legacy", "slot-after-rejection");
    await releasedSlot.release();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("only the claim owner probes OMC; loser and completed retries never do", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-owner-probe-" });
  try {
    const runner = new FakeRunner();
    let executions = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (runnerInput) => {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 75));
      return await execute(runnerInput);
    };
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const getIdentity = legacy.getRuntimeEngineIdentity.bind(legacy);
    let probes = 0;
    legacy.getRuntimeEngineIdentity = async () => {
      probes++;
      return await getIdentity();
    };
    const input = await explicitInput(legacy, service, "single-owner-runtime-probe");
    probes = 0;

    const concurrent = await Promise.all([service.submit(input), service.submit(input)]);
    assertEquals(executions, 1);
    assertEquals(probes, 1);
    assert(
      concurrent.some((result) => (result.request as { status: string }).status === "completed"),
    );
    const completed = await service.submit(input);
    assertEquals((completed.request as { status: string }).status, "completed");
    assertEquals(
      (await service.getRequest({ request_id: input.request_id }).then((result) =>
        result.request
      ) as {
        status: string;
      }).status,
      "completed",
    );
    assertEquals(probes, 1, "completed retry and request_get must use historical sealed evidence");
    assertEquals(executions, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("promotion cannot overwrite a rejected claim installed during the runtime probe", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-promotion-cas-" });
  try {
    const runner = new FakeRunner();
    let executions = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      executions++;
      return await execute(input);
    };
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const input = await explicitInput(legacy, service, "claim-rejected-during-probe");
    const getIdentity = legacy.getRuntimeEngineIdentity.bind(legacy);
    let rejectedSource = "";
    legacy.getRuntimeEngineIdentity = async () => {
      const current = await store.readClaim(input.request_id);
      if (current?.state !== "claimed") throw new Error("expected a claimed request during probe");
      const rejected = {
        ...current,
        state: "rejected" as const,
        slot_reserved: false as const,
        rejection: "manifest_mismatch" as const,
      };
      rejectedSource = stableJson(rejected);
      await store.capacity.updateRequestClaim(input.request_id, rejectedSource);
      return await getIdentity();
    };

    await assertRejects(
      () => service.submit(input),
      Error,
      "changed before promotion",
    );
    assertEquals(executions, 0);
    const claimPath = await store.capacity.requestClaimPath(input.request_id);
    assertEquals(await Deno.readTextFile(claimPath), rejectedSource);
    assertEquals((await store.readClaim(input.request_id))?.state, "rejected");
    assertEquals(await rootRunDirectories(directory), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("promotion requires byte-identical claimed evidence, not only equal parsed fields", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-byte-cas-" });
  try {
    const runner = new FakeRunner();
    let executions = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      executions++;
      return await execute(input);
    };
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const input = await explicitInput(legacy, service, "claim-bytes-change-during-probe");
    const getIdentity = legacy.getRuntimeEngineIdentity.bind(legacy);
    let divergentSource = "";
    legacy.getRuntimeEngineIdentity = async () => {
      const current = await store.readClaim(input.request_id);
      if (current?.state !== "claimed") throw new Error("expected a claimed request during probe");
      // Same parsed claim, deliberately different persisted bytes. The opaque
      // reservation receipt must compare the exact source it originally saw.
      divergentSource = JSON.stringify(current);
      assert(divergentSource !== stableJson(current));
      await store.capacity.updateRequestClaim(input.request_id, divergentSource);
      return await getIdentity();
    };

    await assertRejects(
      () => service.submit(input),
      Error,
      "changed before promotion",
    );
    assertEquals(executions, 0);
    const claimPath = await store.capacity.requestClaimPath(input.request_id);
    assertEquals(await Deno.readTextFile(claimPath), divergentSource);
    assertEquals(await rootRunDirectories(directory), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a stale rejection transition cannot rewrite stronger terminal evidence", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-stale-reject-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "stale-rejection-transition");
    const claimed = await store.claimOrRead(await importCanonical(input));
    if (!claimed.reservation || claimed.claim.state !== "claimed") {
      throw new Error("expected a fresh claimed reservation");
    }
    const completed = {
      ...claimed.claim,
      state: "completed" as const,
      slot_reserved: false as const,
      run_id: `run_${crypto.randomUUID()}`,
      run_json_sha256: "0".repeat(64),
      run_json_bytes: 1,
    };
    await overwriteClaimForTest(store, completed);
    await assertRejects(
      () =>
        store.rejectClaim(claimed.reservation!, {
          schemaVersion: claimed.claim.schemaVersion,
          kind: claimed.claim.kind,
          request_id: claimed.claim.request_id,
          request_sha256: claimed.claim.request_sha256,
          manifest_sha256: claimed.claim.manifest_sha256,
          state: "rejected",
          slot_reserved: false,
          rejection: "manifest_mismatch",
        }),
      Error,
      "changed before rejection",
    );
    assertEquals(await store.readClaim(input.request_id), completed);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("request_get reconciles a committed run without rerunning and owner loss is recovery_required", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-reconcile-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "same-process-reconcile");
    const completed = await service.submit(input);
    const completedClaim = await store.readClaim(input.request_id);
    if (completedClaim?.state !== "completed") {
      throw new Error("expected completed request claim");
    }
    await overwriteClaimForTest(store, runningClaimForTest(completedClaim));
    const reconciled = await service.getRequest({ request_id: input.request_id });
    assertEquals((reconciled.request as { status: string }).status, "completed");
    assertEquals(
      (reconciled.request as { run: { run_id: string } }).run.run_id,
      (completed.request as { run: { run_id: string } }).run.run_id,
    );

    const crashedInput = await explicitInput(legacy, service, "owner-crash-no-ledger");
    await store.claimOrRead(await importCanonical(crashedInput));
    const pending = await service.getRequest({ request_id: crashedInput.request_id });
    assertEquals((pending.request as { status: string }).status, "pending");
    assertEquals((await store.readClaim(crashedInput.request_id))?.state, "claimed");
    const safeRetry = await service.submit(crashedInput);
    assertEquals((safeRetry.request as { status: string }).status, "completed");

    const startedInput = await explicitInput(legacy, service, "owner-crash-after-promote");
    const started = await store.claimOrRead(await importCanonical(startedInput));
    if (!started.reservation || started.claim.state !== "claimed") {
      throw new Error("expected a new durable capacity reservation");
    }
    const abandonedRunId = `run_${crypto.randomUUID()}`;
    await store.promoteClaim(
      started.reservation,
      {
        ...started.claim,
        state: "promoting",
        slot_reserved: true,
        run_id: abandonedRunId,
      },
    );
    const recovered = await service.getRequest({ request_id: startedInput.request_id });
    assertEquals((recovered.request as { status: string }).status, "recovery_required");
    assertEquals(await store.readRunRecord(startedInput.request_id), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("capacity authority is shared between new resumable and historical simulate", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-capacity-" });
  try {
    for (let index = 0; index < 19; index++) {
      await Deno.mkdir(`${directory}/run_${crypto.randomUUID()}`);
    }
    const { legacy, service } = await resumableFixture(directory);
    await service.submit(await explicitInput(legacy, service, "new-fills-twentieth-slot"));
    await assertRejects(
      () => legacy.simulate({ model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" }),
      Error,
      "limit 20",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("promoting crash state reuses one run_id and one capacity slot", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-promoting-" });
  try {
    for (let index = 0; index < 19; index++) {
      await Deno.mkdir(`${directory}/run_${crypto.randomUUID()}`);
    }
    const runner = new FakeRunner();
    let executions = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      executions++;
      return await execute(input);
    };
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const input = await explicitInput(legacy, service, "promoting-crash-retry");
    const claimed = await store.claimOrRead(await importCanonical(input));
    if (claimed.claim.state !== "claimed") throw new Error("expected a new claimed request");
    const promotedRunId = `run_${crypto.randomUUID()}`;
    await overwriteClaimForTest(store, {
      ...claimed.claim,
      state: "promoting",
      slot_reserved: true,
      run_id: promotedRunId,
    });
    // Exact crash point: promoting claim was fsynced, mkdir was durable, but
    // the final running transition was not written and OMC never started.
    await Deno.mkdir(`${directory}/${promotedRunId}`);

    const blocked = await explicitInput(legacy, service, "promoting-capacity-blocked");
    await assertRejects(() => service.submit(blocked), Error, "limit 20");
    assertEquals(executions, 0);
    assertEquals(await store.readClaim(blocked.request_id), undefined);

    const completed = await service.submit(input);
    assertEquals(executions, 1);
    assertEquals(
      (completed.request as { run: { run_id: string } }).run.run_id,
      promotedRunId,
    );
    assertEquals((await store.readClaim(input.request_id))?.state, "completed");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 rejects a source A-to-B-to-A change before OMC starts", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-source-toctou-" });
  try {
    const runner = new FakeRunner();
    let executions = 0;
    const execute = runner.execute.bind(runner);
    runner.execute = async (input) => {
      executions++;
      return await execute(input);
    };
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const input = await explicitInput(legacy, service, "source-a-b-a");
    const readModel = legacy.readQualifiedModelSource.bind(legacy);
    let readsAfterManifest = 0;
    legacy.readQualifiedModelSource = async (modelId, version) => {
      const original = await readModel(modelId, version);
      readsAfterManifest++;
      // CoffeeMachine's parameter-schema read calls the same source port once
      // while rebuilding the manifest. The third read is the fresh artifact
      // read immediately before the runner; all following reads return A.
      if (readsAfterManifest !== 3) return original;
      const source = `${original.source}\n`;
      return {
        ...original,
        source,
        bytes: new TextEncoder().encode(source).byteLength,
        sha256: await sha256(source),
      };
    };
    await assertRejects(
      () => service.submit(input),
      Error,
      "Qualified source bytes changed after manifest sealing",
    );
    assertEquals(executions, 0);
    const returnedToA = await legacy.readQualifiedModelSource("coffee-machine-v1", "0.1.0");
    assertEquals(
      returnedToA.sha256,
      (await service.getManifest({
        model_id: "coffee-machine-v1",
        model_version: "0.1.0",
        scenario_id: "heat-up-nominal",
      })).model.source.sha256,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay rejects self-consistent forged CSV metrics and evidence", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-csv-replay-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "csv-replay-forgery");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed" || typeof run.record.run_id !== "string") {
      throw new Error("expected a sealed completed run");
    }
    const forged = structuredClone(run.record) as {
      run_id: string;
      status: string;
      manifest: { manifest_sha256: string };
      metrics: Record<string, { value: number; unit: string }>;
      warnings: string[];
      artifacts: Array<Record<string, unknown>>;
    };
    forged.metrics.water_temperature_max = { value: 99, unit: "degC" };
    const evidence = stableJson({
      producer: "mcp-modelica",
      status: forged.status,
      request_id: input.request_id,
      manifest_sha256: forged.manifest.manifest_sha256,
      metrics: forged.metrics,
      warnings: forged.warnings,
      note:
        "This is computed evidence only. Requirement pass/fail belongs to mcp-syson and @casys/constraint-solver.",
    });
    const evidenceArtifact = await store.writeRunArtifact(
      input.request_id,
      forged.run_id,
      "evidence",
      "evidence.json",
      "application/json",
      evidence,
    );
    forged.artifacts = forged.artifacts.map((artifact) =>
      artifact.kind === "evidence"
        ? evidenceArtifact as unknown as Record<string, unknown>
        : artifact
    );
    await store.writeRunRecord(input.request_id, forged);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted) throw new Error("forged run record was not persisted");
    await overwriteClaimForTest(store, {
      ...claim,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    });
    const sealedClaim = await store.readClaim(input.request_id);
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "metrics do not equal the re-normalized exact result.csv",
    );
    assertEquals(await store.readClaim(input.request_id), sealedClaim);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay rejects a resolved-parameters artifact forged with its run record", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-parameters-replay-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "parameters-replay-forgery");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed" || typeof run.record.run_id !== "string") {
      throw new Error("expected a sealed completed run");
    }
    const forged = structuredClone(run.record) as {
      run_id: string;
      resolved_parameters: Record<string, { value: number; unit: string }>;
      artifacts: Array<Record<string, unknown>>;
    };
    forged.resolved_parameters.water_mass = { value: 0.6, unit: "kg" };
    const parametersArtifact = await store.writeRunArtifact(
      input.request_id,
      forged.run_id,
      "resolved_parameters",
      "resolved-parameters.json",
      "application/json",
      stableJson(forged.resolved_parameters),
    );
    forged.artifacts = forged.artifacts.map((artifact) =>
      artifact.kind === "resolved_parameters"
        ? parametersArtifact as unknown as Record<string, unknown>
        : artifact
    );
    await store.writeRunRecord(input.request_id, forged);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted) throw new Error("forged run record was not persisted");
    await overwriteClaimForTest(store, {
      ...claim,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    });
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "resolved parameters do not match its exact request artifact",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay regenerates and rejects a self-sealed forged run.mos", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-script-replay-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "script-replay-forgery");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed" || typeof run.record.run_id !== "string") {
      throw new Error("expected a sealed completed run");
    }
    const forged = structuredClone(run.record) as {
      run_id: string;
      artifacts: Array<Record<string, unknown>>;
    };
    const scriptArtifact = await store.writeRunArtifact(
      input.request_id,
      forged.run_id,
      "script",
      "run.mos",
      "text/plain",
      "// self-consistent but foreign lowering\n",
    );
    forged.artifacts = forged.artifacts.map((artifact) =>
      artifact.kind === "script" ? scriptArtifact as unknown as Record<string, unknown> : artifact
    );
    await store.writeRunRecord(input.request_id, forged);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted) throw new Error("forged run record was not persisted");
    await overwriteClaimForTest(store, {
      ...claim,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    });
    const sealedClaim = await store.readClaim(input.request_id);
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "run.mos does not equal the sealed lowering",
    );
    assertEquals(await store.readClaim(input.request_id), sealedClaim);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay binds the exact request model and scenario to its manifest", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-request-link-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "request-manifest-link-forgery");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed") throw new Error("expected a sealed completed run");
    const foreignRequest = await importCanonical({
      ...input,
      model_id: "linear-thermal-ramp-v1",
      scenario_id: "linear-ramp-nominal",
    });
    const requestArtifact = await store.writeRequestArtifact(foreignRequest);
    const forged = structuredClone(run.record) as {
      request_sha256: string;
      artifacts: Array<Record<string, unknown>>;
    };
    forged.request_sha256 = foreignRequest.request_sha256;
    forged.artifacts = forged.artifacts.map((artifact) =>
      artifact.kind === "request" ? requestArtifact as unknown as Record<string, unknown> : artifact
    );
    await store.writeRunRecord(input.request_id, forged);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted) throw new Error("forged run record was not persisted");
    await overwriteClaimForTest(store, {
      ...claim,
      request_sha256: foreignRequest.request_sha256,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    });
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "exact manifest selection",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay rejects a self-sealed source artifact tuple foreign to its manifest", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-source-ledger-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "source-ledger-forgery");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed") throw new Error("expected a sealed completed run");
    const forged = structuredClone(run.record) as {
      artifacts: Array<Record<string, unknown>>;
    };
    const model = forged.artifacts.find((artifact) => artifact.kind === "model");
    if (!model || !model.source_resource || typeof model.source_resource !== "object") {
      throw new Error("expected model source-resource tuple");
    }
    (model.source_resource as Record<string, unknown>).uri =
      "casys://modelica/kits/foreign/1/model.mo";
    await store.writeRunRecord(input.request_id, forged);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted) throw new Error("forged run record was not persisted");
    await overwriteClaimForTest(store, {
      ...claim,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    });
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "source artifact does not match the sealed manifest resource tuple",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay rejects self-consistent source bytes foreign to the sealed manifest", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-source-bytes-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "source-bytes-forgery");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed" || typeof run.record.run_id !== "string") {
      throw new Error("expected a sealed completed run");
    }
    const forged = structuredClone(run.record) as {
      run_id: string;
      manifest: { model: { name: string; source: Record<string, unknown> } };
      artifacts: Array<Record<string, unknown>>;
    };
    const modelArtifact = forged.artifacts.find((artifact) => artifact.kind === "model");
    if (!modelArtifact || typeof modelArtifact.file_name !== "string") {
      throw new Error("expected a model artifact");
    }
    const foreignModel = await store.writeRunArtifact(
      input.request_id,
      forged.run_id,
      "model",
      modelArtifact.file_name,
      "text/x-modelica",
      "within Foreign; model Evidence end Evidence; end Foreign;\n",
      "qualified-kit",
      forged.manifest.model.source as unknown as ManifestResource,
    );
    forged.artifacts = forged.artifacts.map((artifact) =>
      artifact.kind === "model" ? foreignModel as unknown as Record<string, unknown> : artifact
    );
    await store.writeRunRecord(input.request_id, forged);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted) throw new Error("forged run record was not persisted");
    await overwriteClaimForTest(store, {
      ...claim,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    });
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "source artifact does not match the sealed manifest resource tuple",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 preserves a completed claim when its sealed run.json is missing", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-missing-ledger-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "missing-completed-ledger");
    await service.submit(input);
    const sealed = await store.readClaim(input.request_id);
    await Deno.remove(store.runRecordPath(input.request_id));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assertRejects(
        () => service.getRequest({ request_id: input.request_id }),
        Error,
        "Completed simulation request claim seals a run.json that is missing",
      );
      assertEquals(await store.readClaim(input.request_id), sealed);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("completed claim seals run_id, SHA, and size and is never rewritten", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-seal-" });
  try {
    const { legacy, service, store } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "completed-seal-immutable");
    await service.submit(input);
    const sealed = await store.readClaim(input.request_id);
    if (
      !sealed?.run_id || sealed.run_json_sha256 === undefined ||
      sealed.run_json_bytes === undefined
    ) {
      throw new Error("expected a completed claim with an exact run seal");
    }
    await assertRejects(
      () => store.writeClaim({ ...sealed, run_json_bytes: sealed.run_json_bytes! + 1 }),
      Error,
      "immutable",
    );
    assertEquals(await store.readClaim(input.request_id), sealed);

    const corruptions = [
      { ...sealed, run_id: `run_${crypto.randomUUID()}` },
      { ...sealed, run_json_sha256: "0".repeat(64) },
      { ...sealed, run_json_bytes: sealed.run_json_bytes + 1 },
    ];
    for (const corrupted of corruptions) {
      await overwriteClaimForTest(store, corrupted);
      const before = await store.readClaim(input.request_id);
      for (let attempt = 0; attempt < 2; attempt++) {
        await assertRejects(
          () => service.getRequest({ request_id: input.request_id }),
          Error,
        );
        assertEquals(await store.readClaim(input.request_id), before);
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function resumableFixture(directory: string) {
  const legacy = await createModelicaService({
    runsDirectory: directory,
    runner: new FakeRunner(),
  });
  const store = new RequestStore(directory);
  const locks = new FileRequestLockPort(store.locksDirectory);
  return {
    legacy,
    store,
    service: new ResumableSimulationService(
      legacy,
      store,
      locks,
      new FileSimulationWorkspace(directory, legacy.getSimulationRunner()),
    ),
  };
}

async function explicitInput(
  legacy: Awaited<ReturnType<typeof createModelicaService>>,
  service: ResumableSimulationService,
  requestId: string,
) {
  const manifest = await service.getManifest({
    model_id: "coffee-machine-v1",
    model_version: "0.1.0",
    scenario_id: "heat-up-nominal",
  });
  return {
    request_id: requestId,
    manifest_sha256: manifest.manifest_sha256,
    model_id: "coffee-machine-v1",
    model_version: "0.1.0",
    scenario_id: "heat-up-nominal",
    parameters: Object.fromEntries(
      legacy.listKits()[0].parameters.map((parameter) => [parameter.id, parameter.default]),
    ),
    timeout_ms: 30_000,
  };
}

async function importCanonical(input: Record<string, unknown>) {
  const { parseCanonicalSimulationRequest } = await import("../src/domain/simulation-request.ts");
  return await parseCanonicalSimulationRequest(input);
}

async function overwriteClaimForTest(
  store: RequestStore,
  claim: NonNullable<Awaited<ReturnType<RequestStore["readClaim"]>>>,
): Promise<void> {
  await store.capacity.updateRequestClaim(claim.request_id, stableJson(claim));
}

function runningClaimForTest(
  claim: Extract<NonNullable<Awaited<ReturnType<RequestStore["readClaim"]>>>, {
    state: "completed";
  }>,
): Extract<NonNullable<Awaited<ReturnType<RequestStore["readClaim"]>>>, { state: "running" }> {
  const { run_json_sha256: _sha256, run_json_bytes: _bytes, ...identity } = claim;
  return { ...identity, state: "running", slot_reserved: false };
}

async function rootRunDirectories(directory: string): Promise<string[]> {
  const runs: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory && entry.name.startsWith("run_")) runs.push(entry.name);
  }
  return runs.sort();
}
