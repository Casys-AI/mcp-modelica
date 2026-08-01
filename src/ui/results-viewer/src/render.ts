import type { Quantity } from "./model.ts";

export function formatQuantity(quantity: Quantity): string {
  return `${
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(quantity.value)
  } ${quantity.unit}`;
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
      date,
    );
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
