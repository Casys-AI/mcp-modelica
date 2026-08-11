import { join } from "@std/path";
import { ValidationError } from "../domain/errors.ts";
import type { SimulationWorkspacePort } from "../domain/resumable-contracts.ts";
import type { RunnerOutput, SimulationRunner } from "../domain/types.ts";

const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Filesystem workspace adapter for the application-level execution port. */
export class FileSimulationWorkspace implements SimulationWorkspacePort {
  constructor(
    private readonly runsDirectory: string,
    private readonly runner: SimulationRunner,
  ) {}

  async execute(runId: string, timeoutMs: number): Promise<RunnerOutput> {
    if (!RUN_ID.test(runId)) {
      throw new ValidationError("run_id is not a canonical generated run identifier.");
    }
    const runDirectory = join(this.runsDirectory, runId);
    return await this.runner.execute({
      runDirectory,
      scriptPath: join(runDirectory, "run.mos"),
      timeoutMs,
    });
  }
}
