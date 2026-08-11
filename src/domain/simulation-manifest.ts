import { ValidationError } from "./errors.ts";
import { kitParameterSchemaUri, kitScenarioUri, kitSourceUri } from "./evidence-uris.ts";
import { sha256, stableJson } from "./hashing.ts";
import type {
  AffineUnitConversion,
  EngineIdentity,
  ProducedMetricDefinition,
  Quantity,
} from "./types.ts";

export const MODELICA_RESUMABLE_SCHEMA_VERSION = "2.1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const MODELICA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ManifestResource {
  uri: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  qualification: "qualified-kit" | "compiler-derived-verified";
}

export interface ManifestParameter {
  id: string;
  modelica_name: string;
  modelica_type: string;
  description: string;
  unit: string;
  minimum: number;
  maximum: number;
  conversion: AffineUnitConversion;
}

export interface SimulationManifest {
  schemaVersion: typeof MODELICA_RESUMABLE_SCHEMA_VERSION;
  fingerprint: string;
  manifest_sha256: string;
  model: {
    id: string;
    version: string;
    name: string;
    source: ManifestResource;
  };
  scenario: {
    id: string;
    source: ManifestResource;
    public: {
      id: string;
      description: string;
      stop_time_s: number;
      start_time_s: number;
      number_of_intervals: number;
      solver: string;
      target_temperature: Quantity;
    };
    projection_sha256: string;
  };
  parameter_schema?: ManifestResource;
  parameters: ManifestParameter[];
  produced_metrics: ProducedMetricDefinition[];
  result_normalizer: { id: string; version: string };
  /** Versioned server-owned lowering from qualified values to exact run.mos. */
  lowering: { id: string; version: string };
  engine: EngineIdentity;
}

export interface ManifestIdentityInput {
  model_id: string;
  model_version: string;
  scenario_id: string;
}

type UnsignedManifest = Omit<SimulationManifest, "fingerprint" | "manifest_sha256">;

export function parseManifestIdentityInput(value: unknown): ManifestIdentityInput {
  const input = object(value, "modelica_simulation_manifest_get input");
  exactKeys(input, ["model_id", "model_version", "scenario_id"], [], "manifest input");
  return {
    model_id: canonicalString(input.model_id, "model_id"),
    model_version: canonicalString(input.model_version, "model_version"),
    scenario_id: canonicalString(input.scenario_id, "scenario_id"),
  };
}

/**
 * Parse every persisted/output manifest field before it is accepted as a
 * qualified execution identity. This is deliberately independent from MCP
 * output validation: on-disk ledgers are adversarial input during recovery.
 */
export async function parseSealedSimulationManifest(value: unknown): Promise<SimulationManifest> {
  const manifest = object(value, "simulation manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "fingerprint",
      "manifest_sha256",
      "model",
      "scenario",
      "parameters",
      "produced_metrics",
      "result_normalizer",
      "lowering",
      "engine",
    ],
    ["parameter_schema"],
    "simulation manifest",
  );
  if (manifest.schemaVersion !== MODELICA_RESUMABLE_SCHEMA_VERSION) {
    throw new ValidationError("simulation manifest schemaVersion must be 2.1.");
  }
  const fingerprint = digest(manifest.fingerprint, "manifest.fingerprint");
  const manifestSha256 = digest(manifest.manifest_sha256, "manifest.manifest_sha256");
  if (fingerprint !== manifestSha256) {
    throw new ValidationError("simulation manifest fingerprint and manifest_sha256 must be equal.");
  }
  const {
    fingerprint: _fingerprint,
    manifest_sha256: _manifestSha256,
    ...unsignedValue
  } = manifest;
  const unsigned = parseUnsignedManifest(unsignedValue);
  const sealed = await sealManifest(unsigned);
  if (sealed.fingerprint !== fingerprint) {
    throw new ValidationError(
      "simulation manifest fingerprint does not match canonical manifest bytes.",
    );
  }
  return sealed;
}

/** Hash a fully checked canonical manifest without its self-describing hashes. */
export async function sealManifest(manifest: UnsignedManifest): Promise<SimulationManifest> {
  const unsigned = parseUnsignedManifest(manifest);
  if (
    unsigned.scenario.projection_sha256 !==
      await sha256(stableJson(unsigned.scenario.public))
  ) {
    throw new ValidationError(
      "simulation manifest scenario projection_sha256 does not match its public projection.",
    );
  }
  const fingerprint = await sha256(stableJson(unsigned));
  return { ...unsigned, fingerprint, manifest_sha256: fingerprint };
}

export function manifestUnsigned(manifest: SimulationManifest): UnsignedManifest {
  const { fingerprint: _fingerprint, manifest_sha256: _manifestSha, ...unsigned } = manifest;
  return unsigned;
}

