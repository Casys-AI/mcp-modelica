import { ValidationError } from "./errors.ts";
import { sha256Bytes } from "./hashing.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Reject BOMs, malformed sequences, and non-canonical UTF-8 byte sequences. */
export async function canonicalUtf8FromBytes(
  raw: Uint8Array,
  label: string,
): Promise<{ source: string; bytes: number; digest: string }> {
  let source: string;
  try {
    source = decoder.decode(raw);
  } catch (error) {
    throw new ValidationError(
      `Text resource '${label}' is not canonical UTF-8 and cannot be exposed as MCP text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const encoded = encoder.encode(source);
  if (
    raw.byteLength !== encoded.byteLength ||
    !raw.every((byte, index) => byte === encoded[index])
  ) {
    throw new ValidationError(
      `Text resource '${label}' is not canonical UTF-8 and cannot be exposed as MCP text.`,
    );
  }
  return {
    source,
    bytes: raw.byteLength,
    digest: await sha256Bytes(raw),
  };
}

export async function canonicalUtf8FromText(
  source: string,
  label: string,
): Promise<{ source: string; bytes: number; digest: string }> {
  return await canonicalUtf8FromBytes(encoder.encode(source), label);
}

export async function readCanonicalUtf8File(
  path: string | URL,
): Promise<{ source: string; bytes: number; digest: string }> {
  return await canonicalUtf8FromBytes(await Deno.readFile(path), String(path));
}

export function utf8Bytes(source: string): number {
  return encoder.encode(source).byteLength;
}
