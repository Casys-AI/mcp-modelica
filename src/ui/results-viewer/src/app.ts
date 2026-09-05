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
import { Badge, Card, PathBar, StateMessage } from "@casys/mcp-view-components/preact/components";
import { type ComponentChildren, createElement, render } from "preact";
import {
  type ActiveWholeView,
  createWholeViewTransitionCoordinator,
  remountActiveWholeView,
} from "./active-whole-view.ts";
import { createAdmittedRunComponentRegistry } from "./admitted-components.tsx";
import {
  isModelicaRecordedAdmittedSessionInput,
  MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
  MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA,
  type ModelicaAdmittedExecutionViewData,
  type ModelicaRecordedAdmittedExecutionSession,
  type ModelicaRecordedAdmittedSessionInput,
  parseModelicaAdmittedExecutionCapture,
  parseModelicaRecordedAdmittedExecutionSession,
} from "./admitted-recorded-session.ts";
import {
  MODELICA_RUN_LIST_PATH_ID,
  modelicaRunListPath,
  recordedSessionStatusPresentation,
} from "./component-catalog.ts";
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
  isModelicaRecordedViewSessionInputForResource,
  loadModelicaRunDetail,
  MODELICA_VIEW_APP_INFO,
  type ModelicaRecordedSessionStatus,
  type ModelicaRecordedViewSession,
  type ModelicaRecordedViewSessionInput,
  modelicaSessionResource,
  parseModelicaRecordedViewSession,
} from "./recorded-session.ts";
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
  admittedData?: ModelicaAdmittedExecutionViewData;
  activeWholeView?: ActiveWholeView<
    Extract<ResultsEnvelope, { kind: "run-list" }>,
    DetailData
  >;
}

