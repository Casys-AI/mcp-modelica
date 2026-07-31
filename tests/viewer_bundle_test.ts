import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const repositoryRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const viewerPath = join(repositoryRoot, "src", "ui", "dist", "results-viewer", "index.html");

Deno.test("built results viewer contains one document and parseable inline module", async () => {
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
});
