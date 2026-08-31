/** @jsxImportSource preact */
/// <reference lib="dom" />

import type { AppContext } from "@casys/mcp-view";
import { defineComponentRegistry } from "@casys/mcp-view-components";
import type { ViewComponentRegistry } from "@casys/mcp-view-components";
import { definePreactComponent } from "@casys/mcp-view-components/preact";
import {
  ArtifactRow,
  Badge,
  Card,
  DataTable,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementReading,
  EmptyState,
  KeyValueList,
  Message,
  MetricGrid,
  SemanticElement,
  Stack,
  StateMessage,
} from "@casys/mcp-view-components/preact/components";
import type { ResultsViewerState } from "./app.ts";
import {
  compactRunMetricEntries,
  compactRunWarnings,
  executionStatusTone,
  MODELICA_COMPONENTS,
  MODELICA_RUN_DEFAULT_SURFACE,
  MODELICA_RUN_LIST_DEFAULT_SURFACE,
  modelicaRunReference,
} from "./component-catalog.ts";
import type { RunSummary, SimulationRun } from "./model.ts";
import { formatMetricValue, formatTimestamp } from "./render.ts";

export {
  MODELICA_COMPONENTS,
  MODELICA_RUN_DEFAULT_SURFACE,
  MODELICA_RUN_LIST_DEFAULT_SURFACE,
} from "./component-catalog.ts";

type ViewerContext = AppContext<ResultsViewerState>;

export function createRunComponentRegistry(): ViewComponentRegistry<
  SimulationRun,
  ViewerContext
