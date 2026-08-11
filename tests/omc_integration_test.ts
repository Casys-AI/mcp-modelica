import { assert, assertEquals } from "@std/assert";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";

const enabled = Deno.env.get("RUN_OMC_INTEGRATION") === "1";
const integrationTimeoutMs = readIntegrationTimeoutMs();

Deno.test({
  name: "CoffeeMachine runs through a real pinned OpenModelica environment",
  ignore: !enabled,
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-" });
    try {
      const service = await createModelicaService({ runsDirectory: directory });
      const run = await service.simulate({
        model_id: "coffee-machine-v1",
        scenario_id: "heat-up-nominal",
        timeout_ms: integrationTimeoutMs,
      });
      if (run.status !== "succeeded") {
        const diagnostics = await Deno.readTextFile(`${directory}/${run.run_id}/omc.log`);
        throw new Error(
          `OpenModelica CoffeeMachine run returned '${run.status}'.\n` +
            `${diagnostics}\nWarnings: ${run.warnings.join(" | ")}`,
        );
      }
      assertEquals(run.status, "succeeded");
      assertEquals(run.metrics.water_temperature_max.unit, "degC");
      assertEquals(run.metrics.heater_energy.unit, "J");
      assert(
        run.metrics.water_temperature_max.value >= 90,
        "The nominal CoffeeMachine model must actually reach its 90 degC target.",
      );
      assert(
        "time_to_target_temperature" in run.metrics,
        "A successful nominal run must report its target-reaching time.",
      );
      console.log(JSON.stringify({
        engine: run.engine,
        metrics: run.metrics,
        model: run.model,
        run_id: run.run_id,
        scenario: run.scenario,
        status: run.status,
      }));
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "LinearThermalRamp balanced conformance kit runs through real pinned OpenModelica",
  ignore: !enabled,
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-ramp-" });
    try {
      const service = await createModelicaService({ runsDirectory: directory });
      const run = await service.simulate({
        model_id: "linear-thermal-ramp-v1",
        scenario_id: "linear-ramp-nominal",
        timeout_ms: integrationTimeoutMs,
      });
      if (run.status !== "succeeded") {
        const diagnostics = await Deno.readTextFile(`${directory}/${run.run_id}/omc.log`);
        throw new Error(
          `OpenModelica LinearThermalRamp run returned '${run.status}'.\n` +
            `${diagnostics}\nWarnings: ${run.warnings.join(" | ")}`,
        );
      }
      assertEquals(run.metrics.temperature_final.unit, "degC");
      assert(
        Math.abs(run.metrics.temperature_final.value - 22) < 1e-6,
        "The balanced ramp must finish at 22 degC; this is solver-conformance evidence, not a physical thermal claim.",
      );
      console.log(JSON.stringify({
        engine: run.engine,
        metrics: run.metrics,
        model: run.model,
        run_id: run.run_id,
        scenario: run.scenario,
        status: run.status,
      }));
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "2.1 resumable submit runs both qualified kits through real OpenModelica",
  ignore: !enabled,
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-resumable-" });
    try {
      const method = await createModelicaService({ runsDirectory: directory });
      const store = new RequestStore(directory);
      const service = new ResumableSimulationService(
        method,
        store,
        new FileRequestLockPort(store.locksDirectory),
        new FileSimulationWorkspace(directory, method.getSimulationRunner()),
      );
      for (
        const identity of [
          {
            model_id: "coffee-machine-v1",
            model_version: "0.1.0",
            scenario_id: "heat-up-nominal",
          },
          {
            model_id: "linear-thermal-ramp-v1",
            model_version: "0.1.0",
            scenario_id: "linear-ramp-nominal",
          },
        ]
      ) {
        const manifest = await service.getManifest(identity);
        const kit = method.getQualifiedKit(identity.model_id, identity.model_version);
        const result = await service.submit({
          request_id: `omc-2.1-${identity.model_id}`,
          manifest_sha256: manifest.manifest_sha256,
          ...identity,
          parameters: Object.fromEntries(
            kit.parameters.map((parameter) => [
              parameter.id,
              { value: parameter.defaultValue, unit: parameter.unit },
            ]),
          ),
          timeout_ms: integrationTimeoutMs,
        });
        const request = result.request as {
          status: string;
          run: {
            run_id: string;
            status: string;
            manifest: { engine: { name: string; version: string; msl_version: string } };
            metrics: Record<string, { value: number; unit: string }>;
          };
        };
        if (request.status !== "completed" || request.run.status !== "succeeded") {
          const diagnostics = await Deno.readTextFile(
            `${directory}/${request.run.run_id}/omc.log`,
          );
          throw new Error(
            `OpenModelica 2.1 ${identity.model_id} run was not successful.\n${diagnostics}`,
          );
        }
        assertEquals(request.run.manifest.engine.name, "OpenModelica");
        assert(
          /^\d+\.\d+/.test(request.run.manifest.engine.version),
          "The 2.1 manifest must carry the probed runtime OMC version.",
        );
        assert(
          /^\d+\.\d+/.test(request.run.manifest.engine.msl_version),
          "The 2.1 manifest must carry the probed loaded MSL version.",
        );
        assert(Object.keys(request.run.metrics).length > 0);
        console.log(JSON.stringify({
          engine: request.run.manifest.engine,
          metrics: request.run.metrics,
          model: identity.model_id,
          provider: "2.1",
          run_id: request.run.run_id,
          status: request.run.status,
        }));
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

function readIntegrationTimeoutMs(): number {
  const configured = Deno.env.get("OMC_INTEGRATION_TIMEOUT_MS");
  if (configured === undefined) return 30_000;

  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error(
      "OMC_INTEGRATION_TIMEOUT_MS must be an integer between 1 and 120000.",
    );
  }
  return timeoutMs;
}
