/** A physical scalar, always accompanied by its explicit unit. */
export interface Quantity {
  value: number;
  unit: string;
}

/**
 * An explicit affine conversion from the agent-facing unit to Modelica's unit.
 *
 * Both units and both arithmetic terms are required: a missing term must never
 * look like an assumed identity conversion.
 */
export interface AffineUnitConversion {
  from: string;
  to: string;
  factor: number;
  offset: number;
}

export interface ParameterDefinition {
  id: string;
  modelicaName: string;
  /** Exact physical type reported by the compiler-derived model schema. */
  modelicaType: string;
  description: string;
  unit: string;
  defaultValue: number;
  minimum: number;
  maximum: number;
  conversion: AffineUnitConversion;
}

export interface SimulationScenario {
  id: string;
  description: string;
  startTimeS: number;
  stopTimeS: number;
  numberOfIntervals: number;
  solver: string;
  targetTemperature: Quantity;
  /** Server-owned JSON used to qualify this scenario, never a caller input. */
  source?: string;
  sourceUrl?: URL;
}

export interface ProducedMetricDefinition {
  id: string;
  unit: string;
  description: string;
  /** Required metrics must be emitted by every successful normalized run. */
  required: boolean;
}

export interface SimulationResultNormalization {
  metrics: Record<string, Quantity>;
  warnings: string[];
}

/**
 * Versioned, kit-owned interpretation of one solver CSV.
 *
 * The orchestration service intentionally knows nothing about result column
 * names or domain-specific metrics. A qualified kit owns that translation.
 */
export interface SimulationResultNormalizer {
  readonly id: string;
  readonly version: string;
  normalize(
    resultCsv: string,
    scenario: SimulationScenario,
  ): SimulationResultNormalization;
}

export interface ModelicaKit {
  id: string;
  version: string;
  description: string;
  modelName: string;
  modelSource: string;
  /**
   * Immutable, server-owned location of the shipped Modelica source.
   *
   * This is deliberately not part of any public tool input. It lets a
   * resource read re-open the exact source bytes and fail closed if they no
   * longer match the qualified kit identity.
   */
  modelSourceUrl?: URL;
  /** Exact compiler-derived parameter facts that qualified the public kit. */
  parameterSchemaSource?: string;
  parameterSchemaSourceUrl?: URL;
  parameters: readonly ParameterDefinition[];
  scenarios: readonly SimulationScenario[];
  producedMetrics: readonly ProducedMetricDefinition[];
  resultNormalizer: SimulationResultNormalizer;
}

export interface PublicParameterDefinition {
  id: string;
  description: string;
  unit: string;
  default: Quantity;
  minimum: number;
  maximum: number;
}

export interface PublicScenario {
  id: string;
  description: string;
  stop_time_s: number;
  number_of_intervals: number;
  solver: string;
  target_temperature: Quantity;
}

export interface PublicKit {
  id: string;
  version: string;
  description: string;
  parameters: PublicParameterDefinition[];
  scenarios: PublicScenario[];
  produced_metrics: ProducedMetricDefinition[];
}

export interface LegacyPublicKit extends Omit<PublicKit, "produced_metrics"> {
  produced_metrics: Array<Omit<ProducedMetricDefinition, "required">>;
}

export interface SimulateInput {
  model_id: string;
  scenario_id: string;
  parameter_overrides?: Record<string, Quantity>;
  timeout_ms?: number;
}

export type RunStatus = "succeeded" | "failed" | "timed_out";

export interface EngineIdentity {
  name: string;
  version: string;
  msl_version: string;
}

export interface RunnerInput {
  runDirectory: string;
  scriptPath: string;
  timeoutMs: number;
}

export interface RunnerOutput {
  status: RunStatus;
  diagnostics: string;
  resultCsv?: string;
  warnings?: string[];
}

export interface SimulationRunner {
  /** Re-probe the executable/library pair used by the next execution. */
  getRuntimeEngineIdentity(): Promise<EngineIdentity>;
  execute(input: RunnerInput): Promise<RunnerOutput>;
}

export interface Artifact {
  kind:
    | "request"
    | "resolved_parameters"
    | "model"
    | "scenario"
    | "parameter_schema"
    | "script"
    | "diagnostics"
    | "result"
    | "evidence";
  uri: string;
  sha256: string;
  bytes: number;
  /** Why this artifact is present in the evidence ledger, when it is a qualified input. */
  qualification?: "qualified-kit" | "compiler-derived-verified";
}

export type LegacyArtifactKind =
  | "request"
  | "resolved_parameters"
  | "model"
  | "script"
  | "diagnostics"
  | "result"
  | "evidence";

export interface LegacyArtifact {
  kind: LegacyArtifactKind;
  uri: string;
  sha256: string;
  bytes: number;
}

/** Exact public/persisted contract written by the 0.2.x server. */
export interface LegacySimulationRun {
  status: RunStatus;
  run_id: string;
  started_at?: string;
  completed_at?: string;
  fingerprint: string;
  model: {
    id: string;
    version: string;
    sha256: string;
  };
  scenario: {
    id: string;
    sha256: string;
  };
  engine: EngineIdentity;
  resolved_parameters: Record<string, Quantity>;
  metrics: Record<string, Quantity>;
  artifacts: LegacyArtifact[];
  warnings: string[];
}

export interface SimulationRun {
  record_schema_version: "2.0";
  status: RunStatus;
  run_id: string;
  started_at: string;
  completed_at: string;
  fingerprint: string;
  model: {
    id: string;
    version: string;
    name: string;
    source_sha256: string;
  };
  scenario: {
    id: string;
    /** SHA-256 of the exact native scenario JSON copied into the run. */
    source_sha256: string;
    /** SHA-256 of the bounded public scenario projection used by the fingerprint. */
    projection_sha256: string;
  };
  parameter_schema?: {
    source_sha256: string;
    model_source_sha256: string;
    qualification: "compiler-derived-verified";
  };
  result_normalizer: {
    id: string;
    version: string;
  };
  engine: EngineIdentity;
  resolved_parameters: Record<string, Quantity>;
  metrics: Record<string, Quantity>;
  artifacts: Artifact[];
  warnings: string[];
}

/** The bounded, discovery-oriented projection returned by modelica_run_list. */
export interface ModelicaRunSummary {
  record_schema_version: SimulationRun["record_schema_version"];
  status: RunStatus;
  run_id: string;
  started_at: string;
  completed_at: string;
  fingerprint: string;
  model: SimulationRun["model"];
  scenario: SimulationRun["scenario"];
}

export interface LegacyModelicaRunSummary {
  status: RunStatus;
  run_id: string;
  started_at?: string;
  completed_at?: string;
  fingerprint: string;
  model: LegacySimulationRun["model"];
  scenario: LegacySimulationRun["scenario"];
}

export type PersistedSimulationRun = LegacySimulationRun | SimulationRun;