> {
  return defineComponentRegistry({
    components: {
      [MODELICA_COMPONENTS.runSummary]: definePreactComponent<
        SimulationRun,
        ViewerContext
      >(
        {
          title: "Run",
          description:
            "Compact run identity, factual execution state, bounded readings, and provenance.",
        },
        ({ data }) => <RunSummaryCard run={data} />,
      ),
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
              <Badge tone={executionStatusTone(data.status)}>{data.status}</Badge>
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
                {
                  id: "record-schema",
                  label: "Run record contract",
                  value: data.record_schema_version,
                },
                { id: "fingerprint", label: "Fingerprint", value: <code>{data.fingerprint}</code> },
                {
                  id: "model-source-hash",
                  label: "Model source hash",
                  value: <code>{data.model.source_sha256}</code>,
                },
                ...(data.scenario.source_sha256
                  ? [{
                    id: "scenario-source-hash",
                    label: "Native scenario source hash",
                    value: <code>{data.scenario.source_sha256}</code>,
                  }]
                  : [{
                    id: "scenario-source-hash-unavailable",
                    label: "Native scenario source hash",
                    value: "Not recorded by the 1.0 ledger",
                  }]),
                {
                  id: "scenario-projection-hash",
                  label: "Scenario projection hash",
                  value: <code>{data.scenario.projection_sha256}</code>,
                },
                ...(data.parameter_schema
                  ? [{
                    id: "parameter-schema-source-hash",
                    label: "Compiler parameter-schema hash",
                    value: <code>{data.parameter_schema.source_sha256}</code>,
                  }]
                  : []),
                ...(data.result_normalizer
                  ? [{
                    id: "result-normalizer",
                    label: "Result normalizer",
                    value: `${data.result_normalizer.id} · ${data.result_normalizer.version}`,
                  }]
                  : []),
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
                <Stack gap="sm">
                  {data.artifacts.map((artifact) => (
                    <ArtifactRow
                      key={artifact.uri}
                      kind={artifact.kind}
                      label={artifactLabel(artifact)}
                      uri={artifact.uri}
                      fingerprint={{ algorithm: "SHA-256", digest: artifact.sha256 }}
                      sizeLabel={`${artifact.bytes.toLocaleString()} bytes`}
                    />
                  ))}
                </Stack>
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
    defaultSurface: MODELICA_RUN_DEFAULT_SURFACE,
  });
}

export function createRunListComponentRegistry(): ViewComponentRegistry<
  RunSummary[],
  ViewerContext
> {
  return defineComponentRegistry({
    components: {
      [MODELICA_COMPONENTS.runList]: definePreactComponent<
        RunSummary[],
        ViewerContext
      >(
        {
          title: "Persisted runs",
          description: "Navigable list of immutable Modelica run records.",
        },
        ({ data, context }) => <PersistedRunList runs={data} context={context} />,
      ),
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
              onSelect={(run) => openPersistedRun(context, run)}
              columns={[
                { id: "run", label: "Run", render: (run) => <code>{run.run_id}</code> },
                {
                  id: "execution",
                  label: "Execution",
                  render: (run) => (
                    <Badge tone={executionStatusTone(run.status)}>{run.status}</Badge>
                  ),
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
    defaultSurface: MODELICA_RUN_LIST_DEFAULT_SURFACE,
  });
}

function RunSummaryCard({ run }: { readonly run: SimulationRun }) {
  const compactMetrics = compactRunMetricEntries(run.metrics);
  const compactWarnings = compactRunWarnings(run.warnings);
  const readings = compactMetrics.entries.map(([id, quantity]) => (
    <ElementReading
      key={id}
      label={id}
      value={formatMetricValue(quantity.value)}
      unit={quantity.unit}
    />
  ));
  return (
    <SemanticElement
      reference={modelicaRunReference(run)}
      density="card"
      ident={
        <ElementIdent
          marker={<Badge tone={executionStatusTone(run.status)}>{run.status}</Badge>}
          label={run.run_id}
          detail={`${run.model.id} / ${run.scenario.id}`}
        />
      }
      reading={readings.length ? readings : undefined}
      body={compactWarnings.entries.length || compactMetrics.omitted > 0
        ? (
          <ElementBody>
            <Stack gap="sm">
              {compactMetrics.omitted > 0 && (
                <Message>
                  {`${compactMetrics.omitted} additional metric${
                    compactMetrics.omitted === 1 ? "" : "s"
                  } available in the detailed metrics component.`}
                </Message>
              )}
              {compactWarnings.entries.length > 0 && (
                <Message tone="warning">
                  {`${run.warnings.length} warning${run.warnings.length === 1 ? "" : "s"}`}
                  <ul class="modelica-notes">
                    {compactWarnings.entries.map((note, index) => (
                      <li key={`${index}:${note}`}>{note}</li>
                    ))}
                  </ul>
                  {compactWarnings.omitted > 0 && (
                    <span>
                      {`${compactWarnings.omitted} additional warning${
                        compactWarnings.omitted === 1 ? "" : "s"
                      } available in the detailed warnings component.`}
                    </span>
                  )}
                </Message>
              )}
            </Stack>
          </ElementBody>
        )
        : undefined}
      provenance={
        <ElementProvenance
          label="Fingerprint"
          value={<code>{run.fingerprint}</code>}
        />
      }
    />
  );
}

function PersistedRunList({
  runs,
  context,
}: {
  readonly runs: RunSummary[];
  readonly context: ViewerContext;
}) {
  return (
    <div
      aria-label={`${runs.length} persisted Modelica run${runs.length === 1 ? "" : "s"}`}
      class="modelica-run-list"
    >
      {runs.map((run) => (
        <SemanticElement
          key={run.run_id}
          reference={modelicaRunReference(run)}
          density="row"
          ident={
            <ElementIdent
              marker={<Badge tone={executionStatusTone(run.status)}>{run.status}</Badge>}
              label={run.run_id}
              detail={`${run.model.id} / ${run.scenario.id}`}
            />
          }
          provenance={
            <ElementProvenance
              label="Fingerprint"
              value={run.fingerprint}
            />
          }
          activationLabel={`Open run ${run.run_id}`}
          onActivate={() => openPersistedRun(context, run)}
        />
      ))}
    </div>
  );
}

function openPersistedRun(
  context: ViewerContext,
  run: Pick<RunSummary, "run_id" | "record_schema_version">,
): void {
  void context.navigate("detail", {
    runId: run.run_id,
    recorded: run.record_schema_version === "2.0",
  });
}

function quantities(
  values: SimulationRun["metrics"] | SimulationRun["resolved_parameters"],
) {
  return Object.entries(values).map(([id, quantity]) => ({
    id,
    label: id,
    value: formatMetricValue(quantity.value),
    unit: quantity.unit,
  }));
}

function artifactLabel(artifact: SimulationRun["artifacts"][number]): string {
  const segment = artifact.uri.split("/").filter(Boolean).at(-1);
  return segment ?? artifact.kind;
}
