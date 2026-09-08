import { ValidationError } from "./errors.ts";
import { stableJson } from "./hashing.ts";
import type { EngineIdentity, RunnerRawCsv, RunnerRawOutput, RunStatus } from "./types.ts";

export const EXECUTION_ATTESTATION_SCHEMA = "execution-attestation/1.0" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMPILER_UNAVAILABLE_REASONS = [
  "spawn_failed",
  "timed_out_without_output",
  "runner_seam",
] as const;

export const MODELICA_EVIDENCE_NOTE =
  "This is computed evidence only. Requirement pass/fail belongs to mcp-syson and @casys/constraint-solver.";

export type ExecutionAttestationInput =
  | { kind: "recorded_fingerprint"; fingerprint: string }
  | { kind: "resumable_request"; request_id: string; request_sha256: string };

export type RawCsvAttestation = RunnerRawCsv;

export type CompilerOutputAttestation =
  | { status: "captured"; stdout_sha256: string; stderr_sha256: string }
  | {
    status: "unavailable";
    reason: typeof COMPILER_UNAVAILABLE_REASONS[number];
  };

export interface ExecutionAttestationV1 {
  schema: typeof EXECUTION_ATTESTATION_SCHEMA;
  input: ExecutionAttestationInput;
  engine: EngineIdentity;
  script_sha256: string;
  status: RunStatus;
  raw_csv: RawCsvAttestation;
  compiler_output: CompilerOutputAttestation;
}

export function buildExecutionAttestation(args: {
  input: ExecutionAttestationInput;
  engine: EngineIdentity;
  scriptSha256: string;
  status: RunStatus;
  rawOutput?: RunnerRawOutput;
  resultCsvSha256?: string;
}): ExecutionAttestationV1 {
  const rawCsv = rawCsvFrom(args.rawOutput, args.resultCsvSha256);
  if (args.status === "succeeded" && rawCsv.status !== "captured") {
    throw new ValidationError(
      "Successful execution cannot be attested without the exact captured CSV digest.",
    );
  }
  const compilerOutput = compilerOutputFromRaw(args.rawOutput);
  return {
    schema: EXECUTION_ATTESTATION_SCHEMA,
    input: args.input,
    engine: args.engine,
    script_sha256: digest(args.scriptSha256, "script"),
    status: args.status,
    raw_csv: rawCsv,
    compiler_output: compilerOutput,
  };
}

export function parseExecutionAttestation(value: unknown): ExecutionAttestationV1 {
  const attestation = object(value, "execution_attestation");
  exactKeys(attestation, [
    "compiler_output",
    "engine",
    "input",
    "raw_csv",
    "schema",
    "script_sha256",
    "status",
  ]);
  if (attestation.schema !== EXECUTION_ATTESTATION_SCHEMA) {
    throw invalid("execution_attestation.schema must equal 'execution-attestation/1.0'.");
  }
  const status = enumValue(
    attestation.status,
    ["succeeded", "failed", "timed_out"] as const,
    "execution_attestation.status",
  );
  const parsed: ExecutionAttestationV1 = {
    schema: EXECUTION_ATTESTATION_SCHEMA,
    input: parseInput(attestation.input),
    engine: parseEngine(attestation.engine),
    script_sha256: digest(attestation.script_sha256, "execution_attestation.script_sha256"),
    status,
    raw_csv: parseRawCsv(attestation.raw_csv),
    compiler_output: parseCompilerOutput(attestation.compiler_output),
  };
  if (parsed.status === "succeeded" && parsed.raw_csv.status !== "captured") {
    throw invalid("successful execution_attestation cannot omit the raw CSV digest.");
  }
  return parsed;
}

