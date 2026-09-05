/** @jsxImportSource preact */
/// <reference lib="dom" />

import type { AppContext } from "@casys/mcp-view";
import { defineComponentRegistry } from "@casys/mcp-view-components";
import type { ViewComponentRegistry } from "@casys/mcp-view-components";
import { definePreactComponent } from "@casys/mcp-view-components/preact";
import {
  ArtifactRow,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementSection,
  FocusedView,
  InlineCode,
  KeyValueList,
  MetricGrid,
  SemanticElement,
  StateMessage,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChildren } from "preact";
import type { ResultsViewerState } from "./app.ts";
import type { ModelicaAdmittedExecutionViewData } from "./admitted-recorded-session.ts";
import { MODELICA_ADMITTED_RUN_DEFAULT_SURFACE, MODELICA_COMPONENTS } from "./component-catalog.ts";
import { formatMetricValue } from "./render.ts";

type ViewerContext = AppContext<ResultsViewerState>;

/** Fact item for a two-column facts section; label and value may both be JSX. */
interface Fact {
  readonly id: string;
  readonly label: ComponentChildren;
  readonly value: ComponentChildren;
}

function Facts({ items }: { readonly items: readonly Fact[] }) {
  return <KeyValueList layout="facts" items={items} />;
}

export function createAdmittedRunComponentRegistry(): ViewComponentRegistry<
  ModelicaAdmittedExecutionViewData,
  ViewerContext
> {
  return defineComponentRegistry({
    components: {
      [MODELICA_COMPONENTS.admittedRunSummary]: definePreactComponent<
        ModelicaAdmittedExecutionViewData,
        ViewerContext
      >(
        {
          title: "Admitted Modelica execution",
          description:
            "One bounded documentary execution datasheet with readings, scenario, admission facts, and artifact provenance.",
        },
        ({ data, context }) => <AdmittedRunSummary data={data} hostContext={context.hostContext} />,
      ),
    },
    defaultSurface: MODELICA_ADMITTED_RUN_DEFAULT_SURFACE,
  });
}

function AdmittedRunSummary({
  data,
  hostContext,
}: {
  readonly data: ModelicaAdmittedExecutionViewData;
  readonly hostContext: ViewerContext["hostContext"];
}) {
  const { capture } = data;
  const locale = viewerLocale(hostContext.locale);
  const status = admittedStatus(data);

  return (
    <FocusedView
      className="modelica-admitted-run"
      label="Admitted Modelica execution"
      hostContext={hostContext}
      status={status.tone === "neutral"
        ? undefined
        : (
          <StateMessage title={status.title} tone={status.tone}>
            {status.facts.join(" · ")}
          </StateMessage>
        )}
      primary={
        <SemanticElement
          reference={{
            domain: "simulation",
            kind: "artifact",
            id: data.anchor.id,
            basisFingerprint: data.anchor.fingerprint.digest,
          }}
          density="row"
          ident={
            <ElementIdent
              marker={status.title}
              label={capture.modelName}
              detail={`Admitted execution · ${status.facts[0]}`}
            />
          }
          body={
            <ElementBody>
              <MetricGrid
                items={capture.metrics.map((metric) => ({
                  id: `${metric.outputName}:${metric.statistic}`,
                  label: metric.outputName,
                  value: formatMetricValue(metric.value, locale),
                  unit: metric.unit,
                  detail: metric.statistic,
                }))}
              />
            </ElementBody>
          }
        />
      }
      detailsLabel="Technical details"
      details={
        <ElementBody>
          <ElementSection title="Scenario">
            <Facts items={scenarioFacts(capture.scenario, locale)} />
          </ElementSection>
          {capture.parameters.length > 0 && (
            <ElementSection title="Parameters">
              <Facts items={parameterFacts(capture.parameters, locale)} />
            </ElementSection>
          )}
          <ElementSection title="Admission">
            <Facts items={admissionFacts(capture)} />
          </ElementSection>
          <ElementSection title="Artifacts">
            {capture.receipt.outputs.map((artifact) => (
              <ArtifactRow
                key={artifact.role}
                kind={artifact.role}
                label={`${artifact.basename} · ${artifact.validation} · ${artifact.persistence}`}
                uri={artifact.casUri}
                fingerprint={{ algorithm: "sha256", digest: artifact.sha256 }}
                sizeLabel={`${formatBytes(artifact.byteCount, locale)} B`}
              />
            ))}
          </ElementSection>
          <ElementSection title="Provenance">
            <Facts items={provenanceFacts(data)} />
          </ElementSection>
          <ElementProvenance
            label={data.recordedProvenance ? "Recorded capture" : "Capture projection"}
            value={<InlineCode>{data.captureFingerprint.digest}</InlineCode>}
          />
        </ElementBody>
      }
    />
  );
}

