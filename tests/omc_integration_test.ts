import { assertEquals } from "@std/assert";
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
      assertEquals(run.status, "succeeded");
      assertEquals(run.metrics.water_temperature_max.unit, "degC");
      assertEquals(run.metrics.heater_energy.unit, "J");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
