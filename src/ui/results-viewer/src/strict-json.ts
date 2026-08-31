/**
 * Accept only an ordinary dense JSON array: `length`, every own numeric index, and nothing else.
 *
 * `Array.prototype.map` and JSON-style joins skip holes, while extra string/symbol properties are
 * not part of JSON. Reject both forms before validation or canonical hashing can collapse them.
 */
export function isDenseJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) return false;
  const keys = new Set<PropertyKey>(ownKeys);
  if (!keys.has("length")) return false;
  for (let index = 0; index < value.length; index++) {
    if (!keys.has(String(index))) return false;
  }
  return true;
}
