/// <reference lib="dom" />
import { createMcpApp, defineView } from "@casys/mcp-view";
import type { AppContext } from "@casys/mcp-view";
import {
  type DisplayState,
  errorMessage,
  parseResultsEnvelope,
  type ResultsEnvelope,
  type RunSummary,
  type SimulationRun,
} from "./model.ts";
import { escapeHtml, formatTimestamp, renderRunPanels } from "./render.ts";

interface ResultsViewerState {
  display: DisplayState;
}

const statusView = defineView<ResultsViewerState>({
  render(ctx) {
    const display = ctx.state.display;
    if (display.kind === "loading") {
      return shell(
        "Simulation evidence",
        `<div class="state loading"><span class="spinner" aria-hidden="true"></span><p>Receiving Modelica simulation evidence…</p></div>`,
      );
    }
    if (display.kind === "empty") {
      return shell(
        "Persisted simulation runs",
        emptyState("No persisted simulation runs were returned."),
      );
    }
    if (display.kind === "error") {
      return shell(
        "Simulation evidence",
        `<div class="state error" role="alert"><h2>Unable to display this result</h2><p>${
          escapeHtml(display.message)
        }</p></div>`,
      );
    }
    return shell(
      "Simulation evidence",
      emptyState("No displayable Modelica evidence is available."),
    );
  },
});

const listView = defineView<ResultsViewerState, ResultsEnvelope, RunSummary[]>({
  onEnter(_ctx, envelope) {
    if (envelope.kind !== "run-list") throw new TypeError("Expected a Modelica run-list envelope.");
    return envelope.runs;
  },
  render(ctx, runs) {
    if (runs.length === 0) {
      return shell(
        "Persisted simulation runs",
        emptyState("No persisted simulation runs were returned."),
      );
    }
    queueMicrotask(() => attachRunSelection(ctx));
    const rows = runs.map((run) =>
      `<tr><td><button class="run-link" data-run-id="${escapeHtml(run.run_id)}">${
        escapeHtml(run.run_id)
      }</button></td><td><span class="status status-${run.status}">${
        escapeHtml(run.status)
      }</span></td><td>${escapeHtml(run.model.id)}</td><td>${escapeHtml(run.scenario.id)}</td><td>${
        escapeHtml(formatTimestamp(run.completed_at ?? run.started_at))
      }</td></tr>`
    ).join("");
    return shell(
      "Persisted simulation runs",
      `<p class="lede">${runs.length} immutable run record${
        runs.length === 1 ? "" : "s"
      }, ordered by run identifier.</p>
      <div class="table-wrap"><table><thead><tr><th scope="col">Run</th><th scope="col">Execution</th><th scope="col">Model</th><th scope="col">Scenario</th><th scope="col">Recorded</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
  },
});

type DetailArgs = ResultsEnvelope | { runId: string };
type DetailData = SimulationRun | { error: string };

const detailView = defineView<ResultsViewerState, DetailArgs, DetailData>({
  async onEnter(ctx, args) {
    if (!("runId" in args)) {
      if (args.kind === "run") return args.run;
      throw new TypeError("A run-list cannot be rendered as a run detail.");
    }
    try {
      const result = await ctx.callTool("modelica_run_get", { run_id: args.runId });
      if (result.isError) return { error: errorMessage(result) };
      const envelope = parseResultsEnvelope(result.structuredContent);
      return envelope.kind === "run"
        ? envelope.run
        : { error: "The server returned a run list instead of one run." };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The run could not be retrieved." };
    }
  },
  render(ctx, data) {
    if ("error" in data) {
      return shell(
        "Simulation evidence",
        `<div class="state error" role="alert"><h2>Unable to load run detail</h2><p>${
          escapeHtml(data.error)
        }</p></div>`,
      );
    }
    queueMicrotask(() => attachBackToList(ctx));
    const back = ctx.state.display.kind === "run-list"
      ? `<button class="back" type="button" id="back-to-runs">All runs</button>`
      : "";
    return shell(
      "Simulation evidence",
      `<header class="run-header">${back}<div><p class="eyebrow">${escapeHtml(data.model.id)} / ${
        escapeHtml(data.scenario.id)
      }</p><h2>${escapeHtml(data.run_id)}</h2><p class="run-time">Started ${
        escapeHtml(formatTimestamp(data.started_at))
      } · Completed ${
        escapeHtml(formatTimestamp(data.completed_at))
      }</p></div><span class="status status-${data.status}">${
        escapeHtml(data.status)
      }</span></header>${renderRunPanels(data)}`,
    );
  },
});

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("The results viewer root is missing.");
  await createMcpApp<ResultsViewerState>({
    info: { name: "Modelica Results Viewer", version: "1.0.0" },
    root,
    views: { status: statusView, list: listView, detail: detailView },
    initialView: "status",
    initialState: { display: { kind: "loading" } },
    async onToolInput(_input, app) {
      app.ctx.state.display = { kind: "loading" };
      await app.navigate("status");
    },
    async onToolResult(result, app) {
      if (result.isError) {
        app.ctx.state.display = { kind: "error", message: errorMessage(result) };
        await app.navigate("status");
        return;
      }
      try {
        const envelope = parseResultsEnvelope(result.structuredContent);
        app.ctx.state.display = envelope.kind === "run-list" && envelope.runs.length === 0
          ? { kind: "empty" }
          : envelope;
        await app.navigate(envelope.kind === "run-list" ? "list" : "detail", envelope);
      } catch (error) {
        app.ctx.state.display = {
          kind: "error",
          message: error instanceof Error
            ? error.message
            : "The Modelica result could not be read.",
        };
        await app.navigate("status");
      }
    },
  });
}

function attachRunSelection(ctx: AppContext<ResultsViewerState>): void {
  document.querySelectorAll<HTMLButtonElement>("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const runId = button.dataset.runId;
      if (runId) void ctx.navigate("detail", { runId });
    });
  });
}

function attachBackToList(ctx: AppContext<ResultsViewerState>): void {
  const button = document.getElementById("back-to-runs");
  if (button) {
    button.addEventListener("click", () => {
      const display = ctx.state.display;
      if (display.kind === "run-list") void ctx.navigate("list", display);
    });
  }
}

function shell(title: string, content: string): string {
  return `<section class="instrument" aria-label="Modelica simulation results"><header class="masthead"><div><p class="kicker">MCP / MODELICA</p><h1>${title}</h1></div><span class="readout">EVIDENCE</span></header>${content}</section>`;
}

function emptyState(message: string): string {
  return `<div class="state empty"><h2>No evidence to display</h2><p>${message}</p></div>`;
}

boot().catch((error) => {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML =
      `<section class="instrument"><div class="state error" role="alert"><h1>Viewer unavailable</h1><p>${
        escapeHtml(error instanceof Error ? error.message : "The results viewer could not start.")
      }</p></div></section>`;
  }
  console.error(error);
});
