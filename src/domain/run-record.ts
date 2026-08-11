import { sha256, stableJson } from "./hashing.ts";
import { ValidationError } from "./errors.ts";
import type {
  Artifact,
  LegacyArtifact,
  LegacyArtifactKind,
  LegacySimulationRun,
  PersistedSimulationRun,
  Quantity,
  SimulationRun,
} from "./types.ts";

export const MODELICA_RUN_RECORD_SCHEMA_VERSION = "2.0" as const;

const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODELICA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARTIFACT_ORDER: readonly Artifact["kind"][] = [
  "request",
  "resolved_parameters",
  "model",
  "scenario",
  "parameter_schema",
  "script",
  "diagnostics",
  "result",
  "evidence",
];
const LEGACY_ARTIFACT_ORDER: readonly LegacyArtifactKind[] = [
  "request",
  "resolved_parameters",
  "model",
  "script",
  "diagnostics",
  "result",
  "evidence",
];

/** Strictly discriminate the two immutable ledger generations without rewriting either. */
export async function parsePersistedSimulationRunRecord(
  source: string,
  expectedRunId: string,
): Promise<PersistedSimulationRun> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw invalid("run.json is not valid JSON.", { cause: message(error) });
  }
  const run = object(parsed, "run.json");
  return run.record_schema_version === MODELICA_RUN_RECORD_SCHEMA_VERSION
    ? await parseSimulationRunRecord(source, expectedRunId)
    : await parseLegacySimulationRunRecord(source, expectedRunId);
}

/** Parse and cross-check the complete canonical on-disk run ledger. */
export async function parseSimulationRunRecord(
  source: string,
  expectedRunId: string,
): Promise<SimulationRun> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw invalid("run.json is not valid JSON.", { cause: message(error) });
  }
  if (source !== stableJson(parsed)) {
    throw invalid("run.json is not encoded as canonical stable JSON.");
  }
  const run = object(parsed, "run.json");
  exactKeys(run, [
    "artifacts",
    "completed_at",
    "engine",
    "fingerprint",
    "metrics",
    "model",
    "parameter_schema",
    "record_schema_version",
    "result_normalizer",
    "resolved_parameters",
    "run_id",
    "scenario",
    "started_at",
    "status",
    "warnings",
  ], ["parameter_schema"]);

  const recordSchemaVersion = literal(
    run.record_schema_version,
    MODELICA_RUN_RECORD_SCHEMA_VERSION,
    "record_schema_version",
  );
  const runId = runIdentifier(run.run_id, "run_id");
  if (runId !== expectedRunId) {
    throw invalid("run.json run_id does not match its containing directory.", {
      expected: expectedRunId,
      received: runId,
    });
  }
  const startedAt = timestamp(run.started_at, "started_at");
  const completedAt = timestamp(run.completed_at, "completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalid("completed_at precedes started_at.");
  }
  const status = enumValue(run.status, ["succeeded", "failed", "timed_out"] as const, "status");
  const fingerprint = digest(run.fingerprint, "fingerprint");

  const rawModel = object(run.model, "model");
  exactKeys(rawModel, ["id", "name", "source_sha256", "version"]);
  const model = {
    id: nonEmpty(rawModel.id, "model.id"),
    version: nonEmpty(rawModel.version, "model.version"),
    name: modelicaIdentifier(rawModel.name, "model.name"),
    source_sha256: digest(rawModel.source_sha256, "model.source_sha256"),
  };

  const rawScenario = object(run.scenario, "scenario");
  exactKeys(rawScenario, ["id", "projection_sha256", "source_sha256"]);
  const scenario = {
    id: nonEmpty(rawScenario.id, "scenario.id"),
    source_sha256: digest(rawScenario.source_sha256, "scenario.source_sha256"),
    projection_sha256: digest(rawScenario.projection_sha256, "scenario.projection_sha256"),
  };

  const parameterSchema = run.parameter_schema === undefined
    ? undefined
    : parseParameterSchema(run.parameter_schema);
  if (parameterSchema && parameterSchema.model_source_sha256 !== model.source_sha256) {
    throw invalid("parameter_schema.model_source_sha256 does not match model.source_sha256.");
  }

  const resultNormalizer = parseResultNormalizer(run.result_normalizer);

  const engine = parseEngine(run.engine);
  const resolvedParameters = quantityMap(run.resolved_parameters, "resolved_parameters");
  const metrics = quantityMap(run.metrics, "metrics");
  const artifacts = parseArtifacts(run.artifacts, runId, model.name, parameterSchema !== undefined);
  crossCheckSourceArtifacts(artifacts, model, scenario, parameterSchema);
  const warnings = stringArray(run.warnings, "warnings");

  const expectedFingerprint = await sha256(stableJson({
    engine,
    model,
    ...(parameterSchema === undefined ? {} : { parameter_schema: parameterSchema }),
    result_normalizer: resultNormalizer,
    resolved_parameters: resolvedParameters,
    scenario,
  }));
  if (fingerprint !== expectedFingerprint) {
    throw invalid("fingerprint does not match the canonical qualified run inputs.", {
      expected: expectedFingerprint,
      received: fingerprint,
    });
  }

  return {
    record_schema_version: recordSchemaVersion,
    status,
    run_id: runId,
    started_at: startedAt,
    completed_at: completedAt,
    fingerprint,
    model,
    scenario,
    ...(parameterSchema === undefined ? {} : { parameter_schema: parameterSchema }),
    result_normalizer: resultNormalizer,
    engine,
    resolved_parameters: resolvedParameters,
    metrics,
    artifacts,
    warnings,
  };
}

