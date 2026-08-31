/** Advertised Modelica component keys and App-owned default surfaces. */
export const MODELICA_COMPONENTS = {
  runSummary: "modelica.run-summary",
  runIdentity: "modelica.run-identity",
  executionStatus: "modelica.execution-status",
  metrics: "modelica.metrics",
  parameters: "modelica.parameters",
  provenance: "modelica.provenance",
  artifacts: "modelica.artifacts",
  warnings: "modelica.warnings",
  runList: "modelica.run-list",
  runListSummary: "modelica.run-list-summary",
  runTable: "modelica.run-table",
} as const;

export const MODELICA_RUN_CATALOG = [
  MODELICA_COMPONENTS.runSummary,
  MODELICA_COMPONENTS.runIdentity,
  MODELICA_COMPONENTS.executionStatus,
  MODELICA_COMPONENTS.metrics,
  MODELICA_COMPONENTS.parameters,
  MODELICA_COMPONENTS.provenance,
  MODELICA_COMPONENTS.artifacts,
  MODELICA_COMPONENTS.warnings,
] as const;

export const MODELICA_RUN_LIST_CATALOG = [
  MODELICA_COMPONENTS.runList,
  MODELICA_COMPONENTS.runListSummary,
  MODELICA_COMPONENTS.runTable,
] as const;

/** Standalone/whiteboard run surface: one compact semantic object, not the full catalog. */
export const MODELICA_RUN_DEFAULT_SURFACE = {
  layout: { type: "stack", gap: "sm" },
  components: [
    { id: "run", component: MODELICA_COMPONENTS.runSummary },
  ],
} as const;

/** Standalone/whiteboard run-list surface: one navigable list of persisted runs. */
export const MODELICA_RUN_LIST_DEFAULT_SURFACE = {
  layout: { type: "stack", gap: "sm" },
  components: [
    { id: "runs", component: MODELICA_COMPONENTS.runList },
  ],
} as const;

export const MODELICA_RUN_LIST_PATH_ID = "list";
export const MODELICA_COMPACT_READING_LIMIT = 3;
export const MODELICA_COMPACT_WARNING_LIMIT = 2;

const SHA256_DIGEST = /^[a-f0-9]{64}$/;

function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST.test(value);
}

export function modelicaRunReference(run: { run_id: string; fingerprint: string }): {
  readonly domain: "simulation";
  readonly kind: "run";
  readonly id: string;
  readonly basisFingerprint?: string;
} {
  return {
    domain: "simulation",
    kind: "run",
    id: run.run_id,
    ...(isSha256Digest(run.fingerprint) ? { basisFingerprint: run.fingerprint } : {}),
  };
}

export function modelicaRunListPath(runId: string): {
  readonly items: readonly [{ readonly id: "list"; readonly label: "All runs" }, {
    readonly id: string;
    readonly label: string;
  }];
  readonly currentId: string;
} {
  if (!runId.trim()) throw new TypeError("Run path requires a run id.");
  return {
    items: [
      { id: MODELICA_RUN_LIST_PATH_ID, label: "All runs" },
      { id: runId, label: runId },
    ],
    currentId: runId,
  };
}

export function compactRunMetricEntries<T>(
  metrics: Readonly<Record<string, T>>,
): {
  readonly entries: readonly (readonly [string, T])[];
  readonly omitted: number;
} {
  const all = (Object.entries(metrics) as [string, T][]).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return {
    entries: all.slice(0, MODELICA_COMPACT_READING_LIMIT),
    omitted: Math.max(0, all.length - MODELICA_COMPACT_READING_LIMIT),
  };
}

export function compactRunWarnings(
  warnings: readonly string[],
): {
  readonly entries: readonly string[];
  readonly omitted: number;
} {
  return {
    entries: warnings.slice(0, MODELICA_COMPACT_WARNING_LIMIT),
    omitted: Math.max(0, warnings.length - MODELICA_COMPACT_WARNING_LIMIT),
  };
}

/** Factual solver execution coloring; succeeded is not a pass or proof verdict. */
export function executionStatusTone(
  status: "succeeded" | "failed" | "timed_out",
): "neutral" | "warning" | "danger" {
  if (status === "failed") return "danger";
  if (status === "timed_out") return "warning";
  return "neutral";
}

/**
 * Recorded-session presentation only. Titles remain the literal contract states;
 * busy is reserved for in-flight pending/running projections.
 */
export function recordedSessionStatusPresentation(
  status:
    | "pending"
    | "running"
    | "rejected"
    | "recovery_required"
    | "unavailable"
    | "unresolved",
): { readonly tone: "neutral" | "info" | "warning" | "danger"; readonly busy: boolean } {
  switch (status) {
    case "pending":
    case "running":
      return { tone: "info", busy: true };
    case "rejected":
      return { tone: "danger", busy: false };
    case "recovery_required":
      return { tone: "warning", busy: false };
    case "unavailable":
    case "unresolved":
      return { tone: "neutral", busy: false };
  }
}
