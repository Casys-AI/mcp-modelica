import { assert, assertEquals } from "@std/assert";
import { PACKAGE_VERSION } from "../src/release-identity.ts";
import {
  MODELICA_RECORDED_VIEW_SESSION_SCHEMA,
  MODELICA_RESULT_SCHEMA_IDS,
  MODELICA_RESULTS_VIEWER_URI,
  MODELICA_RUN_LIST_VIEWER_URI,
  MODELICA_VIEW_APP_INFO,
  MODELICA_VIEW_APP_MANIFEST,
  VIEWER_SESSION_APPLY_ACTION,
} from "../mod.ts";

Deno.test("public Modelica App manifest names the exact registered resources", () => {
  assertEquals(MODELICA_VIEW_APP_MANIFEST.app, {
    id: "io.casys.mcp-modelica.results",
    title: "Modelica results",
    version: PACKAGE_VERSION,
  });
  assertEquals(MODELICA_VIEW_APP_INFO, {
    name: MODELICA_VIEW_APP_MANIFEST.app.id,
    version: MODELICA_VIEW_APP_MANIFEST.app.version,
  });
  assertEquals(
    MODELICA_VIEW_APP_MANIFEST.resources.map((resource) => resource.uri),
    [MODELICA_RESULTS_VIEWER_URI, MODELICA_RUN_LIST_VIEWER_URI],
  );
  for (const resource of MODELICA_VIEW_APP_MANIFEST.resources) {
    assertEquals(resource.ownership, "whole-view");
    assertEquals(resource.acceptedActions, [VIEWER_SESSION_APPLY_ACTION]);
    assertEquals(resource.sessionSchemas, [MODELICA_RECORDED_VIEW_SESSION_SCHEMA]);
  }
  assertEquals(MODELICA_VIEW_APP_MANIFEST.resources[0].resultSchemas, [
    MODELICA_RESULT_SCHEMA_IDS.legacyRun,
    MODELICA_RESULT_SCHEMA_IDS.recordedRun,
  ]);
  assertEquals(MODELICA_VIEW_APP_MANIFEST.resources[1].resultSchemas, [
    MODELICA_RESULT_SCHEMA_IDS.legacyRunList,
    MODELICA_RESULT_SCHEMA_IDS.recordedRunList,
  ]);
});

Deno.test("serialized Modelica App manifest is the exact exported package contract", async () => {
  const packageConfig = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as {
    version: string;
    exports: Record<string, string>;
    publish: { include: string[] };
  };
  const serializedManifest = JSON.parse(
    await Deno.readTextFile(new URL("../src/ui/view-app-manifest.json", import.meta.url)),
  );

  assertEquals(serializedManifest, MODELICA_VIEW_APP_MANIFEST);
  assertEquals(serializedManifest.app.version, packageConfig.version);
  assertEquals(packageConfig.exports["./view-app-manifest"], "./src/ui/view-app-manifest.json");
  assert(
    packageConfig.publish.include.includes("src/ui/view-app-manifest.json"),
    "The serialized App manifest must be present in the published package archive.",
  );
});
