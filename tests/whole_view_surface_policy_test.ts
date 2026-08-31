import { assertEquals, assertThrows } from "@std/assert";
import { resolveWholeViewSurfacePolicy } from "../src/ui/results-viewer/src/whole-view-surface-policy.ts";

Deno.test("recorded run handshake keeps the App-owned surface under a host-selected component context", () => {
  assertEquals(
    resolveWholeViewSurfacePolicy({
      recorded: true,
      hostSelectedSurface: true,
      defaultSurface: "modelica-complete-run",
    }),
    { componentOnly: false, surface: "modelica-complete-run" },
  );
});

Deno.test("recorded run-list handshake keeps the App-owned surface under a host-selected component context", () => {
  assertEquals(
    resolveWholeViewSurfacePolicy({
      recorded: true,
      hostSelectedSurface: true,
      defaultSurface: "modelica-complete-run-list",
    }),
    { componentOnly: false, surface: "modelica-complete-run-list" },
  );
});

Deno.test("direct tool results retain host component selection and local drill-down behavior", () => {
  assertEquals(
    resolveWholeViewSurfacePolicy({
      recorded: false,
      hostSelectedSurface: true,
      defaultSurface: "modelica-complete-run-list",
    }),
    { componentOnly: true },
  );
  assertEquals(
    resolveWholeViewSurfacePolicy({
      recorded: false,
      hostSelectedSurface: true,
      defaultSurface: "modelica-complete-run",
      preferDefaultSurface: true,
    }),
    { componentOnly: true, surface: "modelica-complete-run" },
  );
});

Deno.test("recorded whole views fail closed without an App-owned default surface", () => {
  assertThrows(
    () =>
      resolveWholeViewSurfacePolicy({
        recorded: true,
        hostSelectedSurface: true,
        defaultSurface: undefined,
      }),
    TypeError,
    "requires an App-owned default surface",
  );
});
