# Plugins Parity

Donor references are local-only parity metadata for PK-01 through PK-04, plus PK-06, PK-07, and PK-09.

Primary source anchors:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation
- `/home/tetsuo/git/openclaude` at `0ca43335375beec6e58711b797d5b0c4bb5019b8` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/core-plugins/src/loader.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/manifest.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/loader_tests.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/manager.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/toggles.rs` // branding-scan: allow local parity citation
- `src/utils/plugins/pluginLoader.ts`
- `src/utils/plugins/pluginDirectories.ts`
- `src/utils/plugins/validatePlugin.ts`
- `src/utils/plugins/schemas.ts`
- `src/utils/plugins/loadPluginHooks.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/plugins/loadPluginAgents.ts`
- `src/utils/plugins/loadPluginOutputStyles.ts`
- `src/utils/plugins/mcpPluginIntegration.ts`
- `src/utils/plugins/lspPluginIntegration.ts`
- `src/utils/plugins/pluginPolicy.ts`
- `src/utils/plugins/pluginBlocklist.ts`
- `src/utils/plugins/pluginFlagging.ts`
- `src/utils/plugins/managedPlugins.ts`
- `src/services/plugins/pluginCliCommands.ts`
- `src/services/plugins/pluginOperations.ts`
- `src/services/plugins/PluginInstallationManager.ts`
- `codex-rs/core-plugins/src/marketplace_add.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_add/install.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_add/metadata.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_add/source.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_remove.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_upgrade.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_upgrade/activation.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_upgrade/git.rs` // branding-scan: allow local parity citation
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
- `codex-rs/core-plugins/src/store.rs` // branding-scan: allow local parity citation
- `src/utils/plugins/pluginIdentifier.ts`
- `src/utils/plugins/cacheUtils.ts`
- `src/utils/plugins/zipCache.ts`
- `src/utils/plugins/fetchTelemetry.ts`

PK-01 scope carried into AgenC:
- `manifest.ts` owns `.agenc-plugin/plugin.json` discovery, root `plugin.json` fallback, bounded JSON reads, and JSON parse errors.
- `directories.ts` owns plugin cache/data/seed directory selection with AgenC environment variables.
- `loader.ts` owns local plugin root discovery, component discovery, hook source loading, MCP/LSP/app config extraction, and enabled/disabled load results.
- `validation.ts` owns author-facing manifest and Markdown component metadata validation.

PK-02 scope carried into AgenC:
- `manifest-schema.ts` owns plugin.json type definitions, shape validation, safe manifest path resolution, dependency/default-prompt normalization, interface metadata, user configuration option validation, and channel declaration preservation.
- `manifest.ts` imports the schema normalizer for parsed plugin.json data and does not re-export schema-owned helpers as a compatibility surface.
- `loader.ts` and `validation.ts` import schema-owned types/helpers from `manifest-schema.ts` directly and filesystem-owned helpers from `manifest.ts`.

PK-03 scope carried into AgenC:
- `registration/load-plugin-commands.ts` projects enabled plugin command declarations and skill directories into runtime `Command` records, including frontmatter metadata, argument substitution, and AgenC plugin template variables.
- `registration/load-plugin-agents.ts` projects enabled plugin agent Markdown into `PluginAgentDefinition` records while preserving the plugin-agent trust boundary by ignoring per-agent permission, hook, and MCP escalation fields.
- `registration/load-plugin-hooks.ts` merges enabled plugin hook sources into AgenC `HooksMap` values and substitutes AgenC plugin/session template variables before runtime registration.
- `registration/mcp-plugin-integration.ts` and `registration/lsp-plugin-integration.ts` namespace plugin server declarations as `plugin:<plugin>:<server>`, inject AgenC plugin environment variables, and substitute local plugin paths.
- `registration/load-plugin-output-styles.ts` loads plugin output-style Markdown into runtime prompt-style records.
- `registration/manager.ts` owns active plugin-surface refresh for `/reload-plugins`, AppState updates, and MCP/LSP config projection.
- `commands.ts`, `commands/reload-plugins.ts`, and `tools/AgentTool/loadAgentsDir.ts` now use the AgenC-owned registration layer instead of the upstream mirror plugin loaders.

PK-04 scope carried into AgenC:
- `policy.ts` owns managed plugin enablement checks, managed marketplace plugin-name extraction, and manifest capability permission decisions.
- `toggles.ts` owns extraction of pending plugin enabled-state edits from direct, per-plugin table, and root table config writes.
- `blocklist.ts` owns marketplace delisting detection, injected delisted-plugin uninstall enforcement, flagged-plugin parsing, 48-hour seen expiry, and private atomic `flagged-plugins.json` writes.
- `pluginPolicy.ts` maps to `policy.ts` via `isPluginBlockedByPolicy`.
- `managedPlugins.ts` maps to `policy.ts` via `getManagedPluginNames`.
- `pluginBlocklist.ts` maps to `blocklist.ts` via `detectDelistedPlugins` and `detectAndUninstallDelistedPlugins`.
- `pluginFlagging.ts` maps to `blocklist.ts` via `FlaggedPluginStore` and pure flagged-plugin state helpers.
- `core-plugins/src/toggles.rs` maps to `toggles.ts` via `collectPluginEnabledCandidates`. // branding-scan: allow local parity citation

PK-06 scope carried into AgenC:
- `cli/pluginCliCommands.ts` owns `agenc plugin` argument parsing, terminal output, and subcommand dispatch.
- `cli/pluginOperations.ts` owns local plugin list/validate/install/uninstall/update/enable/disable/disable-all operations using AgenC's existing loader, manifest validator, plugin directories, and global TOML config.
- `cli/PluginInstallationManager.ts` provides an AgenC-owned manager facade over the plugin and marketplace operations available in PK-06.
- `cli/marketplace-add.ts`, `cli/marketplace-remove.ts`, and `cli/marketplace-upgrade.ts` own local and git marketplace staging, validation, atomic activation, private marketplace index writes, removal, and refresh.
- `bin/agenc.ts` routes `agenc plugin ...` before prompt/TUI routing so plugin commands never get treated as user prompts.

PK-07 scope carried into AgenC:
- `marketplace/marketplace.ts` owns canonical marketplace source parsing, local/git/url/settings staging, validation, atomic activation, persistent marketplace index reads/writes, plugin entry resolution, and safe removal by computed install root. String add/CLI inputs use `parseMarketplaceInput.ts`, malformed plugin entries fail explicitly instead of being silently skipped, staged plugin sources are resolved before activation so bad catalogs cannot be persisted, URL marketplace records omit request headers and redact credential-bearing URLs before persistence, local plugin source paths are realpath-jailed under the marketplace root, and git clone sources reject leading-dash operands, unsupported transports, unsafe refs, and non-loopback HTTP before invoking `git`; clone calls pass repository operands after `--`.
- `marketplace/marketplaceManager.ts` owns marketplace cache refresh, config persistence, seed-dir discovery from `AGENC_PLUGIN_SEED_DIR`, source registration/removal, declared-vs-materialized marketplace diffing/reconciliation, plugin lookup, auto-update toggles, and runtime refresh entry points.
- `marketplace/marketplaceHelpers.ts` owns policy allow/block matching, host/path pattern handling, marketplace loading degradation, empty-marketplace reason detection, and display formatting.
- `marketplace/parseMarketplaceInput.ts` owns user input normalization for local paths, git URLs, SSH/file git URLs, HTTP(S) manifests, GitHub shorthand, and GitHub tree refs with slash-bearing branch names when the marketplace path starts at a known marker.
- `marketplace/officialMarketplace.ts` declares the AgenC-owned official marketplace source.
- `marketplace/installed_marketplaces.ts` projects persistent marketplace index/config entries into installed marketplace roots.
- `marketplace/remote.ts` owns authenticated remote marketplace listing, installed-plugin listing, detail fetches, skill detail fetches, install/uninstall mutations, HTTPS-by-default remote API transport with explicit loopback opt-in before auth headers can be sent, path-jailed remote cache cleanup, installed remote bundle reconciliation, stale cache and old-version removal after fully successful installed-plugin reconciliation, in-flight sync dedupe, cache mutation guards, and remote JSON response-shape validation.
- `marketplace/fetchGuards.ts` owns shared HTTPS/loopback URL policy, timeout/abort handling, stream cancellation on size-limit failures, bounded response reads, and credential-redacted URL formatting for marketplace network surfaces.
- `marketplace/remote_bundle.ts` owns remote bundle validation, local plugin/marketplace cache identity validation, download-boundary HTTPS/loopback revalidation, size-limited download, safe async tar.gz decompression/extraction with traversal/link/truncation/checksum rejection, manifest identity verification, versioned cache activation, and manifest readback.
- `marketplace/remote_legacy.ts` owns the older remote plugin status, featured-plugin, enable, and uninstall endpoints that the runtime may still need while the hosted service migrates, including HTTPS-by-default transport and response-shape validation before mapping.
- `marketplace/startup_sync.ts` owns startup curated marketplace sync through guarded git, HTTP zipball, and backup archive fallbacks with private SHA tracking, valid curated snapshot detection, hidden staging-dir cleanup that cannot collide with valid marketplace names, async ZIP entry decompression, ZIP entry CRC verification, embedded archive identity verification before recording HTTP SHAs, and existing-snapshot degradation.
- `marketplace/startup_remote_sync.ts` owns one-shot startup remote plugin reconciliation after curated marketplace prerequisites are available, including stale lock recovery, concrete remote bundle reconciliation when no injected manager sync callback is supplied, failure propagation for partial remote bundle reconciliation, and no marker write when a separate remote bundle sync is already in flight or any concrete remote bundle failed.
- `marketplace/startup_checks.ts` owns the live REPL startup entrypoint for trust-gated seed marketplace registration, declared marketplace reconciliation, curated marketplace sync, cache invalidation, marketplace install-status AppState updates, and remote installed-plugin reconciliation through caller-provided auth, an injected remote-sync callback, or the remote-auth layer. It reads `AGENC_PLUGIN_SEED_DIR` through the existing AgenC plugin directory helper when callers do not inject explicit seed records, validates seed marketplace names before path lookup, resolves seed marketplaces from each seed's `known_marketplaces.json` to the seed's current `marketplaces/<name>` or `marketplaces/<name>.json` content, rewrites stale seed source metadata to the resolved local seed path, and forces seed records to `autoUpdate: false`. It marks plugin refresh in `finally` after any successful local cache mutation, including remote enable/disable-only changes, so later startup failures cannot hide earlier installs. `runtime/src/agenc/upstream/screens/REPL.tsx` imports this AgenC-owned module directly and passes the current trust/config/env state; the old upstream `performStartupChecks.tsx` path is removed so startup no longer routes through upstream marketplace utilities.

PK-07 typecheck boundary:
- The May 5, 2026 main merge owns the remaining temporary upstream-mirror ambient declarations in `runtime/src/types/runtime-ambient.d.ts`. PK-07 no longer ships a separate `runtime/src/types/upstream-ambient.d.ts` file, and its live startup path relies on that shared main-owned boundary until the upstream mirror cleanup removes the inherited imports.

PK-09 scope carried into AgenC:
- `resolution.ts` owns plugin source classification and resolution for local directories, npm package specs, git URLs, registry tarballs, and local or remote `.mcpb` bundles.
- `resolution.ts` owns remote materialization through real `npm pack`, `git clone`, `tar`, and `unzip` subprocesses, with bounded stdout/stderr and timeouts.
- `resolution.ts` owns source validation for npm package specs and git repository specs before subprocess launch; npm and git calls pass remote specs after `--` separators.
- `resolution.ts` owns archive listing checks, pre-extraction tar/link/device/FIFO/socket and zip metadata checks, extraction-root containment checks, unsupported extracted entry rejection, extracted file/count/depth quotas, bounded downloads with same-origin redirect enforcement, and plugin cache activation under `$AGENC_HOME/plugins/cache/` using redacted source labels plus source-hash cache keys, VCS metadata stripping, lock directories, stale-lock expiry, refresh bypasses, concurrent same-source serialization, and cache-hit telemetry.
- `resolution.ts` owns Ed25519 plugin signature verification using `.agenc-plugin/signature.json`, manifest digests, payload file digests, and trusted publisher keys from `$HOME/.agenc/plugin-publishers.json` or an injected keyring path. Remote resolver paths require signatures by default unless the caller explicitly opts out for trusted fixture/local policy flows. AgenC-owned install metadata is excluded from publisher payload digests so installed signed plugins remain auditable after `.agenc-plugin/agenc-install.json` is written, and signature payload hashing enforces the same count/size/depth quotas as archive extraction.
- `resolution.ts` owns dependency ID qualification, dependency version-constraint preservation for caret, exact, tilde, and comparison operators, semver-compatible prerelease/build metadata comparison, transitive dependency closure with cycle/cross-marketplace/version checks, load-time dependency demotion decisions, and reverse-dependent lookup as pure functions.
- `manifest-schema.ts` preserves dependency version constraints from both string dependencies and object-form `version` / `versionConstraint` entries so downstream dependency demotion enforces the normalized constraint instead of silently dropping it.
- `loader.ts` applies dependency demotion to actual load results so plugins with missing or disabled dependencies do not remain enabled at runtime.
- `cli/pluginOperations.ts` now routes non-directory install sources through the resolver before copying into the user/project/local plugin store, requires trusted signatures for remote installs by default, strips VCS metadata from install copies, reserves internal plugin-store names such as `cache` and `data`, records resolution metadata and dependency identity in `.agenc-plugin/agenc-install.json`, and forces cache refresh for plugin updates.
- `loader.ts` reads installed plugin metadata when discovering user/project/local plugin roots so installed remote plugins retain the dependency identity they were installed from instead of falling back to filesystem paths.
- `registration/manager.ts` serializes dependency-load issues into the active plugin snapshot for UI/runtime consumers.
- `resolution.test.ts` and `loader.test.ts` cover npm resolution priority for ambiguous package-like names, installed remote dependency identity retention, source hardening before subprocess launch, credential redaction in metadata/telemetry/process errors/cache labels, resolver and install-operation default remote signature enforcement, signed git resolution with cache VCS metadata stripping, installed signed-plugin re-verification after install metadata is written, install-copy VCS metadata stripping, internal install-name rejection, install-operation resolver wiring and update refresh, object-form dependency version-constraint preservation/rejection, git cache hits, corrupt-cache rematerialization when signatures are optional, stale-lock expiry, concurrent same-source cache serialization, real gzip/plain tar and zip extraction, cross-origin archive redirect rejection, archive traversal rejection, zip symlink and unsupported tar entry rejection, pre-extraction and post-extraction quota rejection, signature payload quota rejection, remote `.mcpb` extraction, loader dependency demotion/cycle demotion, local path dependency identities when workspace paths contain `@`, duplicate-name dependency ambiguity, dependency version mismatch handling including zero-major caret boundaries, prerelease/build/malformed versions, dependency closure/demotion, Ed25519 payload verification, telemetry outcomes, and source classification.

ZC-30 coverage lock:
- The plugin-engine source anchors above cover the PK-01 through PK-09 plugin rows that previously lacked a single tracked coverage closure. `scripts/goal/verify.mjs` now checks those anchors and the AgenC-owned counterpart files before ZC-30 can complete.

Intentional PK-01 scope reductions:
- Marketplace fetch/install/cache refresh, signing, dependency demotion, plugin CLI, plugin sandboxing, policy/blocklist, MCP/LSP live registration, and remote sync are later PK rows.
- Marketplace schema policy and remote registry validation remain later PK rows; PK-01 validates local plugin manifests and local Markdown component metadata.
- PK-01 extracts hooks, MCP servers, LSP servers, settings, and app connector IDs for discovery. Runtime registration and policy application for those extracted outputs remain later PK rows.
- Donor manifest directories are not carried. AgenC uses `.agenc-plugin/plugin.json`; root `plugin.json` remains a fallback for minimal local plugins.
- Donor `pluginLoader.ts` and `pluginDirectories.ts` are split into behavior-named AgenC modules. No compatibility wrapper is created.
- `.typecheck-baseline.json` is committed because the strengthened goal verifier requires an explicit inherited-error baseline before any item can complete; PK-01 does not add TypeScript errors.

Intentional PK-02 scope reductions:
- Marketplace fetch/install/cache refresh, source schemas, reserved marketplace-name policy, installed-plugin metadata, remote registry validation, and dependency resolution/demotion remain later PK rows.
- MCPB/DXT bundle path and URL declarations in `mcpServers` are intentionally rejected in PK-02 because the current AgenC plugin loader only reads local JSON MCP server maps. Bundle install/extraction belongs with later plugin runtime and marketplace rows (PK-03/PK-09).
- LSP `transport`, `settings`, `shutdownTimeout`, and `restartOnCrash` manifest fields are intentionally rejected in PK-02 because AgenC's current LSP config input does not carry them. Preserving those fields belongs with later plugin runtime integration.
- PK-02 validates and preserves `channels` declarations in the manifest; live channel registration and policy application remain later runtime integration work.
- PK-02 keeps the existing hand-rolled AgenC schema normalizer instead of adding a runtime schema dependency.

Intentional PK-03 scope reductions:
- Marketplace fetch/install/cache refresh, remote plugin sync, plugin UI, plugin sandbox install policy, and dependency resolution remain later PK rows.
- Shell-command expansion inside plugin prompt Markdown is not carried. PK-03 performs argument and plugin template substitution only; command execution from prompt text stays out of the registration layer.
- MCPB/DXT bundle extraction is not carried. PK-03 registers normalized local MCP server maps emitted by `loader.ts`; bundle extraction remains a later plugin-runtime/marketplace row.
- Plugin output styles are loaded and exposed in the active refresh snapshot, but full TUI style selection remains with the output-style/prompt integration rows.
- Donor filenames using camelCase map to AgenC-owned kebab-case registration files. `manager.rs` maps to `registration/manager.ts`; the split avoids a re-export-only barrel and keeps each runtime surface independently testable.
- `commands/cache-stats.ts` includes a defensive fallback because the PK-03 command-surface regression test imports command modules from both repo-root and runtime-root Vitest invocations; the fallback keeps `/cache-stats` usable when the optional upstream tracker module is absent from that execution graph.

Intentional PK-04 scope reductions:
- Marketplace fetch/install/cache refresh and plugin CLI operations remain later PK rows. `blocklist.ts` exposes dependency-injected enforcement so those rows can wire the real installation manager without importing deleted runtime surfaces here.
- Managed settings are modeled as explicit function inputs rather than loading a global settings singleton. AgenC config normalization for the final `plugins.{enabled,allowlist,plugins}` shape belongs to CF-10.
- Flagged-plugin storage writes under the caller-provided plugin directory. Directory selection remains owned by `directories.ts`.

Intentional PK-06 scope reductions:
- AgenC's current runtime only loads user-level `config.toml`; `project` and `local` plugin install scopes map to workspace `.agents/plugins` discovery, while enable/disable writes remain global TOML entries until tiered config persistence lands.
- `agenc plugin update` refreshes local installs from an explicit or recorded local source. Remote marketplace cache version selection, dependency demotion, and managed plugin update orchestration remain later plugin rows.
- `PluginInstallationManager.ts` is scoped to CLI operation orchestration in PK-06. Background marketplace reconciliation, UI status transitions, plugin-cache clearing, and runtime refresh notifications remain with later startup/runtime plugin integration rows.
- Remote marketplace discovery services, signed plugin verification, dependency solving, managed remote settings sync, and marketplace plugin cache/version dependency demotion remain later plugin rows.
- Marketplace add/upgrade supports real git staging through the `git` binary and local filesystem marketplaces. It records source metadata in `$AGENC_HOME/plugins/marketplaces/marketplaces.json` rather than adding a new public config schema before CF-owned config work.

Intentional PK-07 scope reductions:
- Hosted-service auth token vending is not owned here. Callers may pass `RemoteAuth` headers directly, and live startup can derive bearer headers from the remote-auth layer's persisted/bootstrap token state, so PK-07 never reads API key environment variables directly.
- Remote bundle signing and signature verification remain a later plugin row; PK-07 enforces transport, path, and size safety but does not invent a signing backend.
- Dependency solving and plugin demotion are not wired into install/update decisions yet. The inspected dependency/versioning donors are documented so the later dependency row can continue from the same source anchors.
- Full plugin reload/MCP reconnect after startup marketplace reconciliation remains owned by the existing reload/registration path. PK-07 carries marketplace install-status updates and marks plugins for refresh when startup changes local plugin or marketplace cache state.
- The GCS mirror helper is reduced to AgenC-owned startup HTTP/backup fallbacks under `agenc.tech`; no public donor bucket or donor product domain is retained in runtime source.
- Existing PK-06 CLI marketplace modules remain in place as already-merged main work. Live CLI and manager callers now import the canonical PK-07 marketplace layer directly, with no re-export wrapper.

Intentional PK-09 scope reductions:
- Dependency closure and load-time demotion are enforced in PK-09, including rejecting cross-marketplace dependencies before already-enabled shortcuts, preserving manifest dependency version constraints, and demoting live plugins whose enabled dependency version does not satisfy the declared caret/exact/tilde/comparison constraint. This item does not mutate user settings to auto-install dependency closures because the final tiered settings writer is still owned by later config rows.
- Registry tarball support is implemented as URL tarball materialization. Marketplace search/discovery and hosted registry APIs remain outside `agenc-core`.
- `.mcpb` support extracts local bundle files and fetched remote bundles through the system `unzip` command.
- Signature verification trusts explicit publisher keys and requires signed payload digests. Full marketplace publisher policy and revocation remain local data concerns for later remote-sync rows.
- `runtime/src/agenc/upstream/utils/protectedNamespace.ts` and `runtime/src/agenc/upstream/utils/settings/constants.ts` carry minimal no-growth compile-fix compatibility for existing upstream-mirror callers until Z-02 deletes that tree. PK-09 does not add new mirror files, does not import the mirror from live plugin code, and leaves ownership of the temporary mirror surface with the pre-existing mirror cleanup track.
- The previous broad compile-only ambient declaration file was removed after review. The May 5, 2026 `main` merge now owns the remaining temporary upstream-mirror ambient declarations in `runtime/src/types/runtime-ambient.d.ts`; PK-09 does not add separate type shim modules.
- Merge conflict note: the May 5, 2026 merge from `main` also changed `runtime/src/llm/api/http.ts` to derive request-body typing from `RequestInit`; PK-09 took `main`'s direct `RequestInit["body"]` / `NonNullable<RequestInit["body"]>` form for the same-line conflict.
