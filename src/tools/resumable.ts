import type { ResumableSimulationService } from "../application/resumable-simulation-service.ts";
import {
  sealedResultSeriesOutputSchema,
  simulationManifestOutputSchema,
  simulationRequestOutputSchema,
  simulationRequestTemplateOutputSchema,
  toSealedResultSeriesResult,
  toSimulationManifestResult,
  toSimulationRequestResult,
  toSimulationRequestTemplateResult,
} from "./resumable-results.ts";
import type { ModelicaTool } from "./types.ts";

const quantitySchema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { type: "number" }, unit: { type: "string", minLength: 1 } },
  required: ["value", "unit"],
};

export function createResumableSimulationTools(
  service: ResumableSimulationService,
): ModelicaTool[] {
  return [
    {
      name: "modelica_simulation_manifest_get",
      description:
        "Re-read and hash a canonical 2.1 manifest for one qualified Modelica model version and scenario. " +
        "The manifest is required before resumable submission.",
      category: "catalog",
      outputSchema: simulationManifestOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          model_id: { type: "string", minLength: 1 },
          model_version: { type: "string", minLength: 1 },
          scenario_id: { type: "string", minLength: 1 },
        },
        required: ["model_id", "model_version", "scenario_id"],
      },
      handler: async (args) => toSimulationManifestResult(await service.getManifest(args)),
    },
    {
      name: "modelica_simulation_request_template_get",
      description:
        "Build one fully explicit 2.1 submit payload from the exact manifest digest most recently " +
        "issued by this server process for the selected model, version, and scenario. It performs " +
        "no additional runtime probe and creates no durable state or simulation.",
      category: "catalog",
      outputSchema: simulationRequestTemplateOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          request_id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          },
          manifest_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          model_id: { type: "string", minLength: 1 },
          model_version: { type: "string", minLength: 1 },
          scenario_id: { type: "string", minLength: 1 },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
        },
        required: ["request_id", "manifest_sha256", "model_id", "model_version", "scenario_id"],
      },
      handler: async (args) =>
        toSimulationRequestTemplateResult(
          await service.getRequestTemplate(args),
        ),
    },
    {
      name: "modelica_simulation_submit",
      description:
        "Durably claim and execute exactly one fully explicit qualified simulation request. " +
        "The same request_id and canonical bytes resolve to the same run; changed bytes are refused.",
      category: "simulation",
      outputSchema: simulationRequestOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          request_id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          },
          manifest_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          model_id: { type: "string", minLength: 1 },
          model_version: { type: "string", minLength: 1 },
          scenario_id: { type: "string", minLength: 1 },
          parameters: { type: "object", additionalProperties: quantitySchema },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
        },
        required: [
          "request_id",
          "manifest_sha256",
          "model_id",
          "model_version",
          "scenario_id",
          "parameters",
          "timeout_ms",
        ],
      },
      handler: async (args) => toSimulationRequestResult(await service.submit(args)),
    },
    {
      name: "modelica_simulation_request_get",
      description:
        "Read and reconcile one 2.1 durable request without running OMC. It reports unstarted claims as " +
        "pending, live owners as running, manifest drift as rejected, sealed evidence as completed, and " +
        "only an owner-lost started claim as recovery_required.",
      category: "simulation",
      outputSchema: simulationRequestOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          request_id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          },
        },
        required: ["request_id"],
      },
      handler: async (args) => toSimulationRequestResult(await service.getRequest(args)),
    },
    {
      name: "modelica_simulation_series_get",
      description:
        "Read a bounded deterministic summary of the exact result.csv sealed by one completed 2.1 " +
        "request. It accepts no path, URI, Modelica source, script, or solver selection.",
      category: "simulation",
      outputSchema: sealedResultSeriesOutputSchema,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          request_id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          },
          max_samples: { type: "integer", minimum: 1, maximum: 128 },
        },
        required: ["request_id"],
      },
      handler: async (args) =>
        toSealedResultSeriesResult(
          await service.getSealedResultSeries(args),
        ),
    },
  ];
}
