import { join } from "@std/path";
import { ValidationError } from "../domain/errors.ts";
import { requestArtifactUri } from "../domain/evidence-uris.ts";
import { sha256, stableJson } from "../domain/hashing.ts";
import type { CanonicalSimulationRequest } from "../domain/simulation-request.ts";
import type {
  DurableRunRecord,
  RequestCapacityReservationPort,
  ResumableArtifact,
  SimulationRequestClaim,
  SimulationRequestStorePort,
} from "../domain/resumable-contracts.ts";
import type { ManifestResource } from "../domain/simulation-manifest.ts";
import { CapacityCoordinator, CapacityReservationExistsError } from "./capacity-coordinator.ts";
import { readCanonicalUtf8, utf8Bytes, writeDurableText } from "./durable.ts";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class RequestStore implements SimulationRequestStorePort {
  readonly stateDirectory: string;
  readonly requestsDirectory: string;
  readonly locksDirectory: string;
  readonly capacity: CapacityCoordinator;

  constructor(readonly runsDirectory: string) {
    this.stateDirectory = join(runsDirectory, ".resumable");
    this.requestsDirectory = join(this.stateDirectory, "requests");
    this.locksDirectory = join(this.stateDirectory, "locks");
    this.capacity = new CapacityCoordinator(runsDirectory);
  }

  requestDirectory(requestId: string): string {
    assertRequestId(requestId);
    return join(this.requestsDirectory, requestId);
  }

  runRecordPath(requestId: string): string {
    return join(this.requestDirectory(requestId), "run.json");
  }

  artifactPath(requestId: string, artifact: ResumableArtifact): string {
    assertRequestId(requestId);
    if (artifact.kind === "request") return join(this.requestDirectory(requestId), "request.json");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.file_name)) {
      throw new ValidationError("Resumable artifact filename is not canonical.");
    }
    if (artifact.run_id === undefined || !RUN_ID.test(artifact.run_id)) {
      throw new ValidationError(
        "Resumable artifact ledger is missing its canonical run directory identity.",
      );
    }
    return join(this.runsDirectory, artifact.run_id, artifact.file_name);
  }

  async claimOrRead(request: CanonicalSimulationRequest): Promise<{
    claim: SimulationRequestClaim;
    reservation?: RequestCapacityReservationPort;
    created: boolean;
  }> {
    const found = await this.readDurableClaim(request.request_id);
    if (found) {
      assertSameRequest(found, request);
      return { claim: found, created: false };
    }
    const claim: SimulationRequestClaim = {
      schemaVersion: "2.1",
      kind: "simulation-request-claim",
      request_id: request.request_id,
      request_sha256: request.request_sha256,
      manifest_sha256: request.manifest_sha256,
      state: "claimed",
      slot_reserved: true,
    };
    try {
      const reservation = await this.capacity.reserve(
        "request",
        request.request_id,
        stableJson(claim),
      );
      return { claim, reservation, created: true };
    } catch (error) {
      if (!(error instanceof CapacityReservationExistsError)) throw error;
      // A second process may have atomically installed the same claim after
      // our pre-read. Re-read and fsync that exact winner once; a failed claim
      // publication must never be mistaken for election contention.
      const raced = await this.readDurableClaim(request.request_id);
      if (!raced) throw error;
      assertSameRequest(raced, request);
      return { claim: raced, created: false };
    }
  }

  private async readDurableClaim(
    requestId: string,
  ): Promise<SimulationRequestClaim | undefined> {
    assertRequestId(requestId);
    const source = await this.capacity.readDurableRequestClaim(requestId);
    return source === undefined ? undefined : parseClaim(source, requestId);
  }

  async readClaim(requestId: string): Promise<SimulationRequestClaim | undefined> {
    assertRequestId(requestId);
    const path = await this.capacity.requestClaimPath(requestId);
    try {
      const { source } = await readCanonicalUtf8(path);
      return parseClaim(source, requestId);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  async writeClaim(claim: SimulationRequestClaim): Promise<void> {
    assertRequestId(claim.request_id);
    const source = stableJson(claim);
    parseClaim(source, claim.request_id);
    await this.capacity.transitionRequestClaim(claim.request_id, source, (currentSource) => {
      const existing = parseClaim(currentSource, claim.request_id);
      if (existing.state === "completed" || existing.state === "rejected") {
        if (currentSource === source) return false;
        throw new ValidationError(
          "Terminal simulation request claim is immutable and cannot be rewritten.",
        );
      }
      if (
        claim.state === "completed" &&
        existing.state !== "running" && existing.state !== "recovery_required"
      ) {
        throw new ValidationError(
          "Only a running or recovery-required claim may be sealed as completed.",
        );
      }
      if (
        claim.state === "recovery_required" &&
        existing.state !== "running" && existing.state !== "recovery_required"
      ) {
        throw new ValidationError(
          "Only a running claim may transition to recovery-required.",
        );
      }
      if (claim.state !== "completed" && claim.state !== "recovery_required") {
        throw new ValidationError(
          "RequestStore only permits terminal sealing or recovery transitions.",
        );
      }
      return currentSource !== source;
    });
  }

  async adoptClaimReservation(
    claim: SimulationRequestClaim,
  ): Promise<RequestCapacityReservationPort> {
    if (
      !claim.slot_reserved ||
      (claim.state === "claimed" && claim.run_id !== undefined) ||
      (claim.state === "promoting" && claim.run_id === undefined) ||
      (claim.state !== "claimed" && claim.state !== "promoting")
    ) {
      throw new ValidationError(
        "Only a claimed or promoting slot reservation may be adopted for execution.",
      );
    }
    return await this.capacity.adoptRequestReservation(claim.request_id, stableJson(claim));
  }

  async promoteClaim(
    reservation: RequestCapacityReservationPort,
    claim: SimulationRequestClaim,
  ): Promise<SimulationRequestClaim> {
    if (claim.state !== "promoting" || !claim.slot_reserved || claim.run_id === undefined) {
      throw new ValidationError(
        "A request promotion must durably reserve its generated run_id.",
      );
    }
    const running: SimulationRequestClaim = {
      ...claim,
      state: "running",
      slot_reserved: false,
    };
    await reservation.promoteRequest(
      claim.run_id,
      stableJson(claim),
      stableJson(running),
    );
    return running;
  }

  async rejectClaim(
    reservation: RequestCapacityReservationPort,
    claim: SimulationRequestClaim,
  ): Promise<SimulationRequestClaim> {
    if (claim.state !== "rejected" || claim.slot_reserved) {
      throw new ValidationError("A rejected request must release its capacity reservation.");
    }
    await reservation.rejectRequest(stableJson(claim), claim.run_id);
    return claim;
  }

  async writeRequestArtifact(request: CanonicalSimulationRequest): Promise<ResumableArtifact> {
    const path = join(this.requestDirectory(request.request_id), "request.json");
    await writeDurableText(path, request.source);
    return await artifactFromSource(
      "request",
      "request.json",
      requestArtifactUri(request.request_id),
      "application/json",
      request.source,
    );
  }

  async writeRunArtifact(
    requestId: string,
    runId: string,
    kind: Exclude<ResumableArtifact["kind"], "request">,
    fileName: string,
    mediaType: string,
    source: string,
    qualification?: ResumableArtifact["qualification"],
    sourceResource?: ManifestResource,
  ): Promise<ResumableArtifact> {
    assertRequestId(requestId);
    if (!RUN_ID.test(runId)) {
      throw new ValidationError("run_id must be a canonical generated run identifier.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)) {
      throw new ValidationError("Resumable artifact filename is not canonical.");
    }
    await writeDurableText(join(this.runsDirectory, runId, fileName), source);
    return await artifactFromSource(
      kind,
      fileName,
      requestArtifactUri(requestId, `artifacts/${fileName}`),
      mediaType,
      source,
      qualification,
      runId,
      sourceResource,
    );
  }

  async readArtifact(requestId: string, artifact: ResumableArtifact): Promise<{
    source: string;
    bytes: number;
    sha256: string;
  }> {
    const value = await readCanonicalUtf8(this.artifactPath(requestId, artifact));
    if (value.bytes !== artifact.bytes || value.sha256 !== artifact.sha256) {
      throw new ValidationError(
        `Resumable artifact '${artifact.uri}' no longer matches its persisted ledger.`,
      );
    }
    return value;
  }

  async writeRunRecord(requestId: string, record: Record<string, unknown>): Promise<void> {
    await writeDurableText(this.runRecordPath(requestId), stableJson(record));
  }

  async readRunRecord(requestId: string): Promise<DurableRunRecord | undefined> {
    assertRequestId(requestId);
    try {
      const result = await readCanonicalUtf8(this.runRecordPath(requestId));
      let record: unknown;
      try {
        record = JSON.parse(result.source);
      } catch (error) {
        throw new ValidationError(`Resumable run.json is invalid JSON: ${message(error)}`);
      }
      if (result.source !== stableJson(record)) {
        throw new ValidationError("Resumable run.json is not canonical stable JSON.");
      }
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new ValidationError("Resumable run.json must be an object.");
      }
      const object = record as Record<string, unknown>;
      if (
        object.schemaVersion !== "2.1" || object.kind !== "simulation-run" ||
        object.request_id !== requestId
      ) {
        throw new ValidationError("Resumable run.json identity does not match its request.");
      }
      return { record: object, ...result };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  async listRunRecords(): Promise<
    Array<{
      requestId: string;
      record: Record<string, unknown>;
    }>
  > {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(this.requestsDirectory)) entries.push(entry);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    const records: Array<{ requestId: string; record: Record<string, unknown> }> = [];
    for (
      const entry of entries.filter((candidate) => candidate.isDirectory).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      )
    ) {
      if (!REQUEST_ID.test(entry.name)) continue;
      const run = await this.readRunRecord(entry.name);
      if (run) records.push({ requestId: entry.name, record: run.record });
    }
    return records;
  }
}

async function artifactFromSource(
  kind: ResumableArtifact["kind"],
  fileName: string,
  uri: string,
  mediaType: string,
  source: string,
  qualification?: ResumableArtifact["qualification"],
  runId?: string,
  sourceResource?: ManifestResource,
): Promise<ResumableArtifact> {
  return {
    kind,
    file_name: fileName,
    ...(runId === undefined ? {} : { run_id: runId }),
    uri,
    mediaType,
    sha256: await sha256(source),
    bytes: utf8Bytes(source),
    ...(qualification === undefined ? {} : { qualification }),
    ...(sourceResource === undefined ? {} : { source_resource: sourceResource }),
  };
}

function parseClaim(source: string, requestId: string): SimulationRequestClaim {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ValidationError(`Simulation request claim is invalid JSON: ${message(error)}`);
  }
  if (
    source !== stableJson(value) || value === null || typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new ValidationError("Simulation request claim is not canonical stable JSON.");
  }
  const claim = value as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "kind",
    "request_id",
    "request_sha256",
    "manifest_sha256",
    "state",
    "slot_reserved",
    "run_id",
    "run_json_sha256",
    "run_json_bytes",
    "rejection",
  ];
  for (const key of Object.keys(claim)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`Simulation request claim has unknown field '${key}'.`);
    }
  }
  for (
    const key of [
      "schemaVersion",
      "kind",
      "request_id",
      "request_sha256",
      "manifest_sha256",
      "state",
      "slot_reserved",
    ]
  ) {
    if (!(key in claim)) throw new ValidationError(`Simulation request claim is missing '${key}'.`);
  }
  if (
    claim.schemaVersion !== "2.1" || claim.kind !== "simulation-request-claim" ||
    claim.request_id !== requestId || typeof claim.request_sha256 !== "string" ||
    typeof claim.manifest_sha256 !== "string" || typeof claim.slot_reserved !== "boolean" ||
    !["claimed", "promoting", "running", "completed", "rejected", "recovery_required"].includes(
      String(claim.state),
    )
  ) {
    throw new ValidationError("Simulation request claim has an invalid shape.");
  }
  if (
    !/^[0-9a-f]{64}$/.test(claim.request_sha256) || !/^[0-9a-f]{64}$/.test(claim.manifest_sha256)
  ) {
    throw new ValidationError("Simulation request claim SHA-256 identities are invalid.");
  }
  if (
    claim.run_id !== undefined && (typeof claim.run_id !== "string" || !RUN_ID.test(claim.run_id))
  ) {
    throw new ValidationError("Simulation request claim run_id is invalid.");
  }
  if (
    (claim.run_json_sha256 !== undefined &&
      (typeof claim.run_json_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(claim.run_json_sha256))) ||
    (claim.run_json_bytes !== undefined &&
      (typeof claim.run_json_bytes !== "number" || !Number.isSafeInteger(claim.run_json_bytes) ||
        claim.run_json_bytes < 0))
  ) {
    throw new ValidationError("Simulation request claim run.json seal is invalid.");
  }
  if (
    (claim.state === "claimed" && (!claim.slot_reserved || claim.run_id !== undefined)) ||
    (claim.state === "promoting" && (!claim.slot_reserved || claim.run_id === undefined)) ||
    ((claim.state === "running" || claim.state === "completed" ||
      claim.state === "recovery_required") &&
      (claim.slot_reserved || claim.run_id === undefined))
  ) {
    throw new ValidationError(
      "Simulation request claim state is inconsistent with its slot/run transition.",
    );
  }
  if (
    claim.state === "rejected" &&
    (claim.slot_reserved || claim.rejection !== "manifest_mismatch")
  ) {
    throw new ValidationError("Rejected simulation request claim is invalid.");
  }
  if (claim.state !== "rejected" && claim.rejection !== undefined) {
    throw new ValidationError("Only a rejected request claim may carry a rejection reason.");
  }
  if (
    claim.state === "completed" &&
    (claim.run_json_sha256 === undefined || claim.run_json_bytes === undefined)
  ) {
    throw new ValidationError("Completed simulation request claim is missing its run.json seal.");
  }
  if (
    claim.state !== "completed" &&
    (claim.run_json_sha256 !== undefined || claim.run_json_bytes !== undefined)
  ) {
    throw new ValidationError(
      "Only a completed simulation request claim may carry a run.json seal.",
    );
  }
  const baseKeys = [
    "schemaVersion",
    "kind",
    "request_id",
    "request_sha256",
    "manifest_sha256",
    "state",
    "slot_reserved",
  ];
  const expectedKeys = claim.state === "claimed"
    ? baseKeys
    : claim.state === "completed"
    ? [...baseKeys, "run_id", "run_json_sha256", "run_json_bytes"]
    : claim.state === "rejected"
    ? claim.run_id === undefined ? [...baseKeys, "rejection"] : [...baseKeys, "run_id", "rejection"]
    : [...baseKeys, "run_id"];
  if (!hasExactKeys(claim, expectedKeys)) {
    throw new ValidationError("Simulation request claim fields do not match its exact state.");
  }
  return claim as unknown as SimulationRequestClaim;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function assertSameRequest(
  claim: SimulationRequestClaim,
  request: CanonicalSimulationRequest,
): void {
  if (claim.request_sha256 !== request.request_sha256) {
    throw new ValidationError(
      `request_id '${request.request_id}' is already claimed by different canonical request bytes; create a new request_id.`,
    );
  }
}

function assertRequestId(requestId: string): void {
  if (!REQUEST_ID.test(requestId)) {
    throw new ValidationError("request_id is not a canonical request selector.");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
