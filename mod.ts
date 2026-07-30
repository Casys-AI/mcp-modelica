/** Public API for Casys' approved OpenModelica kit runner. */
export { ModelicaToolsClient } from "./src/client.ts";
export { OpenModelicaRunner } from "./src/api/omc-runner.ts";
export { createModelicaService, ModelicaService } from "./src/domain/service.ts";
export { createDefaultKitRegistry, KitRegistry } from "./src/kits/registry.ts";
export { RunNotFoundError, ValidationError } from "./src/domain/errors.ts";
export type {
  Artifact,
  EngineIdentity,
  ModelicaKit,
  ParameterDefinition,
  PublicKit,
  Quantity,
  RunnerInput,
  RunnerOutput,
  RunStatus,
  SimulateInput,
  SimulationRun,
  SimulationRunner,
} from "./src/domain/types.ts";