function admittedStatus(data: ModelicaAdmittedExecutionViewData): {
  readonly title: "recorded" | "documentary";
  readonly tone: "neutral" | "warning" | "danger";
  readonly facts: readonly string[];
} {
  const { capture } = data;
  const termination = capture.receipt.termination;
  const abnormalTermination = termination.kind !== "exited" || termination.exitCode !== 0;
  const destructionUnattested = capture.receipt.destruction.status !== "proven";
  return {
    title: data.recordedProvenance ? "recorded" : "documentary",
    tone: abnormalTermination ? "danger" : destructionUnattested ? "warning" : "neutral",
    facts: [
      `Termination: ${terminationLabel(termination)}`,
      ...(capture.receipt.destruction.status === "proven"
        ? []
        : [`Destruction: ${capture.receipt.destruction.status}`]),
    ],
  };
}

function terminationLabel(
  termination: ModelicaAdmittedExecutionViewData["capture"]["receipt"]["termination"],
): string {
  if (termination.kind === "exited") return `exited · ${termination.exitCode}`;
  if (termination.kind === "signaled") return `signaled · ${termination.signal}`;
  return termination.kind;
}

function scenarioFacts(
  scenario: ModelicaAdmittedExecutionViewData["capture"]["scenario"],
  locale: string,
): Fact[] {
  const stopTimeValue = scenario.startTimeS !== 0
    ? `${formatMetricValue(scenario.startTimeS, locale)} – ${
      formatMetricValue(scenario.stopTimeS, locale)
    } s`
    : `${formatMetricValue(scenario.stopTimeS, locale)} s`;
  return [
    { id: "stop-time", label: "Stop time", value: stopTimeValue },
    {
      id: "interval",
      label: "Interval",
      value: `${formatMetricValue(scenario.intervalS, locale)} s`,
    },
    {
      id: "intervals",
      label: "Intervals",
      value: new Intl.NumberFormat(locale).format(scenario.numberOfIntervals),
    },
    { id: "tolerance", label: "Tolerance", value: formatTolerance(scenario.tolerance, locale) },
    { id: "solver", label: "Solver", value: <InlineCode>{scenario.solver}</InlineCode> },
  ];
}

function parameterFacts(
  parameters: ModelicaAdmittedExecutionViewData["capture"]["parameters"],
  locale: string,
): Fact[] {
  return parameters.map((param) => ({
    id: `param-${param.name}`,
    label: <InlineCode>{param.name}</InlineCode>,
    value: param.unit
      ? `${formatMetricValue(param.value, locale)} ${param.unit}`
      : formatMetricValue(param.value, locale),
  }));
}

function admissionFacts(
  capture: ModelicaAdmittedExecutionViewData["capture"],
): Fact[] {
  return [
    {
      id: "source",
      label: "Source",
      value: <InlineCode>{capture.sourceSha256}</InlineCode>,
    },
    {
      id: "compilation",
      label: "Compilation",
      value: capture.admission.compilation.document.status,
    },
    { id: "admission", label: "Admission", value: capture.admission.status },
    { id: "publication", label: "Publication", value: capture.receipt.publication.status },
    { id: "cleanup", label: "Cleanup", value: capture.receipt.destruction.status },
  ];
}

function provenanceFacts(data: ModelicaAdmittedExecutionViewData): Fact[] {
  const { capture } = data;
  return [
    { id: "project", label: "Project", value: <InlineCode>{capture.projectId}</InlineCode> },
    { id: "agent-run", label: "Agent run", value: <InlineCode>{capture.agentRunId}</InlineCode> },
    {
      id: "execution-run",
      label: "Execution run",
      value: <InlineCode>{capture.executionRunId}</InlineCode>,
    },
    {
      id: "operation",
      label: "Operation",
      value: `${capture.operation.id}@${capture.operation.version}`,
    },
    {
      id: "result-anchor",
      label: "Result anchor",
      value: <InlineCode>{data.anchor.uri}</InlineCode>,
    },
  ];
}

/** Solver tolerances are tiny (1e-6): four fraction digits would print them as 0. */
function formatTolerance(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "scientific",
    maximumSignificantDigits: 3,
  }).format(value);
}

function formatBytes(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Numeric facts preserve a valid host locale; bad or absent input is English. */
function viewerLocale(locale: string | undefined): string {
  try {
    return Intl.getCanonicalLocales(locale ?? "")[0] ?? "en";
  } catch {
    return "en";
  }
}
