# @casys/mcp-modelica

Safe, reproducible MCP tools for **approved Modelica simulation kits**. The
first kit is a deliberately bounded CoffeeMachine electro-thermal model:
boiler/water thermal capacity, ambient losses, heater, and thermostat
hysteresis.

This package is not a generic code-execution endpoint. A caller can select a
known model and scenario, then apply typed, bounded numeric overrides. It can
never submit a `.mo` file, a `.mos` script, a shell command, or a path.

```text
modelica_simulate → computed temperature / time / energy evidence
                                  ↓
mcp-syson + @casys/constraint-solver → units, margins, pass/fail/unresolved
```

`succeeded` means that OpenModelica produced a simulation result. It is not a
requirement verdict.

## Tools

| Tool | Role |
| --- | --- |
| `modelica_kit_list` | Enumerate trusted kits, scenarios, bounds, units and metrics. |
| `modelica_simulate` | Run an approved model/scenario and return evidence. |
| `modelica_run_get` | Retrieve the immutable record of a prior run. |

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

The returned record contains the model/scenario hashes, resolved parameters,
CSV and JSON artifact hashes, and observations such as
`water_temperature_max`, `time_to_target_temperature`, and `heater_energy`.
If a target is not reached, the time metric is absent rather than invented;
the requirement evaluator can therefore return `unresolved` or `fail` from a
real rule.

Run storage is deliberately bounded: at most 20 retained runs and 5 MiB per
CSV result. The server refuses a new run when evidence storage is full; it
never silently deletes prior proof or lets an agent fill the host disk.

## Development

```bash
deno task check
deno task fmt
deno task lint
deno task test
```

The unit suite uses a deterministic fake runner only to test the MCP contract,
validation, artifact hashing and failure semantics. It never claims that a
physical simulation ran. A real OpenModelica regression test is deliberately
separate and requires a pinned OMC/MSL environment:

```bash
deno task test:omc
```

## Container

The `Dockerfile` derives from the official OpenModelica 1.27.0 minimal image
and pins Modelica Standard Library 4.1.0 by commit. It exposes HTTP MCP on
port 3016 and has no Docker socket, no shared CAD-export volume, and no
runtime library download.

Build and publish the image only after `deno task test:omc` passes. Until then,
this package is intentionally not added to the Casys fleet or Compose stack.