function parseResultNormalizer(value: unknown): SimulationRun["result_normalizer"] {
  const normalizer = object(value, "result_normalizer");
  exactKeys(normalizer, ["id", "version"]);
  return {
    id: nonEmpty(normalizer.id, "result_normalizer.id"),
    version: nonEmpty(normalizer.version, "result_normalizer.version"),
  };
}

/** Parse the exact canonical run ledger written by the 0.2.x implementation. */
export async function parseLegacySimulationRunRecord(
  source: string,
  expectedRunId: string,
): Promise<LegacySimulationRun> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw invalid("run.json is not valid JSON.", { cause: message(error) });
  }
  if (source !== stableJson(parsed)) {
    throw invalid("run.json is not encoded as canonical stable JSON.");
  }
  const run = object(parsed, "run.json");
  exactKeys(
    run,
    [
      "artifacts",
      "completed_at",
      "engine",
      "fingerprint",
      "metrics",
      "model",
      "resolved_parameters",
      "run_id",
      "scenario",
      "started_at",
      "status",
      "warnings",
    ],
    ["completed_at", "started_at"],
  );

  const runId = runIdentifier(run.run_id, "run_id");
  if (runId !== expectedRunId) {
    throw invalid("run.json run_id does not match its containing directory.", {
      expected: expectedRunId,
      received: runId,
    });
  }
  const startedAt = run.started_at === undefined
    ? undefined
    : timestamp(run.started_at, "started_at");
  const completedAt = run.completed_at === undefined
    ? undefined
    : timestamp(run.completed_at, "completed_at");
  if (startedAt && completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invalid("completed_at precedes started_at.");
  }
  const status = enumValue(run.status, ["succeeded", "failed", "timed_out"] as const, "status");
  const fingerprint = digest(run.fingerprint, "fingerprint");

  const rawModel = object(run.model, "model");
  exactKeys(rawModel, ["id", "sha256", "version"]);
  const model = {
    id: nonEmpty(rawModel.id, "model.id"),
    version: nonEmpty(rawModel.version, "model.version"),
    sha256: digest(rawModel.sha256, "model.sha256"),
  };
  const rawScenario = object(run.scenario, "scenario");
  exactKeys(rawScenario, ["id", "sha256"]);
  const scenario = {
    id: nonEmpty(rawScenario.id, "scenario.id"),
    sha256: digest(rawScenario.sha256, "scenario.sha256"),
  };
  const engine = parseEngine(run.engine);
  const resolvedParameters = quantityMap(run.resolved_parameters, "resolved_parameters");
  const metrics = quantityMap(run.metrics, "metrics");
  const artifacts = parseLegacyArtifacts(run.artifacts, runId);
  if (artifacts.find((artifact) => artifact.kind === "model")?.sha256 !== model.sha256) {
    throw invalid("model.sha256 does not match the model artifact ledger.");
  }
  const warnings = stringArray(run.warnings, "warnings");
  const expectedFingerprint = await sha256(stableJson({
    engine,
    model,
    resolved_parameters: resolvedParameters,
    scenario,
  }));
  if (fingerprint !== expectedFingerprint) {
    throw invalid("fingerprint does not match the canonical legacy run inputs.", {
      expected: expectedFingerprint,
      received: fingerprint,
    });
  }

  return {
    status,
    run_id: runId,
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    fingerprint,
    model,
    scenario,
    engine,
    resolved_parameters: resolvedParameters,
    metrics,
    artifacts,
    warnings,
  };
}

