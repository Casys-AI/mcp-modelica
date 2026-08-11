import { ValidationError } from "../domain/errors.ts";
import { sha256, stableJson } from "../domain/hashing.ts";
import {
  type ManifestIdentityInput,
  type ManifestResource,
  MODELICA_RESUMABLE_SCHEMA_VERSION,
  parseManifestIdentityInput,
  parseSealedSimulationManifest,
  sealManifest,
  type SimulationManifest,
} from "../domain/simulation-manifest.ts";
import { parseCanonicalSimulationRequest } from "../domain/simulation-request.ts";
import type {
  EngineIdentity,
  ModelicaKit,
  Quantity,
  RunnerOutput,
  SimulationScenario,
} from "../domain/types.ts";
import { convertToModelica } from "../domain/units.ts";
import {
  kitParameterSchemaUri,
  kitScenarioUri,
  kitSourceUri,
  requestArtifactUri,
} from "../domain/evidence-uris.ts";
import type {
  DurableRunRecord,
  QualifiedSimulationMethodPort,
  RequestLockPort,
  ResumableArtifact,
  SimulationRequestClaim,
  SimulationRequestStorePort,
  SimulationWorkspacePort,
} from "../domain/resumable-contracts.ts";

const RESUMABLE_RUN_ID =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ResumableRequestResult extends Record<string, unknown> {
  schemaVersion: typeof MODELICA_RESUMABLE_SCHEMA_VERSION;
  kind: "simulation-request";
  request: Record<string, unknown>;
}

/**
 * 2.1 successor application service.  It has its own request/claim ledger and
 * never asks the v1/v2 run-list surfaces to decide idempotence or recovery.
 */
export class ResumableSimulationService {
  constructor(
    private readonly method: QualifiedSimulationMethodPort,
    readonly store: SimulationRequestStorePort,
    private readonly locks: RequestLockPort,
    private readonly workspace: SimulationWorkspacePort,
  ) {}

  async getManifest(rawInput: unknown): Promise<SimulationManifest> {
    const identity = parseManifestIdentityInput(rawInput);
    return await this.buildManifest(identity, await this.method.getRuntimeEngineIdentity());
  }

