import { assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import {
  checkGeneratedKitAssets,
  GENERATED_MODULE,
  GeneratedKitAssetsError,
  KIT_ASSET_BINDINGS,
  renderGeneratedKitAssets,
  REPOSITORY_ROOT,
} from "../scripts/generate-kit-assets.ts";
import { generatedKitAssetText } from "../src/kits/generated-kit-assets.ts";

const encoder = new TextEncoder();

Deno.test("generated kit asset strings re-encode to the exact source asset bytes", async () => {
  for (const binding of KIT_ASSET_BINDINGS) {
    const raw = await Deno.readFile(new URL(binding.relativePath, REPOSITORY_ROOT));
    const text = generatedKitAssetText[binding.relativePath];
    assertEquals(encoder.encode(text), raw);
  }
});

Deno.test("checked-in generated kit asset module matches the generator byte-for-byte", async () => {
  await checkGeneratedKitAssets();
  assertEquals(await Deno.readFile(GENERATED_MODULE), await renderGeneratedKitAssets());
});

Deno.test("kit asset generator is deterministic across two renders", async () => {
  const first = await renderGeneratedKitAssets();
  const second = await renderGeneratedKitAssets();
  assertEquals(first, second);
});

Deno.test("kit asset generator check mode detects drift from the expected module", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-assets-drift-" });
  try {
    const output = join(directory, "generated-kit-assets.ts");
    const expected = await renderGeneratedKitAssets();
    await Deno.writeFile(output, expected);
    await checkGeneratedKitAssets({ output: toFileUrl(output) });

    const drifted = encoder.encode("// drifted generated kit assets\n");
    await Deno.writeFile(output, drifted);
    const error = await assertRejects(
      () => checkGeneratedKitAssets({ output: toFileUrl(output) }),
      GeneratedKitAssetsError,
    );
    assertEquals(error.code, "generated_kit_assets_stale");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("kit asset generator check mode fails closed when the module is missing", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-assets-missing-" });
  try {
    const error = await assertRejects(
      () =>
        checkGeneratedKitAssets({ output: toFileUrl(join(directory, "generated-kit-assets.ts")) }),
      GeneratedKitAssetsError,
    );
    assertEquals(error.code, "generated_kit_assets_missing");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("kit asset generator rejects a noncanonical UTF-8 source asset", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-assets-utf8-" });
  try {
    await copyQualifiedAssets(directory);
    await Deno.writeFile(
      join(directory, "models", "CoffeeMachine.mo"),
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    const error = await assertRejects(
      () => renderGeneratedKitAssets(directoryUrl(directory)),
      GeneratedKitAssetsError,
    );
    assertEquals(error.code, "generated_kit_asset_noncanonical_utf8");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("rendered generated TypeScript imports back to byte-identical asset strings", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-kit-assets-import-" });
  try {
    const output = join(directory, "generated-kit-assets.ts");
    await Deno.writeFile(output, await renderGeneratedKitAssets());
    const generated = await import(toFileUrl(output).href) as {
      generatedKitAssetText: Record<string, string>;
    };
    for (const binding of KIT_ASSET_BINDINGS) {
      const raw = await Deno.readFile(new URL(binding.relativePath, REPOSITORY_ROOT));
      assertEquals(encoder.encode(generated.generatedKitAssetText[binding.relativePath]), raw);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function copyQualifiedAssets(destinationRoot: string): Promise<void> {
  const repositoryRoot = fromFileUrl(REPOSITORY_ROOT);
  for (const binding of KIT_ASSET_BINDINGS) {
    const destination = join(destinationRoot, binding.relativePath);
    await Deno.mkdir(dirname(destination), { recursive: true });
    await Deno.copyFile(join(repositoryRoot, binding.relativePath), destination);
  }
}

function directoryUrl(path: string): URL {
  const url = toFileUrl(path);
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}
