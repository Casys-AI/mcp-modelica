# Development and release

## Source checkout

For local development, install Deno 2.9.6, OpenModelica 1.27.0, and MSL 4.1.0. Point OMC at the
library and keep evidence in an explicit directory:

```bash
git clone https://github.com/Casys-AI/mcp-modelica.git
cd mcp-modelica
OPENMODELICALIBRARY=/absolute/path/to/Modelica-4.1.0 \
MODELICA_RUN_DIR="$PWD/runs" \
  deno task serve
```

The normal source gate is:

```bash
deno task check
deno task fmt
deno task lint
deno task test
```

`check` includes the generated qualified-kit asset drift check. Unit tests use deterministic fake
runners to verify contracts, validation, hashing, lifecycle, and failure semantics; they do not
claim a physical simulation.

## MCP App build

The checked-in Apps are self-contained HTML resources at:

- `src/ui/dist/results-viewer/index.html`
- `src/ui/dist/run-list-viewer/index.html`

Build them against the coordinated audited MCP View checkout:

```bash
MCP_VIEW_MODULE=file:///absolute/path/to/mcp-server/packages/view/mod.ts \
MCP_VIEW_COMPONENTS_MODULE=file:///absolute/path/to/mcp-server/packages/view-components/mod.ts \
deno task build:ui
```

For local file roots the builder derives the sibling `view-contracts`, Preact adapter, and pure
presentation modules. Explicit `MCP_VIEW_CONTRACTS_MODULE`, `MCP_VIEW_COMPONENTS_PREACT_MODULE`, and
`MCP_VIEW_PRESENTATION_MODULE` overrides are available for another coordinated layout. The output
contains no runtime module path or network dependency.

CI rebuilds both Apps against the pinned MCP View commit and rejects any diff in `src/ui/dist`.

## MCS01 documentation capture

After rebuilding the viewer:

```bash
deno task capture:docs
```

The capture script validates the tracked MCS01 admitted session with the shipped provider parser,
serves the built App in a sandboxed iframe, completes the MCP Apps handshake, applies the recorded
session, and writes an optimized PNG under `docs/assets/`. Chromium and ffmpeg paths can be supplied
through `CHROME_BIN` and `FFMPEG_BIN`.

## Real OpenModelica checks

Real regression checks are deliberately separate and require the pinned OMC/MSL environment:

```bash
deno task test:omc
```

They execute both the historical simulation path and an exact resumable submit for both qualified
kits. The Docker verification stage also runs the compiler-schema check and the real OS-lock /
capacity smoke before the OMC integration tests.

## Generated Modelica assets

`models/CoffeeMachine.parameters.json` is derived from `OpenModelica.Scripting.getModelInstance`,
not parsed from source in TypeScript. It records native parameter names, physical types, SI units,
defaults, and source hash. Regenerate and review it only in the pinned runtime:

```bash
deno task model-schema:generate
deno task model-schema:check
```

Qualified source/scenario files are embedded as deterministic TypeScript strings for checkout-free
JSR consumption:

```bash
deno task kit-assets:generate
deno task kit-assets:check
```

The generated bindings reject noncanonical UTF-8 and have no network fallback.

## Release workflow

The package and image are tag-only releases. The exact `v<deno.json version>` tag triggers separate
workflows:

- JSR rebuilds the Apps, runs the source gates, builds/smokes the runtime image, and publishes with
  provenance.
- GHCR runs the same package/App gate, builds and smokes native AMD64, then publishes signed native
  AMD64 and ARM64 manifests.

Before tagging, verify the candidate commit is clean, the tag/version/CITATION/App identities agree,
the source archive is complete, and `deno publish --dry-run` succeeds. After publication, verify the
JSR version from a fresh empty directory and inspect/pull the immutable GHCR index digest. A later
documentation-only commit may pin that digest on `main`; it must not be confused with the already
tagged release candidate.