  async submit(rawInput: unknown): Promise<ResumableRequestResult> {
    const request = await parseCanonicalSimulationRequest(rawInput);
    // Validate the caller-owned selection and every explicit parameter without
    // starting a native process. The durable request claim is the mandatory
    // boundary before the first OMC identity probe.
    const kit = this.method.getQualifiedKit(request.model_id, request.model_version);
    const scenario = kit.scenarios.find((candidate) => candidate.id === request.scenario_id);
    if (!scenario) throw new ValidationError("scenario_id is not part of the qualified manifest.");
    const resolved = resolveAllParameters(kit, request.parameters);

    const claimed = await this.store.claimOrRead(request);
    if (claimed.claim.state === "rejected") return rejectionResult(claimed.claim);
    const lock = await this.locks.acquire(request.request_id);
    if (!lock) return await this.statusFromClaim(request.request_id, claimed.claim);
    try {
      // Re-read under the per-request kernel lock.  A durable run wins over
      // every non-completed claim state and is reconciled without a runner.
      const current = await this.store.readClaim(request.request_id);
      if (!current) {
        throw new ValidationError("Simulation request claim disappeared before execution.");
      }
      const existing = await this.store.readRunRecord(request.request_id);
      if (existing) return await this.reconcileCompleted(current, existing.record);
      if (current.state === "rejected") return rejectionResult(current);
      if (
        (current.state !== "claimed" && current.state !== "promoting") ||
        !current.slot_reserved
      ) {
        return await this.recoveryResult(current);
      }

      // A process can crash after the durable claim/fsync but before it owns a
      // request lock or starts OMC. That pre-run state is safe to adopt: no
      // run_id/directory exists yet. Any later transition is fail-closed.
      const reservation = claimed.reservation ?? await this.store.adoptClaimReservation(current);

      const manifest = await this.buildManifest(
        {
          model_id: request.model_id,
          model_version: request.model_version,
          scenario_id: request.scenario_id,
        },
        await this.method.getRuntimeEngineIdentity(),
      );
      if (request.manifest_sha256 !== manifest.manifest_sha256) {
        const rejected = await this.store.rejectClaim(
          reservation,
          rejectedManifestClaim(current),
        );
        return rejectionResult(rejected);
      }

      const promotingClaim: SimulationRequestClaim = current.state === "promoting" ? current : {
        ...current,
        state: "promoting",
        slot_reserved: true,
        run_id: `run_${crypto.randomUUID()}`,
      };
      // The storage adapter persists `promoting + run_id` before mkdir and
      // returns the exact running transition. A retry resumes the same id.
      const runningClaim = await this.store.promoteClaim(reservation, promotingClaim);
      if (runningClaim.state !== "running") {
        throw new ValidationError("Request-store promotion did not return a running claim.");
      }
      const runId = runningClaim.run_id!;

      const artifacts: ResumableArtifact[] = [];
      artifacts.push(await this.store.writeRequestArtifact(request));
      const model = await this.method.readQualifiedModelSource(kit.id, kit.version);
      const qualifiedScenario = await this.method.readQualifiedScenarioSource(
        kit.id,
        kit.version,
        scenario.id,
      );
      assertManifestResource(
        manifest.model.source,
        kitSourceUri(kit.id, kit.version),
        "text/x-modelica",
        "qualified-kit",
        model,
      );
      assertManifestResource(
        manifest.scenario.source,
        kitScenarioUri(kit.id, kit.version, scenario.id),
        "application/json",
        "qualified-kit",
        qualifiedScenario,
      );
      artifacts.push(
        await this.store.writeRunArtifact(
          request.request_id,
          runId,
          "resolved_parameters",
          "resolved-parameters.json",
          "application/json",
          stableJson(resolved.quantities),
        ),
      );
      artifacts.push(
        await this.store.writeRunArtifact(
          request.request_id,
          runId,
          "model",
          `${kit.modelName}.mo`,
          "text/x-modelica",
          model.source,
          "qualified-kit",
          manifest.model.source,
        ),
      );
      artifacts.push(
        await this.store.writeRunArtifact(
          request.request_id,
          runId,
          "scenario",
          "scenario.json",
          "application/json",
          qualifiedScenario.source,
          "qualified-kit",
          manifest.scenario.source,
        ),
      );
      if (kit.parameterSchemaSource !== undefined) {
        const schema = await this.method.readQualifiedParameterSchema(kit.id, kit.version);
        if (!manifest.parameter_schema) {
          throw new ValidationError(
            "Qualified parameter schema appeared after the manifest was sealed.",
          );
        }
        assertManifestResource(
          manifest.parameter_schema,
          kitParameterSchemaUri(kit.id, kit.version),
          "application/json",
          "compiler-derived-verified",
          schema,
        );
        artifacts.push(
          await this.store.writeRunArtifact(
            request.request_id,
            runId,
            "parameter_schema",
            "parameter-schema.json",
            "application/json",
            schema.source,
            "compiler-derived-verified",
            manifest.parameter_schema,
          ),
        );
      }
      const script = buildOmcScript(manifest, resolved.quantities);
      artifacts.push(
        await this.store.writeRunArtifact(
          request.request_id,
          runId,
          "script",
          "run.mos",
          "text/plain",
          script,
        ),
      );

      const startedAt = new Date().toISOString();
      let execution: RunnerOutput;
      try {
        execution = await this.workspace.execute(runId, request.timeout_ms);
      } catch (error) {
        execution = { status: "failed", diagnostics: `Simulation runner threw: ${message(error)}` };
      }
      artifacts.push(
        await this.store.writeRunArtifact(
          request.request_id,
          runId,
          "diagnostics",
          "omc.log",
          "text/plain",
          execution.diagnostics,
        ),
      );

      let status = execution.status;
      let metrics: Record<string, Quantity> = {};
      const warnings = [...(execution.warnings ?? [])];
      if (execution.status === "succeeded" && execution.resultCsv !== undefined) {
        try {
          const normalized = kit.resultNormalizer.normalize(execution.resultCsv, scenario);
          validateMetrics(kit, normalized.metrics, normalized.warnings);
          metrics = normalized.metrics;
          warnings.push(...normalized.warnings);
          // Only a successful, versioned normalization makes the solver CSV
          // evidence. A failed/timed-out 2.1 run has the exact no-CSV
          // artifact set, so replay can validate status without guessing.
          artifacts.push(
            await this.store.writeRunArtifact(
              request.request_id,
              runId,
              "result",
              "result.csv",
              "text/csv",
              execution.resultCsv,
            ),
          );
        } catch (error) {
          status = "failed";
          warnings.push(`Simulation output could not be interpreted: ${message(error)}`);
        }
      } else if (execution.status === "succeeded") {
        status = "failed";
        warnings.push("Simulation runner reported success without a CSV result.");
      }
      const evidence = stableJson({
        producer: "mcp-modelica",
        status,
        request_id: request.request_id,
        manifest_sha256: manifest.manifest_sha256,
        metrics,
        warnings,
        note:
          "This is computed evidence only. Requirement pass/fail belongs to mcp-syson and @casys/constraint-solver.",
      });
      artifacts.push(
        await this.store.writeRunArtifact(
          request.request_id,
          runId,
          "evidence",
          "evidence.json",
          "application/json",
          evidence,
        ),
      );

      const run = {
        schemaVersion: MODELICA_RESUMABLE_SCHEMA_VERSION,
        kind: "simulation-run",
        request_id: request.request_id,
        request_sha256: request.request_sha256,
        manifest,
        run_id: runId,
        status,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        resolved_parameters: resolved.quantities,
        metrics,
        artifacts,
        warnings,
      };
      await this.store.writeRunRecord(request.request_id, run);
      const persisted = await this.store.readRunRecord(request.request_id);
      if (!persisted) {
        throw new ValidationError(
          "Durable resumable run.json disappeared before claim completion.",
        );
      }
      const completedClaim: SimulationRequestClaim = {
        ...runningClaim,
        state: "completed",
        run_json_sha256: persisted.sha256,
        run_json_bytes: persisted.bytes,
      };
      await this.store.writeClaim(completedClaim);
      return await this.completeResult(run, completedClaim);
    } finally {
      await lock.release();
    }
  }