type ModelicaViewerSessionInput =
  | ModelicaRecordedViewSessionInput
  | ModelicaRecordedAdmittedSessionInput;

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
        createElement(StateMessage, {
          busy: true,
          title: "Receiving Modelica simulation evidence…",
          tone: "info",
        }),
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
        createElement(StateMessage, {
          title: "Unable to display this result",
          tone: "danger",
        }, display.message),
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
      ctx.state.admittedData = undefined;
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
      ctx.state.admittedData = undefined;
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
        render(recordedState(data.recordedStatus, data.message), target);
        return node;
      }
      if ("error" in data) {
        const { node, target, masthead } = componentShell(
          "Simulation evidence",
          false,
        );
        if (data.runId) addListPathBar(ctx, node, masthead, data.runId);
        render(
          createElement(StateMessage, {
            title: "Unable to load run detail",
            tone: "danger",
          }, data.error),
          target,
        );
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

function createAdmittedView(
  registry: ViewComponentRegistry<ModelicaAdmittedExecutionViewData, ViewerContext>,
) {
  return defineView<
    ResultsViewerState,
    ModelicaAdmittedExecutionViewData,
    ModelicaAdmittedExecutionViewData
  >({
    onEnter(ctx, data) {
      ctx.state.activeWholeView = undefined;
      ctx.state.admittedData = data;
      return data;
    },
    async onLeave() {
      await disposeMountedSurface();
    },
    render(ctx, data) {
      const recorded = data.recordedProvenance !== undefined;
      const presentation = resolveWholeViewSurfacePolicy({
        recorded,
        hostSelectedSurface: false,
        defaultSurface: registry.defaultSurface,
        preferDefaultSurface: true,
      });
      const { node, target } = componentShell(
        "Admitted Modelica execution",
        true,
        recorded,
      );
      scheduleSurfaceMount(target, registry, data, ctx, presentation.surface);
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
  const admittedRegistry = createAdmittedRunComponentRegistry();
  const componentCapabilities = options.resource === "run"
    ? componentCatalogCapabilities(runRegistry)
    : componentCatalogCapabilities(listRegistry);
  const listView = createListView(listRegistry);
  const detailView = createDetailView(runRegistry);
  const admittedView = createAdmittedView(admittedRegistry);
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
      app.ctx.state.admittedData = undefined;
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
  const applyRecordedAdmittedSession = async (
    session: ModelicaRecordedAdmittedExecutionSession,
    app: AppHandle<ResultsViewerState>,
  ): Promise<void> => {
    await wholeViewTransitions.replace(async () => {
      if (options.resource !== "run") {
        throw new TypeError("The Modelica run-list resource does not accept admitted captures.");
      }
      app.ctx.state.recordedSession = undefined;
      viewerRoot.setAttribute("aria-busy", "false");
      if (session.projection.status !== "available") {
        app.ctx.state.admittedData = undefined;
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
      await app.navigate("admitted", session.projection.data);
    });
  };
  const reportRecordedSessionError = async (
    error: unknown,
    app: AppHandle<ResultsViewerState>,
  ): Promise<void> => {
    await wholeViewTransitions.replace(async () => {
      app.ctx.state.recordedSession = undefined;
      app.ctx.state.admittedData = undefined;
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

  const app = await createMcpApp<ResultsViewerState, ModelicaViewerSessionInput>({
    info: MODELICA_VIEW_APP_INFO,
    root,
    views: { status: statusView, list: listView, detail: detailView, admitted: admittedView },
    initialView: "status",
    initialState: { display: { kind: "loading" } },
    capabilities: { experimental: componentCapabilities },
    viewerSession: {
      // Reject foreign shapes and resources synchronously. WebCrypto verifies the fingerprint in
      // onSession before any recorded state or navigation is applied.
      validate: (value): value is ModelicaViewerSessionInput =>
        isModelicaRecordedViewSessionInputForResource(value, options.resource) ||
        (options.resource === "run" && isModelicaRecordedAdmittedSessionInput(value)),
      async onSession(value, _payload, app) {
        try {
          if (value.schemaVersion === MODELICA_RECORDED_ADMITTED_EXECUTION_SESSION_SCHEMA) {
            await applyRecordedAdmittedSession(
              await parseModelicaRecordedAdmittedExecutionSession(value),
              app,
            );
          } else {
            await applyRecordedSession(await parseModelicaRecordedViewSession(value), app);
          }
        } catch (error) {
          await reportRecordedSessionError(error, app);
        }
      },
    },
    async onToolInput(_input, app) {
      await wholeViewTransitions.replace(async () => {
        root.setAttribute("aria-busy", "true");
        app.ctx.state.recordedSession = undefined;
        app.ctx.state.admittedData = undefined;
        app.ctx.state.display = { kind: "loading" };
        await app.navigate("status");
      });
    },
    async onToolResult(result, app) {
      await wholeViewTransitions.replace(async () => {
        root.setAttribute("aria-busy", "false");
        app.ctx.state.recordedSession = undefined;
        app.ctx.state.admittedData = undefined;
        if (result.isError) {
          app.ctx.state.display = { kind: "error", message: errorMessage(result) };
          await app.navigate("status");
          return;
        }
        try {
          if (
            options.resource === "run" &&
            isSchema(result.structuredContent, MODELICA_ADMITTED_EXECUTION_CAPTURE_SCHEMA)
          ) {
            await app.navigate(
              "admitted",
              await parseModelicaAdmittedExecutionCapture(result.structuredContent),
            );
            return;
          }
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
      if (app.ctx.state.admittedData) {
        await app.navigate("admitted", app.ctx.state.admittedData);
        return;
      }
      await remountActiveWholeView(app.ctx.state.activeWholeView, {
        status: () => app.navigate("status"),
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
      root.replaceChildren(
        renderElement(
          createElement(
            Card,
            { className: "modelica-shell" },
            createElement(StateMessage, {
              title: "Viewer unavailable",
              tone: "danger",
            }, error instanceof Error ? error.message : "The results viewer could not start."),
          ),
        ),
      );
    }
    console.error(error);
  });
}

function componentShell(title: string, componentOnly: boolean, recorded = false): {
  node: HTMLElement;
  target: HTMLElement;
  masthead: HTMLElement;
} {
  if (componentOnly) {
    const node = document.createElement("section");
    node.className = "modelica-component-only";
    node.setAttribute("aria-label", "Modelica simulation results");
    const masthead = document.createElement("div");
    masthead.className = "mcp-view-toolbar modelica-component-actions";
    const target = document.createElement("div");
    target.className = "component-surface-host";
    node.append(target);
    return { node, target, masthead };
  }
  const node = renderElement(
    createElement(
      Card,
      {
        actions: createElement(Badge, { tone: "info" }, recorded ? "RECORDED" : "EVIDENCE"),
        className: "modelica-shell",
        eyebrow: "MCP / MODELICA",
        title,
      },
      createElement("div", { class: "component-surface-host" }),
    ),
  );
  node.setAttribute("aria-label", "Modelica simulation results");
  const masthead = node.querySelector(".mcp-view-card-header");
  const target = node.querySelector(".component-surface-host");
  if (!(masthead instanceof HTMLElement) || !(target instanceof HTMLElement)) {
    throw new TypeError("The Modelica shell did not render a masthead and surface host.");
  }
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
      render(
        createElement(StateMessage, {
          title: "Unable to compose components",
          tone: "danger",
        }, error instanceof Error ? error.message : "The component surface failed."),
        target,
      );
    },
  );
}

async function disposeMountedSurface(invalidate = true): Promise<void> {
  disposePathBar();
  await surfaceMounts.dispose(invalidate);
}

function renderElement(vnode: ComponentChildren): HTMLElement {
  const host = document.createElement("div");
  render(vnode, host);
  const element = host.firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Expected a rendered HTML element.");
  }
  return element;
}

function shell(title: string, content: ComponentChildren, badge = "EVIDENCE"): HTMLElement {
  const node = renderElement(
    createElement(
      Card,
      {
        actions: createElement(Badge, { tone: "info" }, badge),
        className: "modelica-shell",
        eyebrow: "MCP / MODELICA",
        title,
      },
      content,
    ),
  );
  node.setAttribute("aria-label", "Modelica simulation results");
  return node;
}

function emptyState(message: string): ComponentChildren {
  return createElement(StateMessage, { title: "No evidence to display" }, message);
}

function recordedState(
  status: ModelicaRecordedSessionStatus,
  message: string,
): ComponentChildren {
  const presentation = recordedSessionStatusPresentation(status);
  return createElement(StateMessage, {
    busy: presentation.busy,
    title: status,
    tone: presentation.tone,
  }, message);
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

function isSchema(
  value: unknown,
  schemaVersion: string,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === schemaVersion;
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
