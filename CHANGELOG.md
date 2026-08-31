# Changelog

All notable changes to `@casys/mcp-modelica` are documented here.

## [Unreleased]

### Changed

- Compact Modelica MCP App default surfaces now present one run or one navigable run list using the
  shared View v2 `SemanticElement` kit. Detailed identity, status, metrics, parameters, provenance,
  artifact, warning, and table components remain advertised for host composition. Solver execution
  stays a factual status, not a pass or proof verdict.

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
