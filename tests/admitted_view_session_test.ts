import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  isModelicaRecordedAdmittedSessionInput,
  MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
  modelicaAdmittedCanonicalSha256,
  parseModelicaAdmittedExecutionCapture,
  parseModelicaRecordedAdmittedExecutionSession,
} from "../src/ui/results-viewer/src/admitted-recorded-session.ts";
import {
  MODELICA_ADMITTED_RUN_DEFAULT_SURFACE,
  MODELICA_COMPONENTS,
} from "../src/ui/results-viewer/src/component-catalog.ts";
import { parseResultsEnvelope } from "../src/ui/results-viewer/src/model.ts";
import {
  MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
  MODELICA_VIEW_APP_MANIFEST,
} from "../src/ui/results-viewer/src/recorded-session.ts";

const CAPTURE_DIGEST = "b4681bc277dc66505022bde78219feab5300dd018635113e4c648a1ee4b96a07";
const ADMISSION_DIGEST = "f6ecea5b5a341e7a41fd1bdf36068e9413f3a2fd12df2133baafef69b9374336";
const EVIDENCE_DIGEST = "5a66a167ee86f9a4f8faec4d5b55d07658ca5c82f38de7af9eba27b5a63b6cd6";
const RESULT_DIGEST = "cf2d2525e2e7e12d0cea6147abfba34bc24407498f4c96ef9217a3a08c62070c";

Deno.test("provider adapter accepts the exact frozen MCS01 admitted capture", async () => {
  const capture = await loadCapture();
  const data = await parseModelicaAdmittedExecutionCapture(capture);

  assertEquals(await modelicaAdmittedCanonicalSha256(capture), CAPTURE_DIGEST);
  assertEquals(data.captureFingerprint, { algorithm: "sha256", digest: CAPTURE_DIGEST });
  assertEquals(data.rawCapture, capture);
  assertEquals(
    data.capture.admission.admissionArtifact.schemaVersion,
    "technical-compilation-admission-capture/2.0",
  );
  assertEquals(
    data.capture.admission.compilation.document.schemaVersion,
    "technical-compilation/1.0",
  );
  assertEquals(data.anchor, {
    kind: "artifact",
    id: `modelica-admitted-result-${RESULT_DIGEST}`,
    uri: `casys://isolated-output/sha256/${RESULT_DIGEST}`,
    fingerprint: { algorithm: "sha256", digest: RESULT_DIGEST },
  });
  assertThrows(() => parseResultsEnvelope(capture), TypeError);
});

Deno.test("recorded MCS01 session binds basis, anchor, and all four artifact references", async () => {
  const session = availableSession(await loadCapture());

  assertEquals(isModelicaRecordedAdmittedSessionInput(session), true);
  const parsed = await parseModelicaRecordedAdmittedExecutionSession(session);
  assertEquals(parsed.projection.status, "available");
  if (parsed.projection.status !== "available") throw new Error("Expected available MCS01 data.");
  assertEquals(parsed.projection.data.anchor.id, `modelica-admitted-result-${RESULT_DIGEST}`);
  assertEquals(
    parsed.projection.data.recordedProvenance?.captureArtifact?.fingerprint.digest,
    CAPTURE_DIGEST,
  );
  assertEquals(
    parsed.projection.data.recordedProvenance?.evidenceArtifact?.fingerprint.digest,
    EVIDENCE_DIGEST,
  );
  assertEquals(
    parsed.projection.data.recordedProvenance?.resultArtifact?.fingerprint.digest,
    RESULT_DIGEST,
  );
});

