/// <reference lib="dom" />

import {
  advertisedComponentCatalog,
  createMcpApp,
  defineView,
  mountComponentSurface,
} from "@casys/mcp-view";
import type {
  AppContext,
  ComponentSurface,
  MountedComponentSurface,
  ViewComponentRegistry,
} from "@casys/mcp-view";
import { createRunComponentRegistry, createRunListComponentRegistry } from "./components.ts";
import {
  type DisplayState,
  errorMessage,
  parseResultsEnvelope,
  type ResultsEnvelope,
  type RunSummary,
  type SimulationRun,
} from "./model.ts";
import { escapeHtml } from "./render.ts";

export interface ResultsViewerState {
  display: DisplayState;
}

export interface ResultsViewerOptions {
  /** The resource chooses its truthful standalone default component surface. */
  resource: "run" | "run-list";
}

type ViewerContext = AppContext<ResultsViewerState>;

let mountedSurface: MountedComponentSurface | undefined;
let mountGeneration = 0;

const statusView = defineView<ResultsViewerState>({
  async onLeave() {
    await disposeMountedSurface();
  },
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

function createListView(
  registry: ViewComponentRegistry<RunSummary[], ViewerContext>,
) {
  return defineView<ResultsViewerState, ResultsEnvelope, RunSummary[]>({
    onEnter(_ctx, envelope) {
      if (envelope.kind !== "run-list") {
        throw new TypeError("Expected a Modelica run-list envelope.");
      }
      return envelope.runs;
    },
    async onLeave() {
      await disposeMountedSurface();
    },
    render(ctx, runs) {
      if (runs.length === 0) {
        return shell(
          "Persisted simulation runs",
          emptyState("No persisted simulation runs were returned."),
        );
      }
      const { node, target } = componentShell("Persisted simulation runs");
      scheduleSurfaceMount(target, registry, runs, ctx);
      return node;
    },
  });
}

type DetailArgs = ResultsEnvelope | { runId: string };
type DetailData =
  | { run: SimulationRun; localDrilldown: boolean }
  | { error: string };

function createDetailView(
  registry: ViewComponentRegistry<SimulationRun, ViewerContext>,
) {
  return defineView<ResultsViewerState, DetailArgs, DetailData>({
    async onEnter(ctx, args) {
      if (!("runId" in args)) {
        if (args.kind === "run") return { run: args.run, localDrilldown: false };
        throw new TypeError("A run-list cannot be rendered as a run detail.");
      }
      try {
        const result = await ctx.callTool("modelica_run_get", { run_id: args.runId });
        if (result.isError) return { error: errorMessage(result) };
        const envelope = parseResultsEnvelope(result.structuredContent);
        return envelope.kind === "run"
          ? { run: envelope.run, localDrilldown: true }
          : { error: "The server returned a run list instead of one run." };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "The run could not be retrieved.",
        };
      }
    },
    async onLeave() {
      await disposeMountedSurface();
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
      const { node, target, masthead } = componentShell("Simulation evidence");
      if (ctx.state.display.kind === "run-list") {
        const back = document.createElement("button");
        back.className = "back";
        back.type = "button";
        back.textContent = "All runs";
        back.addEventListener("click", () => {
          const display = ctx.state.display;
          if (display.kind === "run-list") void ctx.navigate("list", display);
        });
        masthead.prepend(back);
      }
      scheduleSurfaceMount(
        target,
        registry,
        data.run,
        ctx,
        data.localDrilldown ? registry.defaultSurface : undefined,
      );
      return node;
    },
  });
}

export async function bootResultsViewer(options: ResultsViewerOptions): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("The results viewer root is missing.");
  const runRegistry = createRunComponentRegistry();
  const listRegistry = createRunListComponentRegistry();
  const componentCatalog = options.resource === "run"
    ? advertisedComponentCatalog(runRegistry)
    : advertisedComponentCatalog(listRegistry);
  const listView = createListView(listRegistry);
  const detailView = createDetailView(runRegistry);

  await createMcpApp<ResultsViewerState>({
    info: { name: "Modelica Results Viewer", version: "1.0.0" },
    root,
    views: { status: statusView, list: listView, detail: detailView },
    initialView: "status",
    initialState: { display: { kind: "loading" } },
    componentCatalog,
    async onToolInput(_input, app) {
      root.setAttribute("aria-busy", "true");
      app.ctx.state.display = { kind: "loading" };
      await app.navigate("status");
    },
    async onToolResult(result, app) {
      root.setAttribute("aria-busy", "false");
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
    async onTeardown() {
      await disposeMountedSurface();
    },
  });
}

export function startResultsViewer(options: ResultsViewerOptions): void {
  bootResultsViewer(options).catch((error) => {
    const root = document.getElementById("root");
    if (root) {
      root.setAttribute("aria-busy", "false");
      root.innerHTML =
        `<section class="instrument"><div class="state error" role="alert"><h1>Viewer unavailable</h1><p>${
          escapeHtml(error instanceof Error ? error.message : "The results viewer could not start.")
        }</p></div></section>`;
    }
    console.error(error);
  });
}

function componentShell(title: string): {
  node: HTMLElement;
  target: HTMLElement;
  masthead: HTMLElement;
} {
  const node = document.createElement("section");
  node.className = "instrument";
  node.setAttribute("aria-label", "Modelica simulation results");
  const masthead = document.createElement("header");
  masthead.className = "masthead";
  masthead.innerHTML = `<div><p class="kicker">MCP / MODELICA</p><h1>${
    escapeHtml(title)
  }</h1></div><span class="readout">EVIDENCE</span>`;
  const target = document.createElement("div");
  target.className = "component-surface-host";
  node.append(masthead, target);
  return { node, target, masthead };
}

function scheduleSurfaceMount<TData>(
  target: HTMLElement,
  registry: ViewComponentRegistry<TData, ViewerContext>,
  data: TData,
  ctx: ViewerContext,
  surface?: ComponentSurface,
): void {
  const generation = ++mountGeneration;
  queueMicrotask(async () => {
    if (generation !== mountGeneration) return;
    try {
      await disposeMountedSurface(false);
      if (generation !== mountGeneration) return;
      mountedSurface = await mountComponentSurface({
        root: target,
        registry,
        data,
        appContext: ctx,
        hostContext: ctx.hostContext,
        ...(surface ? { surface } : {}),
      });
    } catch (error) {
      target.innerHTML =
        `<div class="state error" role="alert"><h2>Unable to compose components</h2><p>${
          escapeHtml(error instanceof Error ? error.message : "The component surface failed.")
        }</p></div>`;
    }
  });
}

async function disposeMountedSurface(invalidate = true): Promise<void> {
  if (invalidate) mountGeneration++;
  const mounted = mountedSurface;
  mountedSurface = undefined;
  await mounted?.dispose();
}

function shell(title: string, content: string): string {
  return `<section class="instrument" aria-label="Modelica simulation results"><header class="masthead"><div><p class="kicker">MCP / MODELICA</p><h1>${title}</h1></div><span class="readout">EVIDENCE</span></header>${content}</section>`;
}

function emptyState(message: string): string {
  return `<div class="state empty"><h2>No evidence to display</h2><p>${message}</p></div>`;
}
