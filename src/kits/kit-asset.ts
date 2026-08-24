import { canonicalUtf8FromText, readCanonicalUtf8File } from "../domain/canonical-utf8.ts";
import { ValidationError } from "../domain/errors.ts";

const embeddedKitAssets = new Map<string, string>();

/**
 * Bind a statically imported kit asset to the URL Deno would assign it in the
 * module graph. File-backed reads still reopen raw bytes; https/http reads use
 * only this cached binding.
 */
export function registerEmbeddedKitAsset(url: URL, text: string): void {
  const existing = embeddedKitAssets.get(url.href);
  if (existing !== undefined && existing !== text) {
    throw new ValidationError(
      `Embedded kit asset '${url.href}' is already registered with different bytes.`,
    );
  }
  embeddedKitAssets.set(url.href, text);
}

/**
 * Reopen a qualified kit asset.
 *
 * Local file URLs are read from disk on every call so a mutation after registry
 * creation fails closed. https/http JSR-style module URLs reopen only from the
 * statically imported text already in the module graph. There is no fetch and
 * no checkout-path fallback.
 */
export async function readKitAsset(url: URL): Promise<{
  source: string;
  bytes: number;
  digest: string;
}> {
  if (url.protocol === "file:") {
    return await readCanonicalUtf8File(url);
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    const embedded = embeddedKitAssets.get(url.href);
    if (embedded === undefined) {
      throw new ValidationError(
        `Kit asset '${url.href}' is not a cached module graph binding; ` +
          "refusing network fetch and checkout fallback.",
      );
    }
    return await canonicalUtf8FromText(embedded, url.href);
  }
  throw new ValidationError(
    `Kit asset '${url.href}' must be a file URL or a cached http(s) module URL.`,
  );
}
