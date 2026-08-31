# Skills & plugins reference

Sources of truth:

| Area | Path |
| --- | --- |
| Skill load / `SKILL.md` | `runtime/src/skills/local-loader.ts` |
| Bundled skills | `runtime/src/skills/bundledSkills.ts` |
| MCP skills | `runtime/src/skills/mcpSkills.ts` |
| Plugin load / dirs | `runtime/src/plugins/loader.ts`, `directories.ts` |
| Manifest | `runtime/src/plugins/manifest.ts`, `manifest-schema.ts` |
| Registration | `runtime/src/plugins/registration/*` |
| CLI | `runtime/src/plugins/cli/pluginCliCommands.ts` → `agenc plugin` |
| Marketplace | `runtime/src/plugins/marketplace/` |
| Config | `[plugins]` in [config.md](config.md) |

---

## Skills

### Concept

A skill is a directory containing **`SKILL.md`**: YAML frontmatter + markdown
body. On invocation the body is rendered (argument substitution); listing uses
frontmatter only (name, description, when-to-use) for token budget.

### Load paths (`discoverSkillRoots`)

Existing directories only (missing roots skipped). Project walk: cwd up to home.

| Scope | Typical roots |
| --- | --- |
| Project | `<dir>/.agenc/skills`, `<dir>/.agents/skills` |
| User | `$AGENC_HOME/skills`, `$HOME/.agents/skills` |
| Managed | `$AGENC_MANAGED_HOME/.agenc/skills` |
| Plugin | Skill roots exposed by enabled plugins |
| Bundled / MCP | Built-in definitions and MCP-sourced skills |

The runtime command catalog and `/skills` use this same discovery result.
`/skills` can list roots and manage project skills; bundled skills are tagged
`[bundled]`.

### Bundled skills

| Name | Purpose |
| --- | --- |
| `browser-automation` | Snapshot → act → re-snapshot workflow for the LIVE `Browser` tool ([browser.md](../browser.md)) |
| `agenc-marketplace-kit-installer` | Marketplace kit install helper |
| `iot-builder` | IoT/embedded project builder: measurement-first hardware identification, toolchain selection (PlatformIO, Arduino CLI, ESP-IDF, MicroPython, SBC cross-compile), build → flash → serial-monitor loop, flash backup before first overwrite, and an electrical-safety checklist. Extracts per-board and per-toolchain reference files on first invoke |
| `zeroday-hunter` | See shipped plugins below (not `bundledSkills.ts`) |

### `SKILL.md` frontmatter (high level)

Parsed fields include:

| Field | Role |
| --- | --- |
| `name` | Display name (directory name is the invocable id) |
| `description` | Listing / model-facing blurb |
| `when_to_use` | Guidance for auto-invocation |
| `argument-hint` / `arguments` | Argument names / hint |
| `allowed-tools` | Tool allowlist for the skill run |
| `model` | Optional model override |
| `user-invocable` | Default true |
| `disable-model-invocation` | Hide from model-driven invoke |
| `context` | `inline` \| `fork` |
| `agent` / `effort` / `shell` | Execution hints |
| `paths` | Path filters |
| `hooks` | Optional hook map (validated when present) |
| `version` | Optional |

Author under e.g. `.agenc/skills/my-skill/SKILL.md` in the project or
`$AGENC_HOME/skills/my-skill/SKILL.md` for user-global skills.

---

## Plugins

### Defaults

- `[plugins] enabled = false` in `defaultConfig()`
- User-scoped installs, acquisition cache, marketplace inventory, and private
  data share one plugin storage root. The default is `$AGENC_HOME/plugins`.
  `AGENC_PLUGIN_CACHE_DIR` replaces that root as one unit. Project-scoped
  packages remain under the project path shown in the CLI section.
- Plugin private data uses a collision-resistant child name:
  `<plugin-storage-root>/data/<readable-id>--<sha256>/`.

### Manifest

Every plugin requires exactly one manifest at `.agenc-plugin/plugin.json`.
Its `name` is a lowercase canonical identifier made from letters, digits,
periods, underscores, and hyphens. Installed aliases may use the qualified
form `name@marketplace`; that exact ID owns configuration, secrets, and data.
Component-only directories and marketplace metadata cannot synthesize a live
plugin. A root
`plugin.json` is retired: AgenC refuses to load the package and tells the
operator to move the manifest or reinstall the plugin. Ordinary loading never
rewrites plugin package content.

The loader never discovers internal storage children as active plugin
packages. The reserved names are `build`, `cache`, `coverage`, `data`, `dist`,
`marketplaces`, and `node_modules` (case-insensitive). Installed packages
become live only through the canonical loader and config path; acquisition
artifacts cannot become a second plugin authority merely by existing under
the storage root. No registry or cache loader supplies packages from another
root. If different roots resolve to the same canonical plugin ID, every copy
is disabled and the diagnostic lists all conflicting roots.

