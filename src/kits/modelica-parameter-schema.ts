import type { ParameterDefinition } from "../domain/types.ts";
import { sha256 } from "../domain/hashing.ts";
import { convertToModelica } from "../domain/units.ts";

export const MODELICA_PARAMETER_SCHEMA_VERSION = "1";

/** Facts emitted by OpenModelica, not qualified values chosen by this server. */
export interface ModelicaParameterFact {
  name: string;
  modelicaType: string;
  unit: string;
  defaultValue: number;
  description: string;
}

export interface ModelicaParameterSchema {
  schemaVersion: typeof MODELICA_PARAMETER_SCHEMA_VERSION;
  generatedBy: {
    engine: string;
    version: string;
    api: string;
  };
  modelName: string;
  modelSourceSha256: string;
  parameters: readonly ModelicaParameterFact[];
}

/**
 * A parameter can remain inside the Modelica model without becoming an agent
 * override. This declaration is intentionally explicit: it is a reviewed
 * qualification boundary, never an implicit parser exception.
 */
export interface IntentionallyUnqualifiedParameter {
  modelicaName: string;
  modelicaType: string;
  unit: string;
  defaultValue: number;
  reason: string;
}

export class ModelicaParameterSchemaError extends Error {
  constructor(
    readonly code: string,
    readonly context: Record<string, unknown>,
    readonly recovery: string,
  ) {
    super(code);
    this.name = "ModelicaParameterSchemaError";
  }

  toJSON() {
    return { code: this.code, context: this.context, recovery: this.recovery };
  }
}

export function parseModelicaParameterSchema(source: string): ModelicaParameterSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw schemaError(
      "invalid_modelica_parameter_schema_json",
      { message: message(error) },
      "Regenerate the compiler-derived schema with `deno task model-schema:generate`.",
    );
  }

  const schema = record(parsed, "schema");
  const schemaVersion = stringField(schema, "schemaVersion", "schema");
  if (schemaVersion !== MODELICA_PARAMETER_SCHEMA_VERSION) {
    throw schemaError(
      "unsupported_modelica_parameter_schema_version",
      { expected: MODELICA_PARAMETER_SCHEMA_VERSION, received: schemaVersion },
      "Regenerate the schema with the repository's current generator.",
    );
  }

  const generatedBy = record(schema.generatedBy, "schema.generatedBy");
  const parameters = arrayField(schema, "parameters", "schema").map((value, index) => {
    const parameter = record(value, `schema.parameters[${index}]`);
    const defaultValue = parameter.defaultValue;
    if (typeof defaultValue !== "number" || !Number.isFinite(defaultValue)) {
      throw schemaError(
        "invalid_modelica_parameter_schema",
        { field: `schema.parameters[${index}].defaultValue` },
        "Regenerate the compiler-derived schema; Modelica defaults must be finite numbers.",
      );
    }
    return {
      name: stringField(parameter, "name", `schema.parameters[${index}]`),
      modelicaType: stringField(parameter, "modelicaType", `schema.parameters[${index}]`),
      unit: stringField(parameter, "unit", `schema.parameters[${index}]`),
      defaultValue,
      description: stringField(parameter, "description", `schema.parameters[${index}]`, true),
    };
  });

  assertDistinct(
    parameters.map((parameter) => parameter.name),
    "invalid_modelica_parameter_schema",
    "schema parameter names",
  );

  return {
    schemaVersion: MODELICA_PARAMETER_SCHEMA_VERSION,
    generatedBy: {
      engine: stringField(generatedBy, "engine", "schema.generatedBy"),
      version: stringField(generatedBy, "version", "schema.generatedBy"),
      api: stringField(generatedBy, "api", "schema.generatedBy"),
    },
    modelName: stringField(schema, "modelName", "schema"),
    modelSourceSha256: stringField(schema, "modelSourceSha256", "schema"),
    parameters,
  };
}

