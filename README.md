# @casys/mcp-modelica

Safe, reproducible MCP tools for **approved Modelica simulation kits**. The shipped catalogue makes
two deliberately different claims:

- `CoffeeMachine` is a bounded electro-thermal engineering model: boiler/water thermal capacity,
  ambient losses, heater, and thermostat hysteresis.
- `LinearThermalRamp` is a minimal balanced equation used to prove multi-kit dispatch and real OMC
  solver conformance. It is explicitly not a physical thermal oracle.

This package is not a generic code-execution endpoint. A caller can select a known model and
scenario, then apply typed, bounded numeric overrides. It can never submit a `.mo` file, a `.mos`
script, a shell command, or a path.

The MCP endpoint is stateless HTTP only, implementing protocol `2026-07-28`.

```text
modelica_simulate → computed temperature / time / energy evidence
                                  ↓
mcp-syson + @casys/constraint-solver → units, margins, pass/fail/unresolved
```

`succeeded` means that OpenModelica produced a simulation result. It is not a requirement verdict.

## Tools

The original four names remain frozen at envelope `1.0`; they do not acquire fields conditionally.
The four recorded successors use envelope `2.0` and expose the richer, resource-addressable ledger.
The three resumable successors use envelope `2.1`; they are a separate durable request authority and
do not mutate the eight historical tool contracts or their immutable run ledgers.

| Frozen 1.0 tool     | Recorded 2.0 successor       | Role                                                            |
| ------------------- | ---------------------------- | --------------------------------------------------------------- |
| `modelica_kit_list` | `modelica_kit_list_recorded` | Enumerate qualified kits, scenarios, bounds, units and metrics. |
| `modelica_simulate` | `modelica_simulate_recorded` | Run one approved kit/scenario.                                  |
| `modelica_run_list` | `modelica_run_list_recorded` | Read a bounded deterministic persisted-run index.               |
| `modelica_run_get`  | `modelica_run_get_recorded`  | Retrieve one immutable persisted record.                        |

### Resumable 2.1 successor

`modelica_simulation_manifest_get` re-opens and hashes the exact qualified Modelica source, scenario
source, optional compiler schema, public scenario projection, parameter bindings/conversions, result
normalizer, lowering identity and OMC engine. Its `manifest_sha256` is required by
`modelica_simulation_submit`.

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

Completed replay treats the manifest's OMC/MSL identity as historical evidence: it does not compare
it to or probe the current image. It instead verifies the sealed manifest, exact copied source
artifacts, regenerated `run.mos`, resolved parameters, normalized `result.csv`, evidence payload and
run.json seal. Normalization code is resolved by the exact sealed normalizer id and version; an
unavailable or ambiguous implementation fails closed without rewriting the completed claim.

The 2.1 capacity coordinator is shared with both historical simulate tools. A global kernel lock
counts `run_*` directories plus only slot-reserving claims, so incomplete runs and claims remain
conservative capacity occupants after a crash. All claims, artifacts and ledgers are written,
synced, atomically renamed, and followed by a directory sync. The process lock uses the explicitly
installed Perl `flock` helper in the pinned container; it is permitted by the production Deno
runtime command and exercised in the image verification stage.

Both simulate names persist the same canonical 2.0 run record. The frozen tool projects it back to
the exact 1.0 output shape: `model.sha256` is the recorded model-source hash, `scenario.sha256` is
the recorded public-scenario projection hash, and only the seven historical artifact kinds are
returned. Its fingerprint is recalculated over the exact historical 1.0 identity rather than reusing
the richer v2 fingerprint. The recorded tool returns the complete 2.0 ledger.

Only the recorded catalogue exposes `produced_metrics[].required`. The frozen 1.0 catalogue omits
that field, preserving its historical output schema exactly; the explicit required/optional contract
is a 2.0 successor capability.

Example request:

```json
{
  "model_id": "coffee-machine-v1",
  "scenario_id": "heat-up-nominal",
  "parameter_overrides": {
    "heater_power": { "value": 1500, "unit": "W" },
    "initial_water_temperature": { "value": 20, "unit": "degC" }
  }
}
```

