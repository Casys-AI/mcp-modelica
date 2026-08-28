import { assertEquals, assertRejects } from "@std/assert";
import { ResumableSimulationService } from "../src/application/resumable-simulation-service.ts";
import { createModelicaService } from "../src/domain/service.ts";
import { ValidationError } from "../src/domain/errors.ts";
import { KitRegistry } from "../src/kits/registry.ts";
import { loadCoffeeMachineKit } from "../src/kits/coffee-machine.ts";
import { createModelicaKitInputSchemas } from "../src/tools/kit-input-schemas.ts";
import { FileRequestLockPort } from "../src/storage/request-lock.ts";
import { RequestStore } from "../src/storage/request-store.ts";
import { FileSimulationWorkspace } from "../src/storage/simulation-workspace.ts";
import { createModelicaServer } from "../server.ts";
import { SchemaValidator } from "@casys/mcp-server";
import { FakeRunner } from "./test-helpers.ts";

Deno.test("kit-derived schemas snapshot every qualified selection and parameter contract", async () => {
  const service = await createModelicaService({ runner: new FakeRunner() });
  const schemas = createModelicaKitInputSchemas(service.listQualifiedKitsForInputSchema());

  assertEquals(selectionSnapshot(schemas.simulate), [
    {
      model_id: "coffee-machine-v1",
      model_version: undefined,
      scenario_id: "heat-up-nominal",
      parameters: {
        ambient_temperature: {
          type: "number",
          minimum: -10,
          maximum: 50,
          default: 20,
          unit: "degC",
        },
        boiler_heat_capacity: {
          type: "number",
          minimum: 100,
          maximum: 5000,
          default: 500,
          unit: "J/K",
        },
        heat_loss_conductance: {
          type: "number",
          minimum: 0.1,
          maximum: 50,
          default: 5,
          unit: "W/K",
        },
        heater_power: { type: "number", minimum: 500, maximum: 3000, default: 1500, unit: "W" },
        hysteresis: { type: "number", minimum: 0.1, maximum: 20, default: 2, unit: "K" },
        initial_water_temperature: {
          type: "number",
          minimum: 0,
          maximum: 45,
          default: 20,
          unit: "degC",
        },
        setpoint_temperature: {
          type: "number",
          minimum: 70,
          maximum: 110,
          default: 93,
          unit: "degC",
        },
        water_mass: { type: "number", minimum: 0.1, maximum: 3, default: 0.5, unit: "kg" },
      },
      required_parameters: [],
    },
    {
      model_id: "linear-thermal-ramp-v1",
      model_version: undefined,
      scenario_id: "linear-ramp-nominal",
      parameters: {
        heating_rate: { type: "number", minimum: 0.1, maximum: 10, default: 1, unit: "K/s" },
        initial_temperature: {
          type: "number",
          minimum: -50,
          maximum: 100,
          default: 20,
          unit: "degC",
        },
      },
      required_parameters: [],
    },
  ]);
  assertEquals(selectionSnapshot(schemas.submit), [
    {
      model_id: "coffee-machine-v1",
      model_version: "0.1.0",
      scenario_id: "heat-up-nominal",
      parameters: {
        ambient_temperature: {
          type: "number",
          minimum: -10,
          maximum: 50,
          default: 20,
          unit: "degC",
        },
        boiler_heat_capacity: {
          type: "number",
          minimum: 100,
          maximum: 5000,
          default: 500,
          unit: "J/K",
        },
        heat_loss_conductance: {
          type: "number",
          minimum: 0.1,
          maximum: 50,
          default: 5,
          unit: "W/K",
        },
        heater_power: { type: "number", minimum: 500, maximum: 3000, default: 1500, unit: "W" },
        hysteresis: { type: "number", minimum: 0.1, maximum: 20, default: 2, unit: "K" },
        initial_water_temperature: {
          type: "number",
          minimum: 0,
          maximum: 45,
          default: 20,
          unit: "degC",
        },
        setpoint_temperature: {
          type: "number",
          minimum: 70,
          maximum: 110,
          default: 93,
          unit: "degC",
        },
        water_mass: { type: "number", minimum: 0.1, maximum: 3, default: 0.5, unit: "kg" },
      },
      required_parameters: [
        "initial_water_temperature",
        "ambient_temperature",
        "heater_power",
        "water_mass",
        "boiler_heat_capacity",
        "heat_loss_conductance",
        "setpoint_temperature",
        "hysteresis",
      ],
    },
    {
      model_id: "linear-thermal-ramp-v1",
      model_version: "0.1.0",
      scenario_id: "linear-ramp-nominal",
      parameters: {
        heating_rate: { type: "number", minimum: 0.1, maximum: 10, default: 1, unit: "K/s" },
        initial_temperature: {
          type: "number",
          minimum: -50,
          maximum: 100,
          default: 20,
          unit: "degC",
        },
      },
      required_parameters: ["initial_temperature", "heating_rate"],
    },
  ]);
});

