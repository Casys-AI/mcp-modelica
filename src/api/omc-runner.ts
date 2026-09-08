import { join } from "@std/path";
import { canonicalUtf8FromBytes } from "../domain/canonical-utf8.ts";
import { sha256Bytes } from "../domain/hashing.ts";
import type {
  EngineIdentity,
  RunnerInput,
  RunnerOutput,
  RunnerRawOutput,
  SimulationRunner,
} from "../domain/types.ts";

const decoder = new TextDecoder();
const MAX_RESULT_CSV_BYTES = 5 * 1024 * 1024;

/** Executes a server-generated .mos script with the pinned OpenModelica CLI. */
export class OpenModelicaRunner implements SimulationRunner {
  constructor(
    private readonly command = "omc",
    private readonly probeDirectory?: string,
  ) {}

  async getRuntimeEngineIdentity(): Promise<EngineIdentity> {
    const versionOutput = await new Deno.Command(this.command, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!versionOutput.success) {
      throw new Error(
        `OpenModelica identity probe failed: ${
          diagnostics(versionOutput.stdout, versionOutput.stderr)
        }`,
      );
    }
    const versionLine = decoder.decode(versionOutput.stdout).trim();
    const version = versionLine.match(/^OpenModelica\s+(.+)$/)?.[1];
    if (!version) throw new Error("OpenModelica identity probe returned an unknown version line.");

    if (this.probeDirectory) await Deno.mkdir(this.probeDirectory, { recursive: true });
    const directory = await Deno.makeTempDir({
      ...(this.probeDirectory === undefined ? {} : { dir: this.probeDirectory }),
      prefix: "omc-engine-probe-",
    });
    try {
      const scriptPath = join(directory, "probe.mos");
      await Deno.writeTextFile(
        scriptPath,
        ["loadModel(Modelica);", "getVersion(Modelica);", ""].join("\n"),
      );
      const libraryOutput = await new Deno.Command(this.command, {
        args: [scriptPath],
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!libraryOutput.success) {
        throw new Error(
          `Modelica library identity probe failed: ${
            diagnostics(libraryOutput.stdout, libraryOutput.stderr)
          }`,
        );
      }
      const quotedVersion = decoder.decode(libraryOutput.stdout).trim().split(/\r?\n/)
        .findLast((line) => /^"[^"]+"$/.test(line));
      if (!quotedVersion) {
        throw new Error("Modelica library identity probe returned no version.");
      }
      const mslVersion = JSON.parse(quotedVersion);
      if (typeof mslVersion !== "string" || mslVersion.length === 0) {
        throw new Error("Modelica library identity probe returned an invalid version.");
      }
      return { name: "OpenModelica", version, msl_version: mslVersion };
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }

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
        rawOutput: { capture: "unavailable", reason: "spawn_failed" },
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
      if (!completedOutput) {
        return {
          status: "timed_out",
          diagnostics: `OpenModelica exceeded the ${input.timeoutMs} ms timeout.`,
          rawOutput: { capture: "unavailable", reason: "timed_out_without_output" },
        };
      }
      const timedOutCapture = await capturedCompilerOutput(
        completedOutput.output.stdout,
        completedOutput.output.stderr,
      );
      return {
        status: "timed_out",
        diagnostics: diagnostics(completedOutput.output.stdout, completedOutput.output.stderr),
        rawOutput: timedOutCapture,
      };
    }

    const output = outcome.output;
    const log = diagnostics(output.stdout, output.stderr);
    const compilerCapture = await capturedCompilerOutput(output.stdout, output.stderr);
    if (!output.success) {
      return { status: "failed", diagnostics: log, rawOutput: compilerCapture };
    }

    const rawCsv = await readResultCsvBytes(input.runDirectory);
    if (rawCsv === undefined) {
      return {
        status: "failed",
        diagnostics: `${log}\nOpenModelica completed without producing a CSV result.`,
        rawOutput: compilerCapture,
      };
    }
    try {
      const canonical = await canonicalUtf8FromBytes(rawCsv, "result.csv");
      return {
        status: "succeeded",
        diagnostics: log,
        resultCsv: canonical.source,
        rawOutput: {
          ...compilerCapture,
          result_csv: { status: "captured", sha256: canonical.digest },
        },
      };
    } catch (error) {
      return {
        status: "failed",
        diagnostics: `${log}\nOpenModelica CSV is not canonical UTF-8: ${message(error)}`,
        rawOutput: {
          ...compilerCapture,
          result_csv: { status: "rejected", sha256: await sha256Bytes(rawCsv) },
        },
      };
    }
  }
}

async function capturedCompilerOutput(
  stdout: Uint8Array,
  stderr: Uint8Array,
): Promise<Extract<RunnerRawOutput, { capture: "captured" }>> {
  return {
    capture: "captured",
    stdout_sha256: await sha256Bytes(stdout),
    stderr_sha256: await sha256Bytes(stderr),
    result_csv: { status: "absent" },
  };
}

async function readResultCsvBytes(runDirectory: string): Promise<Uint8Array | undefined> {
  // The generated script names the OMC prefix "result", for which OMC's CSV
  // output is exactly result_res.csv. Never select a neighbouring CSV: it may
  // be a stale or unrelated file and must not become sealed simulation evidence.
  const path = join(runDirectory, "result_res.csv");
  let metadata: Deno.FileInfo;
  try {
    metadata = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!metadata.isFile) return undefined;
  if (metadata.size > MAX_RESULT_CSV_BYTES) {
    throw new Error(
      `OpenModelica result CSV exceeds the ${MAX_RESULT_CSV_BYTES} byte safety limit.`,
    );
  }
  return await Deno.readFile(path);
}

function diagnostics(stdout: Uint8Array, stderr: Uint8Array): string {
  const parts = [decoder.decode(stdout).trim(), decoder.decode(stderr).trim()].filter(Boolean);
  return parts.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