The recorded v2 result contains required `started_at` and `completed_at` timestamps, the exact
Modelica source hash, separate native-scenario and public-projection hashes, an exact
compiler-derived parameter-schema hash when the kit has one, resolved parameters, artifact hashes,
and observations. For CoffeeMachine those include `water_temperature_max`,
`time_to_target_temperature`, and `heater_energy`. If a target is not reached, the optional time
metric is absent rather than invented; the requirement evaluator can therefore return `unresolved`
or `fail` from a real rule.

## Results viewer contract

Both simulate/get pairs expose `ui://mcp-modelica/results-viewer`. Both list tools use the separate
`ui://mcp-modelica/run-list-viewer` resource so a discovery list never advertises detail-only
evidence facets. They retain a concise text fallback and expose persisted data as
`structuredContent` with one of two fixed contracts:

- the four historical names return only envelope `1.0` and its legacy run/summary shapes;
- the four `_recorded` names return only envelope `2.0` and the recorded run/summary shapes.

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

The run viewer advertises small, App-owned components rather than alternate size modes:
`modelica.run-identity`, `modelica.execution-status`, `modelica.metrics`, `modelica.parameters`,
`modelica.provenance`, `modelica.artifacts`, and `modelica.warnings`. The run-list resource
separately advertises `modelica.run-list-summary` and `modelica.run-table`. Its standalone viewer is
simply the default surface that assembles the complete catalog. A compatible `@casys/mcp-compose`
host may request a different explicit subset and safe stack/row/grid layout without inspecting the
iframe DOM.

Every Modelica component now maps its domain data into the shared Preact presentation kit from
`@casys/mcp-view/preact`: `Card`, `Badge`, `MetricGrid`, `KeyValueList`, `DataTable`, `EmptyState`,
and `StateMessage`. Modelica owns the evidence semantics and small artifact-specific layout; it does
not maintain a parallel card, metric, table, or state design system. When Compose selects a surface,
the App mounts only those cards and omits its standalone masthead.

No component claims a temperature curve: the current structured result contains scalar metrics and a
hashed CSV artifact reference, but not the samples needed to render a truthful series inside the
sandboxed App. A failed or timed-out run likewise never invents a temperature value.

Run storage is deliberately bounded: at most 20 retained runs and 5 MiB per CSV result. The server
refuses a new run when evidence storage is full; it never silently deletes prior proof or lets an
agent fill the host disk. `modelica_run_list` is read-only and accepts an optional `limit` from 1 to
20; it lists final persisted summaries lexicographically by `run_id`, not by mutable filesystem
timestamps. The shared volume is strict bi-read: canonical 0.2.x v1 ledgers pass through the frozen
list/get contract unchanged, while canonical v2 ledgers are projected there. The recorded list
excludes v1 and recorded get refuses it explicitly. No read rewrites either ledger generation.
Malformed or noncanonical final `run.json` files fail closed before either index or the resource
bootstrap is published.

## Development

Version 0.4.0 is HTTP stateless-only. It does not reintroduce the former stdio/session transport
surface or carry a transport compatibility mode.

```bash
deno task check
deno task fmt
deno task lint
deno task test
```

### Results viewer build

The checked-in viewers are self-contained HTML resources at
`src/ui/dist/{results-viewer,run-list-viewer}/index.html`. Build them against the published, exact
`@casys/mcp-view@0.7.0` release:

```bash
deno task build:ui
```

The build's temporary Deno configuration keeps the default dependency-age quarantine for all
dependencies except the Casys-owned package name `jsr:@casys/mcp-view`; the imports remain pinned to
`0.7.0`. The generated viewer contains no module path or network dependency.

To validate unreleased local `mcp-view` work without publishing it, use the existing module override
and still rebuild the checked-in artifact:

```bash
MCP_VIEW_MODULE=file:///absolute/path/to/mcp-server/packages/view/mod.ts \
MCP_VIEW_PREACT_MODULE=file:///absolute/path/to/mcp-server/packages/view/preact.ts \
deno task build:ui
```

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
no delete/archive tool. The pinned `@casys/mcp-server@0.26.0` lifecycle supports dynamic
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
GitHub runners. The Casys fleet and Compose stack pin the resulting image by digest rather than
rebuilding it during dashboard startup.
