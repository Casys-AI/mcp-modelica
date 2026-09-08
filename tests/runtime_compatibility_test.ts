import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { ValidationError } from "../src/domain/errors.ts";
import {
  COMPATIBILITY_POLICY_UNAVAILABLE_CODE,
  QUALIFIED_KIT_RUNTIME,
  RUNTIME_INCOMPATIBLE_CODE,
  runtimeCompatibilityPolicy,
} from "../src/domain/runtime-compatibility.ts";
import { createModelicaService } from "../src/domain/service.ts";
import type { EngineIdentity, RunnerInput, SimulationRunner } from "../src/domain/types.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";
import { KitRegistry } from "../src/kits/registry.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { mapModelicaToolError } from "../src/tools/error-mapping.ts";
import { FakeRunner } from "./test-helpers.ts";

const DRIFTED_OMC: EngineIdentity = {
  name: "OpenModelica",
  version: "1.26.0",
  msl_version: "4.1.0",
};
const DRIFTED_MSL: EngineIdentity = {
  name: "OpenModelica",
  version: "1.27.0",
  msl_version: "4.0.0",
};

Deno.test("every registered kit uses the exact documented OMC 1.27.0 / MSL 4.1.0 policy", async () => {
  const service = await createModelicaService({ runner: new FakeRunner() });
  const kits = service.listKits();
  assertEquals(kits.map((kit) => `${kit.id}@${kit.version}`).sort(), [
    "coffee-machine-v1@0.1.0",
    "linear-thermal-ramp-v1@0.1.0",
  ]);
  for (const kit of kits) {
    assertEquals(runtimeCompatibilityPolicy(kit), QUALIFIED_KIT_RUNTIME);
  }
});

Deno.test("unknown kit identity fails closed without inventing the 1.27.0/4.1.0 qualification", () => {
  const error = assertThrows(
    () => runtimeCompatibilityPolicy({ id: "future-kit-v1", version: "0.1.0" }),
    ValidationError,
    "No server-owned runtime compatibility policy",
  );
  assertEquals(error.details?.code, COMPATIBILITY_POLICY_UNAVAILABLE_CODE);
  const mapped = JSON.parse(mapModelicaToolError(error, "modelica_simulate")!);
  assertEquals(mapped.code, COMPATIBILITY_POLICY_UNAVAILABLE_CODE);
});

Deno.test("unknown version of a shipped kit fails closed", () => {
  const error = assertThrows(
    () => runtimeCompatibilityPolicy({ id: "coffee-machine-v1", version: "9.9.9" }),
    ValidationError,
    "No server-owned runtime compatibility policy",
  );
  assertEquals(error.details?.code, COMPATIBILITY_POLICY_UNAVAILABLE_CODE);
});

Deno.test("kit registry refuses a kit without an exact server-owned runtime policy", async () => {
  const coffee = await loadCoffeeMachineKit();
  const error = assertThrows(
    () => new KitRegistry([{ ...coffee, id: "future-kit-v1" }]),
    ValidationError,
    "No server-owned runtime compatibility policy",
  );
  assertEquals(error.details?.code, COMPATIBILITY_POLICY_UNAVAILABLE_CODE);
});

Deno.test("runtime drift fails closed before synchronous execution for every registered kit", async () => {
  for (
    const [identity, input] of [
      [DRIFTED_OMC, { model_id: "coffee-machine-v1", scenario_id: "heat-up-nominal" }],
      [DRIFTED_MSL, { model_id: "linear-thermal-ramp-v1", scenario_id: "linear-ramp-nominal" }],
    ] as const
  ) {
    const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-runtime-sync-" });
    try {
      const runner = new CountingRunner(new FakeRunner(undefined, identity));
      const service = await createModelicaService({ runsDirectory: directory, runner });
      const error = await assertRejects(
        () => service.simulate(input),
        ValidationError,
        "incompatible",
      );
      assertEquals(error.details?.code, RUNTIME_INCOMPATIBLE_CODE);
      assertEquals(runner.executions, 0);
      assertEquals(await service.listRuns(), []);
      const mapped = JSON.parse(mapModelicaToolError(error, "modelica_simulate")!);
      assertEquals(mapped.code, RUNTIME_INCOMPATIBLE_CODE);
      assertEquals(mapped.recovery.includes("OpenModelica 1.27.0"), true);
      assertEquals(mapped.recovery.includes("4.1.0"), true);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("runtime drift fails closed before resumable dispatch and leaves historical claims unread", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-runtime-21-" });
  try {
    const runner = new CountingRunner(new FakeRunner(undefined, DRIFTED_OMC));
    const legacy = await createModelicaService({ runsDirectory: directory, runner });
    const store = new RequestStore(directory);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, runner),
    );
    const error = await assertRejects(
      () =>
        service.getManifest({
          model_id: "coffee-machine-v1",
          model_version: "0.1.0",
          scenario_id: "heat-up-nominal",
        }),
      ValidationError,
      "incompatible",
    );
    assertEquals(error.details?.code, RUNTIME_INCOMPATIBLE_CODE);
    assertEquals(runner.executions, 0);
    assertEquals(await store.readClaim("never-issued"), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("compatible 2.1 submit still fails closed if the live probe matches a drifted engine", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-runtime-submit-" });
  try {
    const compatible = new FakeRunner();
    const legacy = await createModelicaService({
      runsDirectory: directory,
      runner: compatible,
    });
    const store = new RequestStore(directory);
    const counting = new CountingRunner(compatible);
    const service = new ResumableSimulationService(
      legacy,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, counting),
    );
    const manifest = await service.getManifest({
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
    });
    const input = {
      request_id: "runtime-submit-drift",
      manifest_sha256: manifest.manifest_sha256,
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
      parameters: Object.fromEntries(
        legacy.listKits()[0].parameters.map((parameter) => [parameter.id, parameter.default]),
      ),
      timeout_ms: 30_000,
    };
    legacy.getRuntimeEngineIdentity = () => Promise.resolve({ ...DRIFTED_MSL });
    const rejected = await service.submit(input);
    assertEquals((rejected.request as { status: string; rejection?: string }).status, "rejected");
    assertEquals(
      (rejected.request as { rejection?: string }).rejection,
      "manifest_mismatch",
    );
    assertEquals(counting.executions, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

class CountingRunner implements SimulationRunner {
  executions = 0;

  constructor(private readonly inner: FakeRunner) {}

  getRuntimeEngineIdentity(): Promise<EngineIdentity> {
    return this.inner.getRuntimeEngineIdentity();
  }

  execute(input: RunnerInput) {
    this.executions++;
    return this.inner.execute(input);
  }
}