function parseUnsignedManifest(value: unknown): UnsignedManifest {
  const manifest = object(value, "unsigned simulation manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "model",
      "scenario",
      "parameters",
      "produced_metrics",
      "result_normalizer",
      "lowering",
      "engine",
    ],
    ["parameter_schema"],
    "unsigned simulation manifest",
  );
  if (manifest.schemaVersion !== MODELICA_RESUMABLE_SCHEMA_VERSION) {
    throw new ValidationError("unsigned simulation manifest schemaVersion must be 2.1.");
  }
  const model = parseModel(manifest.model);
  const scenario = parseScenario(manifest.scenario, model.id, model.version);
  const parameterSchema = manifest.parameter_schema === undefined ? undefined : parseResource(
    manifest.parameter_schema,
    "parameter_schema",
    kitParameterSchemaUri(model.id, model.version),
    "application/json",
    "compiler-derived-verified",
  );
  const parameters = array(manifest.parameters, "parameters").map((item, index) =>
    parseParameter(item, index)
  );
  assertDistinct(parameters.map((parameter) => parameter.id), "manifest parameter ids");
  assertDistinct(
    parameters.map((parameter) => parameter.modelica_name),
    "manifest Modelica parameter names",
  );
  const producedMetrics = array(manifest.produced_metrics, "produced_metrics").map((item, index) =>
    parseMetric(item, index)
  );
  if (producedMetrics.length === 0) {
    throw new ValidationError("simulation manifest must declare produced_metrics.");
  }
  assertDistinct(producedMetrics.map((metric) => metric.id), "manifest produced metric ids");
  return {
    schemaVersion: MODELICA_RESUMABLE_SCHEMA_VERSION,
    model,
    scenario,
    ...(parameterSchema === undefined ? {} : { parameter_schema: parameterSchema }),
    parameters,
    produced_metrics: producedMetrics,
    result_normalizer: parseIdentity(manifest.result_normalizer, "result_normalizer"),
    lowering: parseIdentity(manifest.lowering, "lowering"),
    engine: parseEngine(manifest.engine),
  };
}

function parseModel(value: unknown): UnsignedManifest["model"] {
  const model = object(value, "manifest.model");
  exactKeys(model, ["id", "version", "name", "source"], [], "manifest.model");
  const id = canonicalString(model.id, "manifest.model.id");
  const version = canonicalString(model.version, "manifest.model.version");
  const name = canonicalString(model.name, "manifest.model.name");
  if (!MODELICA_IDENTIFIER.test(name)) {
    throw new ValidationError("manifest.model.name is not a Modelica identifier.");
  }
  return {
    id,
    version,
    name,
    source: parseResource(
      model.source,
      "manifest.model.source",
      kitSourceUri(id, version),
      "text/x-modelica",
      "qualified-kit",
    ),
  };
}

function parseScenario(
  value: unknown,
  modelId: string,
  modelVersion: string,
): UnsignedManifest["scenario"] {
  const scenario = object(value, "manifest.scenario");
  exactKeys(
    scenario,
    ["id", "source", "public", "projection_sha256"],
    [],
    "manifest.scenario",
  );
  const id = canonicalString(scenario.id, "manifest.scenario.id");
  const publicScenario = parsePublicScenario(scenario.public, id);
  return {
    id,
    source: parseResource(
      scenario.source,
      "manifest.scenario.source",
      kitScenarioUri(modelId, modelVersion, id),
      "application/json",
      "qualified-kit",
    ),
    public: publicScenario,
    projection_sha256: digest(scenario.projection_sha256, "manifest.scenario.projection_sha256"),
  };
}

function parsePublicScenario(value: unknown, id: string): UnsignedManifest["scenario"]["public"] {
  const scenario = object(value, "manifest.scenario.public");
  exactKeys(
    scenario,
    [
      "id",
      "description",
      "start_time_s",
      "stop_time_s",
      "number_of_intervals",
      "solver",
      "target_temperature",
    ],
    [],
    "manifest.scenario.public",
  );
  if (canonicalString(scenario.id, "manifest.scenario.public.id") !== id) {
    throw new ValidationError("manifest scenario public id must equal scenario id.");
  }
  const startTime = finite(scenario.start_time_s, "manifest.scenario.public.start_time_s");
  const stopTime = finite(scenario.stop_time_s, "manifest.scenario.public.stop_time_s");
  if (startTime < 0 || stopTime <= startTime) {
    throw new ValidationError("manifest scenario time bounds are invalid.");
  }
  const intervals = integer(
    scenario.number_of_intervals,
    "manifest.scenario.public.number_of_intervals",
  );
  if (intervals < 1) {
    throw new ValidationError("manifest scenario number_of_intervals must be positive.");
  }
  return {
    id,
    description: canonicalString(scenario.description, "manifest.scenario.public.description"),
    start_time_s: startTime,
    stop_time_s: stopTime,
    number_of_intervals: intervals,
    solver: canonicalString(scenario.solver, "manifest.scenario.public.solver"),
    target_temperature: parseQuantity(
      scenario.target_temperature,
      "manifest.scenario.public.target_temperature",
    ),
  };
}

