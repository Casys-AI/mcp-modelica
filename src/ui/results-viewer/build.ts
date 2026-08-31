/// <reference lib="deno.ns" />
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.1.0";

const here = dirname(fromFileUrl(import.meta.url));
const mcpViewModule = requiredModule("MCP_VIEW_MODULE");
const mcpViewComponentsModule = requiredModule("MCP_VIEW_COMPONENTS_MODULE");
const mcpViewContractsModule = Deno.env.get("MCP_VIEW_CONTRACTS_MODULE") ??
  localModule(mcpViewModule, "../view-contracts/mod.ts", "MCP_VIEW_CONTRACTS_MODULE");
const mcpViewComponentsPreactModule = Deno.env.get("MCP_VIEW_COMPONENTS_PREACT_MODULE") ??
  localModule(mcpViewComponentsModule, "./preact.ts", "MCP_VIEW_COMPONENTS_PREACT_MODULE");
const mcpViewPresentationModule = Deno.env.get("MCP_VIEW_PRESENTATION_MODULE") ??
  localModule(
    mcpViewComponentsModule,
    "./preact-components.ts",
    "MCP_VIEW_PRESENTATION_MODULE",
  );
const temporaryDirectory = await Deno.makeTempDir({ prefix: "mcp-modelica-view-build-" });
const importMap = join(temporaryDirectory, "import-map.json");
const lockFile = join(here, "deno.lock");
const builds = [
  { entry: "main.ts", viewer: "results-viewer" },
  { entry: "run-list-main.ts", viewer: "run-list-viewer" },
] as const;
const bundles = new Map<string, string>();
try {
  await Deno.writeTextFile(
    importMap,
    JSON.stringify({
      imports: {
        "@casys/mcp-view": mcpViewModule,
        "@casys/mcp-view-contracts": mcpViewContractsModule,
        "@casys/mcp-view-components": mcpViewComponentsModule,
        "@casys/mcp-view-components/preact": mcpViewComponentsPreactModule,
        "@casys/mcp-view-components/preact/components": mcpViewPresentationModule,
        "preact": "npm:preact@10.29.7",
        "@modelcontextprotocol/ext-apps": "npm:@modelcontextprotocol/ext-apps@1.7.5",
        "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.30.0",
        "@modelcontextprotocol/sdk/types.js": "npm:@modelcontextprotocol/sdk@1.30.0/types.js",
      },
    }),
  );
  for (const build of builds) {
    const bundlePath = join(temporaryDirectory, `${build.viewer}.js`);
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--config",
        importMap,
        "--lock",
        lockFile,
        "--frozen",
        "--check",
        "--platform=browser",
        "--minify",
        join(here, "src", build.entry),
        "--output",
        bundlePath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (!result.success) {
      throw new Error(
        `Modelica ${build.viewer} build failed:\n${new TextDecoder().decode(result.stderr)}`,
      );
    }
    bundles.set(build.viewer, await Deno.readTextFile(bundlePath));
  }
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

const template = await Deno.readTextFile(join(here, "index.html"));
const css = await Deno.readTextFile(join(here, "src", "styles.css"));
for (const build of builds) {
  const js = bundles.get(build.viewer);
  if (js === undefined) throw new Error(`Missing generated bundle for ${build.viewer}.`);
  const html = template
    // Replacement strings interpret `$&`, `$'`, and `$`` specially. Browser
    // bundles routinely contain these sequences, so use callbacks to insert the
    // generated assets byte-for-byte.
    .replace("/* STYLES_PLACEHOLDER */", () => css)
    .replace("/* BUNDLE_PLACEHOLDER */", () => js)
    .replace(/[ \t]+$/gm, "");
  const output = join(here, "..", "dist", build.viewer, "index.html");
  await Deno.mkdir(dirname(output), { recursive: true });
  await Deno.writeTextFile(output, html);
  console.log(
    `[build:ui] wrote ${output} (${(new TextEncoder().encode(html).length / 1024).toFixed(1)} KiB)`,
  );
}

function requiredModule(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) {
    throw new Error(
      `${name} must name the audited local split-package module used for this viewer build.`,
    );
  }
  return value;
}

function localModule(rootModule: string, relative: string, overrideName: string): string {
  try {
    const root = new URL(rootModule);
    if (root.protocol === "file:") return new URL(relative, root).href;
  } catch {
    // Fall through to the actionable override error below.
  }
  throw new Error(
    `${overrideName} is required when its package root is not a local file URL.`,
  );
}
