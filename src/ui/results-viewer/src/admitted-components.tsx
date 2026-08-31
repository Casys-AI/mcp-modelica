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
  ElementReading,
  InlineCode,
  Message,
  SemanticElement,
  Stack,
} from "@casys/mcp-view-components/preact/components";
import type { ResultsViewerState } from "./app.ts";
import type { ModelicaAdmittedExecutionViewData } from "./admitted-recorded-session.ts";
import { MODELICA_ADMITTED_RUN_DEFAULT_SURFACE, MODELICA_COMPONENTS } from "./component-catalog.ts";
import { formatMetricValue } from "./render.ts";

type ViewerContext = AppContext<ResultsViewerState>;

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
            "One bounded documentary execution object with exact readings and artifact provenance.",
        },
        ({ data }) => <AdmittedRunSummary data={data} />,
      ),
    },
    defaultSurface: MODELICA_ADMITTED_RUN_DEFAULT_SURFACE,
  });
}

function AdmittedRunSummary({ data }: { readonly data: ModelicaAdmittedExecutionViewData }) {
  const { capture } = data;
  const readings = capture.metrics.slice(0, 3);
  const omitted = capture.metrics.length - readings.length;
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
          label={data.anchor.id}
          detail={capture.modelName}
        />
      }
      reading={readings.map((metric) => (
        <ElementReading
          key={`${metric.outputName}:${metric.statistic}`}
          label={`${metric.outputName} · ${metric.statistic}`}
          value={formatMetricValue(metric.value)}
          unit={metric.unit}
        />
      ))}
      body={
        <ElementBody>
          <Stack gap="sm">
            {omitted > 0 && (
              <Message>
                {`${omitted} additional recorded metric${
                  omitted === 1 ? "" : "s"
                } omitted from this compact surface.`}
              </Message>
            )}
            <Message>
              Source <InlineCode>{capture.sourceSha256}</InlineCode>
            </Message>
            <Message>
              Admission: {capture.admission.compilation.document.status} ·{" "}
              {capture.admission.status}
            </Message>
            <Message>Publication: {capture.receipt.publication.status}</Message>
            <Message>Cleanup: {capture.receipt.destruction.status}</Message>
            {capture.receipt.outputs.map((artifact) => (
              <ArtifactRow
                key={artifact.role}
                kind={artifact.role}
                label={`${artifact.basename} · ${artifact.validation} · ${artifact.persistence}`}
                uri={artifact.casUri}
                fingerprint={{ algorithm: "sha256", digest: artifact.sha256 }}
                sizeLabel={`${artifact.byteCount} B`}
              />
            ))}
          </Stack>
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
