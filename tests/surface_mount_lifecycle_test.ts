import { assertEquals } from "@std/assert";
import { createLatestSurfaceMountLifecycle } from "../src/ui/results-viewer/src/surface-mount-lifecycle.ts";

interface FakeMount {
  readonly id: string;
  dispose(): void;
}

Deno.test("a delayed stale surface is disposed and cannot replace the newest mount", async () => {
  const lifecycle = createLatestSurfaceMountLifecycle<FakeMount>();
  const disposed: string[] = [];
  const renderedErrors: string[] = [];
  let resolveStale!: (mount: FakeMount) => void;
  const delayedStale = new Promise<FakeMount>((resolve) => resolveStale = resolve);
  let markStaleStarted!: () => void;
  const staleStarted = new Promise<void>((resolve) => markStaleStarted = resolve);

  const staleOperation = lifecycle.schedule(
    () => {
      markStaleStarted();
      return delayedStale;
    },
    (error) => renderedErrors.push(String(error)),
  );
  await staleStarted;

  const newest = fakeMount("newest", disposed);
  const newestOperation = lifecycle.schedule(
    () => Promise.resolve(newest),
    (error) => renderedErrors.push(String(error)),
  );
  await newestOperation;
  assertEquals(lifecycle.current(), newest);

  resolveStale(fakeMount("stale", disposed));
  await staleOperation;
  assertEquals(lifecycle.current(), newest);
  assertEquals(disposed, ["stale"]);
  assertEquals(renderedErrors, []);

  await lifecycle.dispose();
  assertEquals(disposed, ["stale", "newest"]);
});

Deno.test("an error from a stale mount never overwrites the current surface", async () => {
  const lifecycle = createLatestSurfaceMountLifecycle<FakeMount>();
  const errors: string[] = [];
  let rejectStale!: (error: Error) => void;
  const delayedFailure = new Promise<FakeMount>((_resolve, reject) => rejectStale = reject);
  let markStaleStarted!: () => void;
  const staleStarted = new Promise<void>((resolve) => markStaleStarted = resolve);

  const staleOperation = lifecycle.schedule(
    () => {
      markStaleStarted();
      return delayedFailure;
    },
    (error) => errors.push(String(error)),
  );
  await staleStarted;
  await lifecycle.schedule(
    () => Promise.resolve(fakeMount("current", [])),
    (error) => errors.push(String(error)),
  );
  rejectStale(new Error("stale failure"));
  await staleOperation;

  assertEquals(lifecycle.current()?.id, "current");
  assertEquals(errors, []);
  await lifecycle.dispose();
});

function fakeMount(id: string, disposed: string[]): FakeMount {
  return { id, dispose: () => void disposed.push(id) };
}
