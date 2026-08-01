import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const repositoryRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const resultsViewerPath = join(repositoryRoot, "src", "ui", "dist", "results-viewer", "index.html");
const runListViewerPath = join(
  repositoryRoot,
  "src",
  "ui",
  "dist",
  "run-list-viewer",
  "index.html",
);

Deno.test("built viewers contain one document and a parseable inline module", async () => {
  for (const viewerPath of [resultsViewerPath, runListViewerPath]) {
    const html = await Deno.readTextFile(viewerPath);
    assertEquals(html.match(/<!doctype html>/gi)?.length, 1);

    const openTag = '<script type="module">';
    const scriptStart = html.indexOf(openTag);
    const scriptEnd = html.indexOf("</script>", scriptStart + openTag.length);
    assert(scriptStart >= 0, "viewer must contain its inline module script");
    assert(scriptEnd > scriptStart, "viewer inline module script must be closed");

    const source = html.slice(scriptStart + openTag.length, scriptEnd);
    assert(source.trim().length > 0, "viewer inline module script must not be empty");
    // Compilation is a syntax check without executing the viewer or requiring
    // a DOM. The bundle is self-contained and has no module imports.
    new Function(source);
  }
});

Deno.test("built viewers advertise small component catalogs without projection modes", async () => {
  const html = await Deno.readTextFile(resultsViewerPath);
  const listHtml = await Deno.readTextFile(runListViewerPath);

  assert(html.includes("io.casys.mcp.view-components/v1"));
  assert(html.includes("modelica.run-identity"));
  assert(html.includes("modelica.execution-status"));
  assert(html.includes("modelica.metrics"));
  assert(html.includes("modelica.provenance"));
  assert(listHtml.includes("modelica.run-list-summary"));
  assert(listHtml.includes("modelica.run-table"));
  for (const bundle of [html, listHtml]) {
    assertEquals(bundle.includes("io.casys.mcp.composable-view/v1"), false);
    assertEquals(bundle.includes("data-casys-projection-purpose"), false);
  }
});
