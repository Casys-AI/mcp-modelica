const encoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  return await sha256Bytes(encoder.encode(value));
}

/** SHA-256 over exact bytes, used by persisted artifact resource reads. */
export async function sha256Bytes(value: Uint8Array): Promise<string> {
  // Copy to a plain ArrayBuffer-backed view: WebCrypto intentionally rejects a
  // potentially shared backing store under Deno's stricter BufferSource types.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** JSON whose object keys are recursively ordered before hashing or persisting. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2) + "\n";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Canonical hashes must not depend on the host's locale/ICU data.
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