export function assertExecutionAttestationMatches(
  attestation: ExecutionAttestationV1,
  expected: {
    input: ExecutionAttestationInput;
    engine: EngineIdentity;
    scriptSha256: string;
    status: RunStatus;
    resultCsvSha256?: string;
  },
): void {
  if (stableJson(attestation.input) !== stableJson(expected.input)) {
    throw invalid("execution_attestation input identity does not match the sealed request.");
  }
  if (stableJson(attestation.engine) !== stableJson(expected.engine)) {
    throw invalid("execution_attestation engine does not match the sealed engine identity.");
  }
  if (attestation.script_sha256 !== expected.scriptSha256) {
    throw invalid("execution_attestation script digest does not match the sealed run.mos bytes.");
  }
  if (attestation.status !== expected.status) {
    throw invalid("execution_attestation status does not match the sealed run status.");
  }
  if (expected.resultCsvSha256 !== undefined) {
    if (
      attestation.raw_csv.status !== "captured" ||
      attestation.raw_csv.sha256 !== expected.resultCsvSha256
    ) {
      throw invalid("execution_attestation raw CSV digest does not match persisted result.csv.");
    }
  } else if (attestation.status === "succeeded") {
    throw invalid("successful execution_attestation cannot omit the raw CSV digest.");
  }
}

/**
 * Historical evidence has no attestation field and is accepted as the exact
 * canonical `base` document. New records include a strict 1.0 attestation.
 * A present but malformed or mismatched attestation fails closed.
 */
export function assertEvidenceDocument(
  source: string,
  base: Record<string, unknown>,
  expectedAttestation: {
    input: ExecutionAttestationInput;
    engine: EngineIdentity;
    scriptSha256: string;
    status: RunStatus;
    resultCsvSha256?: string;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw invalid(`evidence.json is not valid JSON: ${message(error)}`);
  }
  const evidence = object(parsed, "evidence.json");
  if (!("execution_attestation" in evidence)) {
    if (source !== stableJson(base)) {
      throw invalid(
        "historical evidence.json does not exactly attest the run status, metrics, warnings, and identity.",
      );
    }
    return;
  }
  const attestation = parseExecutionAttestation(evidence.execution_attestation);
  assertExecutionAttestationMatches(attestation, expectedAttestation);
  if (source !== stableJson({ ...base, execution_attestation: attestation })) {
    throw invalid(
      "evidence.json does not exactly attest the run identity, status, metrics, warnings, and execution-attestation/1.0.",
    );
  }
}

/**
 * Recorded 2.0 historical evidence was never body-canonicalized on replay.
 * A missing attestation stays readable; a present attestation is strict.
 */
export function assertRecordedEvidenceDocument(
  source: string,
  expectedAttestation: {
    input: ExecutionAttestationInput;
    engine: EngineIdentity;
    scriptSha256: string;
    status: RunStatus;
    resultCsvSha256?: string;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw invalid(`evidence.json is not valid JSON: ${message(error)}`);
  }
  const evidence = object(parsed, "evidence.json");
  if (!("execution_attestation" in evidence)) return;
  const allowed = new Set([
    "execution_attestation",
    "metrics",
    "model",
    "note",
    "parameter_schema",
    "producer",
    "result_normalizer",
    "scenario",
    "status",
    "warnings",
  ]);
  for (const key of Object.keys(evidence)) {
    if (!allowed.has(key)) throw invalid(`unknown field '${key}' is not accepted.`);
  }
  const attestation = parseExecutionAttestation(evidence.execution_attestation);
  assertExecutionAttestationMatches(attestation, expectedAttestation);
  const { execution_attestation: _attestation, ...rest } = evidence;
  if (source !== stableJson({ ...rest, execution_attestation: attestation })) {
    throw invalid(
      "evidence.json is not canonical stable JSON for execution-attestation/1.0.",
    );
  }
}

function rawCsvFrom(
  rawOutput: RunnerRawOutput | undefined,
  persistedSha256: string | undefined,
): RawCsvAttestation {
  const persisted = persistedSha256 === undefined
    ? undefined
    : digest(persistedSha256, "result.csv");
  if (rawOutput?.capture === "captured") {
    const captured = rawOutput.result_csv;
    if (captured.status === "captured") {
      digest(captured.sha256, "captured CSV");
      if (persisted !== undefined && captured.sha256 !== persisted) {
        throw new ValidationError(
          "Captured raw CSV digest does not match the persisted result.csv bytes.",
        );
      }
      return { status: "captured", sha256: captured.sha256 };
    }
    if (persisted !== undefined) {
      throw new ValidationError(
        "Persisted result.csv is present without a captured canonical CSV digest.",
      );
    }
    if (captured.status === "rejected") {
      return { status: "rejected", sha256: digest(captured.sha256, "rejected CSV") };
    }
    return { status: "absent" };
  }
  if (persisted !== undefined) {
    return { status: "captured", sha256: persisted };
  }
  return { status: "absent" };
}

