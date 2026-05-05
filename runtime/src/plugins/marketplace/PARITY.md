# Plugin Marketplace Parity

Donor references are local-only parity metadata for PK-07.

Primary source anchors:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation
- `/home/tetsuo/git/openclaude` at `0ca43335375beec6e58711b797d5b0c4bb5019b8` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/core-plugins/src/marketplace.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/installed_marketplaces.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/remote.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/remote/remote_installed_plugin_sync.rs` // branding-scan: allow local parity citation
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
- `marketplace.ts` owns canonical marketplace source parsing, local/git/url/settings staging, validation, atomic activation, persistent marketplace index reads/writes, plugin entry resolution, local plugin source realpath jailing, and safe removal by computed install root. `addMarketplaceOp` calls `parseMarketplaceInput.ts` for string sources so CLI/add handling cannot drift from the documented parser grammar, and git clone transports reject non-loopback HTTP before invoking `git`.
- `marketplaceManager.ts` owns marketplace cache refresh, config persistence, seed-dir discovery from `AGENC_PLUGIN_SEED_DIR`, source registration/removal, plugin lookup, auto-update toggles, and runtime refresh entry points.
- `marketplaceHelpers.ts` owns policy allow/block matching, host/path pattern handling, marketplace loading degradation, empty-marketplace reason detection, and display formatting.
- `parseMarketplaceInput.ts` owns user input normalization for local paths, git URLs, SSH/file git URLs, HTTP(S) manifests, GitHub shorthand, and GitHub tree URLs with slash-bearing refs when the marketplace path begins at a known marketplace directory marker.
- `officialMarketplace.ts` declares the AgenC-owned official marketplace source.
- `installed_marketplaces.ts` projects persistent marketplace index/config entries into installed marketplace roots.
- `marketplace.ts` rejects malformed plugin entries, missing source fields, unsupported source shapes, traversal sources, non-loopback HTTP plugin git URLs, and duplicate plugin names instead of silently dropping invalid catalog data.
- `remote.ts` owns authenticated remote marketplace listing, installed-plugin listing, detail fetches, skill detail fetches, install/uninstall mutations, HTTPS-by-default remote API transport with explicit loopback opt-in before auth headers can be sent, path-jailed remote cache cleanup, installed remote bundle reconciliation, stale cache and old-version removal, in-flight sync dedupe, cache mutation guards, and JSON response-shape validation before mapping.
- `fetchGuards.ts` owns shared HTTPS/loopback URL policy, timeout/abort handling, stream cancellation on size-limit failures, bounded response reads, and credential-redacted URL formatting for marketplace network surfaces.
- `remote_bundle.ts` owns remote bundle validation, local plugin/marketplace cache identity validation, download-boundary HTTPS/loopback revalidation, size-limited download, safe tar.gz extraction with traversal/link/truncation/checksum rejection, manifest identity verification, versioned cache activation, and manifest readback.
- `remote_legacy.ts` owns the older remote plugin status, featured-plugin, enable, and uninstall endpoints that the runtime may still need while the hosted service migrates, including HTTPS-by-default transport and response-shape validation before mapping.
- `startup_sync.ts` owns startup curated marketplace sync through guarded git, HTTP zipball, and backup archive fallbacks with private SHA tracking, ZIP entry CRC verification, embedded archive identity verification before recording HTTP SHAs, and existing-snapshot degradation.
- `startup_remote_sync.ts` owns one-shot startup remote plugin reconciliation after curated marketplace prerequisites are available, including stale lock recovery, concrete remote bundle reconciliation when no injected manager sync callback is supplied, and no marker write when a separate remote bundle sync is already in flight.
- `marketplaceManager.ts` owns declared-vs-materialized marketplace diffing and reconciliation in addition to marketplace cache/config/source operations.
- `startup_checks.ts` owns the live REPL startup entrypoint for trust-gated seed marketplace registration, declared marketplace reconciliation, curated marketplace sync, cache invalidation, marketplace install-status AppState updates, and remote installed-plugin reconciliation through caller-provided auth or the remote-auth layer. It reads `AGENC_PLUGIN_SEED_DIR` through the existing AgenC plugin directory helper when callers do not inject explicit seed records, resolves seed marketplaces from each seed's `known_marketplaces.json` to the seed's current `marketplaces/<name>` or `marketplaces/<name>.json` content, and forces seed records to `autoUpdate: false`. It marks plugin refresh in `finally` after any successful local cache mutation so later startup failures cannot hide earlier installs. `runtime/src/agenc/upstream/screens/REPL.tsx` imports this AgenC-owned module directly and passes the current trust/config/env state; the old upstream `performStartupChecks.tsx` path is removed so startup no longer routes through upstream marketplace utilities.

Typecheck boundary:
- `runtime/src/types/upstream-ambient.d.ts` is type-only evidence for inherited upstream-mirror imports pulled into the tsc graph by the live REPL startup path. It deliberately declares only the exact upstream module contracts and platform globals already referenced by that graph, exports no runtime values, and is listed in `parity/PK-07-parity.json` so later upstream cleanup can remove it with a visible contract change.

Intentional PK-07 scope reductions:
- Hosted-service auth token vending is not owned here. Callers may pass `RemoteAuth` headers directly, and live startup can derive bearer headers from the remote-auth layer's persisted/bootstrap token state, so PK-07 never reads API key environment variables directly.
- Remote bundle signing and signature verification remain a later plugin row; PK-07 enforces transport, path, and size safety but does not invent a signing backend.
- Dependency solving and plugin demotion are not wired into install/update decisions yet. The inspected dependency/versioning donors are documented so the later dependency row can continue from the same source anchors.
- Full plugin reload/MCP reconnect after startup marketplace reconciliation remains owned by the existing reload/registration path. PK-07 carries marketplace install-status updates and marks plugins for refresh when startup changes local plugin or marketplace cache state.
- The GCS mirror helper is reduced to AgenC-owned startup HTTP/backup fallbacks under `agenc.tech`; no public donor bucket or donor product domain is retained in runtime source.
- Existing PK-06 CLI marketplace modules remain in place as already-merged main work. Live CLI and manager callers now import the canonical PK-07 marketplace layer directly, with no re-export wrapper.
