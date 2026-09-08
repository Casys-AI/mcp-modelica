# Changelog

All notable changes to `@casys/mcp-modelica` are documented here.

## [Unreleased]

### Added

- Each currently shipped kit identity (`coffee-machine-v1@0.1.0`, `linear-thermal-ramp-v1@0.1.0`)
  now has an explicit server-owned OpenModelica 1.27.0 / MSL 4.1.0 compatibility policy. Native host
  drift fails closed as machine-readable `runtime_incompatible` before dispatch. An unknown kit or
  version fails closed as `compatibility-policy-unavailable` and is not implicitly qualified.
  Historical ledgers remain readable and are not rewritten.
- New runs persist optional `execution-attestation/1.0` inside `evidence.json`, binding the existing
  input fingerprint or 2.1 request identity, engine, generated-script digest, terminal status, and
  SHA-256 of the raw CSV and compiler stdout/stderr bytes captured before decode or trim. Raw CSV
  capture is distinct from persisted `result.csv`: a captured digest is retained when 2.1
  normalization fails without writing that artifact, and invalid UTF-8 is `rejected` with the raw
  digest rather than reported absent. The recorded 2.0 fingerprint stays an input identity. Replay
  validates a present attestation strictly and continues to accept historical evidence that omits
  it.
- A post-publication verifier, sequenced after both the JSR and GHCR tag workflows succeed, hashes
  published OCI index/manifest/config bytes against their advertised digests, binds the published
  README to its JSR checksum, and reads the published `deno.json` version. JSR metadata does not
  prove git commit provenance independently. A failed or partial check is never announced as
  verified.

### Changed

- The MCP View kit pin is `b08802df353bb25d25a1c8d64b22ea61b5287ae0` (`@casys/mcp-view` 0.9.3,
  contracts 0.1.0, `@casys/mcp-view-components` 0.9.0) in the three workflows and the viewer
  lockfile. The App keeps its own `createMcpApp` lifecycle.
- The admitted execution viewer uses `FocusedView`: documentary/recorded state and termination
  remain visible, all recorded metrics stay primary, and scenario / parameters / admission /
  artifacts / provenance are in a native closed technical disclosure. Labels remain English; numeric
  formatting preserves a valid host locale and explicitly falls back to English.
- The documentation capture harness declares `locale: "en-US"` and container dimensions consistent
  with the other providers; `--lang=en-US` and `--force-device-scale-factor=2` are now passed to
  Chrome, which is also found at its macOS application path. The sandboxed App frame is kept in the
  page's renderer (`--disable-features=IsolateSandboxedIframes`): in its own process the handshake
  escaped the virtual-time budget and the capture showed the loading state. A missing executable now
  fails as `CAPTURE_TOOL_MISSING`.
- The README screenshot is regenerated from the committed bundle; the solver tolerance is printed in
  scientific notation (`1E-6`) instead of rounding to `0`.
- The packaged README uses temporally neutral deployment wording: the runnable `docker run` takes
  `MODELICA_IMAGE_DIGEST` from verified evidence, the version tag is only a post-publication
  resolution name, and no historical matching-image digest is presented as this package release.

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