  async getRequest(rawInput: unknown): Promise<ResumableRequestResult> {
    const input = parseRequestGetInput(rawInput);
    const claim = await this.store.readClaim(input.request_id);
    if (!claim) {
      throw new ValidationError(`Simulation request '${input.request_id}' was not found.`);
    }
    return await this.statusFromClaim(input.request_id, claim);
  }

  /**
   * Typed evidence seam for the MCP resource adapter. Every call reconciles
   * and revalidates the completed claim, exact run ledger, and every artifact
   * before any resource bytes can be returned.
   */
  async getCompletedEvidence(requestId: string): Promise<{
    artifacts: ResumableArtifact[];
    runJson: DurableRunRecord;
  }> {
    await this.getRequest({ request_id: requestId });
    const claim = await this.store.readClaim(requestId);
    const runJson = await this.store.readRunRecord(requestId);
    if (claim?.state !== "completed" || !runJson) {
      throw new ValidationError(
        "Simulation request does not have a sealed completed evidence ledger.",
      );
    }
    const artifacts = await this.validateCompletedRun(runJson.record, claim, runJson);
    this.assertCompletedSeal(claim, runJson);
    return { artifacts, runJson };
  }

  private async buildManifest(
    identity: ManifestIdentityInput,
    engine: EngineIdentity,
  ): Promise<SimulationManifest> {
    const kit = this.method.getQualifiedKit(identity.model_id, identity.model_version);
    const scenario = kit.scenarios.find((candidate) => candidate.id === identity.scenario_id);
    if (!scenario) {
      throw new ValidationError(
        `Unknown scenario_id '${identity.scenario_id}' for qualified kit '${kit.id}@${kit.version}'.`,
      );
    }
    // These reads reopen every server-owned byte source and verify its loaded
    // identity before a manifest can be returned or accepted for submission.
    const [model, sourceScenario] = await Promise.all([
      this.method.readQualifiedModelSource(kit.id, kit.version),
      this.method.readQualifiedScenarioSource(kit.id, kit.version, scenario.id),
    ]);
    const publicScenario = {
      id: scenario.id,
      description: scenario.description,
      start_time_s: scenario.startTimeS,
      stop_time_s: scenario.stopTimeS,
      number_of_intervals: scenario.numberOfIntervals,
      solver: scenario.solver,
      target_temperature: scenario.targetTemperature,
    };
    const parameterSchema = kit.parameterSchemaSource === undefined
      ? undefined
      : await this.method.readQualifiedParameterSchema(kit.id, kit.version);
    const unsigned = {
      schemaVersion: MODELICA_RESUMABLE_SCHEMA_VERSION,
      model: {
        id: kit.id,
        version: kit.version,
        name: kit.modelName,
        source: resource(
          kitSourceUri(kit.id, kit.version),
          "text/x-modelica",
          model,
          "qualified-kit",
        ),
      },
      scenario: {
        id: scenario.id,
        source: resource(
          kitScenarioUri(kit.id, kit.version, scenario.id),
          "application/json",
          sourceScenario,
          "qualified-kit",
        ),
        public: publicScenario,
        projection_sha256: await sha256(stableJson(publicScenario)),
      },
      ...(parameterSchema === undefined ? {} : {
        parameter_schema: resource(
          kitParameterSchemaUri(kit.id, kit.version),
          "application/json",
          parameterSchema,
          "compiler-derived-verified",
        ),
      }),
      parameters: kit.parameters.map((parameter) => ({
        id: parameter.id,
        modelica_name: parameter.modelicaName,
        modelica_type: parameter.modelicaType,
        description: parameter.description,
        unit: parameter.unit,
        minimum: parameter.minimum,
        maximum: parameter.maximum,
        conversion: { ...parameter.conversion },
      })),
      produced_metrics: kit.producedMetrics.map((metric) => ({ ...metric })),
      result_normalizer: { id: kit.resultNormalizer.id, version: kit.resultNormalizer.version },
      lowering: { id: "modelica-omc-lowering", version: "1.0.0" },
      engine,
    };
    return await sealManifest(unsigned);
  }

  private async statusFromClaim(
    requestId: string,
    claim: SimulationRequestClaim,
  ): Promise<ResumableRequestResult> {
    const run = await this.store.readRunRecord(requestId);
    if (run) return await this.reconcileCompleted(claim, run.record);
    if (claim.state === "completed") {
      throw new ValidationError(
        "Completed simulation request claim seals a run.json that is missing; preserve the claim and investigate integrity.",
      );
    }
    if (claim.state === "rejected") return rejectionResult(claim);
    // A claim with no run id is an explicitly pre-native state: no OMC runner
    // can have started. request_get must remain read-only so a later exact
    // submit can safely adopt this reservation under the request lock.
    if (
      claim.slot_reserved &&
      ((claim.state === "claimed" && claim.run_id === undefined) ||
        (claim.state === "promoting" && claim.run_id !== undefined))
    ) {
      const held = await this.locks.isHeld(requestId);
      return requestResult({
        request_id: requestId,
        request_sha256: claim.request_sha256,
        manifest_sha256: claim.manifest_sha256,
        status: held ? "running" : "pending",
      });
    }
    const held = await this.locks.isHeld(requestId);
    if (held) {
      return requestResult({
        request_id: requestId,
        request_sha256: claim.request_sha256,
        manifest_sha256: claim.manifest_sha256,
        status: "running",
      });
    }
    // Close the false-negative window between the liveness probe and claim
    // transition. Once this process owns the lock it rereads both durable
    // records; it never marks a concurrently completed request as recovery.
    const lock = await this.locks.acquire(requestId);
    if (!lock) {
      return requestResult({
        request_id: requestId,
        request_sha256: claim.request_sha256,
        manifest_sha256: claim.manifest_sha256,
        status: "running",
      });
    }
    try {
      const current = await this.store.readClaim(requestId);
      if (!current) {
        throw new ValidationError(
          `Simulation request '${requestId}' disappeared during reconciliation.`,
        );
      }
      const completed = await this.store.readRunRecord(requestId);
      if (completed) return await this.reconcileCompleted(current, completed.record);
      return await this.recoveryResult(current);
    } finally {
      await lock.release();
    }
  }

