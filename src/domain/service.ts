import { join } from "@std/path";
import { OpenModelicaRunner } from "../api/omc-runner.ts";
import { createDefaultKitRegistry, KitRegistry } from "../kits/registry.ts";
import { RunNotFoundError, ValidationError } from "./errors.ts";
import { sha256, sha256Bytes, stableJson } from "./hashing.ts";
import { convertToModelica } from "./units.ts";
import { parseModelicaParameterSchema } from "../kits/modelica-parameter-schema.ts";
import { CapacityCoordinator } from "../storage/capacity-coordinator.ts";
import {
  artifactFileName,
  isRecordedSimulationRun,
  legacyArtifactFileName,
  MODELICA_RUN_RECORD_SCHEMA_VERSION,
  parsePersistedSimulationRunRecord,
  projectRecordedRunToLegacy,
} from "./run-record.ts";
import type {
  Artifact,
  EngineIdentity,
  LegacyModelicaRunSummary,
  LegacyPublicKit,
  LegacySimulationRun,
  ModelicaKit,
  ModelicaRunSummary,
  PersistedSimulationRun,
  PublicKit,
  Quantity,
  RunnerOutput,
  SimulateInput,
  SimulationResultNormalizer,
  SimulationRun,
  SimulationRunner,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STORED_RUNS = 20;
const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ModelicaServiceOptions {
  registry?: KitRegistry;
  runner?: SimulationRunner;
  runsDirectory?: string;
}

/**
 * The application boundary for approved Modelica kits.
 *
 * There is intentionally no model path, Modelica source, shell command or
 * arbitrary script in its public input: callers can only select a shipped
 * model/scenario and bounded numeric overrides.
 */
export class ModelicaService {
  private readonly capacity: CapacityCoordinator;

  constructor(
    private readonly registry: KitRegistry,
    private readonly runner: SimulationRunner,
    private readonly runsDirectory: string,
  ) {
    this.capacity = new CapacityCoordinator(runsDirectory);
  }

  /** Internal application seam for the 2.1 resumable successor. */
  getQualifiedKit(modelId: unknown, version: unknown): ModelicaKit {
    return this.requireQualifiedKit(modelId, version);
  }

  /** Exact code resolver used to replay a sealed 2.1 normalizer identity. */
  resolveResultNormalizer(id: string, version: string): SimulationResultNormalizer {
    return this.registry.resolveResultNormalizer(id, version);
  }

  /** Internal application seam; no caller controls the runner implementation. */
  getSimulationRunner(): SimulationRunner {
    return this.runner;
  }

  async getRuntimeEngineIdentity(): Promise<EngineIdentity> {
    return await this.runner.getRuntimeEngineIdentity();
  }

  /** Shared evidence root used by both immutable 2.0 and resumable 2.1 stores. */
  getRunsDirectory(): string {
    return this.runsDirectory;
  }

  listKits(): PublicKit[] {
    return this.registry.list().map(toPublicKit);
  }

  /** Frozen catalogue projection for modelica_kit_list@1.0. */
  listLegacyKits(): LegacyPublicKit[] {
    return this.listKits().map((kit) => ({
      ...kit,
      produced_metrics: kit.produced_metrics.map(({ id, unit, description }) => ({
        id,
        unit,
        description,
      })),
    }));
  }

  /**
   * List persisted simulation records without rerunning, deleting, or
   * otherwise modifying their evidence. The order is deliberately based on
   * the immutable run identifier rather than filesystem timestamps.
   */
  async listRuns(rawLimit: unknown = MAX_STORED_RUNS): Promise<LegacyModelicaRunSummary[]> {
    const limit = parseRunListLimit(rawLimit);
    const projected = await Promise.all((await this.loadAllPersistedRuns()).map(toLegacyRun));
    return projected.map(toLegacyRunSummary).slice(0, limit);
  }

  /** Recorded 2.0 index; strict legacy records are deliberately excluded. */
  async listRecordedRuns(rawLimit: unknown = MAX_STORED_RUNS): Promise<ModelicaRunSummary[]> {
    const limit = parseRunListLimit(rawLimit);
    return (await this.loadAllPersistedRuns())
      .filter(isRecordedSimulationRun)
      .map(toRecordedRunSummary)
      .slice(0, limit);
  }

  /** Strict bi-read surface used to bootstrap only ledger-attested resources. */
  async listPersistedRuns(rawLimit: unknown = MAX_STORED_RUNS): Promise<PersistedSimulationRun[]> {
    const limit = parseRunListLimit(rawLimit);
    return (await this.loadAllPersistedRuns()).slice(0, limit);
  }

  private async loadAllPersistedRuns(): Promise<PersistedSimulationRun[]> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(this.runsDirectory)) entries.push(entry);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }

    const runIds = entries
      .filter((entry) => entry.isDirectory && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const runs: PersistedSimulationRun[] = [];
    for (const runId of runIds) {
      try {
        runs.push(await this.readPersistedRun(runId));
      } catch (error) {
        // A concurrent list can observe the directory before simulate has
        // atomically published its final run.json. It is not a stored run yet.
        if (error instanceof RunNotFoundError) continue;
        throw error;
      }
    }
    return runs;
  }

  async simulate(rawInput: unknown): Promise<SimulationRun> {
    const input = parseSimulateInput(rawInput);
    const kit = this.registry.require(input.model_id);
    const scenario = kit.scenarios.find((candidate) => candidate.id === input.scenario_id);
    if (!scenario) {
      throw new ValidationError(
        `Unknown scenario_id '${input.scenario_id}' for model '${kit.id}'.`,
      );
    }
    const resolved = resolveParameters(kit, input.parameter_overrides ?? {});
    const engine = await this.getRuntimeEngineIdentity();
    const modelHash = await sha256(kit.modelSource);
    if (!scenario.source) {
      throw new ValidationError(
        `Qualified scenario '${scenario.id}' has no server-owned exact JSON source.`,
      );
    }
    const scenarioSourceHash = await sha256(scenario.source);
    const scenarioProjectionHash = await sha256(stableJson(toPublicScenario(scenario)));
    const parameterSchemaSourceHash = kit.parameterSchemaSource === undefined
      ? undefined
      : await sha256(kit.parameterSchemaSource);
    const model = {
      id: kit.id,
      version: kit.version,
      name: kit.modelName,
      source_sha256: modelHash,
    };
    const scenarioIdentity = {
      id: scenario.id,
      source_sha256: scenarioSourceHash,
      projection_sha256: scenarioProjectionHash,
    };
    const parameterSchemaIdentity = parameterSchemaSourceHash === undefined ? undefined : {
      source_sha256: parameterSchemaSourceHash,
      model_source_sha256: modelHash,
      qualification: "compiler-derived-verified" as const,
    };
    const resultNormalizerIdentity = {
      id: kit.resultNormalizer.id,
      version: kit.resultNormalizer.version,
    };
    const fingerprint = await sha256(stableJson({
      engine,
      model,
      ...(parameterSchemaIdentity === undefined
        ? {}
        : { parameter_schema: parameterSchemaIdentity }),
      result_normalizer: resultNormalizerIdentity,
      resolved_parameters: resolved.quantities,
      scenario: scenarioIdentity,
    }));
    const runId = `run_${crypto.randomUUID()}`;
    const runDirectory = join(this.runsDirectory, runId);
    const reservation = await this.capacity.reserve("legacy");
    try {
      await reservation.promote(runDirectory);
    } catch (error) {
      await reservation.release();
      throw error;
    }
    const startedAt = new Date().toISOString();

    const artifacts: Artifact[] = [];
    await this.writeArtifact(
      runId,
      runDirectory,
      "request.json",
      "request",
      stableJson(input),
      artifacts,
    );
    await this.writeArtifact(
      runId,
      runDirectory,
      "resolved-parameters.json",
      "resolved_parameters",
      stableJson(resolved.quantities),
      artifacts,
    );
    await this.writeArtifact(
      runId,
      runDirectory,
      artifactFileName("model", kit.modelName),
      "model",
      kit.modelSource,
      artifacts,
      "qualified-kit",
    );
    await this.writeArtifact(
      runId,
      runDirectory,
      "scenario.json",
      "scenario",
      scenario.source,
      artifacts,
      "qualified-kit",
    );
    if (kit.parameterSchemaSource) {
      await this.writeArtifact(
        runId,
        runDirectory,
        "parameter-schema.json",
        "parameter_schema",
        kit.parameterSchemaSource,
        artifacts,
        "compiler-derived-verified",
      );
    }
    const script = buildOmcScript(
      kit,
      scenario,
      resolved.modelicaValues,
      artifactFileName("model", kit.modelName),
    );
    const scriptPath = join(runDirectory, "run.mos");
    await this.writeArtifact(runId, runDirectory, "run.mos", "script", script, artifacts);

    let execution: RunnerOutput;
    try {
      execution = await this.runner.execute({
        runDirectory,
        scriptPath,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      execution = {
        status: "failed",
        diagnostics: `Simulation runner threw: ${message(error)}`,
      };
    }
    await this.writeArtifact(
      runId,
      runDirectory,
      "omc.log",
      "diagnostics",
      execution.diagnostics,
      artifacts,
    );

    let status = execution.status;
    let metrics: Record<string, Quantity> = {};
    const warnings = [...(execution.warnings ?? [])];
    if (execution.status === "succeeded" && execution.resultCsv !== undefined) {
      await this.writeArtifact(
        runId,
        runDirectory,
        "result.csv",
        "result",
        execution.resultCsv,
        artifacts,
      );
      try {
        const extracted = kit.resultNormalizer.normalize(execution.resultCsv, scenario);
        validateNormalizationResult(kit, extracted);
        metrics = extracted.metrics;
        warnings.push(...extracted.warnings);
      } catch (error) {
        status = "failed";
        warnings.push(`Simulation output could not be interpreted: ${message(error)}`);
      }
    } else if (execution.status === "succeeded") {
      status = "failed";
      warnings.push("Simulation runner reported success without a CSV result.");
    }

    const evidence = {
      producer: "mcp-modelica",
      status,
      model,
      scenario: scenarioIdentity,
      ...(parameterSchemaIdentity === undefined
        ? {}
        : { parameter_schema: parameterSchemaIdentity }),
      result_normalizer: resultNormalizerIdentity,
      metrics,
      warnings,
      note:
        "This is computed evidence only. Requirement pass/fail belongs to mcp-syson and @casys/constraint-solver.",
    };
    await this.writeArtifact(
      runId,
      runDirectory,
      "evidence.json",
      "evidence",
      stableJson(evidence),
      artifacts,
    );

    const run: SimulationRun = {
      record_schema_version: MODELICA_RUN_RECORD_SCHEMA_VERSION,
      status,
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      fingerprint,
      model,
      scenario: scenarioIdentity,
      ...(parameterSchemaIdentity === undefined
        ? {}
        : { parameter_schema: parameterSchemaIdentity }),
      result_normalizer: resultNormalizerIdentity,
      engine,
      resolved_parameters: resolved.quantities,
      metrics,
      artifacts,
      warnings,
    };
    await this.writeRunRecord(runDirectory, run);
    return run;
  }

  async getRun(runId: unknown): Promise<LegacySimulationRun> {
    return await toLegacyRun(await this.readPersistedRun(runId));
  }

  async getRecordedRun(runId: unknown): Promise<SimulationRun> {
    const run = await this.readPersistedRun(runId);
    if (!isRecordedSimulationRun(run)) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' uses the legacy ledger and is unavailable through the recorded 2.0 contract.`,
      );
    }
    return run;
  }

  async readPersistedRun(runId: unknown): Promise<PersistedSimulationRun> {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) {
      throw new ValidationError("run_id must be a run identifier returned by modelica_simulate.");
    }
    try {
      const { source } = await readCanonicalUtf8File(
        join(this.runsDirectory, runId, "run.json"),
      );
      const run = await parsePersistedSimulationRunRecord(source, runId);
      await this.assertRunKitIdentity(run);
      return run;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new RunNotFoundError(runId);
      throw error;
    }
  }

  /**
   * Read the shipped source again and prove that it still represents the
   * requested qualified kit identity. This is a resource-only capability;
   * callers cannot supply paths or Modelica source through it.
   */
  async readQualifiedModelSource(modelId: unknown, version: unknown): Promise<{
    id: string;
    version: string;
    modelName: string;
    source: string;
    sha256: string;
    bytes: number;
  }> {
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new ValidationError("model_id must be a non-empty qualified kit identifier.");
    }
    if (typeof version !== "string" || version.length === 0) {
      throw new ValidationError("version must be a non-empty qualified kit version.");
    }
    const kit = this.registry.require(modelId);
    if (kit.version !== version) {
      throw new ValidationError(
        `Unknown qualified kit identity '${modelId}' version '${version}'.`,
      );
    }
    if (!kit.modelSourceUrl) {
      throw new ValidationError(
        `Qualified kit '${modelId}' does not expose a server-owned source resource.`,
      );
    }
    const { source, digest, bytes } = await readCanonicalUtf8File(kit.modelSourceUrl);
    const expectedDigest = await sha256(kit.modelSource);
    if (digest !== expectedDigest) {
      throw new ValidationError(
        `Qualified kit '${modelId}' source bytes no longer match its loaded identity.`,
      );
    }
    return {
      id: kit.id,
      version: kit.version,
      modelName: kit.modelName,
      source,
      sha256: digest,
      bytes,
    };
  }

  async readQualifiedScenarioSource(
    modelId: unknown,
    version: unknown,
    scenarioId: unknown,
  ): Promise<{
    id: string;
    source: string;
    sha256: string;
    bytes: number;
  }> {
    const kit = this.requireQualifiedKit(modelId, version);
    if (typeof scenarioId !== "string" || scenarioId.length === 0) {
      throw new ValidationError("scenario_id must be a non-empty qualified scenario identifier.");
    }
    const scenario = kit.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario?.sourceUrl || scenario.source === undefined) {
      throw new ValidationError(
        `Qualified scenario '${scenarioId}' does not expose a server-owned JSON resource.`,
      );
    }
    const { source, digest, bytes } = await readCanonicalUtf8File(scenario.sourceUrl);
    if (digest !== await sha256(scenario.source)) {
      throw new ValidationError(
        `Qualified scenario '${scenarioId}' source bytes no longer match its loaded identity.`,
      );
    }
    return { id: scenario.id, source, sha256: digest, bytes };
  }

  async readQualifiedParameterSchema(modelId: unknown, version: unknown): Promise<{
    source: string;
    sha256: string;
    bytes: number;
  }> {
    const kit = this.requireQualifiedKit(modelId, version);
    if (!kit.parameterSchemaSourceUrl || kit.parameterSchemaSource === undefined) {
      throw new ValidationError(
        `Qualified kit '${kit.id}' has no server-owned compiler-derived parameter schema resource.`,
      );
    }
    const { source, digest, bytes } = await readCanonicalUtf8File(
      kit.parameterSchemaSourceUrl,
    );
    if (digest !== await sha256(kit.parameterSchemaSource)) {
      throw new ValidationError(
        `Qualified kit '${kit.id}' compiler-derived parameter schema bytes no longer match its loaded identity.`,
      );
    }
    const schema = parseModelicaParameterSchema(source);
    const model = await this.readQualifiedModelSource(kit.id, kit.version);
    if (schema.modelName !== model.modelName || schema.modelSourceSha256 !== model.sha256) {
      throw new ValidationError(
        `Qualified kit '${kit.id}' compiler-derived parameter schema no longer matches its exact Modelica source.`,
      );
    }
    return { source, sha256: digest, bytes };
  }

  listQualifiedSourceIdentities(): Array<{
    modelId: string;
    version: string;
    hasModelSource: boolean;
    hasParameterSchema: boolean;
    scenarioIds: string[];
  }> {
    return this.registry.list().map((kit) => ({
      modelId: kit.id,
      version: kit.version,
      hasModelSource: kit.modelSourceUrl !== undefined,
      hasParameterSchema: kit.parameterSchemaSourceUrl !== undefined &&
        kit.parameterSchemaSource !== undefined,
      scenarioIds: kit.scenarios
        .filter((scenario) => scenario.sourceUrl !== undefined && scenario.source !== undefined)
        .map((scenario) => scenario.id),
    }));
  }

  /**
   * Re-open one artifact named in a persisted run ledger. The URI selects only
   * a ledger entry; it can never become an arbitrary filesystem path.
   */
  async readRunArtifact(runId: unknown, uri: unknown): Promise<{
    uri: string;
    kind: Artifact["kind"];
    source: string;
    sha256: string;
    bytes: number;
  }> {
    const run = await this.readPersistedRun(runId);
    if (typeof uri !== "string") {
      throw new ValidationError("artifact URI must be a string from a persisted run ledger.");
    }
    const artifact = run.artifacts.find((candidate) => candidate.uri === uri);
    if (!artifact) {
      throw new ValidationError(`Artifact '${uri}' is not in the persisted run ledger.`);
    }
    let fileName: string;
    if (isRecordedSimulationRun(run)) {
      const recordedArtifact = run.artifacts.find((candidate) => candidate.uri === uri)!;
      fileName = artifactFileName(recordedArtifact.kind, run.model.name);
    } else {
      const legacyArtifact = run.artifacts.find((candidate) => candidate.uri === uri)!;
      fileName = legacyArtifactFileName(legacyArtifact.kind, legacyArtifact.uri, run.run_id);
    }
    const { source, bytes, digest } = await readCanonicalUtf8File(
      join(this.runsDirectory, run.run_id, fileName),
    );
    if (bytes !== artifact.bytes || digest !== artifact.sha256) {
      throw new ValidationError(
        `Artifact '${artifact.uri}' no longer matches its persisted bytes and SHA-256 ledger.`,
      );
    }
    return { uri: artifact.uri, kind: artifact.kind, source, sha256: digest, bytes };
  }

  private async writeArtifact(
    runId: string,
    directory: string,
    fileName: string,
    kind: Artifact["kind"],
    contents: string,
    artifacts: Artifact[],
    qualification?: Artifact["qualification"],
  ): Promise<void> {
    await Deno.writeTextFile(join(directory, fileName), contents);
    artifacts.push({
      kind,
      uri: `casys://modelica/runs/${runId}/${fileName}`,
      sha256: await sha256(contents),
      bytes: utf8Bytes(contents),
      ...(qualification === undefined ? {} : { qualification }),
    });
  }

  private requireQualifiedKit(modelId: unknown, version: unknown): ModelicaKit {
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new ValidationError("model_id must be a non-empty qualified kit identifier.");
    }
    if (typeof version !== "string" || version.length === 0) {
      throw new ValidationError("version must be a non-empty qualified kit version.");
    }
    const kit = this.registry.require(modelId);
    if (kit.version !== version) {
      throw new ValidationError(
        `Unknown qualified kit identity '${modelId}' version '${version}'.`,
      );
    }
    return kit;
  }

  private async assertRunKitIdentity(run: PersistedSimulationRun): Promise<void> {
    const kit = this.requireQualifiedKit(run.model.id, run.model.version);
    const modelHash = isRecordedSimulationRun(run) ? run.model.source_sha256 : run.model.sha256;
    if (modelHash !== await sha256(kit.modelSource)) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' model identity does not match its server-owned qualified kit.`,
      );
    }
    const modelArtifact = run.artifacts.find((artifact) => artifact.kind === "model");
    if (
      !modelArtifact ||
      (isRecordedSimulationRun(run)
        ? run.model.name !== kit.modelName
        : legacyArtifactFileName("model", modelArtifact.uri, run.run_id) !== `${kit.modelName}.mo`)
    ) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' model filename does not match its server-owned qualified kit.`,
      );
    }
    const scenario = kit.scenarios.find((candidate) => candidate.id === run.scenario.id);
    if (!scenario?.source) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' scenario is not present with exact source in its qualified kit.`,
      );
    }
    const projectionHash = await sha256(stableJson(toPublicScenario(scenario)));
    if (
      isRecordedSimulationRun(run)
        ? run.scenario.source_sha256 !== await sha256(scenario.source) ||
          run.scenario.projection_sha256 !== projectionHash
        : run.scenario.sha256 !== projectionHash
    ) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' scenario source/projection identity does not match its qualified kit.`,
      );
    }
    validateProducedMetrics(
      kit,
      run.metrics,
      run.status === "succeeded",
      `Persisted run '${run.run_id}'`,
    );
    if (!isRecordedSimulationRun(run)) {
      this.assertResolvedParameters(run, kit);
      return;
    }
    const expectedParameterSchema = kit.parameterSchemaSource === undefined ? undefined : {
      source_sha256: await sha256(kit.parameterSchemaSource),
      model_source_sha256: run.model.source_sha256,
      qualification: "compiler-derived-verified" as const,
    };
    if (stableJson(run.parameter_schema) !== stableJson(expectedParameterSchema)) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' parameter-schema identity does not match its qualified kit.`,
      );
    }
    if (
      run.result_normalizer.id !== kit.resultNormalizer.id ||
      run.result_normalizer.version !== kit.resultNormalizer.version
    ) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' result-normalizer identity does not match its qualified kit.`,
      );
    }
    this.assertResolvedParameters(run, kit);
  }

  private assertResolvedParameters(
    run: PersistedSimulationRun,
    kit: ModelicaKit,
  ): void {
    const expectedParameterIds = kit.parameters.map((parameter) => parameter.id).sort();
    if (
      stableJson(Object.keys(run.resolved_parameters).sort()) !== stableJson(expectedParameterIds)
    ) {
      throw new ValidationError(
        `Persisted run '${run.run_id}' resolved parameter set does not match its qualified kit.`,
      );
    }
    for (const parameter of kit.parameters) {
      const resolved = run.resolved_parameters[parameter.id];
      if (
        resolved.unit !== parameter.unit || resolved.value < parameter.minimum ||
        resolved.value > parameter.maximum
      ) {
        throw new ValidationError(
          `Persisted run '${run.run_id}' resolved parameter '${parameter.id}' is outside its qualified contract.`,
        );
      }
    }
  }

  private async writeRunRecord(directory: string, run: SimulationRun): Promise<void> {
    const runPath = join(directory, "run.json");
    const temporaryPath = `${runPath}.tmp`;
    await Deno.writeTextFile(temporaryPath, stableJson(run));
    await Deno.rename(temporaryPath, runPath);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

async function readCanonicalUtf8File(path: string | URL): Promise<{
  source: string;
  bytes: number;
  digest: string;
}> {
  const raw = await Deno.readFile(path);
  const source = strictUtf8.decode(raw);
  const reencoded = new TextEncoder().encode(source);
  if (
    raw.byteLength !== reencoded.byteLength ||
    !raw.every((byte, index) => byte === reencoded[index])
  ) {
    throw new ValidationError(
      `Text resource '${path}' is not canonical UTF-8 and cannot be exposed as MCP text.`,
    );
  }
  return {
    source,
    bytes: raw.byteLength,
    digest: await sha256Bytes(raw),
  };
}

export async function createModelicaService(
  options: ModelicaServiceOptions = {},
): Promise<ModelicaService> {
  const runsDirectory = options.runsDirectory ?? defaultRunsDirectory();
  return new ModelicaService(
    options.registry ?? await createDefaultKitRegistry(),
    options.runner ?? new OpenModelicaRunner("omc", runsDirectory),
    runsDirectory,
  );
}

function defaultRunsDirectory(): string {
  try {
    return Deno.env.get("MODELICA_RUN_DIR") ?? join(Deno.cwd(), "runs");
  } catch {
    return join(Deno.cwd(), "runs");
  }
}

function toPublicKit(kit: ModelicaKit): PublicKit {
  return {
    id: kit.id,
    version: kit.version,
    description: kit.description,
    parameters: kit.parameters.map((parameter) => ({
      id: parameter.id,
      description: parameter.description,
      unit: parameter.unit,
      default: { value: parameter.defaultValue, unit: parameter.unit },
      minimum: parameter.minimum,
      maximum: parameter.maximum,
    })),
    scenarios: kit.scenarios.map(toPublicScenario),
    produced_metrics: kit.producedMetrics.map((metric) => ({ ...metric })),
  };
}

function validateNormalizationResult(
  kit: ModelicaKit,
  result: { metrics: Record<string, Quantity>; warnings: string[] },
): void {
  if (
    !result || typeof result !== "object" || !Array.isArray(result.warnings) ||
    !result.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new ValidationError(
      `Result normalizer '${kit.resultNormalizer.id}@${kit.resultNormalizer.version}' returned invalid warnings.`,
    );
  }
  validateProducedMetrics(kit, result.metrics, true, "Result normalizer");
}

function validateProducedMetrics(
  kit: ModelicaKit,
  metrics: Record<string, Quantity>,
  requireRequired: boolean,
  subject: string,
): void {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new ValidationError(`${subject} metrics must be an object.`);
  }
  const definitions = new Map(kit.producedMetrics.map((definition) => [definition.id, definition]));
  for (const [id, quantity] of Object.entries(metrics)) {
    const definition = definitions.get(id);
    if (!definition) {
      throw new ValidationError(
        `${subject} emitted undeclared metric '${id}' for Modelica kit '${kit.id}'.`,
      );
    }
    if (
      !quantity || typeof quantity !== "object" || typeof quantity.value !== "number" ||
      !Number.isFinite(quantity.value)
    ) {
      throw new ValidationError(`${subject} metric '${id}' must contain a finite value.`);
    }
    if (quantity.unit !== definition.unit) {
      throw new ValidationError(
        `${subject} metric '${id}' uses unit '${quantity.unit}'; expected '${definition.unit}'.`,
      );
    }
  }
  if (requireRequired) {
    for (const definition of kit.producedMetrics) {
      if (definition.required && !(definition.id in metrics)) {
        throw new ValidationError(
          `${subject} is missing required metric '${definition.id}' for Modelica kit '${kit.id}'.`,
        );
      }
    }
  }
}

