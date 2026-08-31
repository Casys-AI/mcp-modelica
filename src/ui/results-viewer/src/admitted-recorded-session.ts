import { isDenseJsonArray } from "./strict-json.ts";

export const MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA =
  "modelica-admitted-execution-capture/2.0" as const;
export const MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA =
  "io.casys.mcp-modelica.recorded-admitted-execution-session/1.0" as const;

const RECORDED_OPERATION = "simulate.run-admitted-modelica@1" as const;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CAPTURE_PARAMETERS = 256;
const MAX_CAPTURE_METRICS = 512;
const LIMIT_KEYS = [
  "maxWallTimeMs",
  "maxCpuTimeMs",
  "maxMemoryBytes",
  "maxProcesses",
  "maxStdoutBytes",
  "maxStderrBytes",
  "maxOutputFileBytes",
  "maxOutputTotalBytes",
] as const;

export interface ModelicaContentFingerprint {
  readonly algorithm: "sha256";
  readonly digest: string;
}

export interface ModelicaAdmittedMetric {
  readonly outputName: string;
  readonly statistic: "final" | "max_abs";
  readonly value: number;
  readonly unit: string;
}

export interface ModelicaAdmittedParameter {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

export interface ModelicaAdmittedOutputArtifact {
  readonly role: "evidence" | "result";
  readonly basename: "evidence.json" | "result.csv";
  readonly mediaType: "application/json" | "text/csv";
  readonly format: "modelica-isolated-evidence-v2" | "openmodelica-result-csv";
  readonly byteCount: number;
  readonly sha256: string;
  readonly casUri: string;
  readonly validation: "accepted";
  readonly persistence: "staged-reread-atomic-commit";
}

export type ModelicaAdmittedTermination =
  | { readonly kind: "exited"; readonly exitCode: number; readonly signal: null }
  | { readonly kind: "signaled"; readonly exitCode: null; readonly signal: string }
  | {
    readonly kind: "timed-out" | "resource-limit";
    readonly exitCode: null;
    readonly signal: null;
  };

export type ModelicaAdmittedDestruction =
  | {
    readonly status: "proven";
    readonly runId: string;
    readonly proofFingerprint: ModelicaContentFingerprint;
  }
  | {
    readonly status: "acknowledged-unattested";
    readonly runId: string;
    readonly acknowledgementFingerprint: ModelicaContentFingerprint;
  };

export interface ModelicaAdmittedExecutionCaptureView {
  readonly schemaVersion: typeof MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA;
  readonly operation: { readonly id: "simulate.run-admitted-modelica"; readonly version: "1" };
  readonly projectId: string;
  readonly agentRunId: string;
  readonly executionRunId: string;
  readonly admission: {
    readonly schemaVersion: "modelica-admitted-run-admission/3.0";
    readonly admissionArtifact: {
      readonly schemaVersion:
        | "technical-compilation-admission-capture/2.0"
        | "technical-compilation-admission-capture/4.0";
      readonly id: string;
      readonly fingerprint: ModelicaContentFingerprint;
    };
    readonly compilation: {
      readonly document: {
        readonly schemaVersion: "technical-compilation/1.0" | "technical-compilation/2.0";
        readonly status: "ready-for-review";
      };
      readonly projection: { readonly status: "ready-for-review" };
    };
    readonly status: "ready-for-execution-review";
  };
  readonly sourceSha256: string;
  readonly modelName: string;
  readonly scenario: {
    readonly startTimeS: number;
    readonly stopTimeS: number;
    readonly intervalS: number;
    readonly tolerance: number;
    readonly numberOfIntervals: number;
    readonly solver: "dassl";
  };
  readonly parameters: readonly ModelicaAdmittedParameter[];
  readonly metrics: readonly ModelicaAdmittedMetric[];
  readonly receipt: {
    readonly schemaVersion: "isolated-code-execution-receipt-record/1.0";
    readonly receiptSchemaVersion: "isolated-code-execution-receipt/1.0";
    readonly runId: string;
    readonly producerGeneration: 0 | 1;
    readonly termination: ModelicaAdmittedTermination;
    readonly outputs: readonly [
      ModelicaAdmittedOutputArtifact,
      ModelicaAdmittedOutputArtifact,
    ];
    readonly destruction: ModelicaAdmittedDestruction;
    readonly publication: { readonly status: "atomic-batch-published" };
    readonly fingerprint: ModelicaContentFingerprint;
  };
}

export interface ModelicaRecordedArtifactRef {
  readonly artifactId: string;
  readonly uri: string;
  readonly fingerprint: ModelicaContentFingerprint;
}

export interface ModelicaRecordedAdmittedProvenance {
  readonly kind: "digital-thread-operation";
  readonly serverId: "digital-thread";
  readonly operation: typeof RECORDED_OPERATION;
  readonly runId: string;
  readonly admissionArtifact: ModelicaRecordedArtifactRef | null;
  readonly captureArtifact: ModelicaRecordedArtifactRef | null;
  readonly evidenceArtifact: ModelicaRecordedArtifactRef | null;
  readonly resultArtifact: ModelicaRecordedArtifactRef | null;
}

export interface ModelicaAdmittedResultAnchor {
  readonly kind: "artifact";
  readonly id: string;
  readonly uri: string;
  readonly fingerprint: ModelicaContentFingerprint;
}

export interface ModelicaAdmittedExecutionViewData {
  /** The validated raw DT read model. It is preserved without a ResultsEnvelope conversion. */
  readonly rawCapture: Readonly<Record<string, unknown>>;
  readonly capture: ModelicaAdmittedExecutionCaptureView;
  readonly captureFingerprint: ModelicaContentFingerprint;
  readonly anchor: ModelicaAdmittedResultAnchor;
  readonly recordedProvenance?: ModelicaRecordedAdmittedProvenance;
}

export type ModelicaRecordedAdmittedProjection =
  | { readonly status: "available"; readonly capture: unknown }
  | { readonly status: "pending" | "running" }
  | {
    readonly status: "rejected" | "recovery_required" | "unavailable" | "unresolved";
    readonly reason: string;
  };

export interface ModelicaRecordedAdmittedExecutionSession {
  readonly schemaVersion: typeof MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA;
  readonly kind: "modelica.admitted-execution";
  readonly basis: {
    readonly projectId: string;
    readonly projectRevision: number;
    readonly subjectId: string;
    readonly thread: { readonly id: string; readonly revision: number };
  };
  readonly anchor: ModelicaAdmittedResultAnchor;
  readonly provenance: ModelicaRecordedAdmittedProvenance;
  readonly projection:
    | { readonly status: "available"; readonly data: ModelicaAdmittedExecutionViewData }
    | { readonly status: "pending" | "running" }
    | {
      readonly status: "rejected" | "recovery_required" | "unavailable" | "unresolved";
      readonly reason: string;
    };
}

export type ModelicaRecordedAdmittedSessionInput = Readonly<Record<string, unknown>>;

interface ParsedCaptureStructure {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly view: ModelicaAdmittedExecutionCaptureView;
  readonly rawReceipt: Readonly<Record<string, unknown>>;
}

interface AdmissionFacts {
  readonly view: ModelicaAdmittedExecutionCaptureView["admission"];
  readonly sourceSha256: string;
  readonly profile: { readonly id: string; readonly version: string };
  readonly policy: {
    readonly id: string;
    readonly version: string;
    readonly fingerprint: ModelicaContentFingerprint;
  };
  readonly runtime: {
    readonly imageDigest: ModelicaContentFingerprint;
    readonly limits: Readonly<Record<(typeof LIMIT_KEYS)[number], number>>;
    readonly limitAssurance: Readonly<Record<(typeof LIMIT_KEYS)[number], string>>;
  };
  readonly minimumDestructionAssurance: "proven" | "acknowledged-unattested";
}

/** Exact synchronous ingress guard; cryptographic equality is completed asynchronously. */
export function isModelicaRecordedAdmittedSessionInput(
  value: unknown,
): value is ModelicaRecordedAdmittedSessionInput {
  try {
    parseSessionStructure(value);
    return true;
  } catch {
    return false;
  }
}

/** Parse one exact DT capture without converting it to an mcp-modelica ResultsEnvelope. */
export async function parseModelicaAdmittedExecutionCapture(
  value: unknown,
): Promise<ModelicaAdmittedExecutionViewData> {
  const parsed = parseCaptureStructure(value);
  const expectedRunId = `admitted-modelica-${await modelicaAdmittedCanonicalSha256({
    projectId: parsed.view.projectId,
    agentRunId: parsed.view.agentRunId,
    operation: parsed.view.operation,
  })}`;
  if (parsed.view.executionRunId !== expectedRunId) {
    throw new TypeError("Admitted Modelica executionRunId is not derived from its exact basis.");
  }
  await verifyReceiptFingerprint(parsed.rawReceipt);
  await verifyPublicationManifestUri(parsed.rawReceipt);
  const result = parsed.view.receipt.outputs[1];
  return {
    rawCapture: parsed.raw,
    capture: parsed.view,
    captureFingerprint: {
      algorithm: "sha256",
      digest: await modelicaAdmittedCanonicalSha256(value),
    },
    anchor: {
      kind: "artifact",
      id: `modelica-admitted-result-${result.sha256}`,
      uri: result.casUri,
      fingerprint: { algorithm: "sha256", digest: result.sha256 },
    },
  };
}

/** Validate the provider-owned session and bind it to the exact recorded DT capture artifact. */
export async function parseModelicaRecordedAdmittedExecutionSession(
  value: unknown,
): Promise<ModelicaRecordedAdmittedExecutionSession> {
  const parsed = parseSessionStructure(value);
  if (parsed.projection.status !== "available") return parsed;
  const data = await parseModelicaAdmittedExecutionCapture(
    parsed.projection.data.rawCapture,
  );
  const recordedCapture = parsed.provenance.captureArtifact;
  if (!recordedCapture || recordedCapture.fingerprint.digest !== data.captureFingerprint.digest) {
    throw new TypeError("Recorded admitted Modelica capture fingerprint does not match its bytes.");
  }
  return {
    ...parsed,
    projection: {
      status: "available",
      data: { ...data, anchor: parsed.anchor, recordedProvenance: parsed.provenance },
    },
  };
}

export async function modelicaAdmittedCanonicalSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseSessionStructure(value: unknown): ModelicaRecordedAdmittedExecutionSession {
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "basis",
    "anchor",
    "provenance",
    "projection",
  ], "$session");
  literal(root.schemaVersion, MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA, "schemaVersion");
  literal(root.kind, "modelica.admitted-execution", "kind");
  const basisValue = exactRecord(
    root.basis,
    ["projectId", "projectRevision", "subjectId", "thread"],
    "$session.basis",
  );
  const thread = exactRecord(basisValue.thread, ["id", "revision"], "$session.basis.thread");
  const basis = {
    projectId: requireId(basisValue.projectId, "basis.projectId"),
    projectRevision: requireRevision(basisValue.projectRevision, "basis.projectRevision"),
    subjectId: requireId(basisValue.subjectId, "basis.subjectId"),
    thread: {
      id: requireId(thread.id, "basis.thread.id"),
      revision: requireRevision(thread.revision, "basis.thread.revision"),
    },
  };
  if (basis.subjectId !== `project:${basis.projectId}`) {
    throw new TypeError("Recorded admitted Modelica subject does not match its project.");
  }
  const threadPrefix = `${basis.subjectId}:r${basis.thread.revision}`;
  if (basis.thread.id !== threadPrefix && !basis.thread.id.startsWith(`${threadPrefix}:`)) {
    throw new TypeError("Recorded admitted Modelica Thread identity does not match its revision.");
  }
  const anchor = parseResultAnchor(root.anchor);
  const provenanceValue = exactRecord(
    root.provenance,
    [
      "kind",
      "serverId",
      "operation",
      "runId",
      "admissionArtifact",
      "captureArtifact",
      "evidenceArtifact",
      "resultArtifact",
    ],
    "$session.provenance",
  );
  literal(provenanceValue.kind, "digital-thread-operation", "provenance.kind");
  literal(provenanceValue.serverId, "digital-thread", "provenance.serverId");
  literal(provenanceValue.operation, RECORDED_OPERATION, "provenance.operation");
  const provenance: ModelicaRecordedAdmittedProvenance = {
    kind: "digital-thread-operation",
    serverId: "digital-thread",
    operation: RECORDED_OPERATION,
    runId: requireId(provenanceValue.runId, "provenance.runId"),
    admissionArtifact: parseNullableArtifactRef(
      provenanceValue.admissionArtifact,
      "provenance.admissionArtifact",
    ),
    captureArtifact: parseNullableArtifactRef(
      provenanceValue.captureArtifact,
      "provenance.captureArtifact",
    ),
    evidenceArtifact: parseNullableArtifactRef(
      provenanceValue.evidenceArtifact,
      "provenance.evidenceArtifact",
    ),
    resultArtifact: parseNullableArtifactRef(
      provenanceValue.resultArtifact,
      "provenance.resultArtifact",
    ),
  };
  const projectionValue = requireRecord(root.projection, "$session.projection");
  const status = projectionValue.status;
  if (status === "available") {
    exactKeys(projectionValue, ["status", "capture"], "$session.projection");
    assertAllRecordedArtifactRefsPresent(provenance);
    const parsedCapture = parseCaptureStructure(projectionValue.capture);
    assertRecordedJoins(basis, anchor, provenance, parsedCapture.view);
    return {
      schemaVersion: MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
      kind: "modelica.admitted-execution",
      basis,
      anchor,
      provenance,
      projection: {
        status: "available",
        data: {
          rawCapture: parsedCapture.raw,
          capture: parsedCapture.view,
          captureFingerprint: provenance.captureArtifact!.fingerprint,
          anchor,
          recordedProvenance: provenance,
        },
      },
    };
  }
  assertNoRecordedArtifactRefs(provenance);
  if (status === "pending" || status === "running") {
    exactKeys(projectionValue, ["status"], "$session.projection");
    return {
      schemaVersion: MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
      kind: "modelica.admitted-execution",
      basis,
      anchor,
      provenance,
      projection: { status },
    };
  }
  if (
    status === "rejected" || status === "recovery_required" || status === "unavailable" ||
    status === "unresolved"
  ) {
    exactKeys(projectionValue, ["status", "reason"], "$session.projection");
    return {
      schemaVersion: MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
      kind: "modelica.admitted-execution",
      basis,
      anchor,
      provenance,
      projection: { status, reason: requireText(projectionValue.reason, "projection.reason") },
    };
  }
  throw new TypeError("Recorded admitted Modelica projection status is invalid.");
}

