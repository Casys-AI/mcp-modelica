import { dirname } from "@std/path";
import { ValidationError } from "../domain/errors.ts";
import { sha256Bytes } from "../domain/hashing.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Write an exact UTF-8 text artifact durably.  The data file is synced before
 * its atomic rename and the containing directory is synced afterwards, so a
 * successful return is a durable publication boundary rather than merely a
 * process-local write.
 */
export async function writeDurableText(path: string, source: string): Promise<void> {
  const parent = dirname(path);
  await makeDurableDirectory(parent);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true });
    await writeAll(file, encoder.encode(source));
    await file.syncData();
  } finally {
    file?.close();
  }
  await Deno.rename(temporary, path);
  await syncDirectory(parent);
}

/** Create a new durable file without overwriting an existing cross-process claim. */
export async function createDurableText(path: string, source: string): Promise<boolean> {
  const parent = dirname(path);
  await makeDurableDirectory(parent);
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { createNew: true, write: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return false;
    throw error;
  }
  try {
    await writeAll(file, encoder.encode(source));
    await file.syncData();
  } finally {
    file.close();
  }
  await syncDirectory(parent);
  return true;
}

export async function removeDurable(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

/**
 * Re-establish the durability boundary for a file whose publication may have
 * reached rename before its parent-directory fsync reported success.
 */
export async function confirmDurableFile(path: string): Promise<void> {
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { read: true });
    await file.sync();
  } finally {
    file?.close();
  }
  await syncDirectory(dirname(path));
}

/** Ensure a newly-created run directory itself is discoverable after a crash. */
export async function makeDurableDirectory(path: string): Promise<void> {
  try {
    const metadata = await Deno.stat(path);
    if (!metadata.isDirectory) {
      throw new ValidationError(`Durable directory path '${path}' is not a directory.`);
    }
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const parent = dirname(path);
  if (parent !== path) await makeDurableDirectory(parent);
  try {
    await Deno.mkdir(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    const metadata = await Deno.stat(path);
    if (!metadata.isDirectory) throw error;
  }
  await syncDirectory(parent);
}

export async function syncDirectory(path: string): Promise<void> {
  let directory: Deno.FsFile | undefined;
  try {
    directory = await Deno.open(path, { read: true });
    await directory.sync();
  } finally {
    directory?.close();
  }
}

/** Reject BOMs, malformed sequences, and non-canonical UTF-8 byte sequences. */
export async function readCanonicalUtf8(path: string): Promise<{
  source: string;
  bytes: number;
  sha256: string;
}> {
  const raw = await Deno.readFile(path);
  let source: string;
  try {
    source = decoder.decode(raw);
  } catch (error) {
    throw new ValidationError(
      `Text resource '${path}' is not canonical UTF-8 and cannot be exposed as MCP text: ${
        message(error)
      }`,
    );
  }
  const encoded = encoder.encode(source);
  if (
    raw.byteLength !== encoded.byteLength || !raw.every((byte, index) => byte === encoded[index])
  ) {
    throw new ValidationError(
      `Text resource '${path}' is not canonical UTF-8 and cannot be exposed as MCP text.`,
    );
  }
  return { source, bytes: raw.byteLength, sha256: await sha256Bytes(raw) };
}

export function utf8Bytes(source: string): number {
  return encoder.encode(source).byteLength;
}

/** Deno.write may legally make partial progress; publication never does. */
export async function writeAll(
  file: Pick<Deno.FsFile, "write">,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await file.write(bytes.subarray(offset));
    if (
      !Number.isSafeInteger(written) || written <= 0 ||
      written > bytes.byteLength - offset
    ) {
      throw new ValidationError("Durable write made no progress before all bytes were persisted.");
    }
    offset += written;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