export async function assertModelicaParameterAgreement(input: {
  modelName: string;
  modelSource: string;
  schema: ModelicaParameterSchema;
  parameters: readonly ParameterDefinition[];
  intentionallyUnqualified: readonly IntentionallyUnqualifiedParameter[];
}): Promise<void> {
  if (input.schema.modelName !== input.modelName) {
    throw schemaError(
      "modelica_parameter_schema_model_name_mismatch",
      { expected: input.modelName, received: input.schema.modelName },
      "Regenerate the schema for the model loaded by this kit.",
    );
  }

  const actualSourceHash = await sha256(input.modelSource);
  if (actualSourceHash !== input.schema.modelSourceSha256) {
    throw schemaError(
      "modelica_parameter_schema_source_hash_mismatch",
      {
        expected: input.schema.modelSourceSha256,
        actual: actualSourceHash,
        modelName: input.modelName,
      },
      "Regenerate the compiler-derived schema after reviewing the Modelica source change.",
    );
  }

  assertDistinct(
    input.parameters.map((parameter) => parameter.modelicaName),
    "modelica_parameter_set_mismatch",
    "public Modelica parameter names",
  );
  assertDistinct(
    input.intentionallyUnqualified.map((parameter) => parameter.modelicaName),
    "modelica_parameter_set_mismatch",
    "intentionally unqualified Modelica parameter names",
  );

  const publicNames = new Set(input.parameters.map((parameter) => parameter.modelicaName));
  const unqualifiedNames = new Set(
    input.intentionallyUnqualified.map((parameter) => parameter.modelicaName),
  );
  const overlap = [...publicNames].filter((name) => unqualifiedNames.has(name));
  if (overlap.length > 0) {
    throw schemaError(
      "modelica_parameter_set_mismatch",
      { overlap },
      "A Modelica parameter must be either public or intentionally unqualified, never both.",
    );
  }
  for (const parameter of input.intentionallyUnqualified) {
    if (parameter.reason.trim().length === 0) {
      throw schemaError(
        "invalid_unqualified_modelica_parameter",
        { modelicaName: parameter.modelicaName },
        "Document why this model capability has no agent-facing qualification.",
      );
    }
  }

  const sourceByName = new Map(
    input.schema.parameters.map((parameter) => [parameter.name, parameter]),
  );
  const declaredNames = new Set([...publicNames, ...unqualifiedNames]);
  const missingFromKit = [...sourceByName.keys()].filter((name) => !declaredNames.has(name)).sort();
  const unknownToModel = [...declaredNames].filter((name) => !sourceByName.has(name)).sort();
  if (missingFromKit.length > 0 || unknownToModel.length > 0) {
    throw schemaError(
      "modelica_parameter_set_mismatch",
      { missingFromKit, unknownToModel, modelName: input.modelName },
      "Reconcile every compiler-derived parameter with a public qualification or an explicit non-exposure decision.",
    );
  }

  for (const parameter of input.parameters) {
    const sourceParameter = sourceByName.get(parameter.modelicaName);
    if (!sourceParameter) {
      // Set equality above makes this unreachable; retaining it keeps this
      // function fail-closed if its validation order changes.
      throw schemaError(
        "modelica_parameter_set_mismatch",
        { modelicaName: parameter.modelicaName },
        "Declare the parameter in the compiler-derived model schema first.",
      );
    }
    assertPublicParameterAgreement(parameter, sourceParameter);
  }
  for (const parameter of input.intentionallyUnqualified) {
    const sourceParameter = sourceByName.get(parameter.modelicaName);
    if (!sourceParameter) {
      throw schemaError(
        "modelica_parameter_set_mismatch",
        { modelicaName: parameter.modelicaName },
        "Declare the parameter in the compiler-derived model schema first.",
      );
    }
    assertUnqualifiedParameterAgreement(parameter, sourceParameter);
  }
}

