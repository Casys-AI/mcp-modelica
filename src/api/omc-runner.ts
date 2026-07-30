import { join } from "@std/path";
import type { RunnerInput, RunnerOutput, SimulationRunner } from "../domain/types.ts";

const decoder = new TextDecoder();
const MAX_RESULT_CSV_BYTES = 5 * 1024 * 1024;

/** Executes a server-generated .mos script with the pinned OpenModelica CLI. */
export class OpenModelicaRunner implements SimulationRunner {
  readonly engine = {
    name: "OpenModelica",
    version: "1.27.0",
    msl_version: "4.1.0",
  };

  constructor(private readonly command = "omc") {}

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(this.command, {
        args: [input.scriptPath],
        cwd: input.runDirectory,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      return {
        status: "failed",
        diagnostics: `Could not start ${this.command}: ${message(error)}`,
      };
    }

    const completed = child.output().then((output) => ({ kind: "completed" as const, output }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ kind: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timed_out" }), input.timeoutMs);
    });
    const outcome = await Promise.race([completed, timedOut]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome.kind === "timed_out") {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited during the race; its captured output remains useful.
      }
      const completedOutput = await completed.catch(() => undefined);
      return {
        status: "timed_out",
        diagnostics: completedOutput
          ? diagnostics(completedOutput.output.stdout, completedOutput.output.stderr)
          : `OpenModelica exceeded the ${input.timeoutMs} ms timeout.`,
      };
    }

    const output = outcome.output;
    const log = diagnostics(output.stdout, output.stderr);
    if (!output.success) {
      return { status: "failed", diagnostics: log };
    }

    const resultCsv = await readResultCsv(input.runDirectory);
    if (resultCsv === undefined) {
      return {
        status: "failed",
        diagnostics: `${log}\nOpenModelica completed without producing a CSV result.`,
      };
    }
    return { status: "succeeded", diagnostics: log, resultCsv };
  }
}

async function readResultCsv(runDirectory: string): Promise<string | undefined> {
  const candidates: string[] = [];
  for await (const entry of Deno.readDir(runDirectory)) {
    if (entry.isFile && entry.name.endsWith(".csv")) candidates.push(entry.name);
  }
  if (candidates.length === 0) return undefined;
  const preferred = candidates.find((name) => name === "result_res.csv") ?? candidates.sort()[0];
  const path = join(runDirectory, preferred);
  const metadata = await Deno.stat(path);
  if (metadata.size > MAX_RESULT_CSV_BYTES) {
    throw new Error(
      `OpenModelica result CSV exceeds the ${MAX_RESULT_CSV_BYTES} byte safety limit.`,
    );
  }
  return await Deno.readTextFile(path);
}

function diagnostics(stdout: Uint8Array, stderr: Uint8Array): string {
  const parts = [decoder.decode(stdout).trim(), decoder.decode(stderr).trim()].filter(Boolean);
  return parts.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
