# Changelog

All notable changes to `@casys/mcp-modelica` are documented here.

## [0.6.3] - 2026-08-31

### Fixed

- The audited MCP View checkout under `.deps/` is now ignored as a CI-only build input, so the
  tag-only JSR and GHCR archive gates see the exact source candidate as clean after rebuilding the
  committed Apps.
- The `v0.6.2` tag reached neither registry: both tag workflows stopped before publication when that
  checkout appeared as an untracked directory. `0.6.3` is the publishable successor.

## [0.6.2] - 2026-08-31

### Added

- A provider-owned serialized View App manifest, published through the `./view-app-manifest` package
  export, declares both exact Modelica viewer resources and their recorded-session compatibility
  without embedding a session, anchor, or provider authority.
- The run viewer accepts the exact `io.casys.mcp-modelica.recorded-admitted-execution-session/1.0`
  read model and renders a validated Digital Thread `modelica-admitted-execution-capture/2.0`
  directly. The frozen MCS01 nested admission profile remains literal; no provider
  `ResultsEnvelope`, success verdict, or unit is synthesized.

### Changed

- Compact Modelica MCP App default surfaces now present one run or one navigable run list using the
  shared View v2 `SemanticElement` kit. Detailed identity, status, metrics, parameters, provenance,
  artifact, warning, and table components remain advertised for host composition. Solver execution
  stays a factual status, not a pass or proof verdict.
- Remaining generic presentation now uses the shared kit: `Row`, `SemanticList`, `InlineCode`,
  `Stack`/`Message` notes, and `StateMessage` for loading, errors, and recorded-session states.
  Recorded statuses stay literal; pending/running are `busy`. The whole-view shell is composed from
  `Card`, `Badge`, and `StateMessage` instead of reconstructed kit markup.
- Recorded admitted execution sessions bind the visible solver-result anchor to the exact admission,
  capture, evidence, and result artifacts, then verify the capture, execution, receipt, publication,
  and output fingerprints before applying viewer state.
- The concise README now leads with the exact recorded MCS01 viewer capture. Historical contracts,
  recorded sessions, provider/runtime boundaries, and development/release guidance live under
  `docs/` and ship with the JSR package.

## [0.6.1] - 2026-08-29

### Changed

- The qualified container, CI and release gates now pin Deno 2.9.6 by its verified
  multi-architecture OCI index. The image build asserts the binary's actual Deno version before
  caching the server.
- MCP discovery and initialization distinguish the package release from the running Deno version;
  solver records continue to identify only their OpenModelica/MSL engine identity.

## [0.6.0] - 2026-08-28

### Added

- Generated closed MCP input schemas from the loaded qualified kit registry. They enumerate only
  registered kit/version/scenario branches and reviewed parameter type, unit, bounds and planning
  defaults; 2.1 submission still requires every quantity explicitly.
- Stable `modelica-mcp-error/1.0` business-error records with machine-readable code, field, bounded
  context and recovery guidance.

### Changed

- OpenModelica execution now accepts only the generated `result_res.csv`; a neighbouring CSV can
  never become sealed evidence.
- Corrected the recorded kit-list documentation: exact resource identities are discovered through
  MCP resources, not returned by that tool's historical response shape.

## [0.5.0] - 2026-08-28

### Added

- A non-executing resumable request template bound to an explicitly established runtime manifest
  digest.
- A bounded, deterministic summary of the sealed CSV for completed successful resumable requests.

### Changed

- Read-only resumable evidence projections no longer reconcile or mutate request claims.
- CSV parsing rejects malformed quote placement consistently in series summaries and result
  normalization.

## [0.4.3] - 2026-08-27

- Added the explicit native stdio process path while retaining Streamable HTTP.
