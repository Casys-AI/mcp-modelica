import { fromFileUrl } from "@std/path";
import { sha256, stableJson } from "../src/domain/hashing.ts";
import {
  MODELICA_PARAMETER_SCHEMA_VERSION,
  type ModelicaParameterFact,
  type ModelicaParameterSchema,
  ModelicaParameterSchemaError,
} from "../src/kits/modelica-parameter-schema.ts";

const MODEL_NAME = "CoffeeMachine";
const MODEL_SOURCE = new URL("../models/CoffeeMachine.mo", import.meta.url);
const OUTPUT = new URL("../models/CoffeeMachine.parameters.json", import.meta.url);
const decoder = new TextDecoder();

// This explicit table is a supported Modelica subset, not a fallback. A new
// physical type must be reviewed before it can enter a public kit schema.
const SI_TYPE_UNITS: Readonly<Record<string, string>> = {
  "Modelica.Units.SI.Mass": "kg",
  "Modelica.Units.SI.SpecificHeatCapacity": "J/(kg.K)",
  "Modelica.Units.SI.HeatCapacity": "J/K",
  "Modelica.Units.SI.Temperature": "K",
  "Modelica.Units.SI.Power": "W",
  "Modelica.Units.SI.ThermalConductance": "W/K",
  "Modelica.Units.SI.TemperatureDifference": "K",
};

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(JSON.stringify(toMachineReadableError(error)));
    Deno.exitCode = 1;
  }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw failure(
      "invalid_modelica_parameter_schema_command",
      { arguments: args },
      "Use no argument to generate the schema, or `--check` to verify it without writing.",
    );
  }
  const check = args[0] === "--check";
  const modelSource = await Deno.readTextFile(MODEL_SOURCE);
  const compilerInstance = await getModelInstance(fromFileUrl(MODEL_SOURCE));
  const schema: ModelicaParameterSchema = {
    schemaVersion: MODELICA_PARAMETER_SCHEMA_VERSION,
    generatedBy: {
      engine: "OpenModelica",
      version: await openModelicaVersion(),
      api: "OpenModelica.Scripting.getModelInstance",
    },
    modelName: MODEL_NAME,
    modelSourceSha256: await sha256(modelSource),
    parameters: extractParameters(compilerInstance),
  };
  const rendered = stableJson(schema);
  if (check) {
    const current = await readCurrentSchema();
    if (current !== rendered) {
      throw failure(
        "modelica_parameter_schema_stale",
        { output: fromFileUrl(OUTPUT), model: fromFileUrl(MODEL_SOURCE) },
        "Review the compiler-derived change, then run `deno task model-schema:generate`.",
      );
    }
    return;
  }
  await Deno.writeTextFile(OUTPUT, rendered);
}

async function getModelInstance(modelPath: string): Promise<unknown> {
  const start = `__MCP_MODELICA_SCHEMA_BEGIN_${crypto.randomUUID()}__`;
  const end = `__MCP_MODELICA_SCHEMA_END_${crypto.randomUUID()}__`;
  const script = [
    `loadFile(${modelicaString(modelPath)});`,
    `print(${modelicaString(start)});`,
    `print(OpenModelica.Scripting.getModelInstance(${MODEL_NAME}));`,
    `print(${modelicaString(end)});`,
  ].join("\n");
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("omc", {
      args: ["--cmd", script],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    throw failure(
      "openmodelica_introspection_unavailable",
      { command: "omc", message: message(error) },
      "Run this task in the pinned Modelica container, where OpenModelica is installed.",
    );
  }
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  if (!output.success) {
    throw failure(
      "openmodelica_introspection_failed",
      { command: "omc", stdout, stderr },
      "Fix the Modelica source or the pinned OpenModelica environment before regenerating the schema.",
    );
  }
  const payload = delimitedPayload(stdout, start, end);
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw failure(
      "openmodelica_introspection_invalid_json",
      { message: message(error), stderr },
      "Use an OpenModelica version that supports getModelInstance JSON output.",
    );
  }
}

async function openModelicaVersion(): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("omc", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    })
      .output();
  } catch (error) {
    throw failure(
      "openmodelica_introspection_unavailable",
      { command: "omc --version", message: message(error) },
      "Run this task in the pinned Modelica container, where OpenModelica is installed.",
    );
  }
  const stdout = decoder.decode(output.stdout).trim();
  if (!output.success || !/^OpenModelica \d+(?:\.\d+)+$/.test(stdout)) {
    throw failure(
      "openmodelica_version_unreadable",
      { stdout, stderr: decoder.decode(output.stderr).trim() },
      "Use the pinned OpenModelica image declared by the Dockerfile.",
    );
  }
  return stdout.slice("OpenModelica ".length);
}

