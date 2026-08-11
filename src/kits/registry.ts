import type { ModelicaKit, SimulationResultNormalizer } from "../domain/types.ts";
import { ValidationError } from "../domain/errors.ts";
import { loadCoffeeMachineKit } from "./coffee-machine.ts";
import { loadLinearThermalRampKit } from "./linear-thermal-ramp.ts";

export class KitRegistry {
  private readonly kits: readonly ModelicaKit[];

  constructor(kits: readonly ModelicaKit[]) {
    validateKitContracts(kits);
    this.kits = [...kits];
  }

  list(): readonly ModelicaKit[] {
    return this.kits;
  }

  require(id: string): ModelicaKit {
    const kit = this.kits.find((candidate) => candidate.id === id);
    if (!kit) {
      throw new ValidationError(`Unknown model_id '${id}'. Use modelica_kit_list first.`);
    }
    return kit;
  }

  /** Resolve replay code by the exact immutable identity sealed in a run. */
  resolveResultNormalizer(id: string, version: string): SimulationResultNormalizer {
    const matches = this.kits
      .map((kit) => kit.resultNormalizer)
      .filter((normalizer) => normalizer.id === id && normalizer.version === version);
    if (matches.length !== 1) {
      throw new ValidationError(
        `Unknown or ambiguous result normalizer '${id}@${version}'.`,
      );
    }
    return matches[0];
  }
}

function validateKitContracts(kits: readonly ModelicaKit[]): void {
  const kitIds = new Set<string>();
  const normalizerIdentities = new Set<string>();
  for (const kit of kits) {
    const kitId = canonicalNonEmpty(kit.id, "kit.id");
    if (kitIds.has(kitId)) {
      throw new ValidationError(`Duplicate Modelica kit id '${kitId}'.`);
    }
    kitIds.add(kitId);
    canonicalNonEmpty(kit.resultNormalizer.id, `${kitId}.resultNormalizer.id`);
    canonicalNonEmpty(kit.resultNormalizer.version, `${kitId}.resultNormalizer.version`);
    const normalizerIdentity = `${kit.resultNormalizer.id}\u0000${kit.resultNormalizer.version}`;
    if (normalizerIdentities.has(normalizerIdentity)) {
      throw new ValidationError(
        `Duplicate result normalizer identity '${kit.resultNormalizer.id}@${kit.resultNormalizer.version}'.`,
      );
    }
    normalizerIdentities.add(normalizerIdentity);
    if (typeof kit.resultNormalizer.normalize !== "function") {
      throw new ValidationError(`${kitId}.resultNormalizer.normalize must be a function.`);
    }

    const metricIds = new Set<string>();
    for (const metric of kit.producedMetrics) {
      const metricId = canonicalNonEmpty(metric.id, `${kitId}.producedMetrics.id`);
      if (metricIds.has(metricId)) {
        throw new ValidationError(
          `Modelica kit '${kitId}' declares duplicate produced metric '${metricId}'.`,
        );
      }
      metricIds.add(metricId);
      canonicalNonEmpty(metric.unit, `${kitId}.producedMetrics.${metricId}.unit`);
      canonicalNonEmpty(
        metric.description,
        `${kitId}.producedMetrics.${metricId}.description`,
      );
      if (typeof metric.required !== "boolean") {
        throw new ValidationError(
          `${kitId}.producedMetrics.${metricId}.required must be explicitly boolean.`,
        );
      }
    }
  }
}

function canonicalNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new ValidationError(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

export async function createDefaultKitRegistry(): Promise<KitRegistry> {
  const [coffeeMachine, linearThermalRamp] = await Promise.all([
    loadCoffeeMachineKit(),
    loadLinearThermalRampKit(),
  ]);
  return new KitRegistry([coffeeMachine, linearThermalRamp]);
}
