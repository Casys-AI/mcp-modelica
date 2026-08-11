import { assertRejects } from "@std/assert";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../src/domain/service.ts";
import {
  manifestUnsigned,
  parseSealedSimulationManifest,
  type SimulationManifest,
} from "../src/domain/simulation-manifest.ts";
import { sha256, stableJson } from "../src/domain/hashing.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("2.1 manifest parser rejects self-sealed extras, bounds, duplicate identities, and foreign tuples", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-manifest-parser-" });
  try {
    const legacy = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, legacy.getSimulationRunner()),
    );
    const manifest = await service.getManifest({
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    });
    await parseSealedSimulationManifest(manifest);

    const mutations: Array<(unsigned: Record<string, unknown>) => void> = [
      (unsigned) => {
        (unsigned.parameters as Array<Record<string, unknown>>)[0].unexpected = true;
      },
      (unsigned) => {
        const parameters = unsigned.parameters as Array<Record<string, unknown>>;
        parameters[1].id = parameters[0].id;
      },
      (unsigned) => {
        const parameter = (unsigned.parameters as Array<Record<string, unknown>>)[0];
        parameter.minimum = 100;
        parameter.maximum = 1;
      },
      (unsigned) => {
        ((unsigned.model as Record<string, unknown>).source as Record<string, unknown>).uri =
          "casys://modelica/kits/foreign/1/model.mo";
      },
      (unsigned) => {
        ((unsigned.scenario as Record<string, unknown>).source as Record<string, unknown>)
          .qualification = "compiler-derived-verified";
      },
      (unsigned) => {
        (unsigned.scenario as Record<string, unknown>).projection_sha256 = "0".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const unsigned = structuredClone(manifestUnsigned(manifest)) as unknown as Record<
        string,
        unknown
      >;
      mutate(unsigned);
      await assertRejects(
        async () => await parseSealedSimulationManifest(await unsafeSeal(unsigned)),
        Error,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function unsafeSeal(unsigned: Record<string, unknown>): Promise<SimulationManifest> {
  const digest = await sha256(stableJson(unsigned));
  return {
    ...unsigned,
    fingerprint: digest,
    manifest_sha256: digest,
  } as unknown as SimulationManifest;
}
