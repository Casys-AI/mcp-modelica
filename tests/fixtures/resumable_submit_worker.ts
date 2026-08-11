import { ResumableSimulationService } from "../../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../../src/domain/service.ts";
import type {
  EngineIdentity,
  RunnerInput,
  RunnerOutput,
  SimulationRunner,
} from "../../src/domain/types.ts";
import { FileRequestLockPort } from "../../src/storage/request-lock.ts";
import { RequestStore } from "../../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../../src/storage/simulation-workspace.ts";
import { NOMINAL_CSV } from "../test-helpers.ts";

class SlowFakeRunner implements SimulationRunner {
  getRuntimeEngineIdentity(): Promise<EngineIdentity> {
    return Promise.resolve({
      name: "FakeOpenModelica",
      version: "process-test",
      msl_version: "test",
    });
  }

  async execute(_input: RunnerInput): Promise<RunnerOutput> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      status: "succeeded",
      diagnostics: "cross-process fake runner",
      resultCsv: NOMINAL_CSV,
    };
  }
}

const [runsDirectory, requestId] = Deno.args;
if (!runsDirectory || !requestId) {
  throw new Error("usage: resumable_submit_worker <runs-directory> <request-id>");
}

const legacy = await createModelicaService({ runsDirectory, runner: new SlowFakeRunner() });
const store = new RequestStore(runsDirectory);
const service = new ResumableSimulationService(
  legacy,
  store,
  new FileRequestLockPort(store.locksDirectory),
  new FileSimulationWorkspace(runsDirectory, legacy.getSimulationRunner()),
);
const manifest = await service.getManifest({
  model_id: "coffee-machine-v1",
  model_version: "0.1.0",
  scenario_id: "heat-up-nominal",
});
const input = {
  request_id: requestId,
  manifest_sha256: manifest.manifest_sha256,
  model_id: "coffee-machine-v1",
  model_version: "0.1.0",
  scenario_id: "heat-up-nominal",
  parameters: Object.fromEntries(
    legacy.listKits()[0].parameters.map((parameter) => [parameter.id, parameter.default]),
  ),
  timeout_ms: 30_000,
};
let result = await service.submit(input);
for (
  let attempt = 0;
  attempt < 100 && (result.request as { status: string }).status === "running";
  attempt++
) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  result = await service.getRequest({ request_id: requestId });
}
console.log(JSON.stringify(result));
