/** @jsxImportSource preact */
/// <reference lib="dom" />

import type { AppContext } from "@casys/mcp-view";
import { defineComponentRegistry } from "@casys/mcp-view-components";
import type { ViewComponentRegistry } from "@casys/mcp-view-components";
import { definePreactComponent } from "@casys/mcp-view-components/preact";
import {
  ArtifactRow,
  Badge,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementSection,
  InlineCode,
  KeyValueList,
  MetricGrid,
  SemanticElement,
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

/** Metrics beyond this count are collapsed into a compact omitted note. */
const MAX_METRICS_DISPLAYED = 6;

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
        ({ data, context }) => (
          <AdmittedRunSummary data={data} locale={context.hostContext.locale} />
        ),
      ),
    },
    defaultSurface: MODELICA_ADMITTED_RUN_DEFAULT_SURFACE,
  });
}

function AdmittedRunSummary({
  data,
  locale,
}: {
  readonly data: ModelicaAdmittedExecutionViewData;
  readonly locale: string | undefined;
}) {
  const { capture } = data;
  const displayedMetrics = capture.metrics.slice(0, MAX_METRICS_DISPLAYED);
  const omitted = capture.metrics.length - displayedMetrics.length;

  return (
    <SemanticElement
      reference={{
        domain: "simulation",
        kind: "artifact",
        id: data.anchor.id,
        basisFingerprint: data.anchor.fingerprint.digest,
      }}
      density="card"
      ident={
        <ElementIdent
          marker={<Badge tone="neutral">{terminationLabel(capture.receipt.termination)}</Badge>}
          label={capture.modelName}
          detail={`Admitted execution · ${data.anchor.fingerprint.digest.slice(0, 12)}`}
        />
      }
      body={
        <ElementBody>
          <MetricGrid
            items={displayedMetrics.map((metric) => ({
              id: `${metric.outputName}:${metric.statistic}`,
              label: metric.outputName,
              value: formatMetricValue(metric.value, locale),
              unit: metric.unit,
              detail: metric.statistic,
            }))}
          />
          {omitted > 0 && (
            <Facts
              items={[{
                id: "omitted",
                label: "Omitted",
                value: `${omitted} additional metric${omitted === 1 ? "" : "s"}`,
              }]}
            />
          )}
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
        </ElementBody>
      }
      provenance={
        <ElementProvenance
          label={data.recordedProvenance ? "Recorded capture" : "Capture projection"}
          value={<InlineCode>{data.captureFingerprint.digest}</InlineCode>}
        />
      }
    />
  );
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
  locale: string | undefined,
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
  locale: string | undefined,
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
      value: <InlineCode>{capture.sourceSha256.slice(0, 12)}</InlineCode>,
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

/** Solver tolerances are tiny (1e-6): four fraction digits would print them as 0. */
function formatTolerance(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, {
    notation: "scientific",
    maximumSignificantDigits: 3,
  }).format(value);
}

function formatBytes(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale).format(value);
}