function parseCaptureStructure(value: unknown): ParsedCaptureStructure {
  const root = exactRecord(value, [
    "schemaVersion",
    "operation",
    "projectId",
    "agentRunId",
    "executionRunId",
    "admission",
    "sourceSha256",
    "receipt",
    "modelName",
    "scenario",
    "parameters",
    "metrics",
  ], "$capture");
  literal(root.schemaVersion, MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA, "capture.schemaVersion");
  const operation = exactRecord(root.operation, ["id", "version"], "$capture.operation");
  literal(operation.id, "simulate.run-admitted-modelica", "capture.operation.id");
  literal(operation.version, "1", "capture.operation.version");
  const projectId = requireId(root.projectId, "capture.projectId");
  const agentRunId = requireId(root.agentRunId, "capture.agentRunId");
  const executionRunId = requireId(root.executionRunId, "capture.executionRunId");
  const sourceSha256 = requireDigest(root.sourceSha256, "capture.sourceSha256");
  const admission = parseAdmission(root.admission);
  if (admission.sourceSha256 !== sourceSha256) {
    throw new TypeError("Admitted Modelica capture source differs from its admission.");
  }
  const receipt = parseReceipt(root.receipt, executionRunId, sourceSha256, admission);
  const scenarioValue = exactRecord(root.scenario, [
    "startTimeS",
    "stopTimeS",
    "intervalS",
    "tolerance",
    "numberOfIntervals",
    "solver",
  ], "$capture.scenario");
  literal(scenarioValue.solver, "dassl", "capture.scenario.solver");
  const scenario = {
    startTimeS: requireFinite(scenarioValue.startTimeS, "scenario.startTimeS"),
    stopTimeS: requireFinite(scenarioValue.stopTimeS, "scenario.stopTimeS"),
    intervalS: requireFinite(scenarioValue.intervalS, "scenario.intervalS"),
    tolerance: requireFinite(scenarioValue.tolerance, "scenario.tolerance"),
    numberOfIntervals: requireFinite(scenarioValue.numberOfIntervals, "scenario.numberOfIntervals"),
    solver: "dassl" as const,
  };
  const parameters = parseBoundedArray(
    root.parameters,
    MAX_CAPTURE_PARAMETERS,
    "$capture.parameters",
    (item, index) => {
      const parameter = exactRecord(
        item,
        ["name", "value", "unit"],
        `$capture.parameters[${index}]`,
      );
      return {
        name: requireId(parameter.name, `parameters[${index}].name`),
        value: requireFinite(parameter.value, `parameters[${index}].value`),
        unit: requireText(parameter.unit, `parameters[${index}].unit`),
      };
    },
  );
  const metrics = parseBoundedArray(
    root.metrics,
    MAX_CAPTURE_METRICS,
    "$capture.metrics",
    (item, index) => {
      const metric = exactRecord(
        item,
        ["outputName", "statistic", "value", "unit"],
        `$capture.metrics[${index}]`,
      );
      if (metric.statistic !== "final" && metric.statistic !== "max_abs") {
        throw new TypeError(`metrics[${index}].statistic is unsupported.`);
      }
      return {
        outputName: requireId(metric.outputName, `metrics[${index}].outputName`),
        statistic: metric.statistic as "final" | "max_abs",
        value: requireFinite(metric.value, `metrics[${index}].value`),
        unit: requireText(metric.unit, `metrics[${index}].unit`),
      };
    },
  );
  if (parameters.length === 0 || metrics.length === 0) {
    throw new TypeError("Admitted Modelica capture parameters and metrics must not be empty.");
  }
  if (metrics.length % 2 !== 0) {
    throw new TypeError("Admitted Modelica capture metrics must be final/max_abs pairs.");
  }
  for (let index = 0; index < metrics.length; index += 2) {
    const finalMetric = metrics[index]!;
    const maximumMetric = metrics[index + 1]!;
    if (
      finalMetric.statistic !== "final" || maximumMetric.statistic !== "max_abs" ||
      finalMetric.outputName !== maximumMetric.outputName || finalMetric.unit !== maximumMetric.unit
    ) {
      throw new TypeError("Admitted Modelica capture metrics must preserve exact output pairs.");
    }
  }
  return {
    raw: root,
    view: {
      schemaVersion: MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
      operation: { id: "simulate.run-admitted-modelica", version: "1" },
      projectId,
      agentRunId,
      executionRunId,
      admission: admission.view,
      sourceSha256,
      modelName: requireId(root.modelName, "capture.modelName"),
      scenario,
      parameters,
      metrics,
      receipt: receipt.view,
    },
    rawReceipt: receipt.raw,
  };
}

