import { assert, assertMatch } from "@std/assert";

Deno.test("Docker release inputs are immutable and verified", async () => {
  const dockerfile = await Deno.readTextFile(new URL("../Dockerfile", import.meta.url));
  const omcIntegration = await Deno.readTextFile(
    new URL("./omc_integration_test.ts", import.meta.url),
  );

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
    /^ARG PERL_VERSION=5\.34\.0-3ubuntu1\.7$/m.test(dockerfile) &&
      dockerfile.includes('"perl=${PERL_VERSION}"'),
    "The OS-lock helper version must be installed explicitly in the pinned runtime image.",
  );
  assert(
    dockerfile.includes('"--allow-run=omc,perl"'),
    "The production entrypoint must explicitly permit both OMC and the OS-lock helper.",
  );
  assert(
    dockerfile.includes(
      "deno test --allow-read --allow-write --allow-run=perl --allow-env tests/resumable_service_test.ts",
    ),
    "The release verification stage must execute the real 2.1 OS-lock/capacity smoke.",
  );
  assert(
    dockerfile.includes(
      "--allow-env=MODELICA_RUN_DIR,MCP_AUTH_PROVIDER,MCP_AUTH_AUDIENCE,MCP_AUTH_RESOURCE,MCP_AUTH_DOMAIN,MCP_AUTH_ISSUER,MCP_AUTH_JWKS_URI,MCP_AUTH_SCOPES,MCP_AUTH_RESOURCE_METADATA_URL",
    ),
    "The HTTP entrypoint must be permitted to read the full optional MCP auth configuration.",
  );
  assert(
    dockerfile.includes(
      "RUN deno task model-schema:check\n" +
        "RUN deno test --allow-read --allow-write --allow-run=perl --allow-env tests/resumable_service_test.ts\n" +
        'RUN RUN_OMC_INTEGRATION=1 OMC_INTEGRATION_TIMEOUT_MS="${OMC_INTEGRATION_TIMEOUT_MS}" deno task test:omc',
    ),
    "The release image must verify compiler-derived parameter metadata before the simulation proof.",
  );
  assert(
    omcIntegration.includes(
      "2.1 resumable submit runs both qualified kits through real OpenModelica",
    ) && omcIntegration.includes("new ResumableSimulationService(") &&
      omcIntegration.includes('model_id: "coffee-machine-v1"') &&
      omcIntegration.includes('model_id: "linear-thermal-ramp-v1"'),
    "The Docker OMC gate must execute the real 2.1 provider for both qualified kits.",
  );
});
