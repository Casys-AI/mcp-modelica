import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { ModelicaService } from "../src/domain/service.ts";
import { ValidationError } from "../src/domain/errors.ts";
import { sha256, sha256Bytes } from "../src/domain/hashing.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";
import { loadLinearThermalRampKit } from "../src/kits/linear-thermal-ramp.ts";
import { readKitAsset, registerEmbeddedKitAsset } from "../src/kits/kit-asset.ts";
import { KitRegistry } from "../src/kits/registry.ts";
import { FakeRunner } from "./test-helpers.ts";

const repositoryRoot = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const publishedKitLoader = fromFileUrl(
  new URL("./fixtures/load_published_kits.ts", import.meta.url),
);

Deno.test("published JSR 0.4.0 kit URLs fail Deno.readFile with Must be a file URL", async () => {
  // Deliberately targets the already-published 0.4.0 archive to reproduce the old loader failure.
  await assertRejects(
    () =>
      Deno.readFile(
        new URL("https://jsr.io/@casys/mcp-modelica/0.4.0/models/CoffeeMachine.mo"),
      ),
    Error,
    "Must be a file URL",
  );
});

Deno.test("https kit assets reopen from the embedded module binding without fetch or checkout", async () => {
  const url = new URL("https://jsr.io/@casys/mcp-modelica/unreleased-test/models/embedded.mo");
  const embedded = "embedded module graph bytes\n";
  registerEmbeddedKitAsset(url, embedded);
  const opened = await readKitAsset(url);
  assertEquals(opened.source, embedded);
  assertEquals(opened.bytes, new TextEncoder().encode(embedded).byteLength);
  assertEquals(opened.digest, await sha256(embedded));
  assertEquals(opened.source.includes("checkout decoy"), false);
});

Deno.test("unregistered https kit assets fail closed without network fetch", async () => {
  await assertRejects(
    () => readKitAsset(new URL("https://127.0.0.1:1/models/CoffeeMachine.mo")),
    ValidationError,
    "refusing network fetch and checkout fallback",
  );
});

