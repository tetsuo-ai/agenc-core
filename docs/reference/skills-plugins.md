# Skills & plugins reference

Sources of truth:

| Area | Path |
| --- | --- |
| Skill load / `SKILL.md` | `runtime/src/skills/local-loader.ts`, `loadSkillsDir.ts` |
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
| Project | `<dir>/.agenc/skills`, `<dir>/.agents/skills` (and deprecated `…/commands`) |
| User | `$AGENC_HOME/skills`, `~/.agenc/skills`, `~/.agents/skills`, compat `~/.claude/skills`, `~/.codex/skills` (+ `commands` legacy) |
| Managed | `$AGENC_MANAGED_HOME/.agenc/skills` |
| Plugin | Skill roots exposed by enabled plugins |
| Bundled / MCP | Built-in definitions and MCP-sourced skills |

`getSkillsPath` (settings source → path) also maps policy/user/project to
managed / config-home / `.agenc/skills`.

Slash: `/skills` — list roots, manage project skills.

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
- Install cache / data under `~/.agenc/plugins` (override with
  `AGENC_PLUGIN_CACHE_DIR`; seed dirs via `AGENC_PLUGIN_SEED_DIR`)
- Plugin private data: `…/plugins/data/<sanitized-id>/`

### Manifest

Looked up as:

1. `.agenc-plugin/plugin.json`
2. Root `plugin.json`

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

### Config enable

```toml
[plugins]
enabled = true
allowlist = ["my-plugin"]   # optional restriction

[plugins.plugins.my-plugin]
enabled = true
path = "./plugins/my-plugin"
```

Or `enabledPlugins` map. Untrusted workspace trust gates apply to
config/plugin **command** hooks (see [hooks.md](hooks.md)).

### CLI: `agenc plugin`

```text
agenc plugin list [--json]
agenc plugin validate <path> [--marketplace] [--json]
agenc plugin install <path> [--scope user|project|local] [--name …] [--force]
agenc plugin uninstall <name> [--scope …] [--keep-data]
agenc plugin update <name> [--source <path>]
agenc plugin enable <name> [--path <path>]
agenc plugin disable <name>
agenc plugin disable-all
agenc plugin marketplace list|add|remove|upgrade …
```

Aliases: top-level `plugin` and `plugins`. TUI: `/plugins` (aliases
`/plugin`, `/marketplace`).

### Marketplace

Local path, git, URL, or GitHub sources via `marketplace add`. Index ops in
`runtime/src/plugins/marketplace/marketplace.ts`. Validate marketplace
manifests with `plugin validate --marketplace`.

---

## Related

- [slash-commands.md](slash-commands.md) — core registry (plugins add more)
- [mcp.md](mcp.md) — MCP servers (including plugin-contributed)
- [hooks.md](hooks.md) — session hooks including plugin hooks
- [config.md](config.md) — `[plugins]` block
