import type { Quantity, SimulationScenario } from "./types.ts";

export interface ExtractedMetrics {
  metrics: Record<string, Quantity>;
  warnings: string[];
}

/**
 * Extract only declared, units-aware observations from an OMC CSV result.
 * A target not reached yields no invented metric: the downstream constraint
 * evaluator sees the missing value as unresolved.
 */
export function extractCoffeeMachineMetrics(
  csv: string,
  scenario: SimulationScenario,
): ExtractedMetrics {
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    throw new Error("OpenModelica result CSV has no data rows.");
  }

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  const required = ["time", "waterTemperatureC", "heaterPowerW"];
  for (const name of required) {
    if (!headers.includes(name)) {
      throw new Error(`OpenModelica result CSV is missing required column '${name}'.`);
    }
  }

  const values = rows.slice(1).map((row, rowIndex) => ({
    time: numeric(row, headers, "time", rowIndex),
    waterTemperatureC: numeric(row, headers, "waterTemperatureC", rowIndex),
    heaterPowerW: numeric(row, headers, "heaterPowerW", rowIndex),
    heaterEnergyJ: headers.includes("heaterEnergyJ")
      ? numeric(row, headers, "heaterEnergyJ", rowIndex)
      : undefined,
  }));

  const maximumTemperature = Math.max(...values.map((value) => value.waterTemperatureC));
  const peakPower = Math.max(...values.map((value) => Math.abs(value.heaterPowerW)));
  const energy = headers.includes("heaterEnergyJ")
    ? values.at(-1)!.heaterEnergyJ!
    : integrateEnergy(values);

  const metrics: Record<string, Quantity> = {
    water_temperature_max: { value: maximumTemperature, unit: "degC" },
    heater_energy: { value: energy, unit: "J" },
    heater_power_peak: { value: peakPower, unit: "W" },
  };
  const warnings: string[] = [];
  const firstAtTarget = values.find(
    (value) => value.waterTemperatureC >= scenario.targetTemperature.value,
  );
  if (firstAtTarget) {
    metrics.time_to_target_temperature = { value: firstAtTarget.time, unit: "s" };
  } else {
    warnings.push(
      `Target ${scenario.targetTemperature.value} ${scenario.targetTemperature.unit} was not reached; ` +
        "time_to_target_temperature is intentionally absent.",
    );
  }
  return { metrics, warnings };
}

function numeric(rows: string[], headers: string[], name: string, rowIndex: number): number {
  const value = Number(rows[headers.indexOf(name)]);
  if (!Number.isFinite(value)) {
    throw new Error(`OpenModelica CSV row ${rowIndex + 2} has no finite '${name}' value.`);
  }
  return value;
}

function integrateEnergy(
  values: Array<{ time: number; heaterPowerW: number }>,
): number {
  return values.slice(1).reduce((energy, current, index) => {
    const previous = values[index];
    return energy +
      (current.time - previous.time) * (current.heaterPowerW + previous.heaterPowerW) / 2;
  }, 0);
}

function parseCsv(source: string): string[][] {
  return source.trim().split(/\r?\n/).map(parseCsvRow);
}

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("OpenModelica CSV contains an unterminated quoted field.");
  values.push(current);
  return values;
}
