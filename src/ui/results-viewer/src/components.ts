/// <reference lib="dom" />

import {
  defineComponentRegistry,
  defineCustomComponent,
  defineKeyValueComponent,
  defineMetricGridComponent,
  defineStatusComponent,
} from "@casys/mcp-view";
import type { AppContext, ViewComponentRegistry } from "@casys/mcp-view";
import type { ResultsViewerState } from "./app.ts";
import type { RunSummary, SimulationRun } from "./model.ts";
import { escapeHtml, formatTimestamp } from "./render.ts";

export const MODELICA_COMPONENTS = {
  runIdentity: "modelica.run-identity",
  executionStatus: "modelica.execution-status",
  metrics: "modelica.metrics",
  parameters: "modelica.parameters",
  provenance: "modelica.provenance",
  artifacts: "modelica.artifacts",
  warnings: "modelica.warnings",
  runListSummary: "modelica.run-list-summary",
  runTable: "modelica.run-table",
} as const;

type ViewerContext = AppContext<ResultsViewerState>;

export function createRunComponentRegistry(): ViewComponentRegistry<SimulationRun, ViewerContext> {
  return defineComponentRegistry({
    components: {
      [MODELICA_COMPONENTS.runIdentity]: defineCustomComponent({
        title: "Run identity",
        description: "Model, scenario, immutable run id, and timestamps.",
        mount(target, { data }) {
          target.classList.add("run-identity-component");
          target.innerHTML = `<p class="eyebrow">${escapeHtml(data.model.id)} / ${
            escapeHtml(data.scenario.id)
          }</p><h2>${escapeHtml(data.run_id)}</h2><p class="run-time">Started ${
            escapeHtml(formatTimestamp(data.started_at))
          } · Completed ${escapeHtml(formatTimestamp(data.completed_at))}</p>`;
        },
      }),
      [MODELICA_COMPONENTS.executionStatus]: defineStatusComponent({
        title: "Execution status",
        description: "The factual solver execution state.",
        select: (run: SimulationRun) => ({
          label: run.status,
          detail: "Modelica execution",
          tone: run.status === "succeeded"
            ? "success"
            : run.status === "timed_out"
            ? "warning"
            : "danger",
        }),
      }),
      [MODELICA_COMPONENTS.metrics]: defineMetricGridComponent({
        title: "Computed metrics",
        description: "Quantities computed by the approved simulation.",
        select: (run: SimulationRun) =>
          Object.entries(run.metrics).map(([id, quantity]) => ({
            id,
            label: id,
            value: new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
              quantity.value,
            ),
            unit: quantity.unit,
          })),
      }),
      [MODELICA_COMPONENTS.parameters]: defineMetricGridComponent({
        title: "Resolved parameters",
        description: "Typed parameters used by the solver after defaults and overrides.",
        select: (run: SimulationRun) =>
          Object.entries(run.resolved_parameters).map(([id, quantity]) => ({
            id,
            label: id,
            value: new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
              quantity.value,
            ),
            unit: quantity.unit,
          })),
      }),
      [MODELICA_COMPONENTS.provenance]: defineKeyValueComponent({
        title: "Provenance",
        description: "Versioned model, scenario, engine, and immutable hashes.",
        select: (run: SimulationRun) => [
          { key: "model", label: "Model", value: `${run.model.id} · ${run.model.version}` },
          { key: "scenario", label: "Scenario", value: run.scenario.id },
          { key: "engine", label: "Engine", value: `${run.engine.name} ${run.engine.version}` },
          { key: "msl", label: "Modelica Standard Library", value: run.engine.msl_version },
          { key: "fingerprint", label: "Fingerprint", value: run.fingerprint },
          { key: "model-hash", label: "Model hash", value: run.model.sha256 },
          { key: "scenario-hash", label: "Scenario hash", value: run.scenario.sha256 },
        ],
      }),
      [MODELICA_COMPONENTS.artifacts]: defineCustomComponent({
        title: "Evidence artifacts",
        description: "Bounded immutable artifacts and SHA-256 hashes.",
        mount(target, { data }) {
          target.classList.add("panel", "evidence-artifacts");
          const artifacts = data.artifacts.length
            ? `<div class="artifact-list">${
              data.artifacts.map((artifact) =>
                `<article class="artifact"><div><strong>${
                  escapeHtml(artifact.kind)
                }</strong><span>${artifact.bytes.toLocaleString()} bytes</span></div><code title="${
                  escapeHtml(artifact.uri)
                }">${escapeHtml(artifact.uri)}</code><dl><dt>SHA-256</dt><dd><code>${
                  escapeHtml(artifact.sha256)
                }</code></dd></dl></article>`
              ).join("")
            }</div>`
            : `<p class="empty-copy">No artifacts were recorded.</p>`;
          target.innerHTML =
            `<h2>Evidence artifacts <span>${data.artifacts.length}</span></h2>${artifacts}`;
        },
      }),
      [MODELICA_COMPONENTS.warnings]: defineCustomComponent({
        title: "Run notes",
        description: "Warnings emitted by the approved simulation pipeline.",
        mount(target, { data }) {
          target.classList.add("panel", "warnings");
          target.hidden = data.warnings.length === 0;
          target.innerHTML = data.warnings.length
            ? `<h2>Run notes</h2><ul>${
              data.warnings.map((note) => `<li>${escapeHtml(note)}</li>`).join("")
            }</ul>`
            : "";
        },
      }),
    },
    defaultSurface: {
      layout: { type: "stack", gap: "md" },
      components: [
        { id: "identity", component: MODELICA_COMPONENTS.runIdentity },
        { id: "status", component: MODELICA_COMPONENTS.executionStatus },
        { id: "metrics", component: MODELICA_COMPONENTS.metrics },
        { id: "parameters", component: MODELICA_COMPONENTS.parameters },
        { id: "provenance", component: MODELICA_COMPONENTS.provenance },
        { id: "artifacts", component: MODELICA_COMPONENTS.artifacts },
        { id: "warnings", component: MODELICA_COMPONENTS.warnings },
      ],
    },
  });
}