function parseParameter(value: unknown, index: number): ManifestParameter {
  const label = `manifest.parameters[${index}]`;
  const parameter = object(value, label);
  exactKeys(
    parameter,
    [
      "id",
      "modelica_name",
      "modelica_type",
      "description",
      "unit",
      "minimum",
      "maximum",
      "conversion",
    ],
    [],
    label,
  );
  const minimum = finite(parameter.minimum, `${label}.minimum`);
  const maximum = finite(parameter.maximum, `${label}.maximum`);
  if (minimum > maximum) throw new ValidationError(`${label} has minimum greater than maximum.`);
  const modelicaName = canonicalString(parameter.modelica_name, `${label}.modelica_name`);
  if (!MODELICA_IDENTIFIER.test(modelicaName)) {
    throw new ValidationError(`${label}.modelica_name is not a Modelica identifier.`);
  }
  const unit = canonicalString(parameter.unit, `${label}.unit`);
  const conversion = parseConversion(parameter.conversion, `${label}.conversion`);
  if (conversion.from !== unit) {
    throw new ValidationError(`${label}.conversion.from must equal the public unit.`);
  }
  return {
    id: canonicalString(parameter.id, `${label}.id`),
    modelica_name: modelicaName,
    modelica_type: canonicalString(parameter.modelica_type, `${label}.modelica_type`),
    description: canonicalString(parameter.description, `${label}.description`),
    unit,
    minimum,
    maximum,
    conversion,
  };
}

function parseConversion(value: unknown, label: string): AffineUnitConversion {
  const conversion = object(value, label);
  exactKeys(conversion, ["from", "to", "factor", "offset"], [], label);
  return {
    from: canonicalString(conversion.from, `${label}.from`),
    to: canonicalString(conversion.to, `${label}.to`),
    factor: finite(conversion.factor, `${label}.factor`),
    offset: finite(conversion.offset, `${label}.offset`),
  };
}

function parseMetric(value: unknown, index: number): ProducedMetricDefinition {
  const label = `manifest.produced_metrics[${index}]`;
  const metric = object(value, label);
  exactKeys(metric, ["id", "unit", "description", "required"], [], label);
  if (typeof metric.required !== "boolean") {
    throw new ValidationError(`${label}.required must be a boolean.`);
  }
  return {
    id: canonicalString(metric.id, `${label}.id`),
    unit: canonicalString(metric.unit, `${label}.unit`),
    description: canonicalString(metric.description, `${label}.description`),
    required: metric.required,
  };
}

function parseIdentity(value: unknown, label: string): { id: string; version: string } {
  const identity = object(value, `manifest.${label}`);
  exactKeys(identity, ["id", "version"], [], `manifest.${label}`);
  return {
    id: canonicalString(identity.id, `manifest.${label}.id`),
    version: canonicalString(identity.version, `manifest.${label}.version`),
  };
}

function parseEngine(value: unknown): EngineIdentity {
  const engine = object(value, "manifest.engine");
  exactKeys(engine, ["name", "version", "msl_version"], [], "manifest.engine");
  return {
    name: canonicalString(engine.name, "manifest.engine.name"),
    version: canonicalString(engine.version, "manifest.engine.version"),
    msl_version: canonicalString(engine.msl_version, "manifest.engine.msl_version"),
  };
}

function parseResource(
  value: unknown,
  label: string,
  expectedUri: string,
  expectedMediaType: string,
  expectedQualification: ManifestResource["qualification"],
): ManifestResource {
  const resource = object(value, label);
  exactKeys(resource, ["uri", "mediaType", "bytes", "sha256", "qualification"], [], label);
  if (
    resource.uri !== expectedUri || resource.mediaType !== expectedMediaType ||
    resource.qualification !== expectedQualification
  ) {
    throw new ValidationError(`${label} does not name the expected qualified resource tuple.`);
  }
  return {
    uri: expectedUri,
    mediaType: expectedMediaType,
    bytes: nonNegativeInteger(resource.bytes, `${label}.bytes`),
    sha256: digest(resource.sha256, `${label}.sha256`),
    qualification: expectedQualification,
  };
}

function parseQuantity(value: unknown, label: string): Quantity {
  const quantity = object(value, label);
  exactKeys(quantity, ["value", "unit"], [], label);
  return {
    value: finite(quantity.value, `${label}.value`),
    unit: canonicalString(quantity.unit, `${label}.unit`),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`${label} has unknown field '${key}'.`);
  }
  for (const key of required) {
    if (!(key in value)) throw new ValidationError(`${label} is missing '${key}'.`);
  }
}

function canonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new ValidationError(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ValidationError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} must be a safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const integerValue = integer(value, label);
  if (integerValue < 0) throw new ValidationError(`${label} must be non-negative.`);
  return integerValue;
}

function assertDistinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ValidationError(`${label} must be unique.`);
  }
}