  private async recoveryResult(claim: SimulationRequestClaim): Promise<ResumableRequestResult> {
    if (claim.state === "completed" || claim.state === "rejected") {
      throw new ValidationError(
        "Terminal simulation request claims are immutable and cannot be rewritten as recovery.",
      );
    }
    if (claim.state !== "running" && claim.state !== "recovery_required") {
      throw new ValidationError(
        "Only an owner-lost running claim can require operator recovery.",
      );
    }
    if (claim.state === "running") {
      await this.store.writeClaim({ ...claim, state: "recovery_required" });
    }
    return requestResult({
      request_id: claim.request_id,
      request_sha256: claim.request_sha256,
      manifest_sha256: claim.manifest_sha256,
      status: "recovery_required",
      recovery:
        "The durable claim has no completed run.json and no live OS request lock. No simulation was rerun; operator recovery is required.",
    });
  }

  private async reconcileCompleted(
    claim: SimulationRequestClaim,
    run: Record<string, unknown>,
  ): Promise<ResumableRequestResult> {
    const runJson = await this.store.readRunRecord(claim.request_id);
    if (!runJson) {
      throw new ValidationError("Completed resumable request lost its durable run.json.");
    }
    await this.validateCompletedRun(run, claim, runJson);
    if (claim.run_id !== run.run_id) {
      throw new ValidationError(
        "Simulation request claim run_id does not match its durable run.json.",
      );
    }
    if (claim.state === "completed") {
      this.assertCompletedSeal(claim, runJson);
      return await this.completeResult(run, claim);
    }
    if (claim.state !== "running" && claim.state !== "recovery_required") {
      throw new ValidationError(
        "Only a running or recovery-required claim may reconcile a durable run.json.",
      );
    }
    const sealed: SimulationRequestClaim = {
      ...claim,
      state: "completed",
      slot_reserved: false,
      run_json_sha256: runJson.sha256,
      run_json_bytes: runJson.bytes,
    };
    await this.store.writeClaim(sealed);
    return await this.completeResult(run, sealed);
  }

  private async completeResult(
    run: Record<string, unknown>,
    claim: SimulationRequestClaim,
  ): Promise<ResumableRequestResult> {
    const requestId = String(run.request_id);
    const runJson = await this.store.readRunRecord(requestId);
    if (!runJson) {
      throw new ValidationError("Completed resumable request lost its durable run.json.");
    }
    await this.validateCompletedRun(run, claim, runJson);
    this.assertCompletedSeal(claim, runJson);
    return requestResult({
      request_id: requestId,
      request_sha256: run.request_sha256,
      manifest_sha256: (run.manifest as Record<string, unknown>).manifest_sha256,
      status: "completed",
      run: {
        ...run,
        run_json: {
          uri: requestArtifactUri(requestId, "run.json"),
          mediaType: "application/json",
          sha256: runJson.sha256,
          bytes: runJson.bytes,
        },
      },
    });
  }

  private assertCompletedSeal(
    claim: SimulationRequestClaim,
    runJson: { record: Record<string, unknown>; bytes: number; sha256: string },
  ): void {
    if (
      claim.state !== "completed" || claim.run_id !== runJson.record.run_id ||
      claim.run_json_sha256 !== runJson.sha256 || claim.run_json_bytes !== runJson.bytes
    ) {
      throw new ValidationError(
        "Completed simulation request claim does not seal the exact run_id and durable run.json.",
      );
    }
  }