function assertPublicParameterAgreement(
  parameter: ParameterDefinition,
  sourceParameter: ModelicaParameterFact,
): void {
  if (parameter.modelicaType !== sourceParameter.modelicaType) {
    throw schemaError(
      "modelica_parameter_type_mismatch",
      {
        modelicaName: parameter.modelicaName,
        expected: sourceParameter.modelicaType,
        received: parameter.modelicaType,
      },
      "Update the kit only after reviewing the physical-type change in the Modelica model.",
    );
  }
  if (parameter.conversion.from !== parameter.unit) {
    throw schemaError(
      "invalid_modelica_unit_conversion",
      {
        modelicaName: parameter.modelicaName,
        conversionFrom: parameter.conversion.from,
        publicUnit: parameter.unit,
      },
      "Make the conversion source unit exactly match the public parameter unit.",
    );
  }
  if (parameter.conversion.to !== sourceParameter.unit) {
    throw schemaError(
      "modelica_parameter_unit_mismatch",
      {
        modelicaName: parameter.modelicaName,
        expected: sourceParameter.unit,
        received: parameter.conversion.to,
      },
      "Declare a conversion to the SI unit emitted by OpenModelica.",
    );
  }
  if (
    !Number.isFinite(parameter.conversion.factor) ||
    !Number.isFinite(parameter.conversion.offset) ||
    parameter.conversion.factor === 0
  ) {
    throw schemaError(
      "invalid_modelica_unit_conversion",
      {
        modelicaName: parameter.modelicaName,
        factor: parameter.conversion.factor,
        offset: parameter.conversion.offset,
      },
      "Use finite, explicit affine conversion terms and a non-zero factor.",
    );
  }
  const defaultValue = convertToModelica(parameter.defaultValue, parameter.conversion);
  if (!Object.is(defaultValue, sourceParameter.defaultValue)) {
    throw schemaError(
      "modelica_parameter_default_mismatch",
      {
        modelicaName: parameter.modelicaName,
        expected: sourceParameter.defaultValue,
        received: defaultValue,
      },
      "Update the public default only after reviewing the Modelica default change.",
    );
  }
}

function assertUnqualifiedParameterAgreement(
  parameter: IntentionallyUnqualifiedParameter,
  sourceParameter: ModelicaParameterFact,
): void {
  if (parameter.modelicaType !== sourceParameter.modelicaType) {
    throw schemaError(
      "modelica_parameter_type_mismatch",
      {
        modelicaName: parameter.modelicaName,
        expected: sourceParameter.modelicaType,
        received: parameter.modelicaType,
        visibility: "unqualified",
      },
      "Review the physical-type change before retaining this model-only parameter unqualified.",
    );
  }
  if (parameter.unit !== sourceParameter.unit) {
    throw schemaError(
      "modelica_parameter_unit_mismatch",
      {
        modelicaName: parameter.modelicaName,
        expected: sourceParameter.unit,
        received: parameter.unit,
        visibility: "unqualified",
      },
      "Review the SI-unit change before retaining this model-only parameter unqualified.",
    );
  }
  if (!Object.is(parameter.defaultValue, sourceParameter.defaultValue)) {
    throw schemaError(
      "modelica_parameter_default_mismatch",
      {
        modelicaName: parameter.modelicaName,
        expected: sourceParameter.defaultValue,
        received: parameter.defaultValue,
        visibility: "unqualified",
      },
      "Review the default change before retaining this model-only parameter unqualified.",
    );
  }
}

function assertDistinct(values: readonly string[], code: string, label: string): void {
  const duplicates = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  if (duplicates.length > 0) {
    throw schemaError(
      code,
      { duplicates, label },
      "Each Modelica parameter must be declared exactly once in the kit policy.",
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError(
      "invalid_modelica_parameter_schema",
      { field: label },
      "Regenerate the compiler-derived schema with the repository's generator.",
    );
  }
  return value as Record<string, unknown>;
}

function arrayField(value: Record<string, unknown>, field: string, label: string): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) {
    throw schemaError(
      "invalid_modelica_parameter_schema",
      { field: `${label}.${field}` },
      "Regenerate the compiler-derived schema with the repository's generator.",
    );
  }
  return candidate;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  label: string,
  allowEmpty = false,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || (!allowEmpty && candidate.length === 0)) {
    throw schemaError(
      "invalid_modelica_parameter_schema",
      { field: `${label}.${field}` },
      "Regenerate the compiler-derived schema with the repository's generator.",
    );
  }
  return candidate;
}

function schemaError(
  code: string,
  context: Record<string, unknown>,
  recovery: string,
): ModelicaParameterSchemaError {
  return new ModelicaParameterSchemaError(code, context, recovery);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