function toRecordedRunSummary(run: SimulationRun): ModelicaRunSummary {
  return {
    record_schema_version: run.record_schema_version,
    status: run.status,
    run_id: run.run_id,
    started_at: run.started_at,
    completed_at: run.completed_at,
    fingerprint: run.fingerprint,
    model: run.model,
    scenario: run.scenario,
  };
}

async function toLegacyRun(run: PersistedSimulationRun): Promise<LegacySimulationRun> {
  return isRecordedSimulationRun(run) ? await projectRecordedRunToLegacy(run) : run;
}

function toLegacyRunSummary(run: LegacySimulationRun): LegacyModelicaRunSummary {
  return {
    status: run.status,
    run_id: run.run_id,
    ...(run.started_at === undefined ? {} : { started_at: run.started_at }),
    ...(run.completed_at === undefined ? {} : { completed_at: run.completed_at }),
    fingerprint: run.fingerprint,
    model: run.model,
    scenario: run.scenario,
  };
}

function toPublicScenario(scenario: ModelicaKit["scenarios"][number]) {
  return {
    id: scenario.id,
    description: scenario.description,
    stop_time_s: scenario.stopTimeS,
    number_of_intervals: scenario.numberOfIntervals,
    solver: scenario.solver,
    target_temperature: scenario.targetTemperature,
  };
}