function parseAdmission(value: unknown): AdmissionFacts {
  const root = exactRecord(
    value,
    ["schemaVersion", "admissionArtifact", "compilation", "execution", "status"],
    "$capture.admission",
  );
  literal(root.schemaVersion, "modelica-admitted-run-admission/3.0", "admission.schemaVersion");
  literal(root.status, "ready-for-execution-review", "admission.status");
  const artifact = exactRecord(
    root.admissionArtifact,
    ["schemaVersion", "id", "fingerprint"],
    "$capture.admission.admissionArtifact",
  );
  if (
    artifact.schemaVersion !== "technical-compilation-admission-capture/2.0" &&
    artifact.schemaVersion !== "technical-compilation-admission-capture/4.0"
  ) {
    throw new TypeError(
      "admission.admissionArtifact.schemaVersion is not a supported exact capture profile.",
    );
  }
  const artifactFingerprint = parseFingerprint(
    artifact.fingerprint,
    "admissionArtifact.fingerprint",
  );
  literal(
    artifact.id,
    `technical-compilation-admission-${artifactFingerprint.digest}`,
    "admission.admissionArtifact.id",
  );
  const compilation = exactRecord(
    root.compilation,
    ["document", "projection", "source", "profile"],
    "$capture.admission.compilation",
  );
  const document = exactRecord(
    compilation.document,
    ["schemaVersion", "fingerprint", "status"],
    "$capture.admission.compilation.document",
  );
  const expectedCompilationSchema = artifact.schemaVersion ===
      "technical-compilation-admission-capture/2.0"
    ? "technical-compilation/1.0"
    : "technical-compilation/2.0";
  literal(document.schemaVersion, expectedCompilationSchema, "compilation.document.schemaVersion");
  literal(document.status, "ready-for-review", "compilation.document.status");
  parseFingerprint(document.fingerprint, "compilation.document.fingerprint");
  const projection = exactRecord(
    compilation.projection,
    ["target", "fingerprint", "status"],
    "$capture.admission.compilation.projection",
  );
  literal(projection.target, "modelica-source-qualification", "compilation.projection.target");
  literal(projection.status, "ready-for-review", "compilation.projection.status");
  parseFingerprint(projection.fingerprint, "compilation.projection.fingerprint");
  const source = exactRecord(
    compilation.source,
    ["id", "sourceFingerprint", "captureFingerprint", "analysisFingerprint"],
    "$capture.admission.compilation.source",
  );
  requireId(source.id, "compilation.source.id");
  const sourceFingerprint = parseFingerprint(
    source.sourceFingerprint,
    "compilation.source.sourceFingerprint",
  );
  parseFingerprint(source.captureFingerprint, "compilation.source.captureFingerprint");
  parseFingerprint(source.analysisFingerprint, "compilation.source.analysisFingerprint");
  const compilationProfile = exactRecord(
    compilation.profile,
    ["id", "version", "fingerprint"],
    "$capture.admission.compilation.profile",
  );
  literal(compilationProfile.id, "modelica-closed-subset-v2", "compilation.profile.id");
  requireId(compilationProfile.version, "compilation.profile.version");
  parseFingerprint(compilationProfile.fingerprint, "compilation.profile.fingerprint");
  const execution = exactRecord(root.execution, [
    "profile",
    "isolationPolicy",
    "runtimeBackend",
    "runtime",
    "outputValidator",
    "outputs",
    "minimumDestructionAssurance",
  ], "$capture.admission.execution");
  const profile = exactRecord(
    execution.profile,
    ["id", "version", "fingerprint"],
    "execution.profile",
  );
  literal(profile.id, "modelica-closed-subset-v2", "execution.profile.id");
  literal(profile.version, "2.0.0", "execution.profile.version");
  parseFingerprint(profile.fingerprint, "execution.profile.fingerprint");
  const policy = parsePolicy(execution.isolationPolicy, "execution.isolationPolicy");
  const runtimeBackend = exactRecord(execution.runtimeBackend, [
    "id",
    "version",
    "lifecycle",
    "network",
    "imageReference",
    "imageDigest",
  ], "execution.runtimeBackend");
  literal(runtimeBackend.id, "microsandbox-local", "runtimeBackend.id");
  requireId(runtimeBackend.version, "runtimeBackend.version");
  literal(runtimeBackend.lifecycle, "attached", "runtimeBackend.lifecycle");
  literal(runtimeBackend.network, "none", "runtimeBackend.network");
  const backendDigest = parseFingerprint(runtimeBackend.imageDigest, "runtimeBackend.imageDigest");
  const imageReference = requireText(
    runtimeBackend.imageReference,
    "runtimeBackend.imageReference",
  );
  if (!imageReference.endsWith(`@sha256:${backendDigest.digest}`)) {
    throw new TypeError("Runtime backend image reference differs from its fingerprint.");
  }
  const runtime = parseRuntime(execution.runtime, "execution.runtime");
  if (runtime.imageDigest.digest !== backendDigest.digest) {
    throw new TypeError("Admitted Modelica runtime image fingerprints differ.");
  }
  const outputValidator = exactRecord(
    execution.outputValidator,
    ["id", "version"],
    "execution.outputValidator",
  );
  literal(
    outputValidator.id,
    "modelica-closed-subset-v2-result-normalizer",
    "execution.outputValidator.id",
  );
  literal(outputValidator.version, "2.0.0", "execution.outputValidator.version");
  parseOutputDeclarations(execution.outputs, "execution.outputs");
  if (
    execution.minimumDestructionAssurance !== "proven" &&
    execution.minimumDestructionAssurance !== "acknowledged-unattested"
  ) {
    throw new TypeError("execution.minimumDestructionAssurance is unsupported.");
  }
  return {
    view: {
      schemaVersion: "modelica-admitted-run-admission/3.0",
      admissionArtifact: {
        schemaVersion: artifact.schemaVersion,
        id: artifact.id as string,
        fingerprint: artifactFingerprint,
      },
      compilation: {
        document: {
          schemaVersion: expectedCompilationSchema,
          status: "ready-for-review",
        },
        projection: { status: "ready-for-review" },
      },
      status: "ready-for-execution-review",
    },
    sourceSha256: sourceFingerprint.digest,
    profile: { id: "modelica-closed-subset-v2", version: "2.0.0" },
    policy,
    runtime,
    minimumDestructionAssurance: execution.minimumDestructionAssurance,
  };
}

