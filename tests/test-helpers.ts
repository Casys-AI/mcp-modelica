import type { RunnerInput, RunnerOutput, SimulationRunner } from "../src/domain/types.ts";

export const NOMINAL_CSV = [
  "time,waterTemperatureC,heaterPowerW,heaterEnergyJ,heaterOn",
  "0,20,1500,0,1",
  "100,65,1500,150000,1",
  "200,90.5,1500,300000,1",
  "300,94,0,315000,0",
].join("\n") + "\n";

export class FakeRunner implements SimulationRunner {
  readonly engine = {
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

  execute(_input: RunnerInput): Promise<RunnerOutput> {
    return Promise.resolve(this.output);
  }
}