Deno.test("recorded admitted session rejects altered authority joins and fingerprints", async () => {
  const mutations: Array<(session: Record<string, unknown>) => void> = [
    (session) => nested(session, "anchor").id = `modelica-admitted-result-${"0".repeat(64)}`,
    (session) =>
      nested(nested(session, "provenance"), "captureArtifact").uri =
        `casys://foreign/sha256/${CAPTURE_DIGEST}`,
    (session) =>
      nested(nested(session, "provenance"), "evidenceArtifact").artifactId =
        `modelica-admitted-evidence-${"0".repeat(64)}`,
    (session) =>
      nested(nested(session, "provenance"), "resultArtifact").uri =
        `casys://isolated-output/sha256/${"0".repeat(64)}`,
    (session) =>
      nested(nested(session, "provenance"), "admissionArtifact").artifactId =
        `technical-compilation-admission-${"0".repeat(64)}`,
    (session) => nested(session, "provenance").runId = "run:foreign",
  ];
  for (const mutate of mutations) {
    const session = availableSession(await loadCapture());
    mutate(session);
    assertEquals(isModelicaRecordedAdmittedSessionInput(session), false);
    await assertRejects(() => parseModelicaRecordedAdmittedExecutionSession(session), TypeError);
  }

  const alteredBytes = availableSession(await loadCapture());
  nested(nested(nested(alteredBytes, "projection"), "capture"), "scenario").stopTimeS = 21;
  assertEquals(isModelicaRecordedAdmittedSessionInput(alteredBytes), true);
  await assertRejects(
    () => parseModelicaRecordedAdmittedExecutionSession(alteredBytes),
    TypeError,
    "capture fingerprint",
  );
});

Deno.test("capture parser rejects nested-version drift and cryptographic receipt drift", async () => {
  const mutations: Array<(capture: Record<string, unknown>) => void> = [
    (capture) =>
      nested(nested(capture, "admission"), "admissionArtifact").schemaVersion =
        "technical-compilation-admission-capture/3.0",
    (capture) =>
      nested(nested(nested(capture, "admission"), "compilation"), "document").schemaVersion =
        "technical-compilation/2.0",
    (capture) => capture.executionRunId = `admitted-modelica-${"0".repeat(64)}`,
    (capture) => nested(nested(capture, "receipt"), "fingerprint").digest = "0".repeat(64),
    (capture) =>
      nested(nested(nested(capture, "receipt"), "publication"), "ref").manifestUri =
        `casys://isolated-output-publication/sha256/${"0".repeat(64)}`,
    (capture) =>
      nested(nested(nested(capture, "receipt"), "publication"), "ref").fingerprint = {
        algorithm: "sha256",
        digest: "0".repeat(64),
      },
    (capture) => {
      const metrics = nestedArray(capture, "metrics");
      nested(metrics[1], "").statistic = "final";
    },
  ];
  for (const mutate of mutations) {
    const capture = await loadCapture();
    mutate(capture);
    await assertRejects(() => parseModelicaAdmittedExecutionCapture(capture), TypeError);
  }
});

Deno.test("admitted default surface remains one bounded object with literal documentary states", async () => {
  const data = await parseModelicaAdmittedExecutionCapture(await loadCapture());
  assertEquals(MODELICA_ADMITTED_RUN_DEFAULT_SURFACE.components, [
    { id: "admitted-run", component: MODELICA_COMPONENTS.admittedRunSummary },
  ]);
  assertEquals(data.capture.admission.compilation.document.status, "ready-for-review");
  assertEquals(data.capture.admission.status, "ready-for-execution-review");
  assertEquals(data.capture.receipt.termination.kind, "exited");
  assertEquals(data.capture.receipt.destruction.status, "proven");
  assertEquals(data.capture.receipt.publication.status, "atomic-batch-published");
  assertEquals(data.capture.receipt.outputs.map((output) => output.validation), [
    "accepted",
    "accepted",
  ]);
  assertEquals(data.capture.receipt.outputs.map((output) => output.persistence), [
    "staged-reread-atomic-commit",
    "staged-reread-atomic-commit",
  ]);
  const renderedFacts = JSON.stringify(data.capture);
  assertEquals(renderedFacts.includes("succeeded"), false);
  assertEquals(renderedFacts.includes('"pass"'), false);
});

