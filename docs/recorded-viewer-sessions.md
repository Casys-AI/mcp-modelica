# Recorded viewer sessions

The package exports a serialized `io.casys.mcp.view-app-manifest/1.0` manifest as
`./view-app-manifest`. It declares App compatibility only: no recorded project, provider endpoint,
credential, or live-tool policy is embedded.

## App identity and resources

The MCP Apps handshake identity is `io.casys.mcp-modelica.results` at the package version.

| Resource                            | Result schemas                                                                                                            | Recorded session schemas                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ui://mcp-modelica/results-viewer`  | `io.casys.mcp-modelica.run-result/1.0`, `io.casys.mcp-modelica.run-result/2.0`, `modelica-admitted-execution-capture/2.0` | `io.casys.mcp-modelica.recorded-results-session/1.0`, `io.casys.mcp-modelica.recorded-admitted-execution-session/1.0` |
| `ui://mcp-modelica/run-list-viewer` | `io.casys.mcp-modelica.run-list-result/1.0`, `io.casys.mcp-modelica.run-list-result/2.0`                                  | `io.casys.mcp-modelica.recorded-results-session/1.0`                                                                  |

Both resources accept `viewer.session.apply`. The listener is installed before MCP Apps connects so
the first host session can be buffered rather than lost.

## Standard recorded results

`io.casys.mcp-modelica.recorded-results-session/1.0` carries an exact recorded 1.0 or 2.0 result
envelope, its project/thread basis, an anchor, recorded operation, artifact/run joins, and a SHA-256
over the raw canonical projection.

The provider accepts only `simulate.run-qualified-modelica-kit@1` and
`simulate.run-admitted-modelica@1` as recorded provenance. Each projected run must join to one
recorded artifact id, run id, and run fingerprint. A list drill-down resolves locally from recorded
details; it never calls a run-get operation or OpenModelica. Missing detail remains `unavailable`.

`pending`, `running`, `rejected`, `recovery_required`, `unavailable`, and `unresolved` remain
literal session states.

## Exact admitted MCS01 capture

The run resource also accepts `io.casys.mcp-modelica.recorded-admitted-execution-session/1.0`. This
provider-owned adapter renders the Digital Thread capture directly and never converts it into an
mcp-modelica result envelope.

The tracked fixture and documentation image use this exact recorded object:

| Fact          | Recorded value                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Project basis | `motorized-camera-slider-mcs01`, workspace revision `150`                                                                              |
| Thread basis  | `project:motorized-camera-slider-mcs01:r21:decide-accept-admitted-spice-evaluation-run:queue-mcs01-spice-closeout-r146`, revision `21` |
| Operation     | `simulate.run-admitted-modelica@1`                                                                                                     |
| Run           | `run:queue-mcs01-run-slider-motion-r91`                                                                                                |
| Execution run | `admitted-modelica-a4bc00f6d99386da710ba342ff55ee19f023576d4662ceba930e254f049f2287`                                                   |
| Model         | `SliderMotion`                                                                                                                         |
| Source        | SHA-256 `e0f626508ca74c165eebc539de560cd72fd1c3b4a9bcb5088e9ab40adf9031cb`                                                             |
| Capture       | `modelica-admitted-execution-capture/2.0`, SHA-256 `b4681bc277dc66505022bde78219feab5300dd018635113e4c648a1ee4b96a07`                  |
| Admission     | SHA-256 `f6ecea5b5a341e7a41fd1bdf36068e9413f3a2fd12df2133baafef69b9374336`                                                             |
| Evidence      | `1031` bytes, SHA-256 `5a66a167ee86f9a4f8faec4d5b55d07658ca5c82f38de7af9eba27b5a63b6cd6`                                               |
| Result        | `3123` CSV bytes, SHA-256 `cf2d2525e2e7e12d0cea6147abfba34bc24407498f4c96ef9217a3a08c62070c`                                           |

The capture deliberately preserves its historical nested tuple:

- `modelica-admitted-run-admission/3.0`
- `technical-compilation-admission-capture/2.0`
- `technical-compilation/1.0`

The adapter verifies the canonical capture, execution-run derivation, receipt and publication
fingerprints, admission join, source/runtime limits, evidence/result outputs, and all recorded
artifact references before applying viewer state.

Its compact surface keeps `ready-for-review`, `ready-for-execution-review`, `exited`, `proven`,
`atomic-batch-published`, `accepted`, and `staged-reread-atomic-commit` literal. Exit code zero is
not renamed `succeeded`, pass, proof, or acceptance.

The scalar capture records `carriagePosition.final` and `carriagePosition.max_abs` as
`399.9999999999999 mm`; display formatting produces `400 mm` without changing the stored value. The
App does not draw a curve from those scalars. A truthful series requires the exact recorded CSV
bytes through the read-only same-origin resource bridge.

The recorded scenario is `0–20 s`, interval `0.1 s`, tolerance `1e-6`, 200 intervals, solver
`dassl`; its parameters are `targetTravel = 400 mm` and `travelDuration = 20 s`.

## Component surfaces

The standalone run viewer defaults to one compact semantic object. A composing host can explicitly
select the App-owned components:

- `modelica.run-summary`, `modelica.run-identity`, `modelica.execution-status`
- `modelica.metrics`, `modelica.parameters`, `modelica.provenance`
- `modelica.artifacts`, `modelica.warnings`
- `modelica.admitted-run-summary` for the admitted capture schema only

The run-list resource advertises `modelica.run-list`, `modelica.run-list-summary`, and
`modelica.run-table`. A host can request a safe stack, row, or grid surface without inspecting the
iframe DOM.

Shared MCP View primitives provide the presentation. Solver state is factual status, never an
`ElementVerdict`. Fingerprints and ids use inline code; artifacts use dedicated artifact rows;
loading and recorded states use explicit state messages. The iframe is flat and self-contained.

## Reproduce the image

Rebuild the committed App first, then capture through the real handshake and strict recorded-session
parser:

```bash
deno task build:ui
deno task capture:docs
```

`capture:docs` uses the tracked MCS01 capture fixture, the exact artifact joins above, a sandboxed
iframe, the MCP Apps `ui/initialize` lifecycle, and `viewer.session.apply`. The resulting optimized
PNG is `docs/assets/modelica-mcs01-recorded-viewer.png`.