On first discovery after an upgrade, AgenC moves an old private-data directory
to the hashed layout only when its owner is provable. A lossy old path that
could belong to more than one canonical ID is left untouched and disables the
affected plugin with the exact source and destination paths. AgenC never reads
both layouts as live state.

MCP declarations live only in the manifest's `mcpServers` field. A package
containing `.mcp.json` is rejected with guidance to move those declarations
into the manifest. Hooks, LSP, and app descriptor files are loaded only when
the manifest explicitly references them through `hooks`, `lspServers`, or
`apps`; conventional filenames are never discovered implicitly. An
undeclared `hooks/hooks.json`, `.lsp.json`, or `.app.json` fails closed instead
of becoming a second authority.

`PluginManifest` may declare:

| Field | Registration surface |
| --- | --- |
| `commands` | Slash / prompt commands |
| `agents` | Agent definitions |
| `skills` | Skill roots / files |
| `hooks` | Lifecycle hooks map |
| `mcpServers` | Outbound MCP server configs |
| `lspServers` | LSP server configs |
| `outputStyles` | Output styles |
| `apps` / `channels` / `userConfig` | Extended packaging metadata |

Component kinds in schema: `commands`, `agents`, `skills`, `hooks`, `mcp`,
`lsp`, `apps`, `output-styles`.

Load + register: `refreshPluginRegistrations` →
`loadPluginCommands`, `loadPluginSkills`, `loadPluginAgents`,
`loadPluginHooks`, `loadPluginMcpServers`, `loadPluginLspServers`,
`loadPluginOutputStyles`.

### Plugin MCP servers

`loadPluginMcpServers` is not enough by itself. Session startup must also
merge those registrations into the live `MCPManager`
(`getAllMcpConfigs` in `runtime/src/services/mcp/config.ts`). Enabled
user-scoped plugins then appear in `/mcp` as `plugin:<id>:<server>` and
as model tools `mcp.plugin:<id>:<server>.<tool>`.

Project- and local-scope installs are **repository-controlled**
(`isRepositoryControlledPlugin`). The loader strips their `mcpServers`,
hooks, and `lspServers` so workspace-resident packages cannot become a second
process authority. Skills, commands, agents, and output styles still load.
`agenc plugin install --scope project` (or `local`) warns when the manifest
ships hooks or MCP servers. Reinstall with `--scope user` to load those
surfaces.

