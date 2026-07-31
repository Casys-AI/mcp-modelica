/// <reference lib="deno.ns" />
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.1.0";

const here = dirname(fromFileUrl(import.meta.url));
const mcpViewModule = Deno.env.get("MCP_VIEW_MODULE") ?? "jsr:@casys/mcp-view@0.4.0";
const temporaryDirectory = await Deno.makeTempDir({ prefix: "mcp-modelica-view-build-" });
const importMap = join(temporaryDirectory, "import-map.json");
const bundlePath = join(temporaryDirectory, "results-viewer.js");
let js: string;
try {
  await Deno.writeTextFile(
    importMap,
    JSON.stringify({
      imports: {
        "@casys/mcp-view": mcpViewModule,
        "@modelcontextprotocol/ext-apps": "npm:@modelcontextprotocol/ext-apps@^1.7.4",
        "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.29.0",
        "@modelcontextprotocol/sdk/types.js": "npm:@modelcontextprotocol/sdk@^1.29.0/types.js",
      },
    }),
  );
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--no-config",
      "--check",
      "--platform=browser",
      "--minify",
      "--import-map",
      importMap,
      join(here, "src", "main.ts"),
      "--output",
      bundlePath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(
      `Modelica results viewer build failed:\n${new TextDecoder().decode(result.stderr)}`,
    );
  }
  js = await Deno.readTextFile(bundlePath);
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

const template = await Deno.readTextFile(join(here, "index.html"));
const css = await Deno.readTextFile(join(here, "src", "styles.css"));
const html = template
  .replace("/* STYLES_PLACEHOLDER */", css)
  .replace("/* BUNDLE_PLACEHOLDER */", js)
  .replace(/[ \t]+$/gm, "");
const output = join(here, "..", "dist", "results-viewer", "index.html");
await Deno.mkdir(dirname(output), { recursive: true });
await Deno.writeTextFile(output, html);
console.log(
  `[build:ui] wrote ${output} (${(new TextEncoder().encode(html).length / 1024).toFixed(1)} KiB)`,
);
