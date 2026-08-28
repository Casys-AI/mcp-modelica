import { assert, assertMatch } from "@std/assert";

Deno.test("Docker release inputs are immutable and verified", async () => {
  const packageVersion = (JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { version: string }).version;
  const citation = await Deno.readTextFile(new URL("../CITATION.cff", import.meta.url));
  const server = await Deno.readTextFile(new URL("../server.ts", import.meta.url));
  assertMatch(citation, new RegExp(`^version: ${packageVersion.replace(".", "\\.")}$`, "m"));
  assert(
    server.includes(`version: "${packageVersion}"`),
    "The MCP server identity must agree with the published package version.",
  );
  const dockerfile = await Deno.readTextFile(new URL("../Dockerfile", import.meta.url));
  const omcIntegration = await Deno.readTextFile(
    new URL("./omc_integration_test.ts", import.meta.url),
  );
  const checkWorkflow = await Deno.readTextFile(
    new URL("../.github/workflows/check.yml", import.meta.url),
  );
  const publishWorkflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish-image.yml", import.meta.url),
  );

  assertMatch(
    dockerfile,
    /^FROM openmodelica\/openmodelica@sha256:[a-f0-9]{64} AS runtime$/m,
  );
  assertMatch(
    dockerfile,
    /COPY --from=denoland\/deno@sha256:[a-f0-9]{64} \/deno \/usr\/local\/bin\/deno/,
  );
  assert(
    dockerfile.includes("RUN deno cache --frozen server.ts"),
    "Each native image build must populate its own Deno cache.",
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
      "FROM runtime AS verify\n" +
        "ARG OMC_INTEGRATION_TIMEOUT_MS=30000\n" +
        "COPY tests ./tests\n" +
        "COPY scripts ./scripts\n" +
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
  assert(
    dockerfile.includes(
      "RUN mkdir -p /verification && uname -m > /verification/native-omc-smoke-passed",
    ) &&
      dockerfile.includes("COPY --from=verify /verification/native-omc-smoke-passed") &&
      !dockerfile.includes("BUILDPLATFORM") && !dockerfile.includes("TARGETPLATFORM") &&
      !dockerfile.includes("DENO_DIR"),
    "The final image must retain native-runner evidence without platform-crossing Deno state.",
  );
  assert(
    checkWorkflow.includes("runs-on: ubuntu-24.04") &&
      checkWorkflow.includes("runs-on: ubuntu-24.04-arm") &&
      checkWorkflow.includes('test "$(uname -m)" = x86_64') &&
      checkWorkflow.includes('test "$(uname -m)" = aarch64') &&
      !checkWorkflow.includes("setup-qemu-action") && !checkWorkflow.includes("buildx build"),
    "CI must build and smoke the final image on distinct native AMD64 and ARM64 runners.",
  );
  assert(
    publishWorkflow.includes('tags: ["v*"]') &&
      !publishWorkflow.includes("workflow_dispatch") &&
      publishWorkflow.includes("needs: release-gate") &&
      publishWorkflow.includes("deno publish --dry-run") &&
      publishWorkflow.includes("Build and smoke the native AMD64 final image") &&
      publishWorkflow.includes("docker build --target final --tag mcp-modelica:release-check .") &&
      publishWorkflow.includes("bash scripts/smoke-container-http.sh mcp-modelica:release-check") &&
      publishWorkflow.includes(
        "docker/github-builder/.github/workflows/build.yml@a492c6d04fd3315f67230809b44d60cc0acd50b3",
      ) &&
      publishWorkflow.includes("platforms: linux/amd64,linux/arm64") &&
      publishWorkflow.includes("setup-qemu: false") && publishWorkflow.includes("target: final") &&
      publishWorkflow.includes('sign: "true"') &&
      publishWorkflow.includes("type=match,pattern=v(.*),group=1") &&
      publishWorkflow.includes("type=sha,format=long,prefix=sha-") &&
      publishWorkflow.includes("registry: ghcr.io") &&
      publishWorkflow.includes("packages: write") && publishWorkflow.includes("id-token: write"),
    "Tag releases must gate the JSR archive and distribute signed native multi-architecture GHCR images.",
  );
});
