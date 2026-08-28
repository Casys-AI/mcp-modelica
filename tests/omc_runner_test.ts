import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OpenModelicaRunner } from "../src/api/omc-runner.ts";

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

async function fakeOmc(directory: string, body: string): Promise<string> {
  const command = join(directory, "fake-omc.sh");
  await Deno.writeTextFile(command, `#!/bin/sh\nset -eu\n${body}`);
  await Deno.chmod(command, 0o755);
  return command;
}
