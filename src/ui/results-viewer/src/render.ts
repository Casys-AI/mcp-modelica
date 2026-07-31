import type { Quantity, SimulationRun } from "./model.ts";

export function renderRunPanels(run: SimulationRun): string {
  return [
    renderQuantitySection("Computed metrics", run.metrics, "No computed metrics were recorded."),
    renderQuantitySection(
      "Resolved parameters",
      run.resolved_parameters,
      "No resolved parameters were recorded.",
    ),
    `<section class="panel provenance"><h2>Provenance</h2><dl class="fact-grid">
      ${fact("Model", `${run.model.id} · ${run.model.version}`)}
      ${fact("Scenario", run.scenario.id)}
      ${fact("Engine", `${run.engine.name} ${run.engine.version}`)}
      ${fact("Modelica Standard Library", run.engine.msl_version)}
      ${codeFact("Fingerprint", run.fingerprint)}
      ${codeFact("Model hash", run.model.sha256)}
      ${codeFact("Scenario hash", run.scenario.sha256)}
    </dl></section>`,
    renderArtifacts(run),
    run.warnings.length
      ? `<section class="panel warnings"><h2>Run notes</h2><ul>${
        run.warnings.map((note) => `<li>${escapeHtml(note)}</li>`).join("")
      }</ul></section>`
      : "",
  ].join("");
}

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
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
    )[character]!);
}

function renderQuantitySection(
  title: string,
  quantities: Record<string, Quantity>,
  emptyMessage: string,
): string {
  const entries = Object.entries(quantities);
  return `<section class="panel"><h2>${title}</h2>${
    entries.length
      ? `<dl class="quantity-grid">${
        entries.map(([name, quantity]) =>
          `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(formatQuantity(quantity))}</dd></div>`
        ).join("")
      }</dl>`
      : `<p class="empty-copy">${emptyMessage}</p>`
  }</section>`;
}

function renderArtifacts(run: SimulationRun): string {
  return `<section class="panel"><h2>Evidence artifacts <span>${run.artifacts.length}</span></h2>${
    run.artifacts.length
      ? `<div class="artifact-list">${
        run.artifacts.map((artifact) =>
          `<article class="artifact"><div><strong>${
            escapeHtml(artifact.kind)
          }</strong><span>${artifact.bytes.toLocaleString()} bytes</span></div><code title="${
            escapeHtml(artifact.uri)
          }">${escapeHtml(artifact.uri)}</code><dl><dt>SHA-256</dt><dd><code>${
            escapeHtml(artifact.sha256)
          }</code></dd></dl></article>`
        ).join("")
      }</div>`
      : `<p class="empty-copy">No artifacts were recorded.</p>`
  }</section>`;
}

function fact(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function codeFact(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${code(value)}</dd></div>`;
}

function code(value: string): string {
  return `<code title="${escapeHtml(value)}">${escapeHtml(value)}</code>`;
}
