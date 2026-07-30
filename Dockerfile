# Dedicated, reproducible Modelica sidecar. It deliberately does not extend
# engineering-toolchain: OpenModelica/MSL have their own release and disk budget.
FROM openmodelica/openmodelica:v1.27.0-minimal AS runtime

ARG MSL_COMMIT=8ae3d35c24e519cb2996cab20f3b13daf2b0c50a

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The commit, not a floating branch or runtime download, pins MSL 4.1.0.
RUN mkdir -p /opt/modelica-libraries \
    && curl --fail --location --silent --show-error \
      "https://github.com/modelica/ModelicaStandardLibrary/archive/${MSL_COMMIT}.tar.gz" \
      | tar -xz --strip-components=1 -C /opt/modelica-libraries

COPY --from=denoland/deno:bin-2.9.4 /deno /usr/local/bin/deno
WORKDIR /app
COPY deno.json deno.lock mod.ts server.ts ./
COPY src ./src
COPY models ./models
COPY scenarios ./scenarios
RUN deno cache --frozen --minimum-dependency-age=0 server.ts

ENV MODELICAPATH=/opt/modelica-libraries
ENV MODELICA_RUN_DIR=/runs
RUN mkdir -p /runs

# Build-time proof: a container image is not valid until its pinned OMC/MSL
# pair has actually compiled and run the shipped CoffeeMachine model.
FROM runtime AS verify
COPY tests ./tests
RUN RUN_OMC_INTEGRATION=1 deno task test:omc
RUN mkdir -p /verification && touch /verification/omc-smoke-passed

FROM runtime AS final
COPY --from=verify /verification/omc-smoke-passed /verification/omc-smoke-passed

EXPOSE 3016
ENTRYPOINT ["deno", "run", "--allow-read=/app,/runs", "--allow-write=/runs", "--allow-run=omc", "--allow-env=MODELICA_RUN_DIR", "--allow-net=0.0.0.0:3016", "server.ts"]
CMD ["--http", "--port=3016", "--hostname=0.0.0.0"]
