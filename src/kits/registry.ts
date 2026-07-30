import type { ModelicaKit } from "../domain/types.ts";
import { ValidationError } from "../domain/errors.ts";
import { loadCoffeeMachineKit } from "./coffee-machine.ts";

export class KitRegistry {
  constructor(private readonly kits: readonly ModelicaKit[]) {}

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
}

export async function createDefaultKitRegistry(): Promise<KitRegistry> {
  return new KitRegistry([await loadCoffeeMachineKit()]);
}
