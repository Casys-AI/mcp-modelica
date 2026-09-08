import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { OpenModelicaRunner } from "../src/api/omc-runner.ts";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { utf8Bytes } from "../src/domain/canonical-utf8.ts";
import { ValidationError } from "../src/domain/errors.ts";
import {
  MODELICA_EVIDENCE_NOTE,
  parseExecutionAttestation,
} from "../src/domain/execution-attestation.ts";
import { sha256, sha256Bytes, stableJson } from "../src/domain/hashing.ts";
import { createModelicaService } from "../src/domain/service.ts";
import type { SimulationRun } from "../src/domain/types.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { FakeRunner, installLegacyRunFixture, LEGACY_RUN_ID, NOMINAL_CSV } from "./test-helpers.ts";

Deno.test("CSV byte variation changes attestation while the input fingerprint stays stable", async () => {
  const csvB = NOMINAL_CSV.replace("94,0,315000,0", "93.5,0,315000,0");
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-bytes-" });
  try {
    const first = await createModelicaService({
      runsDirectory: join(directory, "a"),
      runner: new FakeRunner({
        status: "succeeded",
        diagnostics: "first",
        resultCsv: NOMINAL_CSV,
      }),
    });
    const second = await createModelicaService({
      runsDirectory: join(directory, "b"),
      runner: new FakeRunner({
        status: "succeeded",
        diagnostics: "second",
        resultCsv: csvB,
      }),
    });
    const request = { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" };
    const left = await first.simulate(request);
    const right = await second.simulate(request);
    assertEquals(left.fingerprint, right.fingerprint);
    const leftAttestation = await readRecordedAttestation(join(directory, "a"), left);
    const rightAttestation = await readRecordedAttestation(join(directory, "b"), right);
    assertEquals(leftAttestation.input, {
      kind: "recorded_fingerprint",
      fingerprint: left.fingerprint,
    });
    assertEquals(leftAttestation.raw_csv.status, "captured");
    assertEquals(rightAttestation.raw_csv.status, "captured");
    if (
      leftAttestation.raw_csv.status !== "captured" ||
      rightAttestation.raw_csv.status !== "captured"
    ) {
      throw new Error("expected captured raw CSV attestations");
    }
    assertEquals(leftAttestation.raw_csv.sha256 === rightAttestation.raw_csv.sha256, false);
    assertEquals(leftAttestation.raw_csv.sha256, await sha256(NOMINAL_CSV));
    assertEquals(rightAttestation.raw_csv.sha256, await sha256(csvB));
    assertEquals(leftAttestation.compiler_output, {
      status: "unavailable",
      reason: "runner_seam",
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed and timed-out runs attest absent CSV without inventing output hashes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-failed-" });
  try {
    for (
      const status of ["failed", "timed_out"] as const
    ) {
      const service = await createModelicaService({
        runsDirectory: join(directory, status),
        runner: new FakeRunner({
          status,
          diagnostics: `${status} without CSV`,
        }),
      });
      const run = await service.simulate({
        model_id: "coffee-machine-v1",
        scenario_id: "heat-up-nominal",
      });
      assertEquals(run.status, status);
      assertEquals(run.artifacts.some((artifact) => artifact.kind === "result"), false);
      const attestation = await readRecordedAttestation(join(directory, status), run);
      assertEquals(attestation.status, status);
      assertEquals(attestation.raw_csv, { status: "absent" });
      assertEquals(attestation.compiler_output, {
        status: "unavailable",
        reason: "runner_seam",
      });
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("malformed and tampered recorded attestations fail closed while historical ledgers stay readable", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-replay-" });
  try {
    const fixture = await installLegacyRunFixture(directory);
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    assertEquals(await service.getRun(LEGACY_RUN_ID), fixture.run);

    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    const evidencePath = join(directory, run.run_id, "evidence.json");
    const original = JSON.parse(await Deno.readTextFile(evidencePath)) as Record<string, unknown>;
    const historical = { ...original };
    delete historical.execution_attestation;
    await rewriteRecordedEvidence(directory, run, historical);
    const historicalRun = await service.getRecordedRun(run.run_id);
    assertEquals(historicalRun.fingerprint, run.fingerprint);

    await rewriteRecordedEvidence(directory, run, {
      ...original,
      execution_attestation: {
        ...(original.execution_attestation as Record<string, unknown>),
        injected: true,
      },
    });
    await assertRejects(
      () => service.getRecordedRun(run.run_id),
      ValidationError,
      "unknown field 'injected'",
    );

    await rewriteRecordedEvidence(directory, run, {
      ...original,
      execution_attestation: { schema: "execution-attestation/1.0" },
    });
    await assertRejects(
      () => service.getRecordedRun(run.run_id),
      ValidationError,
      "required field",
    );

    const tampered = structuredClone(original.execution_attestation) as Record<string, unknown>;
    (tampered.raw_csv as Record<string, unknown>).sha256 = "0".repeat(64);
    await rewriteRecordedEvidence(directory, run, {
      ...original,
      execution_attestation: tampered,
    });
    await assertRejects(
      () => service.getRecordedRun(run.run_id),
      ValidationError,
      "raw CSV digest",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay accepts historical evidence without attestation and rejects a forged attestation", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-21-" });
  try {
    const { service, store, legacy } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "historical-attestation");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed" || typeof run.record.run_id !== "string") {
      throw new Error("expected a sealed completed run");
    }
    const recorded = run.record as {
      run_id: string;
      status: string;
      request_id: string;
      manifest: { manifest_sha256: string; engine: Record<string, unknown> };
      metrics: Record<string, unknown>;
      warnings: string[];
      artifacts: Array<Record<string, unknown>>;
    };
    const historicalEvidence = stableJson({
      producer: "mcp-modelica",
      status: recorded.status,
      request_id: recorded.request_id,
      manifest_sha256: recorded.manifest.manifest_sha256,
      metrics: recorded.metrics,
      warnings: recorded.warnings,
      note: MODELICA_EVIDENCE_NOTE,
    });
    await replaceResumableEvidence(store, input.request_id, recorded, claim, historicalEvidence);
    const historical = await service.getRequest({ request_id: input.request_id });
    assertEquals((historical.request as { status: string }).status, "completed");

    const forged = JSON.parse(historicalEvidence) as Record<string, unknown>;
    forged.execution_attestation = {
      schema: "execution-attestation/1.0",
      input: {
        kind: "resumable_request",
        request_id: input.request_id,
        request_sha256: claim.request_sha256,
      },
      engine: recorded.manifest.engine,
      script_sha256: "0".repeat(64),
      status: recorded.status,
      raw_csv: { status: "absent" },
      compiler_output: { status: "unavailable", reason: "runner_seam" },
    };
    await replaceResumableEvidence(
      store,
      input.request_id,
      recorded,
      claim,
      stableJson(forged),
    );
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "execution_attestation",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 keeps a failed terminal record when captured CSV cannot be normalized", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-21-normalize-" });
  try {
    const invalidCsv = "time,not_coffee\n0,1\n";
    const csvDigest = await sha256(invalidCsv);
    const empty = await sha256Bytes(new Uint8Array());
    const { service, store, legacy } = await resumableFixture(
      directory,
      new FakeRunner({
        status: "succeeded",
        diagnostics: "invalid columns",
        resultCsv: invalidCsv,
        rawOutput: {
          capture: "captured",
          stdout_sha256: empty,
          stderr_sha256: empty,
          result_csv: { status: "captured", sha256: csvDigest },
        },
      }),
    );
    const input = await explicitInput(legacy, service, "captured-normalize-fail");
    const result = await service.submit(input);
    const request = result.request as {
      status: string;
      run?: { status: string; artifacts: Array<{ kind: string }> };
    };
    assertEquals(request.status, "completed");
    assertEquals(request.run?.status, "failed");
    assertEquals(request.run?.artifacts.some((artifact) => artifact.kind === "result"), false);
    const persisted = await store.readRunRecord(input.request_id);
    if (!persisted || typeof persisted.record.run_id !== "string") {
      throw new Error("expected a sealed failed run.json");
    }
    const evidencePath = join(directory, persisted.record.run_id, "evidence.json");
    const attestation = parseExecutionAttestation(
      JSON.parse(await Deno.readTextFile(evidencePath)).execution_attestation,
    );
    assertEquals(attestation.status, "failed");
    assertEquals(attestation.raw_csv, { status: "captured", sha256: csvDigest });
    assertEquals(attestation.compiler_output, {
      status: "captured",
      stdout_sha256: empty,
      stderr_sha256: empty,
    });
    const replayed = await service.getRequest({ request_id: input.request_id });
    assertEquals((replayed.request as { status: string }).status, "completed");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("invalid UTF-8 CSV attests rejected raw bytes instead of absent", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-utf8-" });
  try {
    const command = await fakeOmcWithIdentity(directory, "printf '\\377' > result_res.csv\n");
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new OpenModelicaRunner(command, directory),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    assertEquals(run.status, "failed");
    assertEquals(run.artifacts.some((artifact) => artifact.kind === "result"), false);
    const attestation = await readRecordedAttestation(directory, run);
    assertEquals(attestation.raw_csv, {
      status: "rejected",
      sha256: await sha256Bytes(new Uint8Array([0xff])),
    });
    assertEquals(attestation.compiler_output.status, "captured");
    assertEquals((await service.getRecordedRun(run.run_id)).status, "failed");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed timeout and missing CSV attest the literal runner capture", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-capture-" });
  try {
    const empty = await sha256Bytes(new Uint8Array());
    const cases = [
      {
        name: "failed-no-csv",
        output: {
          status: "failed" as const,
          diagnostics: "no csv",
          rawOutput: {
            capture: "captured" as const,
            stdout_sha256: empty,
            stderr_sha256: empty,
            result_csv: { status: "absent" as const },
          },
        },
        rawCsv: { status: "absent" as const },
        compiler: {
          status: "captured" as const,
          stdout_sha256: empty,
          stderr_sha256: empty,
        },
      },
      {
        name: "timeout-without-output",
        output: {
          status: "timed_out" as const,
          diagnostics: "timeout",
          rawOutput: {
            capture: "unavailable" as const,
            reason: "timed_out_without_output" as const,
          },
        },
        rawCsv: { status: "absent" as const },
        compiler: { status: "unavailable" as const, reason: "timed_out_without_output" as const },
      },
    ];
    for (const testCase of cases) {
      const service = await createModelicaService({
        runsDirectory: join(directory, testCase.name),
        runner: new FakeRunner(testCase.output),
      });
      const run = await service.simulate({
        model_id: "coffee-machine-v1",
        scenario_id: "heat-up-nominal",
      });
      assertEquals(run.status, testCase.output.status);
      const attestation = await readRecordedAttestation(join(directory, testCase.name), run);
      assertEquals(attestation.raw_csv, testCase.rawCsv);
      assertEquals(attestation.compiler_output, testCase.compiler);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("2.1 replay rejects a resealed tampered attestation on the persisted service path", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-21-tamper-" });
  try {
    const { service, store, legacy } = await resumableFixture(directory);
    const input = await explicitInput(legacy, service, "attestation-tamper");
    await service.submit(input);
    const run = await store.readRunRecord(input.request_id);
    const claim = await store.readClaim(input.request_id);
    if (!run || claim?.state !== "completed" || typeof run.record.run_id !== "string") {
      throw new Error("expected a sealed completed run");
    }
    const recorded = run.record as {
      run_id: string;
      artifacts: Array<Record<string, unknown>>;
    };
    const evidencePath = join(directory, recorded.run_id, "evidence.json");
    const original = JSON.parse(await Deno.readTextFile(evidencePath)) as Record<string, unknown>;
    const tampered = structuredClone(original.execution_attestation) as Record<string, unknown>;
    tampered.script_sha256 = "0".repeat(64);
    await replaceResumableEvidence(
      store,
      input.request_id,
      recorded,
      claim,
      stableJson({ ...original, execution_attestation: tampered }),
    );
    await assertRejects(
      () => service.getRequest({ request_id: input.request_id }),
      Error,
      "script digest",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("captured runner CSV digest must equal persisted bytes; mismatch fails closed", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-attestation-mismatch-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner({
        status: "succeeded",
        diagnostics: "captured",
        resultCsv: NOMINAL_CSV,
        rawOutput: {
          capture: "captured",
          stdout_sha256: await sha256Bytes(new Uint8Array()),
          stderr_sha256: await sha256Bytes(new Uint8Array()),
          result_csv: { status: "captured", sha256: "0".repeat(64) },
        },
      }),
    });
    await assertRejects(
      () =>
        service.simulate({
          model_id: "coffee-machine-v1",
          scenario_id: "heat-up-nominal",
        }),
      ValidationError,
      "Captured raw CSV digest",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function readRecordedAttestation(runsDirectory: string, run: SimulationRun) {
  const source = await Deno.readTextFile(join(runsDirectory, run.run_id, "evidence.json"));
  const evidence = JSON.parse(source) as { execution_attestation: unknown };
  return parseExecutionAttestation(evidence.execution_attestation);
}

async function rewriteRecordedEvidence(
  runsDirectory: string,
  run: SimulationRun,
  evidence: Record<string, unknown>,
): Promise<void> {
  const source = stableJson(evidence);
  await Deno.writeTextFile(join(runsDirectory, run.run_id, "evidence.json"), source);
  const digest = await sha256(source);
  const updated = {
    ...run,
    artifacts: run.artifacts.map((artifact) =>
      artifact.kind === "evidence"
        ? { ...artifact, sha256: digest, bytes: utf8Bytes(source) }
        : artifact
    ),
  };
  await Deno.writeTextFile(join(runsDirectory, run.run_id, "run.json"), stableJson(updated));
}

async function resumableFixture(directory: string, runner: FakeRunner = new FakeRunner()) {
  const legacy = await createModelicaService({
    runsDirectory: directory,
    runner,
  });
  const store = new RequestStore(directory);
  return {
    legacy,
    store,
    service: new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
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

async function replaceResumableEvidence(
  store: RequestStore,
  requestId: string,
  recorded: {
    run_id: string;
    artifacts: Array<Record<string, unknown>>;
  },
  claim: NonNullable<Awaited<ReturnType<RequestStore["readClaim"]>>>,
  evidence: string,
): Promise<void> {
  const evidenceArtifact = await store.writeRunArtifact(
    requestId,
    recorded.run_id,
    "evidence",
    "evidence.json",
    "application/json",
    evidence,
  );
  const forged = {
    ...(await store.readRunRecord(requestId))!.record,
    artifacts: recorded.artifacts.map((artifact) =>
      artifact.kind === "evidence"
        ? evidenceArtifact as unknown as Record<string, unknown>
        : artifact
    ),
  };
  await store.writeRunRecord(requestId, forged);
  const persisted = await store.readRunRecord(requestId);
  if (!persisted || claim.state !== "completed") throw new Error("expected completed claim");
  await store.capacity.updateRequestClaim(
    requestId,
    stableJson({
      ...claim,
      run_json_sha256: persisted.sha256,
      run_json_bytes: persisted.bytes,
    }),
  );
}

async function fakeOmcWithIdentity(directory: string, body: string): Promise<string> {
  const command = join(directory, "fake-omc.sh");
  await Deno.writeTextFile(
    command,
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "${1-}" = "--version" ]; then',
      "  printf 'OpenModelica 1.27.0\\n'",
      "  exit 0",
      "fi",
      'case "$1" in',
      "  *probe.mos)",
      "    printf '\"4.1.0\"\\n'",
      "    exit 0",
      "    ;;",
      "esac",
      body,
    ].join("\n") + "\n",
  );
  await Deno.chmod(command, 0o755);
  return command;
}
