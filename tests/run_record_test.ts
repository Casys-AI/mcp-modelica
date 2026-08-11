import { assertEquals, assertRejects } from "@std/assert";
import { stableJson } from "../src/domain/hashing.ts";
import {
  parseLegacySimulationRunRecord,
  parsePersistedSimulationRunRecord,
  parseSimulationRunRecord,
  projectRecordedRunToLegacy,
} from "../src/domain/run-record.ts";
import { createModelicaService } from "../src/domain/service.ts";
import type { SimulationRun } from "../src/domain/types.ts";
import { ValidationError } from "../src/domain/errors.ts";
import { FakeRunner, installLegacyRunFixture, LEGACY_RUN_ID } from "./test-helpers.ts";

Deno.test("persisted run parser reads the exact frozen 0.2.x ledger without rewriting it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-v1-parser-" });
  try {
    const fixture = await installLegacyRunFixture(directory);
    const parsed = await parsePersistedSimulationRunRecord(fixture.source, LEGACY_RUN_ID);
    assertEquals(parsed, fixture.run);
    assertEquals(
      await Deno.readTextFile(`${directory}/${LEGACY_RUN_ID}/run.json`),
      fixture.source,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persisted run parser accepts only the complete canonical v2 ledger", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-run-parser-" });
  try {
    const service = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const run = await service.simulate({
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
    });
    assertEquals(await parseSimulationRunRecord(stableJson(run), run.run_id), run);
    const legacyProjection = await projectRecordedRunToLegacy(run);
    assertEquals(
      await parseLegacySimulationRunRecord(stableJson(legacyProjection), run.run_id),
      legacyProjection,
    );

    const cases: Array<{
      name: string;
      mutate: (candidate: SimulationRun & Record<string, unknown>) => void;
      message: string;
    }> = [
      {
        name: "unknown field",
        mutate: (candidate) => candidate.injected = true,
        message: "unknown field 'injected'",
      },
      {
        name: "timestamp",
        mutate: (candidate) => candidate.completed_at = "not-a-timestamp",
        message: "completed_at must be a canonical UTC ISO timestamp",
      },
      {
        name: "quantity",
        mutate: (candidate) => candidate.resolved_parameters.heater_power.unit = "",
        message: "resolved_parameters.heater_power.unit",
      },
      {
        name: "fingerprint",
        mutate: (candidate) => candidate.fingerprint = "0".repeat(64),
        message: "fingerprint does not match",
      },
      {
        name: "canonical artifact URI",
        mutate: (candidate) =>
          candidate.artifacts[0].uri = `casys://modelica/runs/${candidate.run_id}/../request.json`,
        message: "is not the canonical URI",
      },
      {
        name: "artifact order",
        mutate: (candidate) => {
          [candidate.artifacts[0], candidate.artifacts[1]] = [
            candidate.artifacts[1],
            candidate.artifacts[0],
          ];
        },
        message: "artifacts are not in canonical kind order",
      },
      {
        name: "duplicate artifact kind",
        mutate: (candidate) =>
          candidate.artifacts.splice(1, 0, structuredClone(candidate.artifacts[0])),
        message: "duplicate artifact kind 'request'",
      },
      {
        name: "source hash linkage",
        mutate: (candidate) => candidate.scenario.source_sha256 = "1".repeat(64),
        message: "scenario.source_sha256 does not match",
      },
      {
        name: "parameter-schema model link",
        mutate: (candidate) => {
          if (!candidate.parameter_schema) throw new Error("Expected parameter schema identity.");
          candidate.parameter_schema.model_source_sha256 = "2".repeat(64);
        },
        message: "parameter_schema.model_source_sha256 does not match",
      },
    ];

    for (const testCase of cases) {
      const candidate = structuredClone(run) as SimulationRun & Record<string, unknown>;
      testCase.mutate(candidate);
      await assertRejects(
        () => parseSimulationRunRecord(stableJson(candidate), run.run_id),
        ValidationError,
        testCase.message,
        testCase.name,
      );
    }

    await assertRejects(
      () => parseSimulationRunRecord(JSON.stringify(run), run.run_id),
      ValidationError,
      "canonical stable JSON",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
