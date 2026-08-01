/** @jsxImportSource preact */
/// <reference lib="dom" />

import { defineComponentRegistry } from "@casys/mcp-view";
import type { AppContext, ViewComponentRegistry } from "@casys/mcp-view";
import {
  Badge,
  Card,
  DataTable,
  definePreactComponent,
  EmptyState,
  KeyValueList,
  MetricGrid,
  StateMessage,
} from "@casys/mcp-view/preact";
import type { ResultsViewerState } from "./app.ts";
import type { RunSummary, SimulationRun } from "./model.ts";
import { formatTimestamp } from "./render.ts";

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

export function createRunComponentRegistry(): ViewComponentRegistry<
  SimulationRun,
  ViewerContext
> {
  return defineComponentRegistry({
    components: {
      [MODELICA_COMPONENTS.runIdentity]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Run identity",
          description: "Model, scenario, immutable run id, and timestamps.",
        },
        ({ data }) => (
          <Card
            eyebrow={`${data.model.id} / ${data.scenario.id}`}
            title={data.run_id}
          >
            <p class="modelica-run-time">
              Started {formatTimestamp(data.started_at)} · Completed{" "}
              {formatTimestamp(data.completed_at)}
            </p>
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.executionStatus]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Execution status",
          description: "The factual solver execution state.",
        },
        ({ data }) => (
          <Card title="Execution status">
            <div class="mcp-view-row">
              <Badge tone={statusTone(data.status)}>{data.status}</Badge>
              <span class="modelica-muted">Modelica execution</span>
            </div>
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.metrics]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Computed metrics",
          description: "Quantities computed by the approved simulation.",
        },
        ({ data }) => (
          <Card title="Computed metrics">
            <MetricGrid items={quantities(data.metrics)} />
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.parameters]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Resolved parameters",
          description: "Typed parameters used after defaults and overrides.",
        },
        ({ data }) => (
          <Card title="Resolved parameters">
            <MetricGrid items={quantities(data.resolved_parameters)} />
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.provenance]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Provenance",
          description: "Versioned model, scenario, engine, and immutable hashes.",
        },
        ({ data }) => (
          <Card title="Provenance">
            <KeyValueList
              items={[
                { id: "model", label: "Model", value: `${data.model.id} · ${data.model.version}` },
                { id: "scenario", label: "Scenario", value: data.scenario.id },
                {
                  id: "engine",
                  label: "Engine",
                  value: `${data.engine.name} ${data.engine.version}`,
                },
                { id: "msl", label: "Modelica Standard Library", value: data.engine.msl_version },
                { id: "fingerprint", label: "Fingerprint", value: <code>{data.fingerprint}</code> },
                { id: "model-hash", label: "Model hash", value: <code>{data.model.sha256}</code> },
                {
                  id: "scenario-hash",
                  label: "Scenario hash",
                  value: <code>{data.scenario.sha256}</code>,
                },
              ]}
            />
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.artifacts]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Evidence artifacts",
          description: "Bounded immutable artifacts and SHA-256 hashes.",
        },
        ({ data }) => (
          <Card
            title="Evidence artifacts"
            actions={<Badge>{data.artifacts.length}</Badge>}
          >
            {data.artifacts.length
              ? (
                <div class="mcp-view-stack">
                  {data.artifacts.map((artifact) => (
                    <article class="modelica-artifact" key={artifact.uri}>
                      <div class="mcp-view-row modelica-artifact-summary">
                        <Badge tone="info">{artifact.kind}</Badge>
                        <span>{artifact.bytes.toLocaleString()} bytes</span>
                      </div>
                      <code>{artifact.uri}</code>
                      <KeyValueList
                        items={[{
                          id: "sha256",
                          label: "SHA-256",
                          value: <code>{artifact.sha256}</code>,
                        }]}
                      />
                    </article>
                  ))}
                </div>
              )
              : <EmptyState>No artifacts were recorded.</EmptyState>}
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.warnings]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Run notes",
          description: "Warnings emitted by the approved simulation pipeline.",
        },
        ({ data }) =>
          data.warnings.length
            ? (
              <Card title="Run notes">
                <StateMessage
                  tone="warning"
                  title={`${data.warnings.length} warning${data.warnings.length === 1 ? "" : "s"}`}
                >
                  <ul class="modelica-notes">
                    {data.warnings.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                </StateMessage>
              </Card>
            )
            : null,
      ),
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
      [MODELICA_COMPONENTS.runListSummary]: definePreactComponent<
        RunSummary[],
        ViewerContext
      >(
        {
          title: "Run list summary",
          description: "Bounded count of immutable Modelica run records.",
        },
        ({ data }) => (
          <Card title="Persisted simulation runs">
            <p class="modelica-muted">
              {data.length}{" "}
              immutable run record{data.length === 1 ? "" : "s"}, ordered by run identifier.
            </p>
          </Card>
        ),
      ),
      [MODELICA_COMPONENTS.runTable]: definePreactComponent<
        RunSummary[],
        ViewerContext
      >(
        {
          title: "Run table",
          description: "Run identity, execution state, model, scenario, and recorded time.",
        },
        ({ data, context }) => (
          <Card title="Runs">
            <DataTable
              label="Persisted Modelica runs"
              rows={data}
              rowKey={(run) => run.run_id}
              onSelect={(run) => void context.navigate("detail", { runId: run.run_id })}
              columns={[
                { id: "run", label: "Run", render: (run) => <code>{run.run_id}</code> },
                {
                  id: "execution",
                  label: "Execution",
                  render: (run) => <Badge tone={statusTone(run.status)}>{run.status}</Badge>,
                },
                { id: "model", label: "Model", render: (run) => run.model.id },
                { id: "scenario", label: "Scenario", render: (run) => run.scenario.id },
                {
                  id: "recorded",
                  label: "Recorded",
                  render: (run) => formatTimestamp(run.completed_at ?? run.started_at),
                },
              ]}
            />
          </Card>
        ),
      ),
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

function quantities(
  values: SimulationRun["metrics"] | SimulationRun["resolved_parameters"],
) {
  return Object.entries(values).map(([id, quantity]) => ({
    id,
    label: id,
    value: new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
      quantity.value,
    ),
    unit: quantity.unit,
  }));
}

function statusTone(status: SimulationRun["status"] | RunSummary["status"]) {
  return status === "succeeded"
    ? "success" as const
    : status === "timed_out"
    ? "warning" as const
    : "danger" as const;
}
