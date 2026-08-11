import type { AffineUnitConversion } from "./types.ts";

/**
 * Applies a declared conversion without guessing missing scale or offset
 * values. Kit loading validates descriptors before a caller can use one.
 */
export function convertToModelica(value: number, conversion: AffineUnitConversion): number {
  const converted = value * conversion.factor + conversion.offset;
  if (!Number.isFinite(converted)) {
    throw new TypeError("A declared Modelica unit conversion produced a non-finite value.");
  }
  return Object.is(converted, -0) ? 0 : converted;
}
