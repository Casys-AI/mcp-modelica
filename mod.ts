/** Public API for Casys' approved OpenModelica kit runner. */
export { ModelicaToolsClient } from "./src/client.ts";
export { ResumableSimulationToolsClient } from "./src/resumable-client.ts";
export { OpenModelicaRunner } from "./src/api/omc-runner.ts";
export { createModelicaService, ModelicaService } from "./src/domain/service.ts";
export {
  ResumableSimulationService,
  type SealedResultSeriesResult,
  type SimulationRequestTemplateResult,
} from "./src/application/resumable-simulation-service.ts";
export { RequestStore } from "./src/storage/request-store.ts";
export { FileRequestLockPort } from "./src/storage/request-lock.ts";
export { FileSimulationWorkspace } from "./src/storage/simulation-workspace.ts";
export { createDefaultKitRegistry, KitRegistry } from "./src/kits/registry.ts";
export {
  kitParameterSchemaUri,
  kitScenarioUri,
  kitSourceUri,
  ModelicaEvidenceResources,
} from "./src/resources/modelica-evidence-resources.ts";
export { ResumableEvidenceResources } from "./src/resources/resumable-evidence-resources.ts";
export { RunNotFoundError, ValidationError } from "./src/domain/errors.ts";
export {
  isRecordedSimulationRun,
  MODELICA_RUN_RECORD_SCHEMA_VERSION,
  parseLegacySimulationRunRecord,
  parsePersistedSimulationRunRecord,
  parseSimulationRunRecord,
  projectRecordedRunToLegacy,
} from "./src/domain/run-record.ts";
export {
  MODELICA_RECORDED_RESULTS_SCHEMA_VERSION,
  MODELICA_RESULTS_SCHEMA_VERSION,
  MODELICA_RESULTS_VIEWER_URI,
} from "./src/tools/results.ts";
export {
  MODELICA_RESUMABLE_RESULTS_SCHEMA_VERSION,
  sealedResultSeriesOutputSchema,
  simulationManifestOutputSchema,
  simulationRequestOutputSchema,
  simulationRequestTemplateOutputSchema,
} from "./src/tools/resumable-results.ts";
export { MODELICA_RESUMABLE_SCHEMA_VERSION } from "./src/domain/simulation-manifest.ts";
export {
  DEFAULT_SEALED_CSV_SERIES_SAMPLES,
  MAX_SEALED_CSV_SERIES_SAMPLES,
  summarizeSealedNumericCsv,
} from "./src/domain/sealed-csv-series.ts";
export type {
  QualifiedSimulationMethodPort,
  RequestLockPort,
  ResumableArtifact,
  SimulationRequestClaim,
  SimulationRequestStorePort,
  SimulationWorkspacePort,
} from "./src/domain/resumable-contracts.ts";
export type {
  AffineUnitConversion,
  Artifact,
  EngineIdentity,
  LegacyArtifact,
  LegacyArtifactKind,
  LegacyModelicaRunSummary,
  LegacyPublicKit,
  LegacySimulationRun,
  ModelicaKit,
  ModelicaRunSummary,
  ParameterDefinition,
  PersistedSimulationRun,
  PublicKit,
  Quantity,
  RunnerInput,
  RunnerOutput,
  RunStatus,
  SimulateInput,
  SimulationResultNormalizer,
  SimulationRun,
  SimulationRunner,
} from "./src/domain/types.ts";
export type {
  ModelicaRecordedResultsEnvelope,
  ModelicaRecordedRunListResultEnvelope,
  ModelicaRecordedRunResultEnvelope,
  ModelicaResultsEnvelope,
  ModelicaRunListResultEnvelope,
  ModelicaRunResultEnvelope,
} from "./src/tools/results.ts";
