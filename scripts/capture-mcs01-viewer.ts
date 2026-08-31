/// <reference lib="deno.ns" />

import { dirname, fromFileUrl, join } from "@std/path";
import {
  MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
  parseModelicaRecordedAdmittedExecutionSession,
} from "../src/ui/results-viewer/src/admitted-recorded-session.ts";

const root = dirname(dirname(fromFileUrl(import.meta.url)));
const fixturePath = join(
  root,
  "tests/fixtures/mcs01-modelica-admitted-execution-capture.json",
);
const viewerPath = join(root, "src/ui/dist/results-viewer/index.html");
const outputPath = join(root, "docs/assets/modelica-mcs01-recorded-viewer.png");
const capture = JSON.parse(await Deno.readTextFile(fixturePath));

const CAPTURE_DIGEST = "b4681bc277dc66505022bde78219feab5300dd018635113e4c648a1ee4b96a07";
const ADMISSION_DIGEST = "f6ecea5b5a341e7a41fd1bdf36068e9413f3a2fd12df2133baafef69b9374336";
const EVIDENCE_DIGEST = "5a66a167ee86f9a4f8faec4d5b55d07658ca5c82f38de7af9eba27b5a63b6cd6";
const RESULT_DIGEST = "cf2d2525e2e7e12d0cea6147abfba34bc24407498f4c96ef9217a3a08c62070c";

const fingerprint = (digest: string) => ({ algorithm: "sha256", digest });
const artifact = (artifactId: string, uri: string, digest: string) => ({
  artifactId,
  uri,
  fingerprint: fingerprint(digest),
});
const session = {
  schemaVersion: MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
  kind: "modelica.admitted-execution",
  basis: {
    projectId: "motorized-camera-slider-mcs01",
    projectRevision: 150,
    subjectId: "project:motorized-camera-slider-mcs01",
    thread: {
      id:
        "project:motorized-camera-slider-mcs01:r21:decide-accept-admitted-spice-evaluation-run:queue-mcs01-spice-closeout-r146",
      revision: 21,
    },
  },
  anchor: {
    kind: "artifact",
    id: `modelica-admitted-result-${RESULT_DIGEST}`,
    uri: `casys://isolated-output/sha256/${RESULT_DIGEST}`,
    fingerprint: fingerprint(RESULT_DIGEST),
  },
  provenance: {
    kind: "digital-thread-operation",
    serverId: "digital-thread",
    operation: "simulate.run-admitted-modelica@1",
    runId: "run:queue-mcs01-run-slider-motion-r91",
    admissionArtifact: artifact(
      `technical-compilation-admission-${ADMISSION_DIGEST}`,
      `casys://technical-compilation-admission-capture/sha256/${ADMISSION_DIGEST}`,
      ADMISSION_DIGEST,
    ),
    captureArtifact: artifact(
      `modelica-admitted-capture-${CAPTURE_DIGEST}`,
      `casys://modelica-admitted-execution-capture/sha256/${CAPTURE_DIGEST}`,
      CAPTURE_DIGEST,
    ),
    evidenceArtifact: artifact(
      `modelica-admitted-evidence-${EVIDENCE_DIGEST}`,
      `casys://isolated-output/sha256/${EVIDENCE_DIGEST}`,
      EVIDENCE_DIGEST,
    ),
    resultArtifact: artifact(
      `modelica-admitted-result-${RESULT_DIGEST}`,
      `casys://isolated-output/sha256/${RESULT_DIGEST}`,
      RESULT_DIGEST,
    ),
  },
  projection: { status: "available", capture },
};

// Keep the documentation image on the same strict ingress path as the shipped App.
await parseModelicaRecordedAdmittedExecutionSession(session);

const viewerHtml = await Deno.readTextFile(viewerPath);
const hostHtml = documentationHostHtml(session);
let resolvePort!: (port: number) => void;
const listening = new Promise<number>((resolve) => resolvePort = resolve);
const server = Deno.serve(
  {
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  },
  (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/viewer") {
      return new Response(viewerHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/") {
      return new Response(hostHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
);

const port = await listening;
const temporaryDirectory = await Deno.makeTempDir({ prefix: "mcp-modelica-doc-capture-" });
const rawScreenshot = join(temporaryDirectory, "raw.png");
try {
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  const chrome = await findExecutable([
    Deno.env.get("CHROME_BIN"),
    "/opt/homebrew/bin/chrome-headless-shell",
    "/usr/local/bin/chrome-headless-shell",
    "/usr/bin/chrome-headless-shell",
  ]);
  await run(chrome, [
    "--headless",
    "--disable-background-networking",
    "--disable-gpu",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw",
    "--timeout=5000",
    "--virtual-time-budget=5000",
    "--window-size=1040,720",
    `--screenshot=${rawScreenshot}`,
    `http://127.0.0.1:${port}/`,
  ]);
  const ffmpeg = await findExecutable([
    Deno.env.get("FFMPEG_BIN"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]);
  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    rawScreenshot,
    "-compression_level",
    "9",
    "-pred",
    "mixed",
    outputPath,
  ]);
  const { size } = await Deno.stat(outputPath);
  console.log(`[capture:mcs01] wrote ${outputPath} (${(size / 1024).toFixed(1)} KiB)`);
} finally {
  await server.shutdown();
  await Deno.remove(temporaryDirectory, { recursive: true });
}

function documentationHostHtml(payload: unknown): string {
  const serialized = JSON.stringify(payload).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCS01 recorded Modelica viewer</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #fbfaf7; }
      iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
    </style>
  </head>
  <body>
    <iframe id="viewer" sandbox="allow-scripts" src="/viewer" title="MCS01 recorded Modelica viewer"></iframe>
    <script>
      const session = ${serialized};
      const frame = document.getElementById("viewer");
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || !event.data || event.data.jsonrpc !== "2.0") return;
        const message = event.data;
        const post = (value) => frame.contentWindow.postMessage(value, "*");
        if (message.method === "ui/initialize") {
          post({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: { name: "modelica-doc-capture-host", version: "1.0.0" },
              hostCapabilities: {},
              hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"] },
            },
          });
          return;
        }
        if (message.method === "ui/notifications/initialized") {
          post({
            jsonrpc: "2.0",
            method: "ui/compose/event",
            params: { action: "viewer.session.apply", data: session },
          });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          post({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      });
    </script>
  </body>
</html>`;
}

async function findExecutable(candidates: readonly (string | undefined)[]): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile) return candidate;
    } catch {
      // Try the next documented local executable.
    }
  }
  throw new Error(
    "Set CHROME_BIN to Chrome Headless Shell and FFMPEG_BIN to ffmpeg to capture the viewer.",
  );
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const child = new Deno.Command(command, { args: [...args], stdout: "piped", stderr: "piped" });
  const result = await child.output();
  if (result.success) return;
  throw new Error(
    `${command} failed (${result.code}): ${new TextDecoder().decode(result.stderr).trim()}`,
  );
}