Deno.test("http kit assets never fall back to a checkout path when a decoy file exists", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-checkout-decoy-" });
  const originalCwd = Deno.cwd();
  try {
    await Deno.mkdir(join(directory, "models"), { recursive: true });
    await Deno.writeTextFile(join(directory, "models", "CoffeeMachine.mo"), "checkout decoy\n");
    Deno.chdir(directory);
    await assertRejects(
      () => readKitAsset(new URL("http://127.0.0.1:1/models/CoffeeMachine.mo")),
      ValidationError,
      "refusing network fetch and checkout fallback",
    );
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("qualified kit TypeScript in the publish graph has no text import attributes", async () => {
  const hits = [
    ...await collectTextImportHits(new URL("../mod.ts", import.meta.url)),
    ...await collectTextImportHits(new URL("../server.ts", import.meta.url)),
    ...await collectTextImportHits(new URL("../src/", import.meta.url)),
  ];
  assertEquals(hits, []);
});

Deno.test("file-backed kit assets are reopened from raw bytes and detect mutation after load", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-file-mutation-" });
  try {
    const coffee = await loadCoffeeMachineKit();
    const scenario = coffee.scenarios[0];
    if (
      coffee.modelSourceUrl === undefined || coffee.parameterSchemaSource === undefined ||
      coffee.parameterSchemaSourceUrl === undefined || scenario.source === undefined ||
      scenario.sourceUrl === undefined
    ) {
      throw new Error("CoffeeMachine kit is missing server-owned asset URLs.");
    }
    const modelPath = join(directory, "CoffeeMachine.mo");
    const scenarioPath = join(directory, "heat-up-nominal.json");
    const schemaPath = join(directory, "CoffeeMachine.parameters.json");
    await Deno.writeTextFile(modelPath, coffee.modelSource);
    await Deno.writeTextFile(scenarioPath, scenario.source);
    await Deno.writeTextFile(schemaPath, coffee.parameterSchemaSource);
    const isolated = {
      ...coffee,
      modelSourceUrl: toFileUrl(modelPath),
      parameterSchemaSourceUrl: toFileUrl(schemaPath),
      scenarios: [{ ...scenario, sourceUrl: toFileUrl(scenarioPath) }],
    };
    const service = new ModelicaService(
      new KitRegistry([isolated]),
      new FakeRunner(),
      directory,
    );

    const originalModel = await service.readQualifiedModelSource(coffee.id, coffee.version);
    assertEquals(originalModel.source, coffee.modelSource);
    assertEquals(originalModel.sha256, await sha256(coffee.modelSource));
    await Deno.writeTextFile(
      modelPath,
      `${coffee.modelSource}// mutated after registry creation\n`,
    );
    await assertRejects(
      () => service.readQualifiedModelSource(coffee.id, coffee.version),
      ValidationError,
      "no longer match its loaded identity",
    );
    await Deno.writeTextFile(modelPath, coffee.modelSource);

    await Deno.writeTextFile(scenarioPath, `${scenario.source} `);
    await assertRejects(
      () => service.readQualifiedScenarioSource(coffee.id, coffee.version, scenario.id),
      ValidationError,
      "no longer match its loaded identity",
    );
    await Deno.writeTextFile(scenarioPath, scenario.source);

    await Deno.writeTextFile(schemaPath, `${coffee.parameterSchemaSource} `);
    await assertRejects(
      () => service.readQualifiedParameterSchema(coffee.id, coffee.version),
      ValidationError,
      "no longer match its loaded identity",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("package-style HTTP kit loading works away from the checkout and under --cached-only", async () => {
  const expected = await localPublishedIdentities();
  const denoDir = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-deno-dir-" });
  const emptyCwd = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-empty-cwd-" });
  await installCheckoutDecoys(emptyCwd);
  const server = startRepositoryModuleServer(repositoryRoot);
  try {
    const primed = await runPublishedKitLoader({
      baseUrl: server.baseUrl,
      cwd: emptyCwd,
      denoDir,
      cachedOnly: false,
    });
    assertPackageStyleIdentities(primed, expected, server.baseUrl);

    await server.shutdown();
    const offline = await runPublishedKitLoader({
      baseUrl: server.baseUrl,
      cwd: emptyCwd,
      denoDir,
      cachedOnly: true,
    });
    assertEquals(offline, primed);
  } finally {
    await server.shutdown().catch(() => undefined);
    await Deno.remove(denoDir, { recursive: true });
    await Deno.remove(emptyCwd, { recursive: true });
  }
});

interface PublishedIdentities {
  coffee: {
    id: string;
    modelSourceUrl?: string;
    scenarioSourceUrl?: string;
    parameterSchemaSourceUrl?: string;
    model: string;
    scenario: string;
    schema: string;
    modelBytes: number;
  };
  ramp: {
    id: string;
    modelSourceUrl?: string;
    scenarioSourceUrl?: string;
    model: string;
    scenario: string;
    modelBytes: number;
  };
}

async function localPublishedIdentities(): Promise<PublishedIdentities> {
  const coffee = await loadCoffeeMachineKit();
  const ramp = await loadLinearThermalRampKit();
  const files = {
    coffeeModel: await Deno.readFile(new URL("../models/CoffeeMachine.mo", import.meta.url)),
    coffeeScenario: await Deno.readFile(
      new URL("../scenarios/heat-up-nominal.json", import.meta.url),
    ),
    coffeeSchema: await Deno.readFile(
      new URL("../models/CoffeeMachine.parameters.json", import.meta.url),
    ),
    rampModel: await Deno.readFile(new URL("../models/LinearThermalRamp.mo", import.meta.url)),
    rampScenario: await Deno.readFile(
      new URL("../scenarios/linear-ramp-nominal.json", import.meta.url),
    ),
  };
  const coffeeScenario = coffee.scenarios[0];
  const rampScenario = ramp.scenarios[0];
  if (
    coffee.parameterSchemaSource === undefined || coffeeScenario.source === undefined ||
    rampScenario.source === undefined
  ) {
    throw new Error("Qualified kits are missing server-owned asset bytes.");
  }
  assertEquals(new TextEncoder().encode(coffee.modelSource), files.coffeeModel);
  assertEquals(new TextEncoder().encode(coffee.parameterSchemaSource), files.coffeeSchema);
  assertEquals(new TextEncoder().encode(coffeeScenario.source), files.coffeeScenario);
  assertEquals(new TextEncoder().encode(ramp.modelSource), files.rampModel);
  assertEquals(new TextEncoder().encode(rampScenario.source), files.rampScenario);
  return {
    coffee: {
      id: coffee.id,
      model: await sha256Bytes(files.coffeeModel),
      scenario: await sha256Bytes(files.coffeeScenario),
      schema: await sha256Bytes(files.coffeeSchema),
      modelBytes: files.coffeeModel.byteLength,
    },
    ramp: {
      id: ramp.id,
      model: await sha256Bytes(files.rampModel),
      scenario: await sha256Bytes(files.rampScenario),
      modelBytes: files.rampModel.byteLength,
    },
  };
}

function assertPackageStyleIdentities(
  actual: PublishedIdentities,
  expected: PublishedIdentities,
  baseUrl: string,
): void {
  assertEquals(actual.coffee.id, expected.coffee.id);
  assertEquals(actual.ramp.id, expected.ramp.id);
  assertEquals(actual.coffee.model, expected.coffee.model);
  assertEquals(actual.coffee.scenario, expected.coffee.scenario);
  assertEquals(actual.coffee.schema, expected.coffee.schema);
  assertEquals(actual.coffee.modelBytes, expected.coffee.modelBytes);
  assertEquals(actual.ramp.model, expected.ramp.model);
  assertEquals(actual.ramp.scenario, expected.ramp.scenario);
  assertEquals(actual.ramp.modelBytes, expected.ramp.modelBytes);
  assert(actual.coffee.modelSourceUrl?.startsWith(`${baseUrl}/`) === true);
  assert(actual.coffee.scenarioSourceUrl?.startsWith(`${baseUrl}/`) === true);
  assert(actual.coffee.parameterSchemaSourceUrl?.startsWith(`${baseUrl}/`) === true);
  assert(actual.ramp.modelSourceUrl?.startsWith(`${baseUrl}/`) === true);
  assert(actual.ramp.scenarioSourceUrl?.startsWith(`${baseUrl}/`) === true);
  assert(actual.coffee.modelSourceUrl?.startsWith("file:") === false);
}

async function runPublishedKitLoader(input: {
  baseUrl: string;
  cwd: string;
  denoDir: string;
  cachedOnly: boolean;
}): Promise<PublishedIdentities> {
  const args = [
    "run",
    "--no-lock",
    "--allow-import=127.0.0.1",
    ...(input.cachedOnly ? ["--cached-only"] : ["--allow-net=127.0.0.1"]),
    publishedKitLoader,
    input.baseUrl,
  ];
  const output = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: input.cwd,
    env: { DENO_DIR: input.denoDir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `published kit loader failed (${input.cachedOnly ? "cached-only" : "prime"}):\n` +
        new TextDecoder().decode(output.stderr) +
        new TextDecoder().decode(output.stdout),
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout)) as PublishedIdentities;
}

async function installCheckoutDecoys(cwd: string): Promise<void> {
  const decoys: Record<string, string> = {
    "models/CoffeeMachine.mo": "checkout decoy model\n",
    "models/CoffeeMachine.parameters.json": '{"checkout":"decoy"}\n',
    "models/LinearThermalRamp.mo": "checkout decoy ramp\n",
    "scenarios/heat-up-nominal.json": '{"checkout":"decoy"}\n',
    "scenarios/linear-ramp-nominal.json": '{"checkout":"decoy"}\n',
  };
  for (const [relativePath, source] of Object.entries(decoys)) {
    const path = join(cwd, relativePath);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, source);
  }
}

function hasTextImportAttribute(source: string): boolean {
  return /from\s+["'][^"']+["']\s+with\s*\{[\s\S]*?type:\s*["']text["']/.test(source);
}

async function collectTextImportHits(root: URL): Promise<string[]> {
  const hits: string[] = [];
  const info = await Deno.stat(root);
  if (info.isFile) {
    if (hasTextImportAttribute(await Deno.readTextFile(root))) hits.push(root.pathname);
    return hits;
  }
  for await (const entry of Deno.readDir(root)) {
    if (entry.name === "dist" || entry.name.endsWith("_test.ts")) continue;
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), root);
    if (entry.isDirectory) {
      hits.push(...await collectTextImportHits(child));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (hasTextImportAttribute(await Deno.readTextFile(child))) hits.push(child.pathname);
  }
  return hits;
}

function startRepositoryModuleServer(root: string): {
  baseUrl: string;
  shutdown: () => Promise<void>;
} {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
      const path = join(root, relative);
      if (path !== root && !path.startsWith(prefix)) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const bytes = await Deno.readFile(path);
        return new Response(bytes, {
          headers: {
            "content-type": path.endsWith(".ts") ? "text/typescript" : "text/plain; charset=utf-8",
          },
        });
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return new Response("not found", {
            status: 404,
          });
        }
        throw error;
      }
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    shutdown: () => server.shutdown(),
  };
}