Deno.test("derived schemas reject unqualified branches and preserve explicit 2.1 quantities", async () => {
  const service = await createModelicaService({ runner: new FakeRunner() });
  const schemas = createModelicaKitInputSchemas(service.listQualifiedKitsForInputSchema());
  const simulateValidator = validator("modelica_simulate", schemas.simulate);
  assertEquals(
    simulateValidator.validate("modelica_simulate", {
      model_id: "coffee-machine-v1",
      scenario_id: "unqualified-scenario",
    }).valid,
    false,
  );
  assertEquals(
    simulateValidator.validate("modelica_simulate", {
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
      parameter_overrides: { water_mass: { value: 0.5, unit: "lb" } },
    }).valid,
    false,
  );
  assertEquals(
    simulateValidator.validate("modelica_simulate", {
      model_id: "coffee-machine-v1",
      scenario_id: "heat-up-nominal",
      parameter_overrides: { water_mass: { value: 3.1, unit: "kg" } },
    }).valid,
    false,
  );

  const submitValidator = validator("modelica_simulation_submit", schemas.submit);
  const incomplete = {
    request_id: "schema-rejection",
    manifest_sha256: "0".repeat(64),
    model_id: "coffee-machine-v1",
    model_version: "0.1.0",
    scenario_id: "heat-up-nominal",
    parameters: {
      initial_water_temperature: { value: 20, unit: "degC" },
    },
    timeout_ms: 30_000,
  };
  assertEquals(submitValidator.validate("modelica_simulation_submit", incomplete).valid, false);
  assertEquals(
    submitValidator.validate("modelica_simulation_submit", {
      ...incomplete,
      parameters: Object.fromEntries(
        service.listQualifiedKitsForInputSchema()[0].parameters.map((parameter) => [
          parameter.id,
          { unit: parameter.unit },
        ]),
      ),
    }).valid,
    false,
  );
});

Deno.test("MCP startup fails closed when a qualified parameter default is outside its bounds", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-schema-startup-" });
  try {
    const coffee = await loadCoffeeMachineKit();
    const invalid = {
      ...coffee,
      parameters: [{ ...coffee.parameters[0], defaultValue: 999 }],
    };
    const service = await createModelicaService({
      registry: new KitRegistry([invalid]),
      runner: new FakeRunner(),
      runsDirectory: directory,
    });
    await assertRejects(
      () => createModelicaServer({ service, logger: () => {} }),
      ValidationError,
      "incoherent default or bounds",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("resumable schema construction uses the same qualified registry projection", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-schema-resumable-" });
  try {
    const method = await createModelicaService({
      runsDirectory: directory,
      runner: new FakeRunner(),
    });
    const store = new RequestStore(directory);
    const resumable = new ResumableSimulationService(
      method,
      store,
      new FileRequestLockPort(store.locksDirectory),
      new FileSimulationWorkspace(directory, method.getSimulationRunner()),
    );
    assertEquals(
      resumable.listQualifiedKitsForInputSchema().map((kit) => kit.id),
      method.listQualifiedKitsForInputSchema().map((kit) => kit.id),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

function validator(name: string, schema: Record<string, unknown>): SchemaValidator {
  const result = new SchemaValidator();
  result.addSchema(name, schema);
  return result;
}

function selectionSnapshot(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const branches = schema.oneOf as Array<Record<string, unknown>>;
  return branches.map((branch) => {
    const properties = branch.properties as Record<string, Record<string, unknown>>;
    const parameters = properties.parameters ?? properties.parameter_overrides;
    const parameterSchema = parameters as Record<string, unknown> | undefined;
    const parameterProperties =
      parameterSchema?.properties as Record<string, Record<string, unknown>> ?? {};
    const snapshot = Object.fromEntries(
      Object.entries(parameterProperties).sort().map(([id, quantity]) => {
        const value = (quantity.properties as Record<string, Record<string, unknown>>).value;
        const unit = (quantity.properties as Record<string, Record<string, unknown>>).unit;
        return [id, {
          type: value.type,
          minimum: value.minimum,
          maximum: value.maximum,
          default: value["x-modelica-default"],
          unit: unit.const,
        }];
      }),
    );
    return {
      model_id: properties.model_id.const,
      model_version: properties.model_version?.const,
      scenario_id: properties.scenario_id.const,
      parameters: snapshot,
      required_parameters: parameterSchema?.required ?? [],
    };
  });
}
