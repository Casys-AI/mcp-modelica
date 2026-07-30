import { join } from "@std/path";
import { OpenModelicaRunner } from "../api/omc-runner.ts";
import { createDefaultKitRegistry, KitRegistry } from "../kits/registry.ts";
import { RunNotFoundError, ValidationError } from "./errors.ts";
import { sha256, stableJson } from "./hashing.ts";
import { extractCoffeeMachineMetrics } from "./metrics.ts";
import type {
  Artifact,
  ModelicaKit,
  ModelicaRunSummary,
  PublicKit,
  Quantity,
  RunnerOutput,
  SimulateInput,
  SimulationRun,
  SimulationRunner,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STORED_RUNS = 20;
const RUN_ID = /^run_[0-9a-f-]{36}$/;

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
  constructor(
    private readonly registry: KitRegistry,
    private readonly runner: SimulationRunner,
    private readonly runsDirectory: string,
  ) {}

  listKits(): PublicKit[] {
    return this.registry.list().map(toPublicKit);
  }

  /**
   * List persisted simulation records without rerunning, deleting, or
   * otherwise modifying their evidence. The order is deliberately based on
   * the immutable run identifier rather than filesystem timestamps.
   */
  async listRuns(rawLimit: unknown = MAX_STORED_RUNS): Promise<ModelicaRunSummary[]> {
    const limit = parseRunListLimit(rawLimit);
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
    const runs: ModelicaRunSummary[] = [];
    for (const runId of runIds) {
      try {
        runs.push(toRunSummary(await this.getRun(runId)));
      } catch (error) {
        // A concurrent list can observe the directory before simulate has
        // atomically published its final run.json. It is not a stored run yet.
        if (error instanceof RunNotFoundError) continue;
        throw error;
      }
      if (runs.length === limit) break;
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
    const modelHash = await sha256(kit.modelSource);
    const scenarioHash = await sha256(stableJson(toPublicScenario(scenario)));
    const fingerprint = await sha256(stableJson({
      model: { id: kit.id, version: kit.version, sha256: modelHash },
      scenario: { id: scenario.id, sha256: scenarioHash },
      resolved_parameters: resolved.quantities,
      engine: this.runner.engine,
    }));
    const runId = `run_${crypto.randomUUID()}`;
    await this.ensureRunCapacity();
    const runDirectory = join(this.runsDirectory, runId);
    await Deno.mkdir(runDirectory, { recursive: true });
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
      "CoffeeMachine.mo",
      "model",
      kit.modelSource,
      artifacts,
    );
    const script = buildOmcScript(kit, scenario, resolved.modelicaValues);
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
        const extracted = extractCoffeeMachineMetrics(execution.resultCsv, scenario);
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
      model: { id: kit.id, version: kit.version, sha256: modelHash },
      scenario: { id: scenario.id, sha256: scenarioHash },
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
      status,
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      fingerprint,
      model: { id: kit.id, version: kit.version, sha256: modelHash },
      scenario: { id: scenario.id, sha256: scenarioHash },
      engine: this.runner.engine,
      resolved_parameters: resolved.quantities,
      metrics,
      artifacts,
      warnings,
    };
    await this.writeRunRecord(runDirectory, run);
    return run;
  }

  async getRun(runId: unknown): Promise<SimulationRun> {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) {
      throw new ValidationError("run_id must be a run identifier returned by modelica_simulate.");
    }
    try {
      return JSON.parse(
        await Deno.readTextFile(join(this.runsDirectory, runId, "run.json")),
      ) as SimulationRun;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new RunNotFoundError(runId);
      throw error;
    }
  }

  private async writeArtifact(
    runId: string,
    directory: string,
    fileName: string,
    kind: Artifact["kind"],
    contents: string,
    artifacts: Artifact[],
  ): Promise<void> {
    await Deno.writeTextFile(join(directory, fileName), contents);
    artifacts.push({
      kind,
      uri: `casys://modelica/runs/${runId}/${fileName}`,
      sha256: await sha256(contents),
      bytes: new TextEncoder().encode(contents).byteLength,
    });
  }

  private async writeRunRecord(directory: string, run: SimulationRun): Promise<void> {
    const runPath = join(directory, "run.json");
    const temporaryPath = `${runPath}.tmp`;
    await Deno.writeTextFile(temporaryPath, stableJson(run));
    await Deno.rename(temporaryPath, runPath);
  }

  private async ensureRunCapacity(): Promise<void> {
    try {
      let runCount = 0;
      for await (const entry of Deno.readDir(this.runsDirectory)) {
        if (entry.isDirectory && RUN_ID.test(entry.name)) runCount++;
      }
      if (runCount >= MAX_STORED_RUNS) {
        throw new ValidationError(
          `Modelica run storage contains ${runCount} runs (limit ${MAX_STORED_RUNS}). ` +
            "Archive or remove prior evidence before starting another simulation.",
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }
}

export async function createModelicaService(
  options: ModelicaServiceOptions = {},
): Promise<ModelicaService> {
  return new ModelicaService(
    options.registry ?? await createDefaultKitRegistry(),
    options.runner ?? new OpenModelicaRunner(),
    options.runsDirectory ?? defaultRunsDirectory(),
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
    produced_metrics: [
      { id: "water_temperature_max", unit: "degC", description: "Maximum water temperature." },
      {
        id: "time_to_target_temperature",
        unit: "s",
        description: "First sampled time at the scenario target; absent if not reached.",
      },
      { id: "heater_energy", unit: "J", description: "Integrated heater energy." },
      { id: "heater_power_peak", unit: "W", description: "Maximum heater power." },
    ],
  };
}

function toRunSummary(run: SimulationRun): ModelicaRunSummary {
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
    modelicaValues[parameter.modelicaName] = parameter.toModelica(value);
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
): string {
  const overrides = Object.entries(modelicaValues)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${formatModelicaNumber(value)}`)
    .join(",");
  return [
    "// Generated by mcp-modelica. Do not edit: the server owns this script.",
    "// OPENMODELICALIBRARY is the pinned, sole library path in the container.",
    "loadModel(Modelica);",
    'loadFile("CoffeeMachine.mo");',
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
