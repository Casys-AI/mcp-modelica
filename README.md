# @casys/mcp-modelica

[![JSR](https://jsr.io/badges/@casys/mcp-modelica)](https://jsr.io/@casys/mcp-modelica)
[![CI](https://github.com/Casys-AI/mcp-modelica/actions/workflows/check.yml/badge.svg)](https://github.com/Casys-AI/mcp-modelica/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Run **approved Modelica simulation kits** through a bounded, reproducible MCP surface. The server
discovers qualified scenarios and parameter domains, runs OpenModelica, persists the exact execution
evidence, and exposes hashed inputs and outputs for later inspection or replay.

The shipped catalogue makes two deliberately different claims:

- `CoffeeMachine` is a bounded electro-thermal engineering model: boiler/water thermal capacity,
  ambient losses, heater, and thermostat hysteresis.
- `LinearThermalRamp` is a minimal balanced equation used to prove multi-kit dispatch and real OMC
  solver conformance. It is explicitly not a physical thermal oracle.

| Kit id                   | Scenario              | Reviewed overrides | Produced metrics                                                                     |
| ------------------------ | --------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `coffee-machine-v1`      | `heat-up-nominal`     | 8                  | maximum water temperature, optional time to target, heater energy, peak heater power |
| `linear-thermal-ramp-v1` | `linear-ramp-nominal` | 2                  | final ramp temperature; solver-conformance evidence only                             |

This is not a generic Modelica or code-execution endpoint. A caller can select a known model and
scenario, then apply typed, bounded numeric overrides. It cannot submit a `.mo` file, a `.mos`
script, a shell command, or a path.

Stateless HTTP remains the default transport and implements protocol `2026-07-28`. Version `0.6.1`
also provides an explicit native stdio process mode for MCP hosts that launch their server command
directly. Its resumable flow adds a server-issued request template and bounded readback of the exact
sealed result series.

```text
modelica_simulate → computed temperature / time / energy evidence
                                  ↓
mcp-syson + @casys/constraint-solver → units, margins, pass/fail/unresolved
```

`succeeded` means that OpenModelica produced a simulation result. It is not a requirement verdict.

## Quick start

### Recommended: run the verified container

The published `0.6.1` multi-architecture image below is pinned by its immutable release-index
digest. Use this qualified digest, rather than mutable tag `0.6.1`, for deployment:

```bash
mkdir -p modelica-runs
docker run --rm --name mcp-modelica \
  --publish 127.0.0.1:3016:3016 \
  --volume "$PWD/modelica-runs:/runs" \
  ghcr.io/casys-ai/mcp-modelica@sha256:05df482dafdfe0c12da96332760294df1537c1e6601283ecef3497efc0cb1d29
```

This qualified `0.6.1` image contains OpenModelica 1.27.0 and Modelica Standard Library 4.1.0. It
pins and build-asserts Deno 2.9.6 while preserving that OMC/MSL pair. Its build gate compiles and
runs both shipped kits before the final image is published. The MCP endpoint is
`http://127.0.0.1:3016/mcp`; the process probe is:

```bash
curl http://127.0.0.1:3016/health
```

Point a Streamable HTTP-capable MCP client at the endpoint. The exact config file location depends
on the host; the connection entry is typically:

```json
{
  "mcpServers": {
    "modelica": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3016/mcp"
    }
  }
}
```

### Native stdio

Version `0.6.1` keeps Streamable HTTP as its default and provides an explicit local-process mode.
From a checkout:

```bash
deno task serve:stdio
```

The same versioned server entry point can be launched from JSR when OpenModelica 1.27.0 and Modelica
Standard Library 4.1.0 are available on the host:

```bash
deno run -A jsr:@casys/mcp-modelica@0.6.1/server --stdio
```

The published container entry point invokes `deno … server.ts` directly and its CMD supplies the
HTTP arguments. To run native stdio, replace that CMD by placing `--stdio` after the immutable image
digest; keep the evidence volume:

```bash
mkdir -p modelica-runs
docker run --rm -i --name mcp-modelica \
  --volume "$PWD/modelica-runs:/runs" \
  ghcr.io/casys-ai/mcp-modelica@sha256:05df482dafdfe0c12da96332760294df1537c1e6601283ecef3497efc0cb1d29 \
  --stdio
```

`--stdio` cannot be combined with `--port` or `--hostname`; omitting it starts HTTP exactly as
before.

### Run from JSR

Version `0.6.1` binds kit models, scenarios, and compiler-derived schemas as ordinary generated
TypeScript modules, so a checkout-free import can load those assets. JSR users must still provide
OpenModelica 1.27.0 and Modelica Standard Library 4.1.0. A digest-pinned GHCR image remains the
recommended deployment because it includes that runtime and the release-gate proof that both shipped
kits compile and run.

```bash
deno run -A jsr:@casys/mcp-modelica@0.6.1/server --port=3016
```

A real package import from an empty working directory succeeded on the `0.4.2` release day, then
succeeded again with `--cached-only` after that import primed the cache. Because the package was
fresh that day, the check used `--minimum-dependency-age=0` only to bypass Deno's freshness
quarantine; once that quarantine expires, the flag is not required.

`v0.4.1` is tagged in git, but JSR rejected the `0.4.1` module graph: import attributes with
`type: "text"` are unsupported.

### Run a source checkout

For local development, install Deno 2.9.6, OpenModelica 1.27.0, and MSL 4.1.0, then point
OpenModelica at the library and keep run evidence in an explicit directory:

```bash
git clone https://github.com/Casys-AI/mcp-modelica.git
cd mcp-modelica
OPENMODELICALIBRARY=/absolute/path/to/Modelica-4.1.0 \
MODELICA_RUN_DIR="$PWD/runs" \
  deno task serve
```

### First useful call

For a new integration, call `modelica_kit_list_recorded` first. It returns the model and scenario
ids, units, defaults, accepted bounds, and produced metrics. It does **not** return resource
identities: use the exact resource forms documented below and discover their registered instances
via `resources/list`. Then call `modelica_simulate_recorded` with only the overrides you need:

```json
{
  "model_id": "coffee-machine-v1",
  "scenario_id": "heat-up-nominal",
  "parameter_overrides": {
    "heater_power": { "value": 1500, "unit": "W" },
    "initial_water_temperature": { "value": 20, "unit": "degC" }
  },
  "timeout_ms": 30000
}
```

Use the 2.1 manifest/submit/request flow when a caller needs a durable, idempotent request id and
crash-safe readback. The frozen 1.0 names exist for compatibility; new evidence consumers should
prefer recorded 2.0 or resumable 2.1 contracts.

For the resumable path, first call `modelica_simulation_manifest_get`, then pass its exact
`manifest_sha256` to `modelica_simulation_request_template_get` on the same server process. The
template accepts only the latest manifest identity that process issued for the selected qualified
model, version, and scenario. It prepares the fully explicit submit payload and kit defaults without
another runtime probe, claiming capacity, creating a run directory, or executing a simulation.
Review or adjust the bounded parameter values, then pass its `submit` object to
`modelica_simulation_submit`.

## Security boundary

- Callers cannot choose source, scenario files, solver scripts, commands, or paths. The server
  generates the OMC script from a qualified kit and validated parameters.
- This is still a solver service. Keep the source server on loopback, or publish the container port
  only through an authenticated boundary. The bootstrap does not enable HTTP authentication by
  itself.
- Mount only the evidence directory at `/runs`; the published image needs no Docker socket, CAD
  export volume, or runtime Modelica library download.
- Run capacity and CSV size are bounded, and malformed or changed evidence fails closed, but those
  controls are not a substitute for host/container isolation.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Tools

This source tree exposes the original names frozen at envelope `1.0`; they do not acquire fields
conditionally. Their recorded successors use envelope `2.0` and expose the richer,
resource-addressable ledger. The resumable operations use envelope `2.1`; they are a separate
durable request authority and do not mutate the historical tool contracts or their immutable run
ledgers.

| Frozen 1.0 tool     | Recorded 2.0 successor       | Role                                                            |
| ------------------- | ---------------------------- | --------------------------------------------------------------- |
| `modelica_kit_list` | `modelica_kit_list_recorded` | Enumerate qualified kits, scenarios, bounds, units and metrics. |
| `modelica_simulate` | `modelica_simulate_recorded` | Run one approved kit/scenario.                                  |
| `modelica_run_list` | `modelica_run_list_recorded` | Read a bounded deterministic persisted-run index.               |
| `modelica_run_get`  | `modelica_run_get_recorded`  | Retrieve one immutable persisted record.                        |

The simulation and resumable selection schemas are generated at startup from the loaded qualified
kit registry. Their `oneOf` branches enumerate only registered kit/version/scenario combinations;
their parameter maps are closed and declare numeric type, reviewed bounds, exact unit and
`x-modelica-default` planning metadata. This metadata is intentionally non-mutating: it never
supplies a caller value. In particular, 2.1 submission still requires every parameter value and unit
explicitly.

### Resumable 2.1 successor

| Tool                                       | Role                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `modelica_simulation_manifest_get`         | Re-open the qualified inputs and return the exact manifest identity.     |
| `modelica_simulation_request_template_get` | Prepare a reviewed, explicit submit payload without simulation.          |
| `modelica_simulation_submit`               | Durably claim and execute one fully explicit, manifest-bound request.    |
| `modelica_simulation_request_get`          | Read or reconcile the request state without starting OpenModelica.       |
| `modelica_simulation_series_get`           | Summarize one sealed successful CSV without returning its full contents. |

`modelica_simulation_manifest_get` re-opens and hashes the exact qualified Modelica source, scenario
source, optional compiler schema, public scenario projection, parameter bindings/conversions, result
normalizer, lowering identity and OMC engine. Its `manifest_sha256` is required by
`modelica_simulation_submit`.

`modelica_simulation_request_template_get` requires the selected qualified model, version, scenario,
caller-owned `request_id`, and exact `manifest_sha256` most recently issued by the explicit manifest
operation in that same server process. A restart deliberately requires a fresh manifest call. It
returns every qualified parameter at its kit-owned default with its explicit unit and a bounded
timeout. It neither probes the runtime nor creates durable state or a simulation. Submission
revalidates that supplied identity against the current runtime. The returned `request_sha256`
identifies the exact prepared submit bytes; changing any submit field changes that identity and
remains subject to normal submit validation.

Submit requires a caller-supplied `request_id`, explicit timeout, and every qualified parameter with
its exact unit and bound; it accepts neither defaults nor extras. The server durably claims the
canonical request before it starts any OMC probe or simulation. Only the owner of the per-request
kernel lock re-probes the runtime engine, rebuilds the source-backed manifest, and compares its
hash. A post-claim mismatch becomes an immutable `rejected` / `manifest_mismatch` request, releases
its reserved slot, and never starts the runner. Identical request bytes under the same id resolve to
that same run or rejection without another probe; changed bytes are a collision.
`modelica_simulation_request_get` never runs or probes OMC: it returns the sealed run, reconciles a
run.json committed before its claim, reports a live OS lock as running, reports an unstarted durable
claim as retryable `pending`, preserves a manifest rejection, or returns `recovery_required` without
a rerun after a started owner disappears.

`modelica_simulation_series_get` accepts only a completed 2.1 `request_id` and an optional bounded
sample limit. It revalidates the completed ledger and its exact `result.csv`, then returns the CSV
column catalogue, numeric minimum/maximum/final values, and deterministic evenly spaced samples
including the endpoints. The reader never accepts a file path, resource URI, Modelica source,
script, or solver selection. It reports CSV numbers as raw solver columns and does not invent units
or a requirement verdict.

### Stable tool errors

Business validation failures are MCP `isError: true` results whose text content is canonical JSON
with schema `modelica-mcp-error/1.0`. Every record contains `code`, `field`, `context` and
`recovery`; these fields are for agent control flow and contain no source text, paths or raw solver
diagnostics. A missing process-local 2.1 issuance is `manifest.reissue_required`, directing the
caller to obtain a fresh manifest from that same server process. Unexpected execution faults remain
protocol errors rather than being relabelled as a safe business rejection.

Completed replay treats the manifest's OMC/MSL identity as historical evidence: it does not compare
it to or probe the current image. It instead verifies the sealed manifest, exact copied source
artifacts, regenerated `run.mos`, resolved parameters, normalized `result.csv`, evidence payload and
run.json seal. Normalization code is resolved by the exact sealed normalizer id and version; an
unavailable or ambiguous implementation fails closed without rewriting the completed claim.

The 2.1 capacity coordinator is shared with the historical simulate paths. A global kernel lock
counts `run_*` directories plus only slot-reserving claims, so incomplete runs and claims remain
conservative capacity occupants after a crash. All claims, artifacts and ledgers are written,
synced, atomically renamed, and followed by a directory sync. The process lock uses the explicitly
installed Perl `flock` helper in the pinned container; it is permitted by the production Deno
runtime command and exercised in the image verification stage.

The frozen and recorded simulate names persist the same canonical 2.0 run record. The frozen tool
projects it back to the exact 1.0 output shape: `model.sha256` is the recorded model-source hash,
`scenario.sha256` is the recorded public-scenario projection hash, and only the seven historical
artifact kinds are returned. Its fingerprint is recalculated over the exact historical 1.0 identity
rather than reusing the richer v2 fingerprint. The recorded tool returns the complete 2.0 ledger.

Only the recorded catalogue exposes `produced_metrics[].required`. The frozen 1.0 catalogue omits
that field, preserving its historical output schema exactly; the explicit required/optional contract
is a 2.0 successor capability.

The recorded v2 result contains required `started_at` and `completed_at` timestamps, the exact
Modelica source hash, separate native-scenario and public-projection hashes, an exact
compiler-derived parameter-schema hash when the kit has one, resolved parameters, artifact hashes,
and observations. For CoffeeMachine those include `water_temperature_max`,
`time_to_target_temperature`, `heater_energy`, and `heater_power_peak`. If a target is not reached,
the optional time metric is absent rather than invented; a separate requirement evaluator can then
return `unresolved` or `fail` from a real rule.

## Model, run, resource, and digest semantics

- Qualified model, scenario, and optional compiler-schema resources are server-owned.
  `resources/read` reopens the exact UTF-8 bytes and verifies their byte length and SHA-256 before
  returning them; callers cannot supply a path or arbitrary URI.
- A simulation copies its qualified inputs and generated artifacts under `MODELICA_RUN_DIR` (default
  `./runs`) before publishing an immutable `run.json`. Recorded runs name exact request,
  resolved-parameter, model, scenario, schema, generated `.mos`, diagnostics, CSV result, and
  evidence artifacts as applicable.
- An artifact `sha256` identifies exact bytes. The run `fingerprint` identifies the normalized
  execution contract: kit/scenario identity, resolved parameters, engine, and normalizer. Neither is
  a requirement verdict.
- Recorded 2.0 keeps native scenario bytes and the public scenario projection as different hashes.
  Resumable 2.1 additionally seals the current OMC/MSL engine, unit conversions, lowering, and
  result-normalizer identities in `manifest_sha256` before submission.
- A final resource read rechecks the persisted ledger and bytes. A missing, changed, or noncanonical
  artifact fails closed; reads never rewrite evidence or rerun OpenModelica.
- The store retains at most 20 runs and accepts at most 5 MiB for a result CSV. Capacity exhaustion
  refuses a new run; the server does not silently evict old evidence and exposes no delete tool.

## Results viewer contract

The simulate/get operations expose `ui://mcp-modelica/results-viewer`. The list operations use the
separate `ui://mcp-modelica/run-list-viewer` resource so a discovery list never advertises
detail-only evidence facets. They retain a concise text fallback and expose persisted data as
`structuredContent` with one of two fixed contracts:

- the frozen names return only envelope `1.0` and its legacy run/summary shapes;
- the `_recorded` names return only envelope `2.0` and the recorded run/summary shapes.

Version 2 is an explicit successor rather than a mutation of the former envelope. It names
`model.source_sha256`, `scenario.source_sha256`, and `scenario.projection_sha256` separately, and
links `parameter_schema.source_sha256` back to `model_source_sha256`; consumers are never asked to
guess whether a hash describes native bytes or a projection.

The viewer accepts both fixed envelopes. For a 1.0 result it labels the native scenario-source hash
as not recorded; it never derives or invents that provenance from the projection hash. The published
package includes both built, self-contained HTML resources under `src/ui/dist/`. A source checkout
with either artifact deliberately removed reports that viewer as skipped while keeping text and
structured tool results usable. Neither form contains a requirement verdict; Modelica reports
simulation execution and computed evidence only.

The package also exports an App-owned `io.casys.mcp.view-app-manifest/1.0` declaration for both
resources. Each whole-view resource names its exact run or run-list 1.0/2.0 result contracts and
accepts `viewer.session.apply` with the strict `io.casys.mcp-modelica.recorded-results-session/1.0`
read model. This path is for a read-only host such as a Digital Thread whiteboard: it supplies the
exact recorded 1.0 or 2.0 result envelope and any recorded run details in the session payload. List
drill-down then stays local and never calls `modelica_run_get`, `modelica_run_get_recorded`, or
OpenModelica. A missing detail remains visibly `unavailable`; `pending`, `running`, `rejected`, and
`recovery_required` likewise remain literal states rather than being smoothed into a completed
result. The listener is installed before the MCP Apps connection starts, so an initial host session
is buffered rather than lost. Provenance accepts only the registered
`simulate.run-qualified-modelica-kit@1` and `simulate.run-admitted-modelica@1` operations, binds one
recorded artifact identity to every projected run and verifies a separate SHA-256 over the raw
canonical projection. It cannot relabel foreign evidence or derive detail from a fingerprint.

The run viewer advertises small, App-owned components rather than alternate size modes:
`modelica.run-summary`, `modelica.run-identity`, `modelica.execution-status`, `modelica.metrics`,
`modelica.parameters`, `modelica.provenance`, `modelica.artifacts`, and `modelica.warnings`. The
run-list resource separately advertises `modelica.run-list`, `modelica.run-list-summary`, and
`modelica.run-table`. Each standalone viewer uses a compact default surface: one run
`SemanticElement`, or one navigable list of run rows. Identity, status, metrics, parameters,
provenance, artifacts, warnings, and the tabular list remain in the catalog for host-negotiated
composition. A compatible `@casys/mcp-compose` host may request a different explicit subset and safe
stack/row/grid layout without inspecting the iframe DOM.

Every Modelica component now maps its domain data into the optional shared Preact presentation kit
from `@casys/mcp-view-components/preact/components`. Compact surfaces use `SemanticElement` with
`ElementIdent`, `ElementReading`, `ElementBody`, and `ElementProvenance`. Solver execution stays a
factual status; it is never an `ElementVerdict`, pass, or proof. Artifact ledgers use `ArtifactRow`.
Persisted runs use `SemanticList`; fingerprints, hashes and run ids use `InlineCode`; notes use
`Stack`/`Message`; loading, errors and recorded-session states use `StateMessage` with the local
status-to-tone/busy mapping. The whole-view shell is composed from `Card` and `Badge`. The existing
All runs → run drill-down uses `PathBar`. Modelica does not use `LimitGauge`: the result contract
has no explicit bound to display. When Compose selects a surface, the App mounts only those
components and omits its standalone masthead.

No component claims a temperature curve: the current structured result contains scalar metrics and a
hashed CSV artifact reference, but not the samples needed to render a truthful series inside the
sandboxed App. A failed or timed-out run likewise never invents a temperature value.

Run storage is deliberately bounded: at most 20 retained runs and 5 MiB per CSV result. The server
refuses a new run when evidence storage is full; it never silently deletes prior proof or lets an
agent bypass the admitted run limit. `modelica_run_list` is read-only and accepts an optional
`limit` from 1 to 20; it lists final persisted summaries lexicographically by `run_id`, not by
mutable filesystem timestamps. The shared volume is strict bi-read: canonical 0.2.x v1 ledgers pass
through the frozen list/get contract unchanged, while canonical v2 ledgers are projected there. The
recorded list excludes v1 and recorded get refuses it explicitly. No read rewrites either ledger
generation. Malformed or noncanonical final `run.json` files fail closed before either index or the
resource bootstrap is published.

## Development

Version 0.6.1 keeps the explicit `--stdio` process path above while retaining HTTP as the default;
the container stdio command replaces its HTTP CMD with `--stdio`.

```bash
deno task check
deno task fmt
deno task lint
deno task test
```

`deno task check` includes the kit-asset drift check (`deno task kit-assets:check`).

### Results viewer build

The checked-in viewers are self-contained HTML resources at
`src/ui/dist/{results-viewer,run-list-viewer}/index.html`. Until the split packages are released,
build them only against the coordinated, audited local `packages/view` and
`packages/view-components` modules:

```bash
MCP_VIEW_MODULE=file:///absolute/path/to/mcp-server/packages/view/mod.ts \
MCP_VIEW_COMPONENTS_MODULE=file:///absolute/path/to/mcp-server/packages/view-components/mod.ts \
deno task build:ui
```

For local file roots the build derives the sibling `view-contracts`, Preact adapter, and pure
presentation entry points. Explicit `MCP_VIEW_CONTRACTS_MODULE`,
`MCP_VIEW_COMPONENTS_PREACT_MODULE`, and `MCP_VIEW_PRESENTATION_MODULE` overrides remain available
for a different layout. No unpublished package version is added to this repository. The generated
viewer contains no module path or network dependency.

The unit suite uses a deterministic fake runner only to test the MCP contract, validation, artifact
hashing and failure semantics. It never claims that a physical simulation ran. Real OpenModelica
regression tests execute both the historical path and an exact resumable 2.1 submit for both shipped
kits; they are deliberately separate and require a pinned OMC/MSL environment:

```bash
deno task test:omc
```

### Compiler-derived parameter schema

`models/CoffeeMachine.parameters.json` is generated from `OpenModelica.Scripting.getModelInstance`,
not by parsing Modelica source in TypeScript. It records the model parameter names, physical types,
SI units, defaults and source hash. The CoffeeMachine loader verifies it before exposing the kit: a
changed model, type, Modelica name or default fails closed instead of silently letting
`modelica_kit_list` misrepresent the model.

The qualified public layer remains deliberately manual: agent ids, valid ranges, public narrative
and exposure-unit conversion are engineering decisions, not compiler facts. One model parameter
(`waterSpecificHeatCapacity`) is explicitly documented as unqualified because no bounded agent
override has been reviewed for it.

Regenerate only in the pinned OpenModelica environment, then review the resulting JSON:

```bash
deno task model-schema:generate
deno task model-schema:check
```

The Docker verification stage runs the non-writing check before its separate real simulation test.
CI builds and smokes the complete final image once on a native AMD64 runner and once on a native
ARM64 runner; it does not use QEMU or reuse a Deno cache across architectures. Each final image
therefore carries `native-omc-smoke-passed`, containing that runner's `uname -m` output.

### Qualified kit asset bindings

The five qualified kit files are embedded as ordinary TypeScript string literals in
`src/kits/generated-kit-assets.ts`. The generator reads raw bytes, rejects noncanonical UTF-8, and
emits deterministic TypeScript. In a source checkout, file-URL reads still reopen those assets from
disk. For `http` or `https` package module URLs, only the generated bindings are used: there is no
network fetch and no checkout-path fallback.

```bash
deno task kit-assets:generate
deno task kit-assets:check
```

### Kit-owned result interpretation

The orchestration service does not know CoffeeMachine CSV column names. Each qualified kit owns a
versioned `SimulationResultNormalizer` and its declared `produced_metrics`; that normalizer identity
is part of the v2 fingerprint and run ledger. Registry admission rejects empty normalizer
identities, duplicate metric ids, noncanonical ids/units/descriptions, or a metric without an
explicit required/optional declaration. A successful normalization and every successful replay must
contain all required metrics, no undeclared metric, finite values, and exact declared units; an
absent optional metric remains valid.

The default registry also executes `LinearThermalRamp` through real OMC with its own source,
scenario, CSV column and `temperature_final` metric. Its balanced `der(temperatureC) = heatingRate`
equation proves the generic dispatch/normalization seam and solver path. That deliberately small
conformance model is not evidence for a physical heat balance or a thermal requirement verdict.

### Exact MCP evidence resources

The server declares MCP `resources/list` and `resources/read` under the stateless `2026-07-28`
contract. These resources are evidence reads, not a second execution surface:

- `casys://modelica/kits/<model-id>/<version>/model.mo` is the exact qualified kit source
  (`text/x-modelica`). A read re-opens server-owned UTF-8 bytes and checks their byte length and
  SHA-256 against the loaded kit identity.
- `casys://modelica/kits/<model-id>/<version>/scenarios/<scenario-id>.json` is the exact qualified
  scenario JSON. For a kit that declares one, `.../parameter-schema.json` is the exact
  compiler-derived parameter schema; its read additionally verifies that its declared model hash
  still matches the qualified Modelica source. CoffeeMachine currently supplies this schema;
  LinearThermalRamp does not claim one.
- Each artifact already named in a persisted simulation result, such as
  `casys://modelica/runs/<run-id>/result.csv`, is readable with its appropriate MIME type. A read
  re-opens that fixed server-owned filename and verifies its byte length and SHA-256 against
  `run.json` before returning it. The run ledger labels its copied model/scenario input
  `qualified-kit` and its parameter schema `compiler-derived-verified`, so a consumer can
  distinguish qualified inputs from generated execution artifacts without parsing TypeScript.

No resource accepts a caller path, arbitrary URI, Modelica source, or script. This surface is
deliberately text-only: `.mo`, `.mos`, JSON, CSV, and logs are decoded as strict UTF-8, then
re-encoded and compared byte-for-byte before registration and every read. A BOM,
invalid/noncanonical UTF-8, missing file, or changed digest fails closed. This provider does not
advertise a blob resource; the pinned framework can carry canonical base64 blobs, but Modelica has
no binary artifact in this bounded contract.

For a legacy v1 ledger, startup publishes only the historical artifacts actually present in that
ledger; it never synthesizes a scenario or compiler-schema resource for the run. Qualified kit
resources remain independently available by their model/version identity.

Run resource publication happens after the atomic `run.json` commit. It is a best-effort projection
and therefore cannot turn a durable successful run into a failed tool call; either matching run-get
tool retries a failed publication. Each run is fully validated before its resources are registered
as one atomic batch. A rejected middle entry commits neither a partial `resources/list` surface nor
a `notifications/resources/list_changed` event; one successful batch emits one list-change event.

The supported store is monotone for one server process: it can add at most twenty runs and exposes
no delete/archive tool. The pinned `@casys/mcp-server@0.26.1` lifecycle supports dynamic
`unregisterResource` and list-change notification, but this provider has no authorized removal event
to map onto it yet. It therefore does not invent eviction or archive semantics. An operator who
removes run directories out of band must still restart this server because no provider operation
observed that change; startup reconstructs the exact bounded index and fails if any final ledger or
text artifact is invalid. A future governed archive capability can call the framework lifecycle
directly instead of maintaining a private registry.

## Container

The `Dockerfile` pins the OpenModelica and Deno base-image indices by digest, then verifies the
Modelica Standard Library 4.1.0 archive by commit and SHA-256. It exposes HTTP MCP on port 3016 and
has no Docker socket, no shared CAD-export volume, and no runtime library download. Release
deployments use a published GHCR image digest, never a mutable Docker tag.

Build the image locally and accept it only after `deno task test:omc` executes both shipped kits.
The release workflow is tag-only: it gates the exact tagged JSR archive with `deno task check`,
`deno task fmt`, `deno task lint`, `deno task test`, and `deno publish --dry-run`; it then builds
and HTTP-smokes the final image on native AMD64 before distributing it to native AMD64 and ARM64
GitHub runners. The published image is a standalone deployment option; pin it by digest in any
deployment that uses it.

## Relationship to `casys-digital-thread`

This repository remains a useful standalone MCP server for approved-kit discovery, bounded
OpenModelica execution, durable evidence, and integrations that want a bounded solver server.

It is not the current product execution path inside `casys-digital-thread`. There, admitted Modelica
source is reopened and executed locally in a microVM by `compile.seal-admission@3` plus
`simulate.run-admitted-modelica@1`; the pinned-kit operation `simulate.run-qualified-modelica-kit@1`
is also a local microVM path. The Compose sidecar described by this repository's Docker packaging
must not be treated as a substitute for either registered product operation or as evidence of the
currently running Digital Thread topology.
