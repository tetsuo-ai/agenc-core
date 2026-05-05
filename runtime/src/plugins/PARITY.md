# Plugins Parity

Donor references are local-only parity metadata for PK-01 and PK-02.

Primary source anchors:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation
- `/home/tetsuo/git/openclaude` at `0ca43335375beec6e58711b797d5b0c4bb5019b8` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/core-plugins/src/loader.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/manifest.rs` // branding-scan: allow local parity citation
- `codex-rs/core-plugins/src/loader_tests.rs` // branding-scan: allow local parity citation
- `src/utils/plugins/pluginLoader.ts`
- `src/utils/plugins/pluginDirectories.ts`
- `src/utils/plugins/validatePlugin.ts`
- `src/utils/plugins/schemas.ts`

PK-01 scope carried into AgenC:
- `manifest.ts` owns `.agenc-plugin/plugin.json` discovery, root `plugin.json` fallback, bounded JSON reads, and JSON parse errors.
- `directories.ts` owns plugin cache/data/seed directory selection with AgenC environment variables.
- `loader.ts` owns local plugin root discovery, component discovery, hook source loading, MCP/LSP/app config extraction, and enabled/disabled load results.
- `validation.ts` owns author-facing manifest and Markdown component metadata validation.

PK-02 scope carried into AgenC:
- `manifest-schema.ts` owns plugin.json type definitions, shape validation, safe manifest path resolution, dependency/default-prompt normalization, interface metadata, user configuration option validation, and channel declaration preservation.
- `manifest.ts` imports the schema normalizer for parsed plugin.json data and does not re-export schema-owned helpers as a compatibility surface.
- `loader.ts` and `validation.ts` import schema-owned types/helpers from `manifest-schema.ts` directly and filesystem-owned helpers from `manifest.ts`.

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
