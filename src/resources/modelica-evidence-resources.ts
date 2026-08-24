import type { McpApp, MCPResource, ResourceHandler } from "@casys/mcp-server";
import { ValidationError } from "../domain/errors.ts";
import type { PersistedSimulationRun } from "../domain/types.ts";
import type { ModelicaService } from "../domain/service.ts";
export { kitParameterSchemaUri, kitScenarioUri, kitSourceUri } from "../domain/evidence-uris.ts";
import { kitParameterSchemaUri, kitScenarioUri, kitSourceUri } from "../domain/evidence-uris.ts";

/**
 * Publishes only server-owned, identity-bound Modelica evidence resources.
 *
 * Resource registration is intentionally separate from the simulation tool:
 * tools execute approved kits; resources let clients read exact bytes already
 * identified by a qualified kit identity or immutable run ledger.
 */
export class ModelicaEvidenceResources {
  constructor(
    private readonly server: McpApp,
    private readonly service: ModelicaService,
  ) {}

  async publishInitial(): Promise<void> {
    for (const identity of this.service.listQualifiedSourceIdentities()) {
      if (identity.hasModelSource) {
        await this.publishKitSource(identity.modelId, identity.version);
      }
      if (identity.hasParameterSchema) {
        await this.publishParameterSchema(identity.modelId, identity.version);
      }
      for (const scenarioId of identity.scenarioIds) {
        await this.publishScenarioSource(identity.modelId, identity.version, scenarioId);
      }
    }
    for (const run of await this.service.listPersistedRuns()) {
      await this.publishRun(run);
    }
  }

  async publishRun(run: PersistedSimulationRun): Promise<void> {
    const resources: MCPResource[] = [];
    const handlers = new Map<string, ResourceHandler>();
    // Validate every candidate and its exact text bytes before registering any
    // URI. registerResources performs its own duplicate/handler preflight, so a
    // failed publication cannot leave a partial run surface.
    for (const artifact of run.artifacts.filter((item) => !this.server.hasResource(item.uri))) {
      const uri = artifact.uri;
      const verified = await this.service.readRunArtifact(run.run_id, uri);
      resources.push({
        uri,
        name: `Modelica ${artifact.kind} (${run.run_id})`,
        description:
          `Exact canonical UTF-8 ${artifact.kind} artifact for persisted Modelica run ${run.run_id}; ` +
          "read verifies its bytes and SHA-256 against the run ledger.",
        mimeType: mimeTypeForArtifact(uri),
        size: verified.bytes,
      });
      handlers.set(uri, async (requested) => {
        if (requested.toString() !== uri) {
          throw new ValidationError(
            "Requested URI does not match its registered Modelica artifact.",
          );
        }
        const verified = await this.service.readRunArtifact(run.run_id, uri);
        return { uri, mimeType: mimeTypeForArtifact(uri), text: verified.source };
      });
    }
    if (resources.length > 0) this.server.registerResources(resources, handlers);
  }

  private async publishKitSource(modelId: string, version: string): Promise<void> {
    const uri = kitSourceUri(modelId, version);
    if (this.server.hasResource(uri)) return;
    const identity = await this.service.readQualifiedModelSource(modelId, version);
    this.server.registerResource(
      {
        uri,
        name: `Modelica source (${modelId}@${version})`,
        description:
          "Exact qualified Modelica kit source. Read re-opens the server-owned source and verifies " +
          "its SHA-256 against the loaded kit identity.",
        mimeType: "text/x-modelica",
        size: identity.bytes,
      },
      async (requested) => {
        if (requested.toString() !== uri) {
          throw new ValidationError(
            "Requested URI does not match its registered Modelica kit source.",
          );
        }
        const identity = await this.service.readQualifiedModelSource(modelId, version);
        return { uri, mimeType: "text/x-modelica", text: identity.source };
      },
    );
  }

  private async publishParameterSchema(modelId: string, version: string): Promise<void> {
    const uri = kitParameterSchemaUri(modelId, version);
    if (this.server.hasResource(uri)) return;
    const schema = await this.service.readQualifiedParameterSchema(modelId, version);
    this.server.registerResource(
      {
        uri,
        name: `Modelica parameter schema (${modelId}@${version})`,
        description:
          "Exact compiler-derived parameter schema. Read re-opens its server-owned UTF-8 bytes and " +
          "verifies both the schema identity and the exact qualified Modelica source.",
        mimeType: "application/json",
        size: schema.bytes,
      },
      async (requested) => {
        if (requested.toString() !== uri) {
          throw new ValidationError(
            "Requested URI does not match its registered Modelica parameter schema.",
          );
        }
        const schema = await this.service.readQualifiedParameterSchema(modelId, version);
        return { uri, mimeType: "application/json", text: schema.source };
      },
    );
  }

  private async publishScenarioSource(
    modelId: string,
    version: string,
    scenarioId: string,
  ): Promise<void> {
    const uri = kitScenarioUri(modelId, version, scenarioId);
    if (this.server.hasResource(uri)) return;
    const scenario = await this.service.readQualifiedScenarioSource(
      modelId,
      version,
      scenarioId,
    );
    this.server.registerResource(
      {
        uri,
        name: `Modelica scenario (${scenarioId})`,
        description:
          `Exact qualified scenario JSON for ${modelId}@${version}. Read re-opens its server-owned ` +
          "UTF-8 bytes and verifies its loaded scenario identity.",
        mimeType: "application/json",
        size: scenario.bytes,
      },
      async (requested) => {
        if (requested.toString() !== uri) {
          throw new ValidationError(
            "Requested URI does not match its registered Modelica scenario.",
          );
        }
        const scenario = await this.service.readQualifiedScenarioSource(
          modelId,
          version,
          scenarioId,
        );
        return { uri, mimeType: "application/json", text: scenario.source };
      },
    );
  }
}

function mimeTypeForArtifact(uri: string): string {
  if (uri.endsWith(".mo")) return "text/x-modelica";
  if (uri.endsWith(".json")) return "application/json";
  if (uri.endsWith(".csv")) return "text/csv";
  return "text/plain";
}
