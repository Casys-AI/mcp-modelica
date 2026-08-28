/**
 * Release facts that must remain distinct from the solver-engine identity.
 *
 * `serverInfo.version` identifies this MCP package release. The actual Deno
 * version is reported separately through MCP instructions, while solver run
 * records continue to identify OpenModelica/MSL only.
 */
export const PACKAGE_VERSION = "0.6.1";
export const QUALIFIED_CONTAINER_DENO_VERSION = "2.9.6";

export function runtimeIdentityInstructions(): string {
  return [
    `Release identity: @casys/mcp-modelica ${PACKAGE_VERSION}.`,
    `Runtime identity: Deno ${Deno.version.deno}.`,
    `The qualified container asserts Deno ${QUALIFIED_CONTAINER_DENO_VERSION} during its image build.`,
  ].join(" ");
}

/** Fails the image build if the pinned binary disagrees with its release identity. */
export function assertQualifiedContainerDenoRuntime(): void {
  if (Deno.version.deno !== QUALIFIED_CONTAINER_DENO_VERSION) {
    throw new Error(
      `Qualified container runtime mismatch: expected Deno ${QUALIFIED_CONTAINER_DENO_VERSION}, ` +
        `got ${Deno.version.deno}.`,
    );
  }
}