function parseLegacyArtifacts(value: unknown, runId: string): LegacyArtifact[] {
  if (!Array.isArray(value)) throw invalid("artifacts must be an array.");
  const artifacts = value.map((raw, index) => parseLegacyArtifact(raw, runId, index));
  const seenKinds = new Set<LegacyArtifactKind>();
  const seenUris = new Set<string>();
  let lastOrder = -1;
  for (const artifact of artifacts) {
    if (seenKinds.has(artifact.kind)) throw invalid(`duplicate artifact kind '${artifact.kind}'.`);
    if (seenUris.has(artifact.uri)) throw invalid(`duplicate artifact URI '${artifact.uri}'.`);
    seenKinds.add(artifact.kind);
    seenUris.add(artifact.uri);
    const order = LEGACY_ARTIFACT_ORDER.indexOf(artifact.kind);
    if (order <= lastOrder) throw invalid("artifacts are not in canonical kind order.");
    lastOrder = order;
  }
  for (
    const required of [
      "request",
      "resolved_parameters",
      "model",
      "script",
      "diagnostics",
      "evidence",
    ] as const
  ) {
    if (!seenKinds.has(required)) throw invalid(`required artifact kind '${required}' is missing.`);
  }
  return artifacts;
}

function parseLegacyArtifact(value: unknown, runId: string, index: number): LegacyArtifact {
  const artifact = object(value, `artifacts[${index}]`);
  exactKeys(artifact, ["bytes", "kind", "sha256", "uri"]);
  const kind = enumValue(
    artifact.kind,
    LEGACY_ARTIFACT_ORDER,
    `artifacts[${index}].kind`,
  );
  const uri = nonEmpty(artifact.uri, `artifacts[${index}].uri`);
  legacyArtifactFileName(kind, uri, runId);
  const bytes = artifact.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw invalid(`artifacts[${index}].bytes must be a non-negative safe integer.`);
  }
  return {
    kind,
    uri,
    sha256: digest(artifact.sha256, `artifacts[${index}].sha256`),
    bytes,
  };
}

/** Resolve only a parser-validated legacy artifact URI to its bounded filename. */
export function legacyArtifactFileName(
  kind: LegacyArtifactKind,
  uri: string,
  runId: string,
): string {
  const prefix = `casys://modelica/runs/${runId}/`;
  if (!uri.startsWith(prefix)) {
    throw invalid(`legacy artifact URI is outside run '${runId}'.`);
  }
  const fileName = uri.slice(prefix.length);
  const expected = kind === "model"
    ? /^[A-Za-z_][A-Za-z0-9_]*\.mo$/.test(fileName)
    : fileName === legacyFixedArtifactFileName(kind);
  if (!expected) {
    throw invalid(`legacy artifact URI is not canonical for '${kind}'.`, { uri });
  }
  return fileName;
}

function legacyFixedArtifactFileName(kind: Exclude<LegacyArtifactKind, "model">): string {
  switch (kind) {
    case "request":
      return "request.json";
    case "resolved_parameters":
      return "resolved-parameters.json";
    case "script":
      return "run.mos";
    case "diagnostics":
      return "omc.log";
    case "result":
      return "result.csv";
    case "evidence":
      return "evidence.json";
  }
}

export function isRecordedSimulationRun(run: PersistedSimulationRun): run is SimulationRun {
  return "record_schema_version" in run && run.record_schema_version === "2.0";
}

