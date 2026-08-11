import { assertEquals, assertRejects } from "@std/assert";
import { writeAll } from "../src/storage/durable.ts";

Deno.test("durable writeAll persists every byte across partial writes", async () => {
  const persisted: number[] = [];
  await writeAll({
    write(bytes) {
      const progress = Math.min(2, bytes.byteLength);
      persisted.push(...bytes.subarray(0, progress));
      return Promise.resolve(progress);
    },
  }, new TextEncoder().encode("exact utf-8 bytes"));
  assertEquals(new TextDecoder().decode(new Uint8Array(persisted)), "exact utf-8 bytes");
});

Deno.test("durable writeAll fails closed on zero or impossible progress", async () => {
  await assertRejects(
    () => writeAll({ write: () => Promise.resolve(0) }, new Uint8Array([1])),
    Error,
    "made no progress",
  );
  await assertRejects(
    () => writeAll({ write: () => Promise.resolve(2) }, new Uint8Array([1])),
    Error,
    "made no progress",
  );
});
