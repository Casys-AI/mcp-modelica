# @casys/mcp-modelica

Safe, reproducible MCP tools for **approved Modelica simulation kits**. The first kit is a
deliberately bounded CoffeeMachine electro-thermal model: boiler/water thermal capacity, ambient
losses, heater, and thermostat hysteresis.

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

| Tool                | Role                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `modelica_kit_list` | Enumerate trusted kits, scenarios, bounds, units and metrics.                                                 |
| `modelica_simulate` | Run an approved model/scenario and return evidence. Includes the results MCP App contract.                    |
| `modelica_run_list` | Read up to 20 persisted run summaries in deterministic `run_id` order. Includes the results MCP App contract. |
| `modelica_run_get`  | Retrieve the immutable record of a prior run. Includes the results MCP App contract.                          |

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

The returned record contains `started_at` and `completed_at` timestamps (for new records), the
model/scenario hashes, resolved parameters, CSV and JSON artifact hashes, and observations such as
`water_temperature_max`, `time_to_target_temperature`, and `heater_energy`. If a target is not
reached, the time metric is absent rather than invented; the requirement evaluator can therefore
return `unresolved` or `fail` from a real rule.

## Results viewer contract

`modelica_simulate` and `modelica_run_get` expose `ui://mcp-modelica/results-viewer`.
`modelica_run_list` uses the separate `ui://mcp-modelica/run-list-viewer` resource so a discovery
list never advertises detail-only evidence facets. Both retain a concise text fallback and expose
their real persisted data as `structuredContent`:

- `{ "schemaVersion": "1.0", "kind": "run", "run": <immutable SimulationRun> }` for simulate and
  get;
- `{ "schemaVersion": "1.0", "kind": "run-list", "runs": <ModelicaRunSummary[]> }` for list.

The published package includes both built, self-contained HTML resources under `src/ui/dist/`. A
source checkout with either artifact deliberately removed reports that viewer as skipped while
keeping text and structured tool results usable. Neither form contains a requirement verdict;
Modelica reports simulation execution and computed evidence only.

The run viewer advertises small, App-owned components rather than alternate size modes:
`modelica.run-identity`, `modelica.execution-status`, `modelica.metrics`, `modelica.parameters`,
`modelica.provenance`, `modelica.artifacts`, and `modelica.warnings`. The run-list resource
separately advertises `modelica.run-list-summary` and `modelica.run-table`. Its standalone viewer is
simply the default surface that assembles the complete catalog. A compatible `@casys/mcp-compose`
host may request a different explicit subset and safe stack/row/grid layout without inspecting the
iframe DOM.

No component claims a temperature curve: the current structured result contains scalar metrics and a
hashed CSV artifact reference, but not the samples needed to render a truthful series inside the
sandboxed App. A failed or timed-out run likewise never invents a temperature value.

Run storage is deliberately bounded: at most 20 retained runs and 5 MiB per CSV result. The server
refuses a new run when evidence storage is full; it never silently deletes prior proof or lets an
agent fill the host disk. `modelica_run_list` is read-only and accepts an optional `limit` from 1 to
20; it lists final persisted summaries lexicographically by `run_id`, not by mutable filesystem
timestamps. Use `modelica_run_get` for the metric and artifact detail. Older records without
timestamps remain readable.

## Development

Version 0.2.0 is HTTP stateless-only. It intentionally removes the former stdio/session transport
surface instead of carrying a compatibility mode.

```bash
deno task check
deno task fmt
deno task lint
deno task test
```

### Results viewer build

The checked-in viewers are self-contained HTML resources at
`src/ui/dist/{results-viewer,run-list-viewer}/index.html`. Build them against the published, exact
`@casys/mcp-view@0.5.0` release:

```bash
deno task build:ui
```

The build's temporary Deno configuration keeps the default dependency-age quarantine for all
dependencies except the Casys-owned package name `jsr:@casys/mcp-view`; the import remains pinned to
`0.5.0`. The generated viewer contains no module path or network dependency.

To validate unreleased local `mcp-view` work without publishing it, use the existing module override
and still rebuild the checked-in artifact:

```bash
MCP_VIEW_MODULE=file:///absolute/path/to/mcp-server/packages/view/mod.ts deno task build:ui
```

The unit suite uses a deterministic fake runner only to test the MCP contract, validation, artifact
hashing and failure semantics. It never claims that a physical simulation ran. A real OpenModelica
regression test is deliberately separate and requires a pinned OMC/MSL environment:

```bash
deno task test:omc
```

## Container

The `Dockerfile` pins the OpenModelica and Deno base-image indices by digest, then verifies the
Modelica Standard Library 4.1.0 archive by commit and SHA-256. It exposes HTTP MCP on port 3016 and
has no Docker socket, no shared CAD-export volume, and no runtime library download. Release
deployments use a published GHCR image digest, never a mutable Docker tag.

Build the image locally and accept it only after `deno task test:omc` passes. The Casys fleet and
Compose stack pin the resulting image by digest rather than rebuilding it during dashboard startup.
