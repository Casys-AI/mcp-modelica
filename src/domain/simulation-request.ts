import { ValidationError } from "./errors.ts";
import { sha256, stableJson } from "./hashing.ts";
import type { Quantity } from "./types.ts";

export interface SimulationSubmitInput {
  request_id: string;
  manifest_sha256: string;
  model_id: string;
  model_version: string;
  scenario_id: string;
  parameters: Record<string, Quantity>;
  timeout_ms: number;
}

export interface CanonicalSimulationRequest extends SimulationSubmitInput {
  request_sha256: string;
  source: string;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function parseCanonicalSimulationRequest(
  value: unknown,
): Promise<CanonicalSimulationRequest> {
  const input = record(value, "modelica_simulation_submit input");
  exactKeys(input, [
    "request_id",
    "manifest_sha256",
    "model_id",
    "model_version",
    "scenario_id",
    "parameters",
    "timeout_ms",
  ]);
  if (typeof input.request_id !== "string" || !REQUEST_ID.test(input.request_id)) {
    throw new ValidationError(
      "request_id must use 1-128 ASCII letters, digits, '.', '_' or '-' and must not begin with punctuation.",
    );
  }
  if (typeof input.manifest_sha256 !== "string" || !SHA256.test(input.manifest_sha256)) {
    throw new ValidationError("manifest_sha256 must be a lowercase SHA-256 digest.");
  }
  const parameters = quantityMap(input.parameters, "parameters");
  if (
    typeof input.timeout_ms !== "number" || !Number.isSafeInteger(input.timeout_ms) ||
    input.timeout_ms < 1 || input.timeout_ms > 120_000
  ) {
    throw new ValidationError("timeout_ms must be an integer between 1 and 120000.");
  }
  const canonical: SimulationSubmitInput = {
    request_id: input.request_id,
    manifest_sha256: input.manifest_sha256,
    model_id: nonEmpty(input.model_id, "model_id"),
    model_version: nonEmpty(input.model_version, "model_version"),
    scenario_id: nonEmpty(input.scenario_id, "scenario_id"),
    parameters,
    timeout_ms: input.timeout_ms,
  };
  const source = stableJson(canonical);
  return { ...canonical, source, request_sha256: await sha256(source) };
}

function quantityMap(value: unknown, label: string): Record<string, Quantity> {
  const source = record(value, label);
  const quantities: Record<string, Quantity> = {};
  for (const [id, item] of Object.entries(source)) {
    if (id.length === 0) throw new ValidationError(`${label} contains an empty parameter id.`);
    const quantity = record(item, `${label}.${id}`);
    exactKeys(quantity, ["value", "unit"]);
    if (typeof quantity.value !== "number" || !Number.isFinite(quantity.value)) {
      throw new ValidationError(`${label}.${id}.value must be a finite number.`);
    }
    quantities[id] = {
      value: quantity.value,
      unit: nonEmpty(quantity.unit, `${label}.${id}.unit`),
    };
  }
  return quantities;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new ValidationError(`Unknown input field '${key}' is not accepted.`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) throw new ValidationError(`${key} is required.`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new ValidationError(`${label} must be a non-empty canonical string.`);
  }
  return value;
}