function parseReceipt(
  value: unknown,
  executionRunId: string,
  sourceSha256: string,
  admission: AdmissionFacts,
): {
  readonly view: ModelicaAdmittedExecutionCaptureView["receipt"];
  readonly raw: Readonly<Record<string, unknown>>;
} {
  const root = exactRecord(value, [
    "schemaVersion",
    "receiptSchemaVersion",
    "runId",
    "producerGeneration",
    "profile",
    "sourceSha256",
    "policy",
    "runtime",
    "termination",
    "logs",
    "outputs",
    "destruction",
    "publication",
    "fingerprint",
  ], "$capture.receipt");
  literal(
    root.schemaVersion,
    "isolated-code-execution-receipt-record/1.0",
    "receipt.schemaVersion",
  );
  literal(
    root.receiptSchemaVersion,
    "isolated-code-execution-receipt/1.0",
    "receipt.receiptSchemaVersion",
  );
  literal(root.runId, executionRunId, "receipt.runId");
  if (root.producerGeneration !== 0 && root.producerGeneration !== 1) {
    throw new TypeError("receipt.producerGeneration must be 0 or 1.");
  }
  const profile = exactRecord(root.profile, ["id", "version"], "receipt.profile");
  literal(profile.id, admission.profile.id, "receipt.profile.id");
  literal(profile.version, admission.profile.version, "receipt.profile.version");
  literal(root.sourceSha256, sourceSha256, "receipt.sourceSha256");
  const policy = parsePolicy(root.policy, "receipt.policy");
  if (
    policy.id !== admission.policy.id || policy.version !== admission.policy.version ||
    policy.fingerprint.digest !== admission.policy.fingerprint.digest
  ) {
    throw new TypeError("Admitted Modelica receipt policy differs from its admission.");
  }
  const runtime = parseRuntime(root.runtime, "receipt.runtime", true);
  if (
    runtime.imageDigest.digest !== admission.runtime.imageDigest.digest ||
    LIMIT_KEYS.some((key) =>
      runtime.limits[key] !== admission.runtime.limits[key] ||
      runtime.limitAssurance[key] !== admission.runtime.limitAssurance[key]
    )
  ) {
    throw new TypeError("Admitted Modelica receipt runtime differs from its admission.");
  }
  const termination = parseTermination(root.termination);
  parseLogs(root.logs, runtime.limits);
  const outputs = parseOutputArtifacts(root.outputs, runtime.limits);
  const destruction = parseDestruction(root.destruction, executionRunId);
  if (
    admission.minimumDestructionAssurance === "proven" && destruction.status !== "proven"
  ) {
    throw new TypeError("Admitted Modelica receipt does not meet its destruction assurance.");
  }
  const publication = parsePublication(root.publication, executionRunId, root.producerGeneration);
  const fingerprint = parseFingerprint(root.fingerprint, "receipt.fingerprint");
  return {
    view: {
      schemaVersion: "isolated-code-execution-receipt-record/1.0",
      receiptSchemaVersion: "isolated-code-execution-receipt/1.0",
      runId: executionRunId,
      producerGeneration: root.producerGeneration,
      termination,
      outputs,
      destruction,
      publication,
      fingerprint,
    },
    raw: root,
  };
}

