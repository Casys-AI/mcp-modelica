import { assertEquals } from "@std/assert";
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
