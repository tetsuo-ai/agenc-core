# Plugin Marketplace Parity

Donor references are local-only parity metadata for PK-07.

Primary source anchors:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation
- `/home/tetsuo/git/openclaude` at `0ca43335375beec6e58711b797d5b0c4bb5019b8` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/core-plugins/src/marketplace.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/installed_marketplaces.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/remote.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/remote_bundle.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/remote_legacy.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/startup_sync.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/startup_remote_sync.rs` // branding-scan: allow local parity citation
- `src/utils/plugins/marketplaceManager.ts`
- `src/utils/plugins/marketplaceHelpers.ts`
- `src/utils/plugins/parseMarketplaceInput.ts`
- `src/utils/plugins/officialMarketplace.ts`
- `src/utils/plugins/officialMarketplaceGcs.ts`
- `src/utils/plugins/officialMarketplaceStartupCheck.ts`
- `src/utils/plugins/headlessPluginInstall.ts`
- `src/utils/plugins/pluginAutoupdate.ts`
- `src/utils/plugins/refresh.ts`
- `src/utils/plugins/performStartupChecks.tsx`
- `src/utils/plugins/dependencyResolver.ts`
- `src/utils/plugins/pluginVersioning.ts`

PK-07 scope carried into AgenC:
- `marketplace.ts` owns canonical marketplace source parsing, local/git/url/settings staging, validation, atomic activation, persistent marketplace index reads/writes, plugin entry resolution, and safe removal by computed install root. `addMarketplaceOp` calls `parseMarketplaceInput.ts` for string sources so CLI/add handling cannot drift from the documented parser grammar, and git clone transports reject non-loopback HTTP before invoking `git`.
- `marketplaceManager.ts` owns marketplace cache refresh, config persistence, source registration/removal, plugin lookup, auto-update toggles, and runtime refresh entry points.
- `marketplaceHelpers.ts` owns policy allow/block matching, host/path pattern handling, marketplace loading degradation, empty-marketplace reason detection, and display formatting.
- `parseMarketplaceInput.ts` owns user input normalization for local paths, git URLs, SSH/file git URLs, HTTP(S) manifests, GitHub shorthand, and GitHub tree URLs with slash-bearing refs when the marketplace path begins at a known marketplace directory marker.
- `officialMarketplace.ts` declares the AgenC-owned official marketplace source.
- `installed_marketplaces.ts` projects persistent marketplace index/config entries into installed marketplace roots.
- `marketplace.ts` rejects malformed plugin entries, missing source fields, unsupported source shapes, traversal sources, non-loopback HTTP plugin git URLs, and duplicate plugin names instead of silently dropping invalid catalog data.
- `remote.ts` owns authenticated remote marketplace listing, installed-plugin listing, detail fetches, skill detail fetches, install/uninstall mutations, remote cache cleanup, and JSON response-shape validation before mapping.
- `fetchGuards.ts` owns shared HTTPS/loopback URL policy, timeout/abort handling, stream cancellation on size-limit failures, bounded response reads, and credential-redacted URL formatting for marketplace network surfaces.
- `remote_bundle.ts` owns remote bundle validation, download-boundary HTTPS/loopback revalidation, size-limited download, safe tar.gz extraction with traversal/link/truncation/checksum rejection, manifest identity verification, versioned cache activation, and manifest readback.
- `remote_legacy.ts` owns the older remote plugin status, featured-plugin, enable, and uninstall endpoints that the runtime may still need while the hosted service migrates, including response-shape validation before mapping.
- `startup_sync.ts` owns startup curated marketplace sync through git, HTTP zipball, and backup archive fallbacks with private SHA tracking and existing-snapshot degradation.
- `startup_remote_sync.ts` owns one-shot startup remote plugin reconciliation after curated marketplace prerequisites are available, including stale lock recovery.

Intentional PK-07 scope reductions:
- Hosted-service auth token vending is not owned here. Callers pass `RemoteAuth` headers from the auth layer so PK-07 never reads API key environment variables directly.
- Remote bundle signing and signature verification remain a later plugin row; PK-07 enforces transport, path, and size safety but does not invent a signing backend.
- Dependency solving and plugin demotion are not wired into install/update decisions yet. The inspected dependency/versioning donors are documented so the later dependency row can continue from the same source anchors.
- UI refresh notifications and marketplace-specific TUI status transitions are not carried here; PK-07 exposes runtime functions that later UI rows can call.
- The GCS mirror helper is reduced to AgenC-owned startup HTTP/backup fallbacks under `agenc.tech`; no public donor bucket or donor product domain is retained in runtime source.
- Existing PK-06 CLI marketplace modules remain in place as already-merged main work. Live CLI and manager callers now import the canonical PK-07 marketplace layer directly, with no re-export wrapper.
- The small upstream-mirror diff in `runtime/src/agenc/upstream/utils/{envUtils,protectedNamespace}.ts` is conflict cleanup from integrating main: the existing caller and helper export disagreed on the protected-namespace helper name, and touching the file required an inline provider-name branding allow comment. This is not a PK-07 runtime surface and remains scheduled for the mirror cleanup/absorb work.