async function verifyReceiptFingerprint(receipt: Readonly<Record<string, unknown>>): Promise<void> {
  const fingerprint = parseFingerprint(receipt.fingerprint, "receipt.fingerprint");
  const metadata = {
    schemaVersion: receipt.receiptSchemaVersion,
    runId: receipt.runId,
    producerGeneration: receipt.producerGeneration,
    profile: receipt.profile,
    sourceSha256: receipt.sourceSha256,
    policy: receipt.policy,
    runtime: receipt.runtime,
    termination: receipt.termination,
    logs: receipt.logs,
    outputs: receipt.outputs,
    destruction: receipt.destruction,
    publication: receipt.publication,
  };
  if (await modelicaAdmittedCanonicalSha256(metadata) !== fingerprint.digest) {
    throw new TypeError("Admitted Modelica receipt fingerprint does not match its metadata.");
  }
}

async function verifyPublicationManifestUri(
  receipt: Readonly<Record<string, unknown>>,
): Promise<void> {
  const publication = exactRecord(receipt.publication, ["status", "ref"], "receipt.publication");
  const ref = exactRecord(
    publication.ref,
    ["runId", "producerGeneration", "fingerprint", "manifestUri"],
    "receipt.publication.ref",
  );
  const expectedUri =
    `casys://isolated-output-publication/sha256/${await modelicaAdmittedCanonicalSha256({
      schemaVersion: "isolated-output-publication-key/1.0",
      runId: ref.runId,
      producerGeneration: ref.producerGeneration,
    })}`;
  literal(ref.manifestUri, expectedUri, "publication.ref.manifestUri");
  const outputs = requireDenseArray(receipt.outputs, "receipt.outputs").map((value, index) => {
    const output = exactRecord(value, [
      "role",
      "basename",
      "mediaType",
      "format",
      "byteCount",
      "sha256",
      "casUri",
      "validation",
      "persistence",
    ], `receipt.outputs[${index}]`);
    return {
      role: output.role,
      basename: output.basename,
      mediaType: output.mediaType,
      format: output.format,
      byteCount: output.byteCount,
      sha256: output.sha256,
      casUri: output.casUri,
    };
  });
  const expectedFingerprint = await modelicaAdmittedCanonicalSha256({
    schemaVersion: "isolated-output-publication/1.0",
    runId: ref.runId,
    producerGeneration: ref.producerGeneration,
    outputs,
  });
  const fingerprint = parseFingerprint(ref.fingerprint, "publication.ref.fingerprint");
  if (fingerprint.digest !== expectedFingerprint) {
    throw new TypeError("Admitted Modelica publication fingerprint does not match its outputs.");
  }
}

