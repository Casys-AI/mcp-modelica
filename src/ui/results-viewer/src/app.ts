/// <reference lib="dom" />

import { createMcpApp, defineView } from "@casys/mcp-view";
import type { AppContext, AppHandle } from "@casys/mcp-view";
import {
  componentCatalogCapabilities,
  installMcpViewTheme,
  mountComponentSurface,
  readSurfaceContext,
} from "@casys/mcp-view-components";
import type {
  ComponentSurface,
  MountedComponentSurface,
  ViewComponentRegistry,
} from "@casys/mcp-view-components";
import { PathBar } from "@casys/mcp-view-components/preact/components";
import { createElement, render } from "preact";
import {
  type ActiveWholeView,
  createWholeViewTransitionCoordinator,
  remountActiveWholeView,
} from "./active-whole-view.ts";
import { MODELICA_RUN_LIST_PATH_ID, modelicaRunListPath } from "./component-catalog.ts";
import { createRunComponentRegistry, createRunListComponentRegistry } from "./components.tsx";
import {
  type DisplayState,
  errorMessage,
  parseResultsEnvelope,
  type ResultsEnvelope,
  type RunSummary,
  type SimulationRun,
} from "./model.ts";
import {
  loadModelicaRunDetail,
  MODELICA_VIEW_APP_INFO,
  type ModelicaRecordedSessionStatus,
  type ModelicaRecordedViewSession,
  modelicaSessionResource,
  parseModelicaRecordedViewSession,
} from "./recorded-session.ts";
import { escapeHtml } from "./render.ts";
import { createLatestSurfaceMountLifecycle } from "./surface-mount-lifecycle.ts";
import { resolveWholeViewSurfacePolicy } from "./whole-view-surface-policy.ts";

type DetailData =
  | { run: SimulationRun; localDrilldown: boolean }
  | { recordedStatus: ModelicaRecordedSessionStatus; message: string; runId: string }
  | { error: string; runId?: string };

type DetailArgs =
  | ResultsEnvelope
  | { runId: string; recorded: boolean }
  | { resolvedDetail: DetailData };

export interface ResultsViewerState {
  display: DisplayState;
  recordedSession?: ModelicaRecordedViewSession;
  activeWholeView?: ActiveWholeView<
    Extract<ResultsEnvelope, { kind: "run-list" }>,
    DetailData
  >;
}

export interface ResultsViewerOptions {
  /** The resource chooses its truthful standalone default component surface. */
  resource: "run" | "run-list";
}

type ViewerContext = AppContext<ResultsViewerState>;

const surfaceMounts = createLatestSurfaceMountLifecycle<MountedComponentSurface>();

