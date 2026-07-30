import { assert, assertMatch } from "@std/assert";

Deno.test("Docker release inputs are immutable and verified", async () => {
  const dockerfile = await Deno.readTextFile(new URL("../Dockerfile", import.meta.url));

  assertMatch(
    dockerfile,
    /^FROM openmodelica\/openmodelica@sha256:[a-f0-9]{64} AS runtime$/m,
  );
  assertMatch(
    dockerfile,
    /COPY --from=denoland\/deno@sha256:[a-f0-9]{64} \/deno \/usr\/local\/bin\/deno/,
  );
  assertMatch(dockerfile, /^ARG MSL_TARBALL_SHA256=[a-f0-9]{64}$/m);
  assert(
    dockerfile.includes("sha256sum -c -"),
    "The downloaded MSL archive must be verified before extraction.",
  );
  assert(
    dockerfile.includes(
      "--allow-env=MODELICA_RUN_DIR,MCP_AUTH_PROVIDER,MCP_AUTH_AUDIENCE,MCP_AUTH_RESOURCE,MCP_AUTH_DOMAIN,MCP_AUTH_ISSUER,MCP_AUTH_JWKS_URI,MCP_AUTH_SCOPES,MCP_AUTH_RESOURCE_METADATA_URL",
    ),
    "The HTTP entrypoint must be permitted to read the full optional MCP auth configuration.",
  );
});