function parseResultAnchor(value: unknown): ModelicaAdmittedResultAnchor {
  const root = exactRecord(value, ["kind", "id", "uri", "fingerprint"], "$session.anchor");
  literal(root.kind, "artifact", "anchor.kind");
  return {
    kind: "artifact",
    id: requireId(root.id, "anchor.id"),
    uri: requireText(root.uri, "anchor.uri"),
    fingerprint: parseFingerprint(root.fingerprint, "anchor.fingerprint"),
  };
}

function parseNullableArtifactRef(
  value: unknown,
  path: string,
): ModelicaRecordedArtifactRef | null {
  if (value === null) return null;
  const root = exactRecord(value, ["artifactId", "uri", "fingerprint"], path);
  return {
    artifactId: requireId(root.artifactId, `${path}.artifactId`),
    uri: requireText(root.uri, `${path}.uri`),
    fingerprint: parseFingerprint(root.fingerprint, `${path}.fingerprint`),
  };
}

function assertAllRecordedArtifactRefsPresent(
  provenance: ModelicaRecordedAdmittedProvenance,
): void {
  if (
    !provenance.admissionArtifact || !provenance.captureArtifact ||
    !provenance.evidenceArtifact || !provenance.resultArtifact
  ) {
    throw new TypeError(
      "Available admitted Modelica session must identify all recorded artifacts.",
    );
  }
}

function assertNoRecordedArtifactRefs(provenance: ModelicaRecordedAdmittedProvenance): void {
  if (
    provenance.admissionArtifact || provenance.captureArtifact || provenance.evidenceArtifact ||
    provenance.resultArtifact
  ) {
    throw new TypeError("A non-available admitted Modelica session must not claim artifacts.");
  }
}

function assertRecordedJoins(
  basis: ModelicaRecordedAdmittedExecutionSession["basis"],
  anchor: ModelicaAdmittedResultAnchor,
  provenance: ModelicaRecordedAdmittedProvenance,
  capture: ModelicaAdmittedExecutionCaptureView,
): void {
  if (capture.projectId !== basis.projectId || capture.agentRunId !== provenance.runId) {
    throw new TypeError("Recorded admitted Modelica basis or producer differs from its capture.");
  }
  const admission = provenance.admissionArtifact!;
  const captureArtifact = provenance.captureArtifact!;
  const evidence = provenance.evidenceArtifact!;
  const result = provenance.resultArtifact!;
  const admitted = capture.admission.admissionArtifact;
  assertArtifactRef(
    admission,
    admitted.id,
    `casys://technical-compilation-admission-capture/sha256/${admitted.fingerprint.digest}`,
    admitted.fingerprint.digest,
    "admission",
  );
  assertArtifactRef(
    captureArtifact,
    `modelica-admitted-capture-${captureArtifact.fingerprint.digest}`,
    `casys://modelica-admitted-execution-capture/sha256/${captureArtifact.fingerprint.digest}`,
    captureArtifact.fingerprint.digest,
    "capture",
  );
  const evidenceOutput = capture.receipt.outputs[0];
  const resultOutput = capture.receipt.outputs[1];
  assertArtifactRef(
    evidence,
    `modelica-admitted-evidence-${evidenceOutput.sha256}`,
    evidenceOutput.casUri,
    evidenceOutput.sha256,
    "evidence",
  );
  assertArtifactRef(
    result,
    `modelica-admitted-result-${resultOutput.sha256}`,
    resultOutput.casUri,
    resultOutput.sha256,
    "result",
  );
  if (
    anchor.id !== result.artifactId || anchor.uri !== result.uri ||
    anchor.fingerprint.digest !== result.fingerprint.digest
  ) {
    throw new TypeError("Recorded admitted Modelica anchor is not its exact result artifact.");
  }
}

