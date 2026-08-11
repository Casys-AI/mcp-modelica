import { assertEquals } from "@std/assert";
import { join } from "@std/path";

Deno.test("two real processes share one durable 2.1 claim and one run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-resumable-process-" });
  try {
    const worker = join(Deno.cwd(), "tests", "fixtures", "resumable_submit_worker.ts");
    const command = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          `--allow-write=${directory}`,
          "--allow-run=perl",
          worker,
          directory,
          "cross-process-same-request",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
    const [left, right] = await Promise.all([command(), command()]);
    for (const output of [left, right]) {
      if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    }
    const parse = (output: Deno.CommandOutput) =>
      JSON.parse(new TextDecoder().decode(output.stdout)) as {
        request: { status: string; run: { run_id: string } };
      };
    const results = [parse(left), parse(right)];
    assertEquals(results.map((result) => result.request.status), ["completed", "completed"]);
    assertEquals(results[0].request.run.run_id, results[1].request.run.run_id);
    const runDirectories: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isDirectory && entry.name.startsWith("run_")) runDirectories.push(entry.name);
    }
    assertEquals(runDirectories.length, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("two real 2.1 processes serialize the 19/20 capacity race", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-capacity-process-" });
  try {
    await seedRunDirectories(directory, 19);
    const worker = join(Deno.cwd(), "tests", "fixtures", "resumable_submit_worker.ts");
    const outputs = await Promise.all([
      runWorker(worker, directory, "capacity-process-left"),
      runWorker(worker, directory, "capacity-process-right"),
    ]);
    assertOneCapacityWinner(outputs);
    assertEquals(await countRunDirectories(directory), 20);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("historical simulate and 2.1 submit share the cross-process 19/20 lock", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-old-new-capacity-" });
  try {
    await seedRunDirectories(directory, 19);
    const resumable = join(Deno.cwd(), "tests", "fixtures", "resumable_submit_worker.ts");
    const legacy = join(Deno.cwd(), "tests", "fixtures", "legacy_simulate_worker.ts");
    const outputs = await Promise.all([
      runWorker(resumable, directory, "old-new-capacity-request"),
      runWorker(legacy, directory),
    ]);
    assertOneCapacityWinner(outputs);
    assertEquals(await countRunDirectories(directory), 20);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

function runWorker(worker: string, directory: string, requestId?: string) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      `--allow-write=${directory}`,
      "--allow-run=perl",
      worker,
      directory,
      ...(requestId === undefined ? [] : [requestId]),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

function assertOneCapacityWinner(outputs: Deno.CommandOutput[]): void {
  assertEquals(outputs.filter((output) => output.success).length, 1);
  const failure = outputs.find((output) => !output.success);
  if (!failure) throw new Error("expected one capacity loser");
  const diagnostics = new TextDecoder().decode(failure.stderr);
  assertEquals(diagnostics.includes("limit 20"), true);
}

async function seedRunDirectories(directory: string, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await Deno.mkdir(join(directory, `run_${crypto.randomUUID()}`));
  }
}

async function countRunDirectories(directory: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory && entry.name.startsWith("run_")) count++;
  }
  return count;
}