/** Project a recorded run onto the frozen 1.0 public tool contract. */
export async function projectRecordedRunToLegacy(
  run: SimulationRun,
): Promise<LegacySimulationRun> {
  const model = {
    id: run.model.id,
    version: run.model.version,
    sha256: run.model.source_sha256,
  };
  const scenario = {
    id: run.scenario.id,
    sha256: run.scenario.projection_sha256,
  };
  const fingerprint = await sha256(stableJson({
    engine: run.engine,
    model,
    resolved_parameters: run.resolved_parameters,
    scenario,
  }));
  return {
    status: run.status,
    run_id: run.run_id,
    started_at: run.started_at,
    completed_at: run.completed_at,
    fingerprint,
    model,
    scenario,
    engine: run.engine,
    resolved_parameters: run.resolved_parameters,
    metrics: run.metrics,
    artifacts: run.artifacts
      .filter((artifact): artifact is Artifact & { kind: LegacyArtifactKind } =>
        LEGACY_ARTIFACT_ORDER.includes(artifact.kind as LegacyArtifactKind)
      )
      .map(({ kind, uri, sha256, bytes }) => ({ kind, uri, sha256, bytes })),
    warnings: run.warnings,
  };
}

function parseParameterSchema(value: unknown): NonNullable<SimulationRun["parameter_schema"]> {
  const schema = object(value, "parameter_schema");
  exactKeys(schema, ["model_source_sha256", "qualification", "source_sha256"]);
  return {
    source_sha256: digest(schema.source_sha256, "parameter_schema.source_sha256"),
    model_source_sha256: digest(
      schema.model_source_sha256,
      "parameter_schema.model_source_sha256",
    ),
    qualification: literal(
      schema.qualification,
      "compiler-derived-verified",
      "parameter_schema.qualification",
    ),
  };
}

function parseEngine(value: unknown): SimulationRun["engine"] {
  const engine = object(value, "engine");
  exactKeys(engine, ["msl_version", "name", "version"]);
  return {
    name: nonEmpty(engine.name, "engine.name"),
    version: nonEmpty(engine.version, "engine.version"),
    msl_version: nonEmpty(engine.msl_version, "engine.msl_version"),
  };
}

function parseArtifacts(
  value: unknown,
  runId: string,
  modelName: string,
  expectsParameterSchema: boolean,
): Artifact[] {
  if (!Array.isArray(value)) throw invalid("artifacts must be an array.");
  const artifacts = value.map((raw, index) => parseArtifact(raw, runId, modelName, index));
  const seenKinds = new Set<string>();
  const seenUris = new Set<string>();
  let lastOrder = -1;
  for (const artifact of artifacts) {
    if (seenKinds.has(artifact.kind)) throw invalid(`duplicate artifact kind '${artifact.kind}'.`);
    if (seenUris.has(artifact.uri)) throw invalid(`duplicate artifact URI '${artifact.uri}'.`);
    seenKinds.add(artifact.kind);
    seenUris.add(artifact.uri);
    const order = ARTIFACT_ORDER.indexOf(artifact.kind);
    if (order <= lastOrder) throw invalid("artifacts are not in canonical kind order.");
    lastOrder = order;
  }
  for (
    const required of [
      "request",
      "resolved_parameters",
      "model",
      "scenario",
      "script",
      "diagnostics",
      "evidence",
    ] as const
  ) {
    if (!seenKinds.has(required)) throw invalid(`required artifact kind '${required}' is missing.`);
  }
  if (seenKinds.has("parameter_schema") !== expectsParameterSchema) {
    throw invalid("parameter_schema identity and artifact presence disagree.");
  }
  return artifacts;
}