const statusView = defineView<ResultsViewerState>({
  onEnter(ctx) {
    ctx.state.activeWholeView = { name: "status" };
  },
  async onLeave() {
    await disposeMountedSurface();
  },
  render(ctx) {
    const display = ctx.state.display;
    if (display.kind === "loading") {
      return shell(
        "Simulation evidence",
        `<div class="mcp-view-state" data-tone="info"><span class="spinner" aria-hidden="true"></span><strong>Receiving Modelica simulation evidence…</strong></div>`,
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
        `<div class="mcp-view-state" data-tone="danger" role="alert"><strong>Unable to display this result</strong><div class="mcp-view-state-detail">${
          escapeHtml(display.message)
        }</div></div>`,
      );
    }
    if (display.kind === "recorded-status") {
      return shell(
        "Recorded simulation projection",
        recordedState(display.status, display.message),
        "RECORDED",
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
    onEnter(ctx, envelope) {
      if (envelope.kind !== "run-list") {
        throw new TypeError("Expected a Modelica run-list envelope.");
      }
      ctx.state.activeWholeView = { name: "list", envelope };
      return envelope.runs;
    },
    async onLeave() {
      await disposeMountedSurface();
    },
    render(ctx, runs) {
      const recorded = ctx.state.recordedSession !== undefined;
      if (runs.length === 0) {
        return shell(
          "Persisted simulation runs",
          emptyState("No persisted simulation runs were returned."),
          recorded ? "RECORDED" : "EVIDENCE",
        );
      }
      const presentation = resolveWholeViewSurfacePolicy({
        recorded,
        hostSelectedSurface: hasRequestedSurface(ctx),
        defaultSurface: registry.defaultSurface,
      });
      const { node, target } = componentShell(
        "Persisted simulation runs",
        presentation.componentOnly,
        recorded,
      );
      scheduleSurfaceMount(target, registry, runs, ctx, presentation.surface);
      return node;
    },
  });
}

function createDetailView(
  registry: ViewComponentRegistry<SimulationRun, ViewerContext>,
) {
  return defineView<ResultsViewerState, DetailArgs, DetailData>({
    async onEnter(ctx, args) {
      const remember = (data: DetailData): DetailData => {
        ctx.state.activeWholeView = { name: "detail", data };
        return data;
      };
      if ("resolvedDetail" in args) return remember(args.resolvedDetail);
      if (!("runId" in args)) {
        if (args.kind === "run") return remember({ run: args.run, localDrilldown: false });
        throw new TypeError("A run-list cannot be rendered as a run detail.");
      }
      // Suspend remounting before the first await. Otherwise a host-context
      // change can capture the previous list while this drill-down is loading
      // and navigate back to it after the detail has resolved.
      ctx.state.activeWholeView = { name: "pending-detail" };
      try {
        const detail = await loadModelicaRunDetail(
          ctx.state.recordedSession,
          args.runId,
          async () => {
            const result = await ctx.callTool(
              args.recorded ? "modelica_run_get_recorded" : "modelica_run_get",
              { run_id: args.runId },
            );
            if (result.isError) throw new Error(errorMessage(result));
            return parseResultsEnvelope(result.structuredContent);
          },
        );
        return remember(
          detail.status === "available" ? { run: detail.result.run, localDrilldown: true } : {
            recordedStatus: detail.status,
            message: "reason" in detail
              ? detail.reason
              : defaultRecordedStatusMessage(detail.status),
            runId: args.runId,
          },
        );
      } catch (error) {
        return remember({
          error: error instanceof Error ? error.message : "The run could not be retrieved.",
          runId: args.runId,
        });
      }
    },
    async onLeave() {
      await disposeMountedSurface();
    },
    render(ctx, data) {
      if ("recordedStatus" in data) {
        const { node, target, masthead } = componentShell(
          "Simulation evidence",
          false,
          true,
        );
        addListPathBar(ctx, node, masthead, data.runId);
        target.innerHTML = recordedState(data.recordedStatus, data.message);
        return node;
      }
      if ("error" in data) {
        const { node, target, masthead } = componentShell(
          "Simulation evidence",
          false,
        );
        if (data.runId) addListPathBar(ctx, node, masthead, data.runId);
        target.innerHTML =
          `<div class="mcp-view-state" data-tone="danger" role="alert"><strong>Unable to load run detail</strong><div class="mcp-view-state-detail">${
            escapeHtml(data.error)
          }</div></div>`;
        return node;
      }
      const recorded = ctx.state.recordedSession !== undefined;
      const presentation = resolveWholeViewSurfacePolicy({
        recorded,
        hostSelectedSurface: hasRequestedSurface(ctx),
        defaultSurface: registry.defaultSurface,
        preferDefaultSurface: data.localDrilldown,
      });
      const { node, target, masthead } = componentShell(
        "Simulation evidence",
        presentation.componentOnly,
        recorded,
      );
      addListPathBar(ctx, node, masthead, data.run.run_id);
      scheduleSurfaceMount(
        target,
        registry,
        data.run,
        ctx,
        presentation.surface,
      );
      return node;
    },
  });
}

export async function bootResultsViewer(options: ResultsViewerOptions): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("The results viewer root is missing.");
  const viewerRoot: HTMLElement = root;
  installMcpViewTheme();
  const runRegistry = createRunComponentRegistry();
  const listRegistry = createRunListComponentRegistry();
  const componentCapabilities = options.resource === "run"
    ? componentCatalogCapabilities(runRegistry)
    : componentCatalogCapabilities(listRegistry);
  const listView = createListView(listRegistry);
  const detailView = createDetailView(runRegistry);
  const wholeViewTransitions = createWholeViewTransitionCoordinator();

  let removeHostContextListener = () => {};
  const applyRecordedSession = async (
    session: ModelicaRecordedViewSession,
    app: AppHandle<ResultsViewerState>,
  ): Promise<void> => {
    await wholeViewTransitions.replace(async () => {
      if (modelicaSessionResource(session) !== options.resource) {
        throw new TypeError(
          `This Modelica resource accepts ${options.resource} sessions only.`,
        );
      }
      app.ctx.state.recordedSession = session;
      viewerRoot.setAttribute("aria-busy", "false");
      if (session.projection.status !== "available") {
        app.ctx.state.display = {
          kind: "recorded-status",
          status: session.projection.status,
          message: "reason" in session.projection
            ? session.projection.reason
            : defaultRecordedStatusMessage(session.projection.status),
        };
        await app.navigate("status");
        return;
      }
      const envelope = session.projection.result;
      app.ctx.state.display = envelope.kind === "run-list" && envelope.runs.length === 0
        ? { kind: "empty" }
        : envelope;
      await app.navigate(envelope.kind === "run-list" ? "list" : "detail", envelope);
    });
  };
  const reportRecordedSessionError = async (
    error: unknown,
    app: AppHandle<ResultsViewerState>,
  ): Promise<void> => {
    await wholeViewTransitions.replace(async () => {
      app.ctx.state.recordedSession = undefined;
      app.ctx.state.display = {
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "The recorded Modelica session could not be read.",
      };
      viewerRoot.setAttribute("aria-busy", "false");
      await app.navigate("status");
    });
  };

  const app = await createMcpApp<ResultsViewerState, unknown>({
    info: MODELICA_VIEW_APP_INFO,
    root,
    views: { status: statusView, list: listView, detail: detailView },
    initialView: "status",
    initialState: { display: { kind: "loading" } },
    capabilities: { experimental: componentCapabilities },
    viewerSession: {
      // The strict projection fingerprint uses asynchronous WebCrypto. Admit the opaque transport
      // payload into the core FIFO, then parse it fully before any state or navigation changes.
      validate: (_value: unknown): _value is unknown => true,
      async onSession(value, _payload, app) {
        try {
          await applyRecordedSession(await parseModelicaRecordedViewSession(value), app);
        } catch (error) {
          await reportRecordedSessionError(error, app);
        }
      },
    },
    async onToolInput(_input, app) {
      await wholeViewTransitions.replace(async () => {
        root.setAttribute("aria-busy", "true");
        app.ctx.state.recordedSession = undefined;
        app.ctx.state.display = { kind: "loading" };
        await app.navigate("status");
      });
    },
    async onToolResult(result, app) {
      await wholeViewTransitions.replace(async () => {
        root.setAttribute("aria-busy", "false");
        app.ctx.state.recordedSession = undefined;
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
      });
    },
    async onTeardown() {
      removeHostContextListener();
      await wholeViewTransitions.replace(() => {});
      await disposeMountedSurface();
    },
  });
  const remountSelectedSurface = () => {
    void wholeViewTransitions.remount(async () => {
      await remountActiveWholeView(app.ctx.state.activeWholeView, {
        list: (envelope) => app.navigate("list", envelope),
        detail: (data) => app.navigate("detail", { resolvedDetail: data }),
      });
    }).catch((error) => console.error("Unable to remount the Modelica surface", error));
  };
  app.ctx.app.addEventListener("hostcontextchanged", remountSelectedSurface);
  removeHostContextListener = () => {
    app.ctx.app.removeEventListener("hostcontextchanged", remountSelectedSurface);
  };
}

export function startResultsViewer(options: ResultsViewerOptions): void {
  bootResultsViewer(options).catch((error) => {
    const root = document.getElementById("root");
    if (root) {
      root.setAttribute("aria-busy", "false");
      root.innerHTML =
        `<section class="mcp-view-card modelica-shell"><div class="mcp-view-state" data-tone="danger" role="alert"><strong>Viewer unavailable</strong><div class="mcp-view-state-detail">${
          escapeHtml(error instanceof Error ? error.message : "The results viewer could not start.")
        }</div></div></section>`;
    }
    console.error(error);
  });
}

function componentShell(title: string, componentOnly: boolean, recorded = false): {
  node: HTMLElement;
  target: HTMLElement;
  masthead: HTMLElement;
} {
  const node = document.createElement("section");
  node.className = componentOnly ? "modelica-component-only" : "mcp-view-card modelica-shell";
  node.setAttribute("aria-label", "Modelica simulation results");
  const masthead = document.createElement(componentOnly ? "div" : "header");
  masthead.className = componentOnly
    ? "mcp-view-toolbar modelica-component-actions"
    : "mcp-view-card-header";
  if (!componentOnly) {
    masthead.innerHTML =
      `<div class="mcp-view-card-heading"><p class="mcp-view-card-eyebrow">MCP / MODELICA</p><h2 class="mcp-view-card-title">${
        escapeHtml(title)
      }</h2></div><div class="mcp-view-card-actions"><span class="mcp-view-badge" data-tone="info">${
        recorded ? "RECORDED" : "EVIDENCE"
      }</span></div>`;
  }
  const target = document.createElement("div");
  target.className = "component-surface-host";
  if (componentOnly) node.append(target);
  else node.append(masthead, target);
  return { node, target, masthead };
}

function hasRequestedSurface(ctx: ViewerContext): boolean {
  const surface = readSurfaceContext(ctx.hostContext);
  return surface?.status === "ready" && surface.surface !== undefined;
}

function scheduleSurfaceMount<TData>(
  target: HTMLElement,
  registry: ViewComponentRegistry<TData, ViewerContext>,
  data: TData,
  ctx: ViewerContext,
  surface?: ComponentSurface,
): void {
  void surfaceMounts.schedule(
    () =>
      mountComponentSurface({
        root: target,
        registry,
        data,
        appContext: ctx,
        hostContext: ctx.hostContext,
        ...(surface ? { surface } : {}),
      }),
    (error) => {
      target.innerHTML =
        `<div class="mcp-view-state" data-tone="danger" role="alert"><strong>Unable to compose components</strong><div class="mcp-view-state-detail">${
          escapeHtml(error instanceof Error ? error.message : "The component surface failed.")
        }</div></div>`;
    },
  );
}

async function disposeMountedSurface(invalidate = true): Promise<void> {
  disposePathBar();
  await surfaceMounts.dispose(invalidate);
}

function shell(title: string, content: string, badge = "EVIDENCE"): string {
  return `<section class="mcp-view-card modelica-shell" aria-label="Modelica simulation results"><header class="mcp-view-card-header"><div class="mcp-view-card-heading"><p class="mcp-view-card-eyebrow">MCP / MODELICA</p><h2 class="mcp-view-card-title">${title}</h2></div><div class="mcp-view-card-actions"><span class="mcp-view-badge" data-tone="info">${badge}</span></div></header>${content}</section>`;
}

function emptyState(message: string): string {
  return `<div class="mcp-view-state"><strong>No evidence to display</strong><div class="mcp-view-state-detail">${message}</div></div>`;
}

function recordedState(status: ModelicaRecordedSessionStatus, message: string): string {
  return `<div class="modelica-recorded-state" data-status="${status}" role="status"><span class="modelica-recorded-state-dot" aria-hidden="true"></span><div><strong><code>${status}</code></strong><div class="mcp-view-state-detail">${
    escapeHtml(message)
  }</div></div></div>`;
}

function defaultRecordedStatusMessage(status: ModelicaRecordedSessionStatus): string {
  switch (status) {
    case "pending":
      return "The recorded simulation projection is pending.";
    case "running":
      return "The recorded simulation projection is running.";
    case "rejected":
      return "The recorded simulation request was rejected.";
    case "recovery_required":
      return "The recorded simulation requires recovery before detail is available.";
    case "unresolved":
      return "The recorded simulation projection is unresolved.";
    case "unavailable":
      return "Recorded simulation detail is unavailable.";
  }
}

let pathBarRoot: HTMLElement | undefined;

function disposePathBar(): void {
  if (!pathBarRoot) return;
  render(null, pathBarRoot);
  pathBarRoot = undefined;
}

function addListPathBar(
  ctx: ViewerContext,
  node: HTMLElement,
  masthead: HTMLElement,
  runId: string,
): void {
  disposePathBar();
  if (ctx.state.display.kind !== "run-list") return;
  const host = document.createElement("div");
  host.className = "modelica-path-bar-host";
  const path = modelicaRunListPath(runId);
  render(
    createElement(PathBar, {
      label: "Run navigation",
      items: path.items,
      currentId: path.currentId,
      onSelect: (id: string) => {
        if (id !== MODELICA_RUN_LIST_PATH_ID) return;
        const display = ctx.state.display;
        if (display.kind === "run-list") void ctx.navigate("list", display);
      },
    }),
    host,
  );
  pathBarRoot = host;
  if (masthead.parentElement === null) {
    masthead.prepend(host);
    node.prepend(masthead);
    return;
  }
  node.insertBefore(host, masthead);
}
