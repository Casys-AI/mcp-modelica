import { createModelicaService } from "../../src/domain/service.ts";
import type {
  EngineIdentity,
  RunnerInput,
  RunnerOutput,
  SimulationRunner,
} from "../../src/domain/types.ts";
import { NOMINAL_CSV } from "../test-helpers.ts";

class SlowLegacyRunner implements SimulationRunner {
  getRuntimeEngineIdentity(): Promise<EngineIdentity> {
    return Promise.resolve({
      name: "FakeOpenModelica",
      version: "legacy-process-test",
      msl_version: "test",
    });
  }

  async execute(_input: RunnerInput): Promise<RunnerOutput> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      status: "succeeded",
      diagnostics: "cross-process legacy fake runner",
      resultCsv: NOMINAL_CSV,
    };
  }
}

const [runsDirectory] = Deno.args;
if (!runsDirectory) throw new Error("usage: legacy_simulate_worker <runs-directory>");

const service = await createModelicaService({
  runsDirectory,
  runner: new SlowLegacyRunner(),
});
console.log(JSON.stringify(
  await service.simulate({
    model_id: "coffee-machine-v1",
    scenario_id: "heat-up-nominal",
    timeout_ms: 30_000,
  }),
));