  private async validateCompletedRun(
    run: Record<string, unknown>,
    claim: SimulationRequestClaim,
    runJson: { source: string; bytes: number; sha256: string },
  ): Promise<ResumableArtifact[]> {
    exactKeys(run, [
      "schemaVersion",
      "kind",
      "request_id",
      "request_sha256",
      "manifest",
      "run_id",
      "status",
      "started_at",
      "completed_at",
      "resolved_parameters",
      "metrics",
      "artifacts",
      "warnings",
    ]);
    if (
      run.schemaVersion !== "2.1" || run.kind !== "simulation-run" ||
      run.request_id !== claim.request_id || run.request_sha256 !== claim.request_sha256 ||
      typeof run.run_id !== "string" || !RESUMABLE_RUN_ID.test(run.run_id) ||
      (claim.run_id !== undefined && run.run_id !== claim.run_id) ||
      !["succeeded", "failed", "timed_out"].includes(String(run.status)) ||
      !canonicalTimestamp(run.started_at) || !canonicalTimestamp(run.completed_at) ||
      Date.parse(String(run.completed_at)) < Date.parse(String(run.started_at))
    ) {
      throw new ValidationError("Resumable run.json has an invalid immutable execution identity.");
    }
    if (runJson.source !== stableJson(run)) {
      throw new ValidationError(
        "Resumable run.json source does not equal its canonical ledger object.",
      );
    }
    if (!isRecord(run.manifest)) {
      throw new ValidationError("Resumable run manifest must be an object.");
    }
    let recordedManifest: SimulationManifest;
    try {
      recordedManifest = await parseSealedSimulationManifest(run.manifest);
    } catch (error) {
      throw new ValidationError(`Resumable run manifest is invalid: ${message(error)}`);
    }
    if (recordedManifest.manifest_sha256 !== claim.manifest_sha256) {
      throw new ValidationError("Resumable run manifest fingerprint is invalid.");
    }
    const validatedArtifacts = await this.validateRunArtifacts(
      claim.request_id,
      String(run.run_id),
      run.artifacts,
      recordedManifest.parameter_schema !== undefined,
      String(run.status),
      String(recordedManifest.model.name),
      recordedManifest,
    );
    const artifacts = validatedArtifacts.sources;
    const requestArtifact = artifacts.get("request");
    if (!requestArtifact) {
      throw new ValidationError("Resumable run has no request artifact.");
    }
    const parsedRequest = await parseCanonicalSimulationRequest(JSON.parse(requestArtifact.source));
    if (
      parsedRequest.source !== requestArtifact.source ||
      parsedRequest.request_sha256 !== claim.request_sha256 ||
      parsedRequest.manifest_sha256 !== recordedManifest.manifest_sha256 ||
      parsedRequest.request_id !== claim.request_id ||
      parsedRequest.model_id !== recordedManifest.model.id ||
      parsedRequest.model_version !== recordedManifest.model.version ||
      parsedRequest.scenario_id !== recordedManifest.scenario.id
    ) {
      throw new ValidationError(
        "Resumable request artifact does not match its claim and exact manifest selection.",
      );
    }
    let normalizer;
    try {
      normalizer = this.method.resolveResultNormalizer(
        recordedManifest.result_normalizer.id,
        recordedManifest.result_normalizer.version,
      );
    } catch (error) {
      throw new ValidationError(
        `The exact versioned result normalizer sealed by this historical run is unavailable: ${
          message(error)
        }`,
      );
    }
    const resolved = resolveManifestParameters(recordedManifest, parsedRequest.parameters);
    if (stableJson(resolved.quantities) !== stableJson(run.resolved_parameters)) {
      throw new ValidationError(
        "Resumable run resolved parameters do not match its exact request artifact.",
      );
    }
    const resolvedArtifact = artifacts.get("resolved_parameters");
    if (!resolvedArtifact || resolvedArtifact.source !== stableJson(resolved.quantities)) {
      throw new ValidationError(
        "Resumable resolved-parameters artifact does not exactly match the qualified request.",
      );
    }
    const scriptArtifact = artifacts.get("script");
    if (
      !scriptArtifact ||
      scriptArtifact.source !== buildOmcScript(recordedManifest, resolved.quantities)
    ) {
      throw new ValidationError(
        "Resumable run.mos does not equal the sealed lowering of its manifest and request.",
      );
    }
    if (
      !isRecord(run.metrics) || !Array.isArray(run.warnings) ||
      !run.warnings.every((item) => typeof item === "string")
    ) {
      throw new ValidationError("Resumable run metrics or warnings are invalid.");
    }
    validateMetricDefinitions(
      recordedManifest.produced_metrics,
      run.metrics as Record<string, Quantity>,
      run.warnings as string[],
      run.status === "succeeded",
    );
    const scenario = scenarioFromManifest(recordedManifest);
    if (run.status === "succeeded") {
      const result = artifacts.get("result");
      if (!result) throw new ValidationError("Successful resumable run is missing result.csv.");
      let normalized: { metrics: Record<string, Quantity>; warnings: string[] };
      try {
        normalized = normalizer.normalize(result.source, scenario);
        validateMetricDefinitions(
          recordedManifest.produced_metrics,
          normalized.metrics,
          normalized.warnings,
        );
      } catch (error) {
        throw new ValidationError(
          `Resumable result.csv no longer normalizes with the sealed normalizer: ${message(error)}`,
        );
      }
      if (stableJson(normalized.metrics) !== stableJson(run.metrics)) {
        throw new ValidationError(
          "Resumable run metrics do not equal the re-normalized exact result.csv.",
        );
      }
      if (!endsWithWarnings(run.warnings as string[], normalized.warnings)) {
        throw new ValidationError(
          "Resumable run warnings do not retain the sealed result-normalizer warnings.",
        );
      }
    } else {
      if (artifacts.has("result") || stableJson(run.metrics) !== stableJson({})) {
        throw new ValidationError(
          "Failed or timed-out resumable runs must carry no result.csv and empty metrics.",
        );
      }
    }
    const evidence = artifacts.get("evidence");
    const expectedEvidence = stableJson({
      producer: "mcp-modelica",
      status: run.status,
      request_id: claim.request_id,
      manifest_sha256: recordedManifest.manifest_sha256,
      metrics: run.metrics,
      warnings: run.warnings,
      note:
        "This is computed evidence only. Requirement pass/fail belongs to mcp-syson and @casys/constraint-solver.",
    });
    if (!evidence || evidence.source !== expectedEvidence) {
      throw new ValidationError(
        "Resumable evidence.json does not exactly attest the run status, metrics, warnings, request, and manifest.",
      );
    }
    return validatedArtifacts.ledger;
  }

