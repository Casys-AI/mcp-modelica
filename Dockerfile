# Dedicated, reproducible Modelica sidecar. It deliberately does not extend
# engineering-toolchain: OpenModelica/MSL have their own release and disk budget.
FROM openmodelica/openmodelica@sha256:80fbff1a66fb6a6ade64a158415a45e022363249982c9f3ade07df2a369a357e AS runtime

ARG MSL_COMMIT=8ae3d35c24e519cb2996cab20f3b13daf2b0c50a
ARG MSL_TARBALL_SHA256=b402903aefd4f1397364e3ae1992bb99080ce935ab9a426d3bcdb47e4da8eeb6
ARG PERL_VERSION=5.34.0-3ubuntu1.7

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl "perl=${PERL_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

# The commit and archive SHA, not a floating branch or runtime download, pin
# MSL 4.1.0. Keep this check because GitHub source archives are external input.
RUN mkdir -p /opt/modelica-libraries \
    && curl --fail --location --silent --show-error \
      --output /tmp/modelica-standard-library.tar.gz \
      "https://github.com/modelica/ModelicaStandardLibrary/archive/${MSL_COMMIT}.tar.gz" \
    && echo "${MSL_TARBALL_SHA256}  /tmp/modelica-standard-library.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/modelica-standard-library.tar.gz --strip-components=1 \
      -C /opt/modelica-libraries \
    && rm /tmp/modelica-standard-library.tar.gz

# Deno 2.9.6 OCI index: sha256:4cf0029b9aeeeed5efcbb71828737f0d7c8c8a20072df960e51a5679ef0d21ba
# linux/amd64: sha256:456e1a0fada18d727c3f38eb4937218c1b46924c832b713dcf9358eb32ff15a6
# linux/arm64: sha256:3257165d117f787441e08ad0981f916969423220bdb4550c9fcdecc21ab6551f
COPY --from=denoland/deno@sha256:4cf0029b9aeeeed5efcbb71828737f0d7c8c8a20072df960e51a5679ef0d21ba /deno /usr/local/bin/deno
WORKDIR /app
COPY deno.json deno.lock mod.ts server.ts ./
COPY src ./src
COPY models ./models
COPY scenarios ./scenarios
RUN deno eval --frozen 'import { assertQualifiedContainerDenoRuntime } from "./src/release-identity.ts"; assertQualifiedContainerDenoRuntime()'
RUN deno cache --frozen server.ts

# OMC deliberately reads OPENMODELICALIBRARY rather than MODELICAPATH.
# This directory contains only the MSL 4.1.0 source pinned above.
ENV OPENMODELICALIBRARY=/opt/modelica-libraries
ENV MODELICA_RUN_DIR=/runs
RUN mkdir -p /runs

# Every CI runner builds this full graph natively for its own architecture.
# Build-time proof: a container image is not valid until its pinned OMC/MSL
# pair has actually compiled and run both shipped kits. LinearThermalRamp is
# solver-conformance coverage, not a physical-oracle qualification.
FROM runtime AS verify
ARG OMC_INTEGRATION_TIMEOUT_MS=30000
COPY tests ./tests
COPY scripts ./scripts
RUN deno task model-schema:check
RUN deno test --allow-read --allow-write --allow-run=perl --allow-env tests/resumable_service_test.ts
RUN RUN_OMC_INTEGRATION=1 OMC_INTEGRATION_TIMEOUT_MS="${OMC_INTEGRATION_TIMEOUT_MS}" deno task test:omc
RUN mkdir -p /verification && uname -m > /verification/native-omc-smoke-passed

FROM runtime AS final
COPY --from=verify /verification/native-omc-smoke-passed /verification/native-omc-smoke-passed

EXPOSE 3016
ENTRYPOINT ["deno", "run", "--allow-read=/app,/runs", "--allow-write=/runs", "--allow-run=omc,perl", "--allow-env=MODELICA_RUN_DIR,MCP_AUTH_PROVIDER,MCP_AUTH_AUDIENCE,MCP_AUTH_RESOURCE,MCP_AUTH_DOMAIN,MCP_AUTH_ISSUER,MCP_AUTH_JWKS_URI,MCP_AUTH_SCOPES,MCP_AUTH_RESOURCE_METADATA_URL", "--allow-net=0.0.0.0:3016", "server.ts"]
CMD ["--port=3016", "--hostname=0.0.0.0"]