function assertArtifactRef(
  value: ModelicaRecordedArtifactRef,
  id: string,
  uri: string,
  digest: string,
  label: string,
): void {
  if (
    value.artifactId !== id || value.uri !== uri || value.fingerprint.algorithm !== "sha256" ||
    value.fingerprint.digest !== digest
  ) {
    throw new TypeError(`Recorded admitted Modelica ${label} artifact is not exact.`);
  }
}

function parsePolicy(value: unknown, path: string) {
  const root = exactRecord(value, ["id", "version", "fingerprint"], path);
  return {
    id: requireId(root.id, `${path}.id`),
    version: requireId(root.version, `${path}.version`),
    fingerprint: parseFingerprint(root.fingerprint, `${path}.fingerprint`),
  };
}

function parseRuntime(value: unknown, path: string, receipt = false): AdmissionFacts["runtime"] {
  const root = exactRecord(
    value,
    receipt
      ? ["isolationClass", "imageDigest", "requestedLimits", "limitAssurance"]
      : ["imageDigest", "isolationClass", "limits", "limitAssurance"],
    path,
  );
  literal(root.isolationClass, "microsandbox-local-microvm-v1", `${path}.isolationClass`);
  const limitsValue = receipt ? root.requestedLimits : root.limits;
  const limitsRoot = exactRecord(limitsValue, [...LIMIT_KEYS], `${path}.limits`);
  const assuranceRoot = exactRecord(root.limitAssurance, [...LIMIT_KEYS], `${path}.limitAssurance`);
  const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [
    key,
    requirePositiveInteger(limitsRoot[key], `${path}.limits.${key}`),
  ])) as unknown as Record<(typeof LIMIT_KEYS)[number], number>;
  const limitAssurance = Object.fromEntries(LIMIT_KEYS.map((key) => {
    const assurance = assuranceRoot[key];
    if (
      assurance !== "backend-attested" && assurance !== "broker-observed-cap" &&
      assurance !== "unattested"
    ) throw new TypeError(`${path}.limitAssurance.${key} is unsupported.`);
    return [key, assurance];
  })) as Record<(typeof LIMIT_KEYS)[number], string>;
  if (limits.maxOutputFileBytes > limits.maxOutputTotalBytes) {
    throw new TypeError(`${path} output limits are inconsistent.`);
  }
  return {
    imageDigest: parseFingerprint(root.imageDigest, `${path}.imageDigest`),
    limits,
    limitAssurance,
  };
}

function parseTermination(value: unknown): ModelicaAdmittedTermination {
  const root = exactRecord(value, ["kind", "exitCode", "signal"], "receipt.termination");
  if (root.kind === "exited") {
    if (!Number.isSafeInteger(root.exitCode) || root.signal !== null) {
      throw new TypeError("Exited Modelica receipt termination is invalid.");
    }
    return { kind: "exited", exitCode: Number(root.exitCode), signal: null };
  }
  if (root.kind === "signaled") {
    if (root.exitCode !== null) {
      throw new TypeError("Signaled termination must not carry an exit code.");
    }
    return {
      kind: "signaled",
      exitCode: null,
      signal: requireText(root.signal, "termination.signal"),
    };
  }
  if (root.kind === "timed-out" || root.kind === "resource-limit") {
    if (root.exitCode !== null || root.signal !== null) {
      throw new TypeError("Bounded termination must not carry an exit code or signal.");
    }
    return { kind: root.kind, exitCode: null, signal: null };
  }
  throw new TypeError("Admitted Modelica receipt termination kind is unsupported.");
}

function parseLogs(value: unknown, limits: Readonly<Record<string, number>>): void {
  const root = exactRecord(value, ["stdout", "stderr"], "receipt.logs");
  for (const name of ["stdout", "stderr"] as const) {
    const log = exactRecord(
      root[name],
      ["byteCount", "sha256", "truncated"],
      `receipt.logs.${name}`,
    );
    const byteCount = requireNonNegativeInteger(log.byteCount, `receipt.logs.${name}.byteCount`);
    if (byteCount > limits[name === "stdout" ? "maxStdoutBytes" : "maxStderrBytes"]!) {
      throw new TypeError(`receipt.logs.${name} exceeds its recorded limit.`);
    }
    requireDigest(log.sha256, `receipt.logs.${name}.sha256`);
    if (typeof log.truncated !== "boolean") {
      throw new TypeError(`receipt.logs.${name}.truncated is invalid.`);
    }
  }
}

function parseOutputDeclarations(value: unknown, path: string): void {
  const outputs = requireDenseArray(value, path);
  if (outputs.length !== 2) throw new TypeError(`${path} must contain evidence and result.`);
  outputs.forEach((output, index) => {
    const expected = expectedOutput(index);
    const root = exactRecord(
      output,
      ["role", "basename", "mediaType", "format"],
      `${path}[${index}]`,
    );
    for (const key of ["role", "basename", "mediaType", "format"] as const) {
      literal(root[key], expected[key], `${path}[${index}].${key}`);
    }
  });
}

