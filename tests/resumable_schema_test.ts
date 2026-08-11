import { assert, assertEquals } from "@std/assert";
import {
  simulationManifestOutputSchema,
  simulationRequestOutputSchema,
} from "../src/tools/resumable-results.ts";

Deno.test("2.1 wire schemas close every fixed top-level and nested object", () => {
  assertClosedObjects(simulationManifestOutputSchema, "manifest-output");
  assertClosedObjects(simulationRequestOutputSchema, "request-output");

  const request = object(object(simulationRequestOutputSchema).properties).request;
  const variants = object(request).oneOf;
  assert(Array.isArray(variants));
  assertEquals(
    variants.map((variant) => object(object(object(variant).properties).status).const),
    ["pending", "running", "completed", "rejected", "recovery_required"],
  );
});

function assertClosedObjects(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedObjects(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") {
    const additional = schema.additionalProperties;
    assert(
      additional === false || (additional !== null && typeof additional === "object"),
      `${path} must reject extra fields or declare an explicit typed value map`,
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    assertClosedObjects(child, `${path}.${key}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected schema object");
  }
  return value as Record<string, unknown>;
}