function parseArtifact(
  value: unknown,
  runId: string,
  modelName: string,
  index: number,
): Artifact {
  const artifact = object(value, `artifacts[${index}]`);
  exactKeys(artifact, ["bytes", "kind", "qualification", "sha256", "uri"], ["qualification"]);
  const kind = enumValue(artifact.kind, ARTIFACT_ORDER, `artifacts[${index}].kind`);
  const expectedFile = artifactFileName(kind, modelName);
  const expectedUri = `casys://modelica/runs/${runId}/${expectedFile}`;
  const uri = nonEmpty(artifact.uri, `artifacts[${index}].uri`);
  if (uri !== expectedUri) {
    throw invalid(`artifacts[${index}].uri is not the canonical URI for '${kind}'.`, {
      expected: expectedUri,
      received: uri,
    });
  }
  const qualification = artifact.qualification === undefined ? undefined : enumValue(
    artifact.qualification,
    ["qualified-kit", "compiler-derived-verified"] as const,
    `artifacts[${index}].qualification`,
  );
  const expectedQualification = kind === "model" || kind === "scenario"
    ? "qualified-kit"
    : kind === "parameter_schema"
    ? "compiler-derived-verified"
    : undefined;
  if (qualification !== expectedQualification) {
    throw invalid(`artifacts[${index}].qualification is inconsistent with '${kind}'.`);
  }
  const bytes = artifact.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw invalid(`artifacts[${index}].bytes must be a non-negative safe integer.`);
  }
  return {
    kind,
    uri,
    sha256: digest(artifact.sha256, `artifacts[${index}].sha256`),
    bytes,
    ...(qualification === undefined ? {} : { qualification }),
  };
}

export function artifactFileName(kind: Artifact["kind"], modelName: string): string {
  switch (kind) {
    case "request":
      return "request.json";
    case "resolved_parameters":
      return "resolved-parameters.json";
    case "model":
      return `${modelicaIdentifier(modelName, "model.name")}.mo`;
    case "scenario":
      return "scenario.json";
    case "parameter_schema":
      return "parameter-schema.json";
    case "script":
      return "run.mos";
    case "diagnostics":
      return "omc.log";
    case "result":
      return "result.csv";
    case "evidence":
      return "evidence.json";
  }
}

function crossCheckSourceArtifacts(
  artifacts: Artifact[],
  model: SimulationRun["model"],
  scenario: SimulationRun["scenario"],
  parameterSchema: SimulationRun["parameter_schema"],
): void {
  const byKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
  if (byKind.get("model")?.sha256 !== model.source_sha256) {
    throw invalid("model.source_sha256 does not match the model artifact ledger.");
  }
  if (byKind.get("scenario")?.sha256 !== scenario.source_sha256) {
    throw invalid("scenario.source_sha256 does not match the scenario artifact ledger.");
  }
  if (parameterSchema && byKind.get("parameter_schema")?.sha256 !== parameterSchema.source_sha256) {
    throw invalid("parameter_schema.source_sha256 does not match its artifact ledger.");
  }
}

function quantityMap(value: unknown, label: string): Record<string, Quantity> {
  const raw = object(value, label);
  const result: Record<string, Quantity> = {};
  for (const [key, child] of Object.entries(raw)) {
    if (key.length === 0) throw invalid(`${label} contains an empty quantity id.`);
    const quantity = object(child, `${label}.${key}`);
    exactKeys(quantity, ["unit", "value"]);
    if (typeof quantity.value !== "number" || !Number.isFinite(quantity.value)) {
      throw invalid(`${label}.${key}.value must be finite.`);
    }
    result[key] = {
      value: quantity.value,
      unit: nonEmpty(quantity.unit, `${label}.${key}.unit`),
    };
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalid(`${label} must be an array of strings.`);
  }
  return [...value];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw invalid(`unknown field '${key}' is not accepted.`);
  }
  for (const key of allowed) {
    if (!optionalSet.has(key) && !(key in value)) {
      throw invalid(`required field '${key}' is missing.`);
    }
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

function runIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw invalid(`${label} must be a canonical run UUID identifier.`);
  }
  return value;
}

function modelicaIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODELICA_IDENTIFIER.test(value)) {
    throw invalid(`${label} must be a simple server-owned Modelica identifier.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} must be an ISO timestamp.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalid(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw invalid(`${label} must equal '${expected}'.`);
  return expected;
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

function invalid(messageText: string, context: Record<string, unknown> = {}): ValidationError {
  const suffix = Object.keys(context).length === 0 ? "" : ` ${JSON.stringify(context)}`;
  return new ValidationError(`Invalid persisted Modelica run ledger: ${messageText}${suffix}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