function compilerOutputFromRaw(rawOutput?: RunnerRawOutput): CompilerOutputAttestation {
  if (rawOutput === undefined) {
    return { status: "unavailable", reason: "runner_seam" };
  }
  if (rawOutput.capture === "unavailable") {
    return { status: "unavailable", reason: rawOutput.reason };
  }
  return {
    status: "captured",
    stdout_sha256: digest(rawOutput.stdout_sha256, "compiler stdout"),
    stderr_sha256: digest(rawOutput.stderr_sha256, "compiler stderr"),
  };
}

function parseInput(value: unknown): ExecutionAttestationInput {
  const input = object(value, "execution_attestation.input");
  const kind = enumValue(
    input.kind,
    ["recorded_fingerprint", "resumable_request"] as const,
    "execution_attestation.input.kind",
  );
  if (kind === "recorded_fingerprint") {
    exactKeys(input, ["fingerprint", "kind"]);
    return {
      kind,
      fingerprint: digest(input.fingerprint, "execution_attestation.input.fingerprint"),
    };
  }
  exactKeys(input, ["kind", "request_id", "request_sha256"]);
  if (typeof input.request_id !== "string" || !REQUEST_ID.test(input.request_id)) {
    throw invalid("execution_attestation.input.request_id is not canonical.");
  }
  return {
    kind,
    request_id: input.request_id,
    request_sha256: digest(input.request_sha256, "execution_attestation.input.request_sha256"),
  };
}

function parseEngine(value: unknown): EngineIdentity {
  const engine = object(value, "execution_attestation.engine");
  exactKeys(engine, ["msl_version", "name", "version"]);
  return {
    name: nonEmpty(engine.name, "execution_attestation.engine.name"),
    version: nonEmpty(engine.version, "execution_attestation.engine.version"),
    msl_version: nonEmpty(engine.msl_version, "execution_attestation.engine.msl_version"),
  };
}

function parseRawCsv(value: unknown): RawCsvAttestation {
  const rawCsv = object(value, "execution_attestation.raw_csv");
  const status = enumValue(
    rawCsv.status,
    ["captured", "rejected", "absent"] as const,
    "execution_attestation.raw_csv.status",
  );
  if (status === "absent") {
    exactKeys(rawCsv, ["status"]);
    return { status };
  }
  exactKeys(rawCsv, ["sha256", "status"]);
  return { status, sha256: digest(rawCsv.sha256, "execution_attestation.raw_csv.sha256") };
}

function parseCompilerOutput(value: unknown): CompilerOutputAttestation {
  const output = object(value, "execution_attestation.compiler_output");
  const status = enumValue(
    output.status,
    ["captured", "unavailable"] as const,
    "execution_attestation.compiler_output.status",
  );
  if (status === "captured") {
    exactKeys(output, ["status", "stderr_sha256", "stdout_sha256"]);
    return {
      status,
      stdout_sha256: digest(
        output.stdout_sha256,
        "execution_attestation.compiler_output.stdout_sha256",
      ),
      stderr_sha256: digest(
        output.stderr_sha256,
        "execution_attestation.compiler_output.stderr_sha256",
      ),
    };
  }
  exactKeys(output, ["reason", "status"]);
  return {
    status,
    reason: enumValue(
      output.reason,
      COMPILER_UNAVAILABLE_REASONS,
      "execution_attestation.compiler_output.reason",
    ),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw invalid(`unknown field '${key}' is not accepted.`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw invalid(`required field '${key}' is missing.`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw invalid(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`${label} has an unsupported value.`);
  }
  return value as T;
}

function invalid(messageText: string): ValidationError {
  return new ValidationError(`Invalid Modelica execution attestation: ${messageText}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