  private async validateRunArtifacts(
    requestId: string,
    runId: string,
    value: unknown,
    expectsSchema: boolean,
    status: string,
    modelName: string,
    manifest: SimulationManifest,
  ): Promise<{
    sources: Map<string, { source: string; bytes: number; sha256: string }>;
    ledger: ResumableArtifact[];
  }> {
    if (!Array.isArray(value)) {
      throw new ValidationError("Resumable run artifacts must be an array.");
    }
    const expected = [
      "request",
      "resolved_parameters",
      "model",
      "scenario",
      ...(expectsSchema ? ["parameter_schema"] : []),
      "script",
      "diagnostics",
      ...(status === "succeeded" ? ["result"] : []),
      "evidence",
    ];
    if (value.length !== expected.length) {
      throw new ValidationError("Resumable run artifact set is incomplete.");
    }
    const verifiedArtifacts = new Map<string, { source: string; bytes: number; sha256: string }>();
    const ledger: ResumableArtifact[] = [];
    const sourceArtifacts = new Map<string, Record<string, unknown>>();
    for (const [index, kind] of expected.entries()) {
      const artifact = value[index];
      if (
        !isRecord(artifact) || artifact.kind !== kind || typeof artifact.file_name !== "string" ||
        typeof artifact.uri !== "string" || typeof artifact.mediaType !== "string" ||
        typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) ||
        typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 0
      ) {
        throw new ValidationError("Resumable run artifact shape/order is invalid.");
      }
      assertExactArtifactKeys(artifact, kind);
      const fileName = artifactName(kind, modelName);
      if (
        artifact.file_name !== fileName || artifact.uri !== artifactUri(requestId, kind, fileName)
      ) {
        throw new ValidationError("Resumable run artifact URI/filename is not canonical.");
      }
      const isRequest = kind === "request";
      if (
        (isRequest && artifact.run_id !== undefined) ||
        (!isRequest && artifact.run_id !== runId) ||
        artifact.mediaType !== artifactMediaType(kind) ||
        (kind === "model" || kind === "scenario"
          ? artifact.qualification !== "qualified-kit"
          : kind === "parameter_schema"
          ? artifact.qualification !== "compiler-derived-verified"
          : artifact.qualification !== undefined) ||
        ((kind === "model" || kind === "scenario" || kind === "parameter_schema")
          ? !isRecord(artifact.source_resource)
          : artifact.source_resource !== undefined)
      ) {
        throw new ValidationError(
          "Resumable run artifact qualification/media identity is invalid.",
        );
      }
      const typedArtifact = artifact as unknown as ResumableArtifact;
      const verified = await this.store.readArtifact(requestId, typedArtifact);
      verifiedArtifacts.set(kind, verified);
      ledger.push(typedArtifact);
      if (kind === "model" || kind === "scenario" || kind === "parameter_schema") {
        sourceArtifacts.set(kind, artifact);
      }
    }
    assertArtifactMatchesManifest(sourceArtifacts.get("model"), manifest.model.source);
    assertArtifactMatchesManifest(sourceArtifacts.get("scenario"), manifest.scenario.source);
    if (manifest.parameter_schema) {
      assertArtifactMatchesManifest(
        sourceArtifacts.get("parameter_schema"),
        manifest.parameter_schema,
      );
    } else if (sourceArtifacts.has("parameter_schema")) {
      throw new ValidationError("Resumable run has an unmanifested parameter-schema artifact.");
    }
    if (!verifiedArtifacts.has("request")) {
      throw new ValidationError("Resumable run has no request artifact.");
    }
    return { sources: verifiedArtifacts, ledger };
  }
}

function resource(
  uri: string,
  mediaType: string,
  value: { bytes: number; sha256: string },
  qualification: ManifestResource["qualification"],
): ManifestResource {
  return { uri, mediaType, bytes: value.bytes, sha256: value.sha256, qualification };
}

/** Compare freshly opened source bytes to the manifest sealed before claim. */
function assertManifestResource(
  expected: ManifestResource,
  uri: string,
  mediaType: string,
  qualification: ManifestResource["qualification"],
  actual: { bytes: number; sha256: string },
): void {
  if (
    expected.uri !== uri || expected.mediaType !== mediaType ||
    expected.qualification !== qualification || expected.bytes !== actual.bytes ||
    expected.sha256 !== actual.sha256
  ) {
    throw new ValidationError(
      "Qualified source bytes changed after manifest sealing; execution was not started.",
    );
  }
}