function parseOutputArtifacts(
  value: unknown,
  limits: Readonly<Record<string, number>>,
): readonly [ModelicaAdmittedOutputArtifact, ModelicaAdmittedOutputArtifact] {
  const outputs = requireDenseArray(value, "receipt.outputs");
  if (outputs.length !== 2) {
    throw new TypeError("receipt.outputs must contain evidence and result.");
  }
  let total = 0;
  const parsed = outputs.map((output, index) => {
    const expected = expectedOutput(index);
    const root = exactRecord(output, [
      "role",
      "basename",
      "mediaType",
      "format",
      "byteCount",
      "sha256",
      "casUri",
      "validation",
      "persistence",
    ], `receipt.outputs[${index}]`);
    for (const key of ["role", "basename", "mediaType", "format"] as const) {
      literal(root[key], expected[key], `receipt.outputs[${index}].${key}`);
    }
    const byteCount = requireNonNegativeInteger(
      root.byteCount,
      `receipt.outputs[${index}].byteCount`,
    );
    if (byteCount > limits.maxOutputFileBytes!) {
      throw new TypeError("Receipt output exceeds its file cap.");
    }
    total += byteCount;
    const sha256 = requireDigest(root.sha256, `receipt.outputs[${index}].sha256`);
    literal(
      root.casUri,
      `casys://isolated-output/sha256/${sha256}`,
      `receipt.outputs[${index}].casUri`,
    );
    literal(root.validation, "accepted", `receipt.outputs[${index}].validation`);
    literal(
      root.persistence,
      "staged-reread-atomic-commit",
      `receipt.outputs[${index}].persistence`,
    );
    return {
      ...expected,
      byteCount,
      sha256,
      casUri: root.casUri,
      validation: "accepted" as const,
      persistence: "staged-reread-atomic-commit" as const,
    };
  });
  if (total > limits.maxOutputTotalBytes!) {
    throw new TypeError("Receipt outputs exceed their total cap.");
  }
  return parsed as [ModelicaAdmittedOutputArtifact, ModelicaAdmittedOutputArtifact];
}

function parseDestruction(value: unknown, runId: string): ModelicaAdmittedDestruction {
  const root = requireRecord(value, "receipt.destruction");
  if (root.status === "proven") {
    exactKeys(root, ["status", "runId", "proofFingerprint"], "receipt.destruction");
    literal(root.runId, runId, "destruction.runId");
    return {
      status: "proven",
      runId,
      proofFingerprint: parseFingerprint(root.proofFingerprint, "destruction.proofFingerprint"),
    };
  }
  if (root.status === "acknowledged-unattested") {
    exactKeys(root, ["status", "runId", "acknowledgementFingerprint"], "receipt.destruction");
    literal(root.runId, runId, "destruction.runId");
    return {
      status: "acknowledged-unattested",
      runId,
      acknowledgementFingerprint: parseFingerprint(
        root.acknowledgementFingerprint,
        "destruction.acknowledgementFingerprint",
      ),
    };
  }
  throw new TypeError("Admitted Modelica receipt destruction status is unsupported.");
}

function parsePublication(
  value: unknown,
  runId: string,
  generation: 0 | 1,
): { readonly status: "atomic-batch-published" } {
  const root = exactRecord(value, ["status", "ref"], "receipt.publication");
  literal(root.status, "atomic-batch-published", "publication.status");
  const ref = exactRecord(
    root.ref,
    ["runId", "producerGeneration", "fingerprint", "manifestUri"],
    "publication.ref",
  );
  literal(ref.runId, runId, "publication.ref.runId");
  literal(ref.producerGeneration, generation, "publication.ref.producerGeneration");
  parseFingerprint(ref.fingerprint, "publication.ref.fingerprint");
  const manifestUri = requireText(ref.manifestUri, "publication.ref.manifestUri");
  if (!manifestUri.startsWith("casys://isolated-output-publication/sha256/")) {
    throw new TypeError("publication.ref.manifestUri is not an isolated-output publication URI.");
  }
  return { status: "atomic-batch-published" };
}

function parseFingerprint(value: unknown, path: string): ModelicaContentFingerprint {
  const root = exactRecord(value, ["algorithm", "digest"], path);
  literal(root.algorithm, "sha256", `${path}.algorithm`);
  return { algorithm: "sha256", digest: requireDigest(root.digest, `${path}.digest`) };
}

function expectedOutput(index: number) {
  return index === 0
    ? {
      role: "evidence" as const,
      basename: "evidence.json" as const,
      mediaType: "application/json" as const,
      format: "modelica-isolated-evidence-v2" as const,
    }
    : {
      role: "result" as const,
      basename: "result.csv" as const,
      mediaType: "text/csv" as const,
      format: "openmodelica-result-csv" as const,
    };
}

function parseBoundedArray<T>(
  value: unknown,
  maximum: number,
  path: string,
  parse: (item: unknown, index: number) => T,
): T[] {
  const values = requireDenseArray(value, path);
  if (values.length > maximum) throw new TypeError(`${path} exceeds ${maximum} entries.`);
  return values.map(parse);
}

function requireDenseArray(value: unknown, path: string): unknown[] {
  if (!isDenseJsonArray(value)) throw new TypeError(`${path} must be a dense JSON array.`);
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  const root = requireRecord(value, path);
  exactKeys(root, keys, path);
  return root;
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(root: Readonly<Record<string, unknown>>, keys: readonly string[], path: string) {
  const expected = new Set(keys);
  const actual = Object.keys(root);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`${path} has an invalid closed shape.`);
  }
}

function literal<T extends string | number | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new TypeError(`${path} must equal ${String(expected)}.`);
  return expected;
}

function requireText(value: unknown, path: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 1024 || value.trim() !== value
  ) {
    throw new TypeError(`${path} must be bounded non-empty text.`);
  }
  return value;
}

function requireId(value: unknown, path: string): string {
  const id = requireText(value, path);
  if (!SAFE_ID.test(id)) throw new TypeError(`${path} must be a safe id.`);
  return id;
}

function requireDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite.`);
  }
  return value;
}

function requireRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, path: string): number {
  const result = requireRevision(value, path);
  if (result === 0) throw new TypeError(`${path} must be positive.`);
  return result;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  return requireRevision(value, path);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (!isDenseJsonArray(value)) throw new TypeError("Canonical JSON arrays must be dense.");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      ).join(",")
    }}`;
  }
  throw new TypeError("Canonical JSON accepts JSON values only.");
}
