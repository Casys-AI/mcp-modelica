import { assert, assertEquals } from "@std/assert";
import { createModelicaService } from "../src/domain/service.ts";

const enabled = Deno.env.get("RUN_OMC_INTEGRATION") === "1";

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