/** Bind persisted source-artifact metadata to the manifest, not merely itself. */
function assertArtifactMatchesManifest(
  artifact: Record<string, unknown> | undefined,
  resource: ManifestResource,
): void {
  const sourceResource = artifact?.source_resource;
  if (
    !artifact || !isRecord(sourceResource) || sourceResource.uri !== resource.uri ||
    sourceResource.mediaType !== resource.mediaType || sourceResource.bytes !== resource.bytes ||
    sourceResource.sha256 !== resource.sha256 ||
    sourceResource.qualification !== resource.qualification ||
    artifact.mediaType !== resource.mediaType || artifact.bytes !== resource.bytes ||
    artifact.sha256 !== resource.sha256 || artifact.qualification !== resource.qualification ||
    !hasExactKeys(sourceResource, ["uri", "mediaType", "bytes", "sha256", "qualification"])
  ) {
    throw new ValidationError(
      "Resumable source artifact does not match the sealed manifest resource tuple.",
    );
  }
}

function resolveAllParameters(kit: ModelicaKit, supplied: Record<string, Quantity>): {
  quantities: Record<string, Quantity>;
} {
  const expected = kit.parameters.map((parameter) => parameter.id).sort();
  const received = Object.keys(supplied).sort();
  if (stableJson(expected) !== stableJson(received)) {
    throw new ValidationError(
      `parameters must explicitly provide every qualified parameter and no extras; expected ${
        expected.join(", ")
      }.`,
    );
  }
  const quantities: Record<string, Quantity> = {};
  for (const parameter of kit.parameters) {
    const value = supplied[parameter.id];
    if (value.unit !== parameter.unit) {
      throw new ValidationError(
        `parameters.${parameter.id} uses '${value.unit}'; expected '${parameter.unit}'.`,
      );
    }
    if (value.value < parameter.minimum || value.value > parameter.maximum) {
      throw new ValidationError(
        `parameters.${parameter.id} must be between ${parameter.minimum} and ${parameter.maximum} ${parameter.unit}.`,
      );
    }
    quantities[parameter.id] = { value: value.value, unit: parameter.unit };
  }
  return { quantities };
}

function resolveManifestParameters(
  manifest: SimulationManifest,
  supplied: Record<string, Quantity>,
): { quantities: Record<string, Quantity> } {
  const expected = manifest.parameters.map((parameter) => parameter.id).sort(asciiCompare);
  const received = Object.keys(supplied).sort(asciiCompare);
  if (stableJson(expected) !== stableJson(received)) {
    throw new ValidationError(
      "Historical request parameters do not cover the exact sealed manifest bindings.",
    );
  }
  const quantities: Record<string, Quantity> = {};
  for (const parameter of manifest.parameters) {
    const value = supplied[parameter.id];
    if (
      value.unit !== parameter.unit || value.value < parameter.minimum ||
      value.value > parameter.maximum
    ) {
      throw new ValidationError(
        `Historical request parameter '${parameter.id}' violates its sealed unit or bounds.`,
      );
    }
    quantities[parameter.id] = { value: value.value, unit: parameter.unit };
  }
  return { quantities };
}

function scenarioFromManifest(manifest: SimulationManifest): SimulationScenario {
  const scenario = manifest.scenario.public;
  return {
    id: scenario.id,
    description: scenario.description,
    startTimeS: scenario.start_time_s,
    stopTimeS: scenario.stop_time_s,
    numberOfIntervals: scenario.number_of_intervals,
    solver: scenario.solver,
    targetTemperature: { ...scenario.target_temperature },
  };
}

function validateMetrics(
  kit: ModelicaKit,
  metrics: Record<string, Quantity>,
  warnings: string[],
  requireRequired = true,
): void {
  validateMetricDefinitions(kit.producedMetrics, metrics, warnings, requireRequired);
}

function validateMetricDefinitions(
  definitionsList: readonly SimulationManifest["produced_metrics"][number][],
  metrics: Record<string, Quantity>,
  warnings: string[],
  requireRequired = true,
): void {
  if (!Array.isArray(warnings) || !warnings.every((warning) => typeof warning === "string")) {
    throw new ValidationError("Result normalizer returned invalid warnings.");
  }
  const definitions = new Map(definitionsList.map((metric) => [metric.id, metric]));
  for (const [id, value] of Object.entries(metrics)) {
    const definition = definitions.get(id);
    if (!definition || !Number.isFinite(value.value) || value.unit !== definition.unit) {
      throw new ValidationError(`Result normalizer emitted invalid metric '${id}'.`);
    }
  }
  for (const definition of definitionsList) {
    if (requireRequired && definition.required && !(definition.id in metrics)) {
      throw new ValidationError(`Result normalizer is missing required metric '${definition.id}'.`);
    }
  }
}

function rejectedManifestClaim(claim: SimulationRequestClaim): SimulationRequestClaim {
  if (claim.state !== "claimed" && claim.state !== "promoting") {
    throw new ValidationError("Only an unstarted claimed request may be rejected.");
  }
  const identity = {
    schemaVersion: claim.schemaVersion,
    kind: claim.kind,
    request_id: claim.request_id,
    request_sha256: claim.request_sha256,
    manifest_sha256: claim.manifest_sha256,
  } as const;
  return claim.state === "promoting"
    ? {
      ...identity,
      state: "rejected",
      slot_reserved: false,
      run_id: claim.run_id,
      rejection: "manifest_mismatch",
    }
    : {
      ...identity,
      state: "rejected",
      slot_reserved: false,
      rejection: "manifest_mismatch",
    };
}

