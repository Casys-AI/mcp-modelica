/** A physical scalar, always accompanied by its explicit unit. */
export interface Quantity {
  value: number;
  unit: string;
}

export interface ParameterDefinition {
  id: string;
  modelicaName: string;
  description: string;
  unit: string;
  defaultValue: number;
  minimum: number;
  maximum: number;
  toModelica(value: number): number;
}

export interface SimulationScenario {
  id: string;
  description: string;
  startTimeS: number;
  stopTimeS: number;
  numberOfIntervals: number;
  solver: string;
  targetTemperature: Quantity;
}

export interface ModelicaKit {
  id: string;
  version: string;
  description: string;
  modelName: string;
  modelSource: string;
  parameters: readonly ParameterDefinition[];
  scenarios: readonly SimulationScenario[];
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
  produced_metrics: Array<{ id: string; unit: string; description: string }>;
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
  readonly engine: EngineIdentity;
  execute(input: RunnerInput): Promise<RunnerOutput>;
}

export interface Artifact {
  kind:
    | "request"
    | "resolved_parameters"
    | "model"
    | "script"
    | "diagnostics"
    | "result"
    | "evidence";
  uri: string;
  sha256: string;
  bytes: number;
}

export interface SimulationRun {
  status: RunStatus;
  run_id: string;
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
  artifacts: Artifact[];
  warnings: string[];
}