function extractParameters(instance: unknown): ModelicaParameterFact[] {
  const model = record(instance, "OpenModelica model instance");
  if (model.name !== MODEL_NAME) {
    throw failure(
      "openmodelica_introspection_model_mismatch",
      { expected: MODEL_NAME, received: model.name },
      "Verify that the generator points at the same Modelica class as the kit.",
    );
  }
  const elements = array(model.elements, "OpenModelica model instance.elements");
  const parameters: ModelicaParameterFact[] = [];
  for (const [index, element] of elements.entries()) {
    const component = record(element, `OpenModelica model instance.elements[${index}]`);
    if (component.$kind !== "component") continue;
    if (component.prefixes === undefined) continue;
    const prefixes = record(
      component.prefixes,
      `OpenModelica model instance.elements[${index}].prefixes`,
    );
    if (prefixes.variability !== "parameter") continue;

    const name = nonEmptyString(component.name, `OpenModelica parameter[${index}].name`);
    const modelicaType = typeName(component.type, `OpenModelica parameter '${name}'.type`);
    const unit = SI_TYPE_UNITS[modelicaType];
    if (unit === undefined) {
      throw failure(
        "unsupported_modelica_physical_type",
        { name, modelicaType },
        "Add an explicit reviewed SI type-to-unit mapping before exposing this physical parameter.",
      );
    }
    const value = record(component.value, `OpenModelica parameter '${name}'.value`);
    if (typeof value.binding !== "number" || !Number.isFinite(value.binding)) {
      throw failure(
        "unsupported_modelica_parameter_default",
        { name, binding: value.binding },
        "Use a finite numeric Modelica parameter default before generating a bounded kit schema.",
      );
    }
    parameters.push({
      name,
      modelicaType,
      unit,
      defaultValue: value.binding,
      description: typeof component.comment === "string" ? component.comment : "",
    });
  }
  if (parameters.length === 0) {
    throw failure(
      "openmodelica_introspection_no_parameters",
      { modelName: MODEL_NAME },
      "Declare Modelica parameters with finite numeric defaults before generating the schema.",
    );
  }
  const names = parameters.map((parameter) => parameter.name);
  if (new Set(names).size !== names.length) {
    throw failure(
      "openmodelica_introspection_duplicate_parameters",
      { names },
      "Use unique Modelica parameter names.",
    );
  }
  return parameters;
}

async function readCurrentSchema(): Promise<string> {
  try {
    return await Deno.readTextFile(OUTPUT);
  } catch (error) {
    throw failure(
      "modelica_parameter_schema_missing",
      { output: fromFileUrl(OUTPUT), message: message(error) },
      "Generate the compiler-derived schema before running the check.",
    );
  }
}

function delimitedPayload(stdout: string, start: string, end: string): string {
  const normalized = stdout.replaceAll("\r\n", "\n");
  const startIndex = normalized.indexOf(start);
  const endIndex = normalized.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw failure(
      "openmodelica_introspection_missing_payload",
      { stdout },
      "Use an OpenModelica version that supports getModelInstance JSON output.",
    );
  }
  const payload = normalized.slice(startIndex + start.length, endIndex).trim();
  if (payload.length === 0) {
    throw failure(
      "openmodelica_introspection_empty_payload",
      {},
      "Fix the Modelica class so OpenModelica can instantiate it for metadata inspection.",
    );
  }
  return payload;
}

function modelicaString(value: string): string {
  return JSON.stringify(value);
}

function typeName(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  return nonEmptyString(record(value, label).name, `${label}.name`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw failure(
      "openmodelica_introspection_invalid_shape",
      { field: label },
      "Use the pinned OpenModelica JSON model-instance API.",
    );
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw failure(
      "openmodelica_introspection_invalid_shape",
      { field: label },
      "Use the pinned OpenModelica JSON model-instance API.",
    );
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw failure(
      "openmodelica_introspection_invalid_shape",
      { field: label },
      "Use the pinned OpenModelica JSON model-instance API.",
    );
  }
  return value;
}

function failure(
  code: string,
  context: Record<string, unknown>,
  recovery: string,
): ModelicaParameterSchemaError {
  return new ModelicaParameterSchemaError(code, context, recovery);
}

function toMachineReadableError(error: unknown): Record<string, unknown> {
  if (error instanceof ModelicaParameterSchemaError) return error.toJSON();
  return {
    code: "modelica_parameter_schema_unexpected_failure",
    context: { message: message(error) },
    recovery: "Inspect the underlying error before retrying the schema operation.",
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