export function createRunListComponentRegistry(): ViewComponentRegistry<
  RunSummary[],
  ViewerContext
> {
  return defineComponentRegistry({
    components: {
      [MODELICA_COMPONENTS.runListSummary]: defineCustomComponent({
        title: "Run list summary",
        description: "Bounded count of immutable Modelica run records.",
        mount(target, { data }) {
          target.classList.add("run-list-summary");
          target.innerHTML = `<p class="lede">${data.length} immutable run record${
            data.length === 1 ? "" : "s"
          }, ordered by run identifier.</p>`;
        },
      }),
      [MODELICA_COMPONENTS.runTable]: defineCustomComponent({
        title: "Run table",
        description: "Run identity, execution state, model, scenario, and recorded time.",
        mount(target, { data, appContext }) {
          target.classList.add("table-wrap");
          const rows = data.map((run) =>
            `<tr><td><button class="run-link" data-run-id="${escapeHtml(run.run_id)}">${
              escapeHtml(run.run_id)
            }</button></td><td><span class="status status-${run.status}">${
              escapeHtml(run.status)
            }</span></td><td>${escapeHtml(run.model.id)}</td><td>${
              escapeHtml(run.scenario.id)
            }</td><td>${escapeHtml(formatTimestamp(run.completed_at ?? run.started_at))}</td></tr>`
          ).join("");
          target.innerHTML =
            `<table><thead><tr><th scope="col">Run</th><th scope="col">Execution</th><th scope="col">Model</th><th scope="col">Scenario</th><th scope="col">Recorded</th></tr></thead><tbody>${rows}</tbody></table>`;
          const buttons = [...target.querySelectorAll<HTMLButtonElement>("[data-run-id]")];
          const handlers = buttons.map((button) => {
            const handler = () => {
              const runId = button.dataset.runId;
              if (runId) void appContext.navigate("detail", { runId });
            };
            button.addEventListener("click", handler);
            return { button, handler };
          });
          return () => {
            for (const { button, handler } of handlers) {
              button.removeEventListener("click", handler);
            }
          };
        },
      }),
    },
    defaultSurface: {
      layout: { type: "stack", gap: "sm" },
      components: [
        { id: "summary", component: MODELICA_COMPONENTS.runListSummary },
        { id: "runs", component: MODELICA_COMPONENTS.runTable },
      ],
    },
  });
}
