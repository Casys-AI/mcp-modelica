import { join } from "@std/path";
import { stableJson } from "../src/domain/hashing.ts";
import type {
  EngineIdentity,
  LegacySimulationRun,
  RunnerInput,
  RunnerOutput,
  SimulationRunner,
} from "../src/domain/types.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";

export const LEGACY_RUN_ID = "run_11111111-1111-4111-8111-111111111111";
const LEGACY_RUN_FIXTURE = new URL("./fixtures/run-v1.json", import.meta.url);

export const NOMINAL_CSV = [
  "time,waterTemperatureC,heaterPowerW,heaterEnergyJ,heaterOn",
  "0,20,1500,0,1",
  "100,65,1500,150000,1",
  "200,90.5,1500,300000,1",
  "300,94,0,315000,0",
].join("\n") + "\n";

export class FakeRunner implements SimulationRunner {
  private readonly identity = {
    name: "FakeOpenModelica",
    version: "test",
    msl_version: "test",
  };

  constructor(
    private readonly output: RunnerOutput = {
      status: "succeeded",
      diagnostics: "Fake runner: no physical simulation was performed.",
      resultCsv: NOMINAL_CSV,
    },
  ) {}

  getRuntimeEngineIdentity(): Promise<EngineIdentity> {
    return Promise.resolve({ ...this.identity });
  }

  execute(_input: RunnerInput): Promise<RunnerOutput> {
    return Promise.resolve(this.output);
  }
}

/** Install the exact frozen 0.2.x ledger and the bytes it attests. */
export async function installLegacyRunFixture(
  runsDirectory: string,
): Promise<{ run: LegacySimulationRun; source: string }> {
  const kit = await loadCoffeeMachineKit();
  const scenario = kit.scenarios[0];
  const directory = join(runsDirectory, LEGACY_RUN_ID);
  await Deno.mkdir(directory, { recursive: true });
  const resolved = Object.fromEntries(
    kit.parameters.map((parameter) => [
      parameter.id,
      { value: parameter.defaultValue, unit: parameter.unit },
    ]),
  );
  const payloads: Record<string, string> = {
    "request.json": stableJson({ model_id: kit.id, scenario_id: scenario.id }),
    "resolved-parameters.json": stableJson(resolved),
    [`${kit.modelName}.mo`]: kit.modelSource,
    "run.mos": "// frozen legacy fixture\n",
    "omc.log": "legacy fixture diagnostics\n",
    "evidence.json": stableJson({ legacy_fixture: true }),
  };
  await Promise.all(
    Object.entries(payloads).map(([fileName, source]) =>
      Deno.writeTextFile(join(directory, fileName), source)
    ),
  );
  const source = await Deno.readTextFile(LEGACY_RUN_FIXTURE);
  await Deno.writeTextFile(join(directory, "run.json"), source);
  return { run: JSON.parse(source) as LegacySimulationRun, source };
}
