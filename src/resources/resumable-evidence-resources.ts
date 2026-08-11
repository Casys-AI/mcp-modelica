import type { McpApp, MCPResource, ResourceHandler } from "@casys/mcp-server";
import { ResumableSimulationService } from "../application/resumable-simulation-service.ts";
import { ValidationError } from "../domain/errors.ts";
import { stableJson } from "../domain/hashing.ts";
import { requestArtifactUri } from "../domain/evidence-uris.ts";

/** Publishes 2.1 resources only after their durable ledger has been validated. */
export class ResumableEvidenceResources {
  constructor(
    private readonly server: McpApp,
    private readonly service: ResumableSimulationService,
  ) {}

  async publishInitial(): Promise<void> {
    for (const { requestId } of await this.service.store.listRunRecords()) {
      await this.publishRequest(requestId);
    }
  }

  async publishRequest(requestId: string): Promise<void> {
    const evidence = await this.service.getCompletedEvidence(requestId);
    const artifacts = evidence.artifacts;
    const candidates: Array<{
      uri: string;
      name: string;
      mimeType: string;
      size: number;
      read: () => Promise<{ uri: string; mimeType: string; text: string }>;
    }> = [];
    for (const artifact of artifacts) {
      if (this.server.hasResource(artifact.uri)) continue;
      // Validate all bytes first. registerResources will commit this batch or
      // none of it, preserving an atomic resources/list projection.
      await this.service.store.readArtifact(requestId, artifact);
      candidates.push({
        uri: artifact.uri,
        name: `Modelica 2.1 ${artifact.kind} (${requestId})`,
        mimeType: artifact.mediaType,
        size: artifact.bytes,
        read: async () => {
          const current = await this.service.getCompletedEvidence(requestId);
          const currentArtifact = current.artifacts.find((item) => item.uri === artifact.uri);
          if (!currentArtifact || stableJson(currentArtifact) !== stableJson(artifact)) {
            throw new ValidationError(
              "Resumable artifact no longer belongs to its sealed run ledger.",
            );
          }
          const verified = await this.service.store.readArtifact(requestId, currentArtifact);
          return { uri: artifact.uri, mimeType: artifact.mediaType, text: verified.source };
        },
      });
    }
    const runJsonUri = requestArtifactUri(requestId, "run.json");
    if (!this.server.hasResource(runJsonUri)) {
      const runJson = evidence.runJson;
      candidates.push({
        uri: runJsonUri,
        name: `Modelica 2.1 run ledger (${requestId})`,
        mimeType: "application/json",
        size: runJson.bytes,
        read: async () => {
          const current = await this.service.getCompletedEvidence(requestId);
          return { uri: runJsonUri, mimeType: "application/json", text: current.runJson.source };
        },
      });
    }
    if (candidates.length === 0) return;
    const resources: MCPResource[] = candidates.map(({ uri, name, mimeType, size }) => ({
      uri,
      name,
      description:
        "Exact durable Modelica 2.1 evidence; every read rechecks UTF-8 bytes and SHA-256.",
      mimeType,
      size,
    }));
    const handlers = new Map<string, ResourceHandler>(candidates.map((candidate) => [
      candidate.uri,
      async (requested) => {
        if (requested.toString() !== candidate.uri) {
          throw new ValidationError(
            "Requested URI does not match its registered Modelica 2.1 evidence.",
          );
        }
        return await candidate.read();
      },
    ]));
    this.server.registerResources(resources, handlers);
  }
}
