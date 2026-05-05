# Plugins Parity

Donor references are local-only parity metadata for PK-01 through PK-04, plus PK-06.

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
- `codex-rs/core-plugins/src/marketplace_remove.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/marketplace_upgrade.rs` // branding-scan: allow local parity citation

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
- `cli/pluginOperations.ts` owns local plugin list/validate/install/uninstall/enable/disable/disable-all operations using AgenC's existing loader, manifest validator, plugin directories, and global TOML config.
- `cli/PluginInstallationManager.ts` provides an AgenC-owned manager facade over the plugin and marketplace operations.
- `cli/marketplace-add.ts`, `cli/marketplace-remove.ts`, and `cli/marketplace-upgrade.ts` own local and git marketplace staging, validation, atomic activation, private marketplace index writes, removal, and refresh.
- `bin/agenc.ts` routes `agenc plugin ...` before prompt/TUI routing so plugin commands never get treated as user prompts.

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
- Remote marketplace discovery services, signed plugin verification, dependency solving, managed remote settings sync, and marketplace plugin cache/version dependency demotion remain later plugin rows.
- Marketplace add/upgrade supports real git staging through the `git` binary and local filesystem marketplaces. It records source metadata in `$AGENC_HOME/plugins/marketplaces/marketplaces.json` rather than adding a new public config schema before CF-owned config work.
