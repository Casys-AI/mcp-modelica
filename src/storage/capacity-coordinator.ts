import { join } from "@std/path";
import { ValidationError } from "../domain/errors.ts";
import { sha256 } from "../domain/hashing.ts";
import { makeDurableDirectory, removeDurable, writeDurableText } from "./durable.ts";
import { OsLock } from "./os-lock.ts";

export const MAX_STORED_RUNS = 20;
const RUN_DIRECTORY =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface SlotReservation {
  schemaVersion: "capacity/1";
  kind: "legacy" | "request";
  slot_reserved: true;
}

/**
 * One disk-backed capacity authority shared by historical simulate and 2.1
 * submit.  It counts final/active `run_*` directories plus only claims that
 * still reserve a slot, under one OS global lock.
 */
export class CapacityCoordinator {
  private readonly stateDirectory: string;
  private readonly claimsDirectory: string;
  private readonly locksDirectory: string;

  constructor(private readonly runsDirectory: string) {
    this.stateDirectory = join(runsDirectory, ".resumable");
    this.claimsDirectory = join(this.stateDirectory, "capacity-claims");
    this.locksDirectory = join(this.stateDirectory, "locks");
  }

  async reserve(
    kind: SlotReservation["kind"],
    id: string = crypto.randomUUID(),
    source?: string,
  ): Promise<CapacityReservation> {
    return await this.withGlobalLock(async () => {
      const path = await this.reservationPath(kind, id);
      await Deno.mkdir(this.claimsDirectory, { recursive: true });
      try {
        await Deno.stat(path);
        throw new ValidationError(`Capacity reservation '${kind}-${id}' already exists.`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const used = await this.usedSlots();
      if (used >= MAX_STORED_RUNS) {
        throw new ValidationError(
          `Modelica run storage contains ${used} runs or active claims (limit ${MAX_STORED_RUNS}). ` +
            "Archive or remove prior evidence before starting another simulation.",
        );
      }
      const reservationSource = source ??
        JSON.stringify({ schemaVersion: "capacity/1", kind, slot_reserved: true }) + "\n";
      await writeDurableText(path, reservationSource);
      return new CapacityReservation(this, path, reservationSource);
    });
  }

  /** A hash-derived filename keeps caller selectors out of filesystem paths. */
  async requestClaimPath(requestId: string): Promise<string> {
    return await this.reservationPath("request", requestId);
  }

  async updateRequestClaim(requestId: string, source: string): Promise<void> {
    const path = await this.requestClaimPath(requestId);
    await this.withGlobalLock(async () => {
      try {
        await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new ValidationError(`Simulation request claim '${requestId}' was not found.`);
        }
        throw error;
      }
      await writeDurableText(path, source);
    });
  }

  /**
   * Compare and replace a request claim while holding the shared capacity
   * lock. The adapter supplies the domain transition check so a stale read in
   * another process cannot rewrite an immutable completed proof seal.
   */
  async transitionRequestClaim(
    requestId: string,
    source: string,
    validate: (currentSource: string) => boolean,
  ): Promise<void> {
    const path = await this.requestClaimPath(requestId);
    await this.withGlobalLock(async () => {
      let currentSource: string;
      try {
        currentSource = await Deno.readTextFile(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new ValidationError(`Simulation request claim '${requestId}' was not found.`);
        }
        throw error;
      }
      if (validate(currentSource)) await writeDurableText(path, source);
    });
  }

  /** Reattach an unstarted durable request claim after a process died pre-OMC. */
  async adoptRequestReservation(
    requestId: string,
    expectedSource: string,
  ): Promise<CapacityReservation> {
    const path = await this.requestClaimPath(requestId);
    return await this.withGlobalLock(async () => {
      let source: string;
      try {
        source = await Deno.readTextFile(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new ValidationError(`Simulation request claim '${requestId}' was not found.`);
        }
        throw error;
      }
      if (source !== expectedSource) {
        throw new ValidationError(
          `Simulation request claim '${requestId}' changed before reservation adoption.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch {
        throw new ValidationError(`Simulation request claim '${requestId}' is not valid JSON.`);
      }
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).slot_reserved !== true
      ) {
        throw new ValidationError(
          `Simulation request claim '${requestId}' no longer reserves capacity.`,
        );
      }
      return new CapacityReservation(this, path, expectedSource);
    });
  }

  async promote(
    reservationPath: string,
    runDirectory: string,
    retainedSource?: string,
  ): Promise<void> {
    await this.withGlobalLock(async () => {
      await makeDurableDirectory(runDirectory);
      if (retainedSource === undefined) await removeDurable(reservationPath);
      else await writeDurableText(reservationPath, retainedSource);
    });
  }

  /**
   * Publish request ownership before creating its run directory. A crash can
   * therefore resume the same run_id, and the promoting claim/run-directory
   * pair is one capacity slot rather than two unrelated observations.
   */
  async promoteRequest(
    reservationPath: string,
    expectedSource: string,
    runId: string,
    promotingSource: string,
    runningSource: string,
  ): Promise<void> {
    if (!RUN_DIRECTORY.test(runId)) {
      throw new ValidationError("Promoted run_id is not a canonical generated identifier.");
    }
    await this.withGlobalLock(async () => {
      let current: string;
      try {
        current = await Deno.readTextFile(reservationPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new ValidationError("Simulation request claim disappeared before promotion.");
        }
        throw error;
      }
      if (current !== expectedSource) {
        throw new ValidationError(
          "Simulation request claim changed before promotion; durable state is immutable.",
        );
      }
      await writeDurableText(reservationPath, promotingSource);
      await makeDurableDirectory(join(this.runsDirectory, runId));
      await writeDurableText(reservationPath, runningSource);
    });
  }

  /** Retain a terminal rejected request identity while releasing its slot. */
  async rejectRequest(
    reservationPath: string,
    source: string,
    expectedSource: string,
  ): Promise<void> {
    await this.withGlobalLock(async () => {
      let current: string;
      try {
        current = await Deno.readTextFile(reservationPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new ValidationError("Simulation request claim disappeared before rejection.");
        }
        throw error;
      }
      if (current !== expectedSource) {
        throw new ValidationError(
          "Simulation request claim changed before rejection; terminal evidence is immutable.",
        );
      }
      await writeDurableText(reservationPath, source);
    });
  }

  async release(reservationPath: string): Promise<void> {
    await this.withGlobalLock(async () => await removeDurable(reservationPath));
  }

  async update(reservationPath: string, source: string): Promise<void> {
    await this.withGlobalLock(async () => await writeDurableText(reservationPath, source));
  }

  private async reservationPath(kind: SlotReservation["kind"], id: string): Promise<string> {
    // A fixed hexadecimal digest is injective enough for this authority's
    // collision-resistant request identity and cannot carry separators.
    return join(this.claimsDirectory, `${kind}-${await sha256(id)}.json`);
  }

  private async usedSlots(): Promise<number> {
    const directoryRuns = new Set<string>();
    try {
      for await (const entry of Deno.readDir(this.runsDirectory)) {
        if (entry.isDirectory && RUN_DIRECTORY.test(entry.name)) directoryRuns.add(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    let claims = 0;
    try {
      for await (const entry of Deno.readDir(this.claimsDirectory)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(await Deno.readTextFile(join(this.claimsDirectory, entry.name)));
          // Only an exact non-reserving terminal state, or an exact durable
          // request state linked to an existing run, can prove this claim does
          // not consume another slot. Unknown records count conservatively.
          if (isExactNonReservingRequestClaim(raw, directoryRuns)) continue;
        } catch {
          // A torn/operator-written claim is never a free slot.  Counting it
          // conservatively prevents a crash from becoming over-capacity work.
        }
        claims++;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return directoryRuns.size + claims;
  }

  private async withGlobalLock<T>(action: () => Promise<T>): Promise<T> {
    // A bounded OS-lock wait serializes legitimate 19/20 races instead of
    // turning a scheduling race into an avoidable failed request. Liveness is
    // still determined solely by the kernel lock, never elapsed timestamps in
    // a claim payload.
    for (let attempt = 0; attempt < 200; attempt++) {
      const lock = await OsLock.acquire(this.locksDirectory, "capacity");
      if (!lock) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        return await action();
      } finally {
        await lock.release();
      }
    }
    throw new ValidationError("Modelica capacity coordinator is busy; retry the request.");
  }
}

function isExactNonReservingRequestClaim(
  value: unknown,
  directoryRuns: ReadonlySet<string>,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  if (
    claim.schemaVersion !== "2.1" || claim.kind !== "simulation-request-claim" ||
    typeof claim.request_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.request_id) ||
    typeof claim.request_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(claim.request_sha256) ||
    typeof claim.manifest_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(claim.manifest_sha256)
  ) {
    return false;
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
  if (
    claim.state === "rejected" && claim.slot_reserved === false &&
    claim.rejection === "manifest_mismatch"
  ) {
    if (claim.run_id === undefined) return hasExactKeys(claim, [...baseKeys, "rejection"]);
    return typeof claim.run_id === "string" && RUN_DIRECTORY.test(claim.run_id) &&
      hasExactKeys(claim, [...baseKeys, "run_id", "rejection"]);
  }
  if (
    typeof claim.run_id !== "string" || !RUN_DIRECTORY.test(claim.run_id) ||
    !directoryRuns.has(claim.run_id)
  ) {
    return false;
  }
  const runKeys = [...baseKeys, "run_id"];
  if (claim.state === "promoting" && claim.slot_reserved === true) {
    return hasExactKeys(claim, runKeys);
  }
  if (
    (claim.state === "running" || claim.state === "recovery_required") &&
    claim.slot_reserved === false
  ) {
    return hasExactKeys(claim, runKeys);
  }
  if (
    claim.state === "completed" && claim.slot_reserved === false &&
    typeof claim.run_json_sha256 === "string" && /^[0-9a-f]{64}$/.test(claim.run_json_sha256) &&
    typeof claim.run_json_bytes === "number" && Number.isSafeInteger(claim.run_json_bytes) &&
    claim.run_json_bytes >= 0
  ) {
    return hasExactKeys(claim, [...runKeys, "run_json_sha256", "run_json_bytes"]);
  }
  return false;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export class CapacityReservation {
  private active = true;

  constructor(
    private readonly coordinator: CapacityCoordinator,
    private readonly path: string,
    private readonly expectedSource: string,
  ) {}

  async promote(runDirectory: string, retainedSource?: string): Promise<void> {
    if (!this.active) throw new ValidationError("Capacity reservation is no longer active.");
    await this.coordinator.promote(this.path, runDirectory, retainedSource);
    this.active = false;
  }

  async promoteRequest(
    runId: string,
    promotingSource: string,
    runningSource: string,
  ): Promise<void> {
    if (!this.active) throw new ValidationError("Capacity reservation is no longer active.");
    await this.coordinator.promoteRequest(
      this.path,
      this.expectedSource,
      runId,
      promotingSource,
      runningSource,
    );
    this.active = false;
  }

  async rejectRequest(source: string): Promise<void> {
    if (!this.active) throw new ValidationError("Capacity reservation is no longer active.");
    await this.coordinator.rejectRequest(this.path, source, this.expectedSource);
    this.active = false;
  }

  async update(source: string): Promise<void> {
    await this.coordinator.update(this.path, source);
  }

  async release(): Promise<void> {
    if (!this.active) return;
    await this.coordinator.release(this.path);
    this.active = false;
  }
}