Deno.test("only the run resource declares the admitted recorded session schema", () => {
  assertEquals(MODELICA_VIEW_APP_MANIFEST.resources[0].sessionSchemas, [
    MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
    MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
  ]);
  assertEquals(MODELICA_VIEW_APP_MANIFEST.resources[1].sessionSchemas, [
    MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
  ]);
});

Deno.test("non-available admitted projections preserve their literal status", async () => {
  for (
    const status of [
      "pending",
      "running",
      "rejected",
      "recovery_required",
      "unavailable",
      "unresolved",
    ] as const
  ) {
    const session = availableSession(await loadCapture());
    const provenance = nested(session, "provenance");
    provenance.admissionArtifact = null;
    provenance.captureArtifact = null;
    provenance.evidenceArtifact = null;
    provenance.resultArtifact = null;
    session.projection = status === "pending" || status === "running"
      ? { status }
      : { status, reason: `literal ${status}` };
    assertEquals(isModelicaRecordedAdmittedSessionInput(session), true);
    assertEquals(
      (await parseModelicaRecordedAdmittedExecutionSession(session)).projection.status,
      status,
    );
  }
});

async function loadCapture(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/mcs01-modelica-admitted-execution-capture.json", import.meta.url),
    ),
  );
}

function availableSession(capture: Record<string, unknown>): Record<string, unknown> {
  const fingerprint = (digest: string) => ({ algorithm: "sha256", digest });
  const artifact = (artifactId: string, uri: string, digest: string) => ({
    artifactId,
    uri,
    fingerprint: fingerprint(digest),
  });
  return {
    schemaVersion: MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
    kind: "modelica.admitted-execution",
    basis: {
      projectId: "motorized-camera-slider-mcs01",
      projectRevision: 150,
      subjectId: "project:motorized-camera-slider-mcs01",
      thread: {
        id:
          "project:motorized-camera-slider-mcs01:r21:decide-accept-admitted-spice-evaluation-run:queue-mcs01-spice-closeout-r146",
        revision: 21,
      },
    },
    anchor: {
      kind: "artifact",
      id: `modelica-admitted-result-${RESULT_DIGEST}`,
      uri: `casys://isolated-output/sha256/${RESULT_DIGEST}`,
      fingerprint: fingerprint(RESULT_DIGEST),
    },
    provenance: {
      kind: "digital-thread-operation",
      serverId: "digital-thread",
      operation: "simulate.run-admitted-modelica@1",
      runId: "run:queue-mcs01-run-slider-motion-r91",
      admissionArtifact: artifact(
        `technical-compilation-admission-${ADMISSION_DIGEST}`,
        `casys://technical-compilation-admission-capture/sha256/${ADMISSION_DIGEST}`,
        ADMISSION_DIGEST,
      ),
      captureArtifact: artifact(
        `modelica-admitted-capture-${CAPTURE_DIGEST}`,
        `casys://modelica-admitted-execution-capture/sha256/${CAPTURE_DIGEST}`,
        CAPTURE_DIGEST,
      ),
      evidenceArtifact: artifact(
        `modelica-admitted-evidence-${EVIDENCE_DIGEST}`,
        `casys://isolated-output/sha256/${EVIDENCE_DIGEST}`,
        EVIDENCE_DIGEST,
      ),
      resultArtifact: artifact(
        `modelica-admitted-result-${RESULT_DIGEST}`,
        `casys://isolated-output/sha256/${RESULT_DIGEST}`,
        RESULT_DIGEST,
      ),
    },
    projection: { status: "available", capture },
  };
}

function nested(value: unknown, key: string): Record<string, unknown> {
  if (key === "") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Expected test fixture record.");
    }
    return value as Record<string, unknown>;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected test fixture record.");
  }
  return nested((value as Record<string, unknown>)[key], "");
}

function nestedArray(value: unknown, key: string): unknown[] {
  const selected = nested(value, "")[key];
  if (!Array.isArray(selected)) throw new TypeError("Expected test fixture array.");
  return selected;
}