function rejectionResult(claim: SimulationRequestClaim): ResumableRequestResult {
  if (claim.state !== "rejected") {
    throw new ValidationError("Only a rejected durable claim can produce a rejection result.");
  }
  return requestResult({
    request_id: claim.request_id,
    request_sha256: claim.request_sha256,
    manifest_sha256: claim.manifest_sha256,
    status: "rejected",
    rejection: claim.rejection,
  });
}

function endsWithWarnings(warnings: string[], suffix: string[]): boolean {
  if (suffix.length > warnings.length) return false;
  return suffix.every((warning, index) =>
    warnings[warnings.length - suffix.length + index] === warning
  );
}

function artifactName(kind: string, modelName: string): string {
  switch (kind) {
    case "request":
      return "request.json";
    case "resolved_parameters":
      return "resolved-parameters.json";
    case "model":
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(modelName)) {
        throw new ValidationError("Resumable manifest model name is invalid.");
      }
      return `${modelName}.mo`;
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
    default:
      throw new ValidationError("Resumable run contains an unknown artifact kind.");
  }
}

function artifactUri(requestId: string, kind: string, fileName: string): string {
  return kind === "request"
    ? requestArtifactUri(requestId)
    : requestArtifactUri(requestId, `artifacts/${fileName}`);
}

function artifactMediaType(kind: string): string {
  switch (kind) {
    case "model":
      return "text/x-modelica";
    case "result":
      return "text/csv";
    case "request":
    case "resolved_parameters":
    case "scenario":
    case "parameter_schema":
    case "evidence":
      return "application/json";
    case "script":
    case "diagnostics":
      return "text/plain";
    default:
      throw new ValidationError("Resumable run contains an unknown artifact kind.");
  }
}

function assertExactArtifactKeys(artifact: Record<string, unknown>, kind: string): void {
  const keys = kind === "request"
    ? ["kind", "file_name", "uri", "mediaType", "sha256", "bytes"]
    : kind === "model" || kind === "scenario" || kind === "parameter_schema"
    ? [
      "kind",
      "file_name",
      "run_id",
      "uri",
      "mediaType",
      "sha256",
      "bytes",
      "qualification",
      "source_resource",
    ]
    : ["kind", "file_name", "run_id", "uri", "mediaType", "sha256", "bytes"];
  if (!hasExactKeys(artifact, keys)) {
    throw new ValidationError("Resumable run artifact has unknown or missing fields.");
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (!hasExactKeys(value, expected)) {
    throw new ValidationError("Resumable run.json has unknown or missing fields.");
  }
}

function canonicalTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildOmcScript(
  manifest: SimulationManifest,
  resolved: Record<string, Quantity>,
): string {
  if (
    manifest.lowering.id !== "modelica-omc-lowering" ||
    manifest.lowering.version !== "1.0.0"
  ) {
    throw new ValidationError("Simulation manifest names an unsupported lowering identity.");
  }
  const expectedIds = manifest.parameters.map((parameter) => parameter.id).sort(asciiCompare);
  const resolvedIds = Object.keys(resolved).sort(asciiCompare);
  if (stableJson(expectedIds) !== stableJson(resolvedIds)) {
    throw new ValidationError("Resolved parameters do not cover the sealed lowering bindings.");
  }
  const modelicaValues: Record<string, number> = {};
  for (const parameter of manifest.parameters) {
    const quantity = resolved[parameter.id];
    if (
      quantity.unit !== parameter.unit || quantity.value < parameter.minimum ||
      quantity.value > parameter.maximum
    ) {
      throw new ValidationError(
        `Resolved parameter '${parameter.id}' does not match its sealed lowering binding.`,
      );
    }
    modelicaValues[parameter.modelica_name] = convertToModelica(
      quantity.value,
      parameter.conversion,
    );
  }
  const overrides = Object.entries(modelicaValues)
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([name, value]) => `${name}=${formatNumber(value)}`)
    .join(",");
  const scenario = manifest.scenario.public;
  return [
    "// Generated by mcp-modelica 2.1. Do not edit: the server owns this script.",
    "loadModel(Modelica);",
    `loadFile("${manifest.model.name}.mo");`,
    `simulate(${manifest.model.name}, startTime=${formatNumber(scenario.start_time_s)}, ` +
    `stopTime=${
      formatNumber(scenario.stop_time_s)
    }, numberOfIntervals=${scenario.number_of_intervals}, ` +
    `method="${scenario.solver}", outputFormat="csv", fileNamePrefix="result", ` +
    `simflags="-override=${overrides}");`,
    "getErrorString();",
    "",
  ].join("\n");
}

function parseRequestGetInput(value: unknown): { request_id: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("modelica_simulation_request_get input must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 || typeof input.request_id !== "string" ||
    !REQUEST_ID.test(input.request_id)
  ) {
    throw new ValidationError(
      "modelica_simulation_request_get requires only a non-empty request_id.",
    );
  }
  return { request_id: input.request_id };
}

function requestResult(request: Record<string, unknown>): ResumableRequestResult {
  return { schemaVersion: MODELICA_RESUMABLE_SCHEMA_VERSION, kind: "simulation-request", request };
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ValidationError("Modelica parameter was not finite after validation.");
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
