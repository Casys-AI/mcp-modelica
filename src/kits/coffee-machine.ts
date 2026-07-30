import type { ModelicaKit, ParameterDefinition, SimulationScenario } from "../domain/types.ts";

const MODEL_SOURCE = new URL("../../models/CoffeeMachine.mo", import.meta.url);
const SCENARIO_SOURCE = new URL("../../scenarios/heat-up-nominal.json", import.meta.url);

const parameters: readonly ParameterDefinition[] = [
  {
    id: "initial_water_temperature",
    modelicaName: "initialWaterTemperature",
    description: "Water and boiler temperature at t=0.",
    unit: "degC",
    defaultValue: 20,
    minimum: 0,
    maximum: 45,
    toModelica: (value) => value + 273.15,
  },
  {
    id: "ambient_temperature",
    modelicaName: "ambientTemperature",
    description: "Fixed ambient temperature used by the loss model.",
    unit: "degC",
    defaultValue: 20,
    minimum: -10,
    maximum: 50,
    toModelica: (value) => value + 273.15,
  },
  {
    id: "heater_power",
    modelicaName: "heaterPowerRated",
    description: "Rated electrical-to-thermal heater power.",
    unit: "W",
    defaultValue: 1500,
    minimum: 500,
    maximum: 3000,
    toModelica: (value) => value,
  },
  {
    id: "water_mass",
    modelicaName: "waterMass",
    description: "Water mass represented by the lumped thermal capacity.",
    unit: "kg",
    defaultValue: 0.5,
    minimum: 0.1,
    maximum: 3,
    toModelica: (value) => value,
  },
  {
    id: "boiler_heat_capacity",
    modelicaName: "boilerHeatCapacity",
    description: "Thermal capacity of the boiler hardware.",
    unit: "J/K",
    defaultValue: 500,
    minimum: 100,
    maximum: 5000,
    toModelica: (value) => value,
  },
  {
    id: "heat_loss_conductance",
    modelicaName: "heatLossConductance",
    description: "Lumped thermal conductance from boiler to ambient.",
    unit: "W/K",
    defaultValue: 5,
    minimum: 0.1,
    maximum: 50,
    toModelica: (value) => value,
  },
  {
    id: "setpoint_temperature",
    modelicaName: "setpointTemperature",
    description: "Thermostat centre setpoint.",
    unit: "degC",
    defaultValue: 93,
    minimum: 70,
    maximum: 110,
    toModelica: (value) => value + 273.15,
  },
  {
    id: "hysteresis",
    modelicaName: "hysteresis",
    description: "Total thermostat hysteresis band.",
    unit: "K",
    defaultValue: 2,
    minimum: 0.1,
    maximum: 20,
    toModelica: (value) => value,
  },
];

export async function loadCoffeeMachineKit(): Promise<ModelicaKit> {
  const [modelSource, scenarioSource] = await Promise.all([
    Deno.readTextFile(MODEL_SOURCE),
    Deno.readTextFile(SCENARIO_SOURCE),
  ]);
  const scenario = parseScenario(scenarioSource);
  return {
    id: "coffee-machine-v1",
    version: "0.1.0",
    description: "Lumped boiler/water electro-thermal model with losses and thermostat hysteresis.",
    modelName: "CoffeeMachine",
    modelSource,
    parameters,
    scenarios: [scenario],
  };
}

function parseScenario(source: string): SimulationScenario {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const target = parsed.target_temperature as Record<string, unknown> | undefined;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.start_time_s !== "number" ||
    typeof parsed.stop_time_s !== "number" ||
    typeof parsed.number_of_intervals !== "number" ||
    typeof parsed.solver !== "string" ||
    !target ||
    typeof target.value !== "number" ||
    typeof target.unit !== "string"
  ) {
    throw new Error("CoffeeMachine scenario has an invalid schema.");
  }
  return {
    id: parsed.id,
    description: parsed.description,
    startTimeS: parsed.start_time_s,
    stopTimeS: parsed.stop_time_s,
    numberOfIntervals: parsed.number_of_intervals,
    solver: parsed.solver,
    targetTemperature: { value: target.value, unit: target.unit },
  };
}
