import type { CanonicalSimulationRequest } from "./simulation-request.ts";
import type { ManifestResource } from "./simulation-manifest.ts";
import type {
  EngineIdentity,
  ModelicaKit,
  RunnerOutput,
  SimulationResultNormalizer,
} from "./types.ts";

export type RequestClaimState =
  | "claimed"
  | "promoting"
  | "running"
  | "completed"
  | "rejected"
  | "recovery_required";

interface SimulationRequestClaimIdentity {
  schemaVersion: "2.1";
  kind: "simulation-request-claim";
  request_id: string;
  request_sha256: string;
  manifest_sha256: string;
}

/**
 * Durable ownership record, independent of its filesystem representation.
 * The discriminated union makes impossible recovery/completion combinations
 * unrepresentable inside the application as well as rejected on disk.
 */
export type SimulationRequestClaim =
  & SimulationRequestClaimIdentity
  & (
    | {
      state: "claimed";
      slot_reserved: true;
      run_id?: never;
      run_json_sha256?: never;
      run_json_bytes?: never;
    }
    | {
      state: "promoting";
      slot_reserved: true;
      run_id: string;
      run_json_sha256?: never;
      run_json_bytes?: never;
    }
    | {
      state: "running";
      slot_reserved: false;
      run_id: string;
      run_json_sha256?: never;
      run_json_bytes?: never;
    }
    | {
      state: "recovery_required";
      slot_reserved: false;
      run_id: string;
      run_json_sha256?: never;
      run_json_bytes?: never;
    }
    | {
      state: "rejected";
      slot_reserved: false;
      run_id?: string;
      rejection: "manifest_mismatch";
      run_json_sha256?: never;
      run_json_bytes?: never;
    }
    | {
      state: "completed";
      slot_reserved: false;
      run_id: string;
      run_json_sha256: string;
      run_json_bytes: number;
    }
  );

export interface ResumableArtifact {
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
  file_name: string;
  run_id?: string;
  uri: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  qualification?: "qualified-kit" | "compiler-derived-verified";
  /** Original server-owned resource tuple copied into this request's evidence root. */
  source_resource?: ManifestResource;
}

/** Opaque request-capacity handle; the application cannot name a storage class. */
export interface RequestCapacityReservationPort {
  promoteRequest(
    runId: string,
    promotingSource: string,
    runningSource: string,
  ): Promise<void>;
  rejectRequest(source: string): Promise<void>;
  release(): Promise<void>;
}

export interface DurableRunRecord {
  record: Record<string, unknown>;
  source: string;
  bytes: number;
  sha256: string;
}

/** Application port for durable idempotence/recovery state and exact artifacts. */
export interface SimulationRequestStorePort {
  claimOrRead(request: CanonicalSimulationRequest): Promise<{
    claim: SimulationRequestClaim;
    reservation?: RequestCapacityReservationPort;
    created: boolean;
  }>;
  readClaim(requestId: string): Promise<SimulationRequestClaim | undefined>;
  writeClaim(claim: SimulationRequestClaim): Promise<void>;
  adoptClaimReservation(claim: SimulationRequestClaim): Promise<RequestCapacityReservationPort>;
  promoteClaim(
    reservation: RequestCapacityReservationPort,
    claim: SimulationRequestClaim,
  ): Promise<SimulationRequestClaim>;
  rejectClaim(
    reservation: RequestCapacityReservationPort,
    claim: SimulationRequestClaim,
  ): Promise<SimulationRequestClaim>;
  writeRequestArtifact(request: CanonicalSimulationRequest): Promise<ResumableArtifact>;
  writeRunArtifact(
    requestId: string,
    runId: string,
    kind: Exclude<ResumableArtifact["kind"], "request">,
    fileName: string,
    mediaType: string,
    source: string,
    qualification?: ResumableArtifact["qualification"],
    sourceResource?: ManifestResource,
  ): Promise<ResumableArtifact>;
  readArtifact(requestId: string, artifact: ResumableArtifact): Promise<{
    source: string;
    bytes: number;
    sha256: string;
  }>;
  writeRunRecord(requestId: string, record: Record<string, unknown>): Promise<void>;
  readRunRecord(requestId: string): Promise<DurableRunRecord | undefined>;
  listRunRecords(): Promise<Array<{ requestId: string; record: Record<string, unknown> }>>;
}

export interface QualifiedSimulationMethodPort {
  getQualifiedKit(modelId: unknown, version: unknown): ModelicaKit;
  resolveResultNormalizer(id: string, version: string): SimulationResultNormalizer;
  getRuntimeEngineIdentity(): Promise<EngineIdentity>;
  readQualifiedModelSource(modelId: unknown, version: unknown): Promise<{
    id: string;
    version: string;
    modelName: string;
    source: string;
    sha256: string;
    bytes: number;
  }>;
  readQualifiedScenarioSource(
    modelId: unknown,
    version: unknown,
    scenarioId: unknown,
  ): Promise<{ id: string; source: string; sha256: string; bytes: number }>;
  readQualifiedParameterSchema(modelId: unknown, version: unknown): Promise<{
    source: string;
    sha256: string;
    bytes: number;
  }>;
}

/** Filesystem paths and runner invocation stay behind the workspace adapter. */
export interface SimulationWorkspacePort {
  execute(runId: string, timeoutMs: number): Promise<RunnerOutput>;
}

export interface RequestLockHandle {
  release(): Promise<void>;
}

/** Liveness is supplied by the composition root as an OS-lock port. */
export interface RequestLockPort {
  acquire(requestId: string): Promise<RequestLockHandle | undefined>;
  isHeld(requestId: string): Promise<boolean>;
}
