import type { ModelicaKit, ParameterDefinition, SimulationScenario } from "../domain/types.ts";

const MODEL_SOURCE = new URL("../../models/LinearThermalRamp.mo", import.meta.url);
const SCENARIO_SOURCE = new URL("../../scenarios/linear-ramp-nominal.json", import.meta.url);

const parameters: readonly ParameterDefinition[] = [
  {
    id: "initial_temperature",
    modelicaName: "initialTemperature",
    modelicaType: "Real",
    description: "Initial value of the conformance ramp.",
    unit: "degC",
    defaultValue: 20,
    minimum: -50,
    maximum: 100,
    conversion: { from: "degC", to: "degC", factor: 1, offset: 0 },
  },
  {
    id: "heating_rate",
    modelicaName: "heatingRate",
    modelicaType: "Real",
    description: "Constant derivative used by the solver-conformance ramp.",
    unit: "K/s",
    defaultValue: 1,
    minimum: 0.1,
    maximum: 10,
    conversion: { from: "K/s", to: "K/s", factor: 1, offset: 0 },
  },
];

export async function loadLinearThermalRampKit(): Promise<ModelicaKit> {
  const [modelSource, scenarioSource] = await Promise.all([
    Deno.readTextFile(MODEL_SOURCE),
    Deno.readTextFile(SCENARIO_SOURCE),
  ]);
  return {
    id: "linear-thermal-ramp-v1",
    version: "0.1.0",
    description:
      "Minimal balanced Modelica ramp for real OMC integration coverage; not a physical thermal oracle.",
    modelName: "LinearThermalRamp",
    modelSource,
    modelSourceUrl: MODEL_SOURCE,
    parameters,
    scenarios: [parseScenario(scenarioSource)],
    producedMetrics: [{
      id: "temperature_final",
      unit: "degC",
      description: "Final solver sample of the ramp output.",
      required: true,
    }],
    resultNormalizer: {
      id: "linear-thermal-ramp-result-normalizer",
      version: "1.0.0",
      normalize(resultCsv) {
        const rows = parseCsv(resultCsv);
        if (rows.length < 2) throw new Error("OpenModelica ramp CSV has no data rows.");
        const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
        const stateIndex = headers.indexOf("temperatureC");
        if (stateIndex < 0) {
          throw new Error("OpenModelica ramp CSV is missing required column 'temperatureC'.");
        }
        const finalValue = Number(rows.at(-1)![stateIndex]);
        if (!Number.isFinite(finalValue)) {
          throw new Error("OpenModelica ramp CSV final temperatureC is not finite.");
        }
        return {
          metrics: { temperature_final: { value: finalValue, unit: "degC" } },
          warnings: [],
        };
      },
    },
  };
}

function parseScenario(source: string): SimulationScenario {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const target = parsed.target_temperature as Record<string, unknown> | undefined;
  if (
    typeof parsed.id !== "string" || typeof parsed.description !== "string" ||
    typeof parsed.start_time_s !== "number" || typeof parsed.stop_time_s !== "number" ||
    typeof parsed.number_of_intervals !== "number" || typeof parsed.solver !== "string" ||
    !target || typeof target.value !== "number" || typeof target.unit !== "string"
  ) {
    throw new Error("LinearThermalRamp scenario has an invalid schema.");
  }
  return {
    id: parsed.id,
    description: parsed.description,
    startTimeS: parsed.start_time_s,
    stopTimeS: parsed.stop_time_s,
    numberOfIntervals: parsed.number_of_intervals,
    solver: parsed.solver,
    targetTemperature: { value: target.value, unit: target.unit },
    source,
    sourceUrl: SCENARIO_SOURCE,
  };
}

function parseCsv(source: string): string[][] {
  return source.trim().split(/\r?\n/).map((line) =>
    line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""))
  );
}