function parseSimulateInput(value: unknown): SimulateInput {
  const input = record(value, "modelica_simulate input");
  assertOnlyKeys(input, ["model_id", "scenario_id", "parameter_overrides", "timeout_ms"]);
  if (typeof input.model_id !== "string" || input.model_id.length === 0) {
    throw new ValidationError("model_id must be a non-empty string.");
  }
  if (typeof input.scenario_id !== "string" || input.scenario_id.length === 0) {
    throw new ValidationError("scenario_id must be a non-empty string.");
  }
  let timeoutMs: number | undefined;
  if (input.timeout_ms !== undefined) {
    if (
      typeof input.timeout_ms !== "number" ||
      !Number.isSafeInteger(input.timeout_ms) ||
      input.timeout_ms < 1 ||
      input.timeout_ms > MAX_TIMEOUT_MS
    ) {
      throw new ValidationError(`timeout_ms must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
    timeoutMs = input.timeout_ms;
  }
  const overrides: Record<string, Quantity> = {};
  if (input.parameter_overrides !== undefined) {
    const rawOverrides = record(input.parameter_overrides, "parameter_overrides");
    for (const [id, rawQuantity] of Object.entries(rawOverrides)) {
      const quantity = record(rawQuantity, `parameter_overrides.${id}`);
      assertOnlyKeys(quantity, ["value", "unit"]);
      if (typeof quantity.value !== "number" || !Number.isFinite(quantity.value)) {
        throw new ValidationError(`parameter_overrides.${id}.value must be a finite number.`);
      }
      if (typeof quantity.unit !== "string" || quantity.unit.length === 0) {
        throw new ValidationError(`parameter_overrides.${id}.unit must be a non-empty string.`);
      }
      overrides[id] = { value: quantity.value, unit: quantity.unit };
    }
  }
  return {
    model_id: input.model_id,
    scenario_id: input.scenario_id,
    ...(Object.keys(overrides).length > 0 ? { parameter_overrides: overrides } : {}),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  };
}

function parseRunListLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_STORED_RUNS
  ) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MAX_STORED_RUNS}.`,
    );
  }
  return value;
}

function resolveParameters(kit: ModelicaKit, overrides: Record<string, Quantity>) {
  const quantities: Record<string, Quantity> = {};
  const modelicaValues: Record<string, number> = {};
  for (const parameter of kit.parameters) {
    const override = overrides[parameter.id];
    const value = override?.value ?? parameter.defaultValue;
    const unit = override?.unit ?? parameter.unit;
    if (override && unit !== parameter.unit) {
      throw new ValidationError(
        `parameter_overrides.${parameter.id} uses '${unit}'; expected '${parameter.unit}'.`,
      );
    }
    if (value < parameter.minimum || value > parameter.maximum) {
      throw new ValidationError(
        `parameter_overrides.${parameter.id} must be between ${parameter.minimum} and ${parameter.maximum} ${parameter.unit}.`,
      );
    }
    quantities[parameter.id] = { value, unit: parameter.unit };
    modelicaValues[parameter.modelicaName] = convertToModelica(value, parameter.conversion);
  }
  for (const id of Object.keys(overrides)) {
    if (!kit.parameters.some((parameter) => parameter.id === id)) {
      throw new ValidationError(`parameter_overrides.${id} is not an approved parameter.`);
    }
  }
  return { quantities, modelicaValues };
}

function buildOmcScript(
  kit: ModelicaKit,
  scenario: ModelicaKit["scenarios"][number],
  modelicaValues: Record<string, number>,
  modelFileName: string,
): string {
  const overrides = Object.entries(modelicaValues)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${formatModelicaNumber(value)}`)
    .join(",");
  return [
    "// Generated by mcp-modelica. Do not edit: the server owns this script.",
    "// OPENMODELICALIBRARY is the pinned, sole library path in the container.",
    "loadModel(Modelica);",
    `loadFile("${modelFileName}");`,
    `simulate(${kit.modelName}, startTime=${formatModelicaNumber(scenario.startTimeS)}, ` +
    `stopTime=${formatModelicaNumber(scenario.stopTimeS)}, ` +
    `numberOfIntervals=${scenario.numberOfIntervals}, method="${scenario.solver}", ` +
    'outputFormat="csv", fileNamePrefix="result", ' +
    `simflags="-override=${overrides}");`,
    "getErrorString();",
    "",
  ].join("\n");
}

function formatModelicaNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Modelica parameter was not finite after validation.");
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`Unknown input field '${key}' is not accepted.`);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
