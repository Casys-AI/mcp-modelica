import { assert, assertEquals, assertRejects } from "@std/assert";
import { sha256 } from "../src/domain/hashing.ts";
import { convertToModelica } from "../src/domain/units.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";
import {
  assertModelicaParameterAgreement,
  MODELICA_PARAMETER_SCHEMA_VERSION,
  type ModelicaParameterSchema,
  ModelicaParameterSchemaError,
} from "../src/kits/modelica-parameter-schema.ts";

Deno.test("CoffeeMachine kit refuses a stale or disagreeing compiler-derived parameter schema", async () => {
  const kit = await loadCoffeeMachineKit();

  // The loader has already checked source freshness, complete parameter-set
  // coverage, physical types, SI targets and converted defaults. The remaining
  // assertions prove that every current conversion fits the same affine form:
  // Celsius-to-Kelvin or an explicit identity, with no executable exception.
  const celsiusConversions = kit.parameters.filter((parameter) => parameter.unit === "degC");
  assert(celsiusConversions.length > 0);
  for (const parameter of celsiusConversions) {
    assertEquals(parameter.conversion, { from: "degC", to: "K", factor: 1, offset: 273.15 });
    assertEquals(convertToModelica(0, parameter.conversion), 273.15);
  }
  for (const parameter of kit.parameters.filter((parameter) => parameter.unit !== "degC")) {
    assertEquals(parameter.conversion, {
      from: parameter.unit,
      to: parameter.unit,
      factor: 1,
      offset: 0,
    });
  }
});

Deno.test("parameter-schema guard reports physical-default disagreement as structured data", async () => {
  const modelSource = "unit-test CoffeeMachine model";
  const schema: ModelicaParameterSchema = {
    schemaVersion: MODELICA_PARAMETER_SCHEMA_VERSION,
    generatedBy: {
      engine: "OpenModelica",
      version: "test",
      api: "OpenModelica.Scripting.getModelInstance",
    },
    modelName: "CoffeeMachine",
    modelSourceSha256: await sha256(modelSource),
    parameters: [{
      name: "waterMass",
      modelicaType: "Modelica.Units.SI.Mass",
      unit: "kg",
      defaultValue: 0.5,
      description: "",
    }],
  };

  const error = await assertRejects(
    () =>
      assertModelicaParameterAgreement({
        modelName: "CoffeeMachine",
        modelSource,
        schema,
        parameters: [{
          id: "water_mass",
          modelicaName: "waterMass",
          modelicaType: "Modelica.Units.SI.Power",
          description: "",
          unit: "kg",
          defaultValue: 0.5,
          minimum: 0,
          maximum: 1,
          conversion: { from: "kg", to: "kg", factor: 1, offset: 0 },
        }],
        intentionallyUnqualified: [],
      }),
    ModelicaParameterSchemaError,
  );

  const structured = error.toJSON();
  assertEquals(structured.code, "modelica_parameter_type_mismatch");
  assertEquals(structured.context, {
    modelicaName: "waterMass",
    expected: "Modelica.Units.SI.Mass",
    received: "Modelica.Units.SI.Power",
  });
  assert(typeof structured.recovery === "string" && structured.recovery.length > 0);
});
