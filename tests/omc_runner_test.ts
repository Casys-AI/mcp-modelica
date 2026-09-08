import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OpenModelicaRunner } from "../src/api/omc-runner.ts";
import { sha256Bytes } from "../src/domain/hashing.ts";

Deno.test("OpenModelica runner never substitutes a neighbouring CSV for result_res.csv", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-runner-" });
  try {
    const command = await fakeOmc(directory, 'printf "wrong\\n" > unexpected.csv\n');
    const runner = new OpenModelicaRunner(command);
    const output = await runner.execute({
      runDirectory: directory,
      scriptPath: join(directory, "run.mos"),
      timeoutMs: 1_000,
    });
    assertEquals(output.status, "failed");
    assertEquals(output.resultCsv, undefined);
    assertEquals(output.diagnostics.includes("without producing a CSV result"), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("OpenModelica runner reads only the generated result_res.csv", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-runner-" });
  try {
    const command = await fakeOmc(
      directory,
      'printf "wrong\\n" > unrelated.csv\nprintf "time,value\\n0,1\\n" > result_res.csv\n',
    );
    const runner = new OpenModelicaRunner(command);
    const output = await runner.execute({
      runDirectory: directory,
      scriptPath: join(directory, "run.mos"),
      timeoutMs: 1_000,
    });
    assertEquals(output.status, "succeeded");
    assertEquals(output.resultCsv, "time,value\n0,1\n");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("OpenModelica runner hashes raw stdout/stderr/CSV bytes before decode or trim", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-raw-" });
  try {
    const stdout = "RAW-STDOUT\n\n";
    const stderr = " RAW-STDERR \n";
    const csv = "time,value\n0,1\n";
    const command = await fakeOmc(
      directory,
      "printf 'RAW-STDOUT\\n\\n'\nprintf ' RAW-STDERR \\n' >&2\nprintf 'time,value\\n0,1\\n' > result_res.csv\n",
    );
    const output = await new OpenModelicaRunner(command).execute({
      runDirectory: directory,
      scriptPath: join(directory, "run.mos"),
      timeoutMs: 1_000,
    });
    assertEquals(output.status, "succeeded");
    assertEquals(output.resultCsv, csv);
    assertEquals(output.diagnostics.includes("RAW-STDOUT"), true);
    assertEquals(output.rawOutput, {
      capture: "captured",
      stdout_sha256: await sha256Bytes(encoder.encode(stdout)),
      stderr_sha256: await sha256Bytes(encoder.encode(stderr)),
      result_csv: { status: "captured", sha256: await sha256Bytes(encoder.encode(csv)) },
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("OpenModelica runner treats noncanonical CSV as a literal failed capture", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-utf8-" });
  try {
    const command = await fakeOmc(directory, "printf '\\377' > result_res.csv\n");
    const output = await new OpenModelicaRunner(command).execute({
      runDirectory: directory,
      scriptPath: join(directory, "run.mos"),
      timeoutMs: 1_000,
    });
    assertEquals(output.status, "failed");
    assertEquals(output.resultCsv, undefined);
    assertEquals(output.diagnostics.includes("canonical UTF-8"), true);
    const empty = await sha256Bytes(new Uint8Array());
    assertEquals(output.rawOutput, {
      capture: "captured",
      stdout_sha256: empty,
      stderr_sha256: empty,
      result_csv: { status: "rejected", sha256: await sha256Bytes(new Uint8Array([0xff])) },
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("OpenModelica runner records spawn failure as unavailable raw output", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-omc-spawn-" });
  try {
    const output = await new OpenModelicaRunner(
      join(directory, "missing-omc-binary"),
    ).execute({
      runDirectory: directory,
      scriptPath: join(directory, "run.mos"),
      timeoutMs: 1_000,
    });
    assertEquals(output.status, "failed");
    assertEquals(output.resultCsv, undefined);
    assertEquals(output.rawOutput, { capture: "unavailable", reason: "spawn_failed" });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const encoder = new TextEncoder();

async function fakeOmc(directory: string, body: string): Promise<string> {
  const command = join(directory, "fake-omc.sh");
  await Deno.writeTextFile(command, `#!/bin/sh\nset -eu\n${body}`);
  await Deno.chmod(command, 0o755);
  return command;
}