Stdio plugin servers run under a tight sandbox profile (writes confined
to the plugin data directory). Landlock can express this profile;
ordinary workspace-write MCP is not. Operator merge rules, templates,
and failure symptoms: [mcp.md](mcp.md#plugin-declared-servers).

## Shipped plugins

Source of truth is repo `plugins/<name>/`. `runtime/scripts/sync-shipped-plugins.mjs`
copies that tree into gitignored `runtime/plugins/` on `npm run build` so the
installed package ships the same files. Edit repo `plugins/`, not the copy.

`initBuiltinPlugins()` (`runtime/src/plugins/builtin/index.ts`) registers
`zeroday-hunter` as `source: "bundled"` for `/skills` and the Skill tool.
**Not gated by `[plugins] enabled`.** That flag is workspace auto-discovery
only. Packaged users do not need `agenc plugin install`.

Every shipped plugin has the same required `.agenc-plugin/plugin.json` as an
installed plugin. `initBuiltinPlugins()` parses that on-disk manifest through
the canonical manifest authority; the registry does not synthesize package
metadata. Builtin disable key is
`plugins.plugins["zeroday-hunter@builtin"]`. `agenc plugin list` / `/plugins`
call `loadPlugins()` and **will not show** the builtin unless auto-discovery
also finds `plugins/zeroday-hunter`. `agenc plugin disable zeroday-hunter`
writes `[plugins.plugins.zeroday-hunter]`, not the `@builtin` key.

Campaign scripts and templates live on disk next to the plugin
(`plugins/zeroday-hunter/scripts/`). Builtin command conversion does not
extract those scripts or set `skillRoot`.

### Config enable

```toml
[plugins]
enabled = true
allowlist = ["my-plugin"]   # optional restriction

[plugins.plugins.my-plugin]
enabled = true
path = "./plugins/my-plugin"
```

All plugin enablement entries use `plugins.plugins`; there is no parallel
enablement map. External plugin and skill command, HTTP, prompt, and agent hook
effects require workspace trust. An explicit operator capability can permit
command effects in an untrusted workspace, but it does not permit the other
external effect types. See [hooks.md](hooks.md).

### Plugin option storage

The installed manifest's `userConfig` schema selects exactly one owner for
each declared value:

- fields marked `sensitive: true` live only in the native secure storage;
- other declared fields live under `pluginConfigs.<plugin>.options` or the
  channel-specific `pluginConfigs.<plugin>.mcpServers.<server>` table in
  `config.toml`;
- undeclared or stale fields are not loaded as live plugin configuration.

The installed plugin manifest's `settings` field is the sole package-default
authority. It is not a user-settings or credential surface: values declared
sensitive by the manifest are ignored there and reported by plugin
validation/registration. A root `settings.json` beside the manifest is
rejected with guidance to move its defaults into the manifest and remove the
file, or reinstall the plugin. Only the native secure storage value may be substituted into an MCP or LSP
server.

A sensitive field found in `config.toml` is rejected even when secure storage also
contains a value. Open `/plugin`, choose the plugin, and use **Configure** to
write the value to secure storage and scrub the plaintext field. AgenC never treats
TOML as a secret fallback and never creates a plaintext secret archive during
this reconfiguration.

### CLI: `agenc plugin`

```text
agenc plugin list [--json]
agenc plugin validate <path> [--marketplace] [--json]
agenc plugin install <path> [--scope user|project|local] [--name …] [--force]
agenc plugin uninstall <name> [--scope …] [--keep-data]
agenc plugin update <name> [--scope user|project|local] [--source <path>]
agenc plugin enable <name> [--path <path>]
agenc plugin disable <name>
agenc plugin disable-all
agenc plugin marketplace list|add|remove|upgrade …
```

Dispatch accepts `agenc plugin` only. `agenc plugins` is a **help topic**,
not an execution alias. TUI: `/plugins` (aliases `/plugin`, `/marketplace`).
Install roots use the same collision-resistant child key: user
`<plugin-storage-root>/<readable-id>--<sha256>`; project/local
`<workspace>/.agents/plugins/<readable-id>--<sha256>`. Extra discovery also
`<workspace>/plugins/` and git-root `plugins/`. `[plugins] enabled = false`
in `defaultConfig()`.

For a non-user install, the CLI writes an install-time stderr warning when the
plugin ships hooks or MCP servers. The loader enforces the scope restriction
even if the warning is missed.

A canonical plugin ID can be installed in one managed scope at a time.
Uninstall it before moving it between user and project/local scope. Uninstall
still accepts an explicit scope so old duplicate copies can be removed safely.

### Marketplace

Local path, git, URL, or GitHub sources enter only through `marketplace add`.
Every source must expose its catalog at `.agenc-plugin/marketplace.json`; a
root `marketplace.json` is not probed as a fallback. Validate a catalog with
`plugin validate --marketplace`.

`<plugin-storage-root>/known_marketplaces.json` is strict plugin inventory and
cache state, not operator configuration. It records the exact absolute install
and manifest paths selected by the sole marketplace operation authority in
`runtime/src/plugins/marketplace/marketplace.ts`. Inventory read-modify-write
transactions are serialized by plugin root and committed with a durable atomic
rename. Duplicate JSON keys, unknown fields, relative paths, or policy matchers
fail closed. Ordinary reads never refresh a source, probe another cache path,
or migrate an old entry.

---

## Output styles

Markdown files that replace or wrap the assistant's default writing style.

Load paths (`runtime/src/outputStyles/loadOutputStylesDir.ts`):

| Source | Path |
| --- | --- |
| Managed | `<platform-managed-root>/.agenc/output-styles/*.md` |
| User | `$AGENC_HOME/output-styles/*.md` |
| Project | `<ancestor>/.agenc/output-styles/*.md` (discovered as untrusted content; excluded from style authority) |
| Plugin | `<plugin>/output-styles/` plus manifest `outputStyles` |

The platform-managed root is `/etc/agenc` on Linux,
`/Library/Application Support/AgenC` on macOS, and `%ProgramData%\AgenC` on
Windows.

Built-ins (`runtime/src/constants/outputStyles.ts`): `default`, `Explanatory`,
`Learning`. Repository files cannot override user, managed, built-in, or plugin
styles. The filename stem is the style name unless frontmatter sets `name`.
Frontmatter may also set `description` and `keep-coding-instructions`.
Plugin-only: `force-for-plugin`.

TUI: `/output-style`, `/output-style list`, `/output-style <name>` (alias
`/style`). `/output-style:new` asks the agent to create a **user** file under
`$AGENC_HOME/output-styles/<name>.md`, not a project file.

## Related

- [slash-commands.md](slash-commands.md) (plugins add more commands)
- [mcp.md](mcp.md) (including plugin-contributed servers)
- [hooks.md](hooks.md)
- [config.md](config.md) `[plugins]` block
