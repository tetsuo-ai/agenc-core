# Skills & plugins reference

Sources of truth:

| Area | Path |
| --- | --- |
| Skill load / `SKILL.md` | `runtime/src/skills/local-loader.ts` |
| Bundled skills | `runtime/src/skills/bundledSkills.ts` |
| Headless inventory CLI | `runtime/src/skills/skills-cli.ts` → `agenc skills list` |
| MCP skills | `runtime/src/skills/mcpSkills.ts` |
| Plugin load / dirs | `runtime/src/plugins/loader.ts`, `directories.ts` |
| Manifest | `runtime/src/plugins/manifest.ts`, `manifest-schema.ts` |
| Registration | `runtime/src/plugins/registration/*` |
| CLI | `runtime/src/plugins/cli/pluginCliCommands.ts` → `agenc plugin` |
| Marketplace | `runtime/src/plugins/marketplace/` |
| Publisher signatures | `runtime/src/plugins/resolution.ts` (`verifyResolvedPluginSignature`) |
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
`[bundled]`. Headless clients that must not open a session use
[`agenc skills list`](#agenc-skills-list-cli) instead. Local-snapshot
inventory rows preserve `whenToUse` and `argumentHint` when declared,
including inline built-ins that have no `SKILL.md` a client could open.
Registry-only bundled fallback rows currently expose their descriptions but
not those two optional fields.

A plugin manifest may declare a skill root that **is** the skill
(`skills: ["./skills/flash-board"]` with `SKILL.md` in that directory).
Discovery looks for child skill dirs first; an empty scan falls back to
the root's own `SKILL.md`. Without that fallback the inventory reports
"no such skill".

Plugin-shipped skill bodies substitute `${AGENC_PLUGIN_ROOT}` to the
owning plugin root (same rendering pass as `${AGENC_SKILL_DIR}` and
`${AGENC_SESSION_ID}`). A sibling script path that still contains the
literal placeholder was not rendered from a plugin root.

### Bundled skills

The local loader defines eleven built-in skills: `update-config`,
`keybindings`, `debug`, `simplify`, `batch`, `loop`, `agenc-in-browser`,
`schedule-agents`, `agenc-api`, `ledger-wallet-cli`, and `verify`.

Separately, `registerBundledSkill` in `bundledSkills.ts` registers these two
commands. They are compiled into the runtime and appear as
`origin: "built-in"` on `agenc skills list`.

| Name | Purpose |
| --- | --- |
| `browser-automation` | Snapshot → act → re-snapshot workflow for the LIVE `Browser` tool ([browser.md](../browser.md)) |
| `agenc-marketplace-kit-installer` | Marketplace kit install helper |

`zeroday-hunter` is a signed marketplace plugin, not a `bundledSkills.ts`
registration. The in-package builtin-plugin skill seam
(`initBuiltinPlugins` / `getBuiltinPluginSkillCommands`) is intentionally
empty so a first-party skill cannot exist twice under one name.
`/skills` still folds that seam; `agenc skills list` does not. An older
`iot-builder` bundled skill is not registered in this tree.

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

### `agenc skills list` CLI

Inventory of the local-loader snapshot plus the registered bundled skills.
Desktop and other GUI clients can use it without opening a session. It does
not change config, install content, or print skill bodies. Ordinary runtime
initialization can create runtime directories, and plugin discovery can
migrate legacy plugin-data directories.

```text
agenc skills list
agenc skills list --json
agenc help skills
```

```bash
agenc skills list --json
```

`--json` writes a schema-versioned document to stdout:

```json
{
  "schemaVersion": 1,
  "kind": "agenc.skills.inventory",
  "skills": [
    {
      "name": "verify",
      "description": "Checks the requested behavior.",
      "whenToUse": "Use after making a change.",
      "origin": "built-in",
      "root": "/path/to/skill",
      "userInvocable": true
    }
  ],
  "errors": []
}
```

| Field | Notes |
| --- | --- |
| `origin` | `built-in`, `personal`, `project`, `plugin`, or `managed` |
| `pluginRoot` | Owning plugin directory; present only for `plugin` origin |
| `root` | Loader discovery root for disk-backed skills. Inline built-ins use their prospective extraction directory. Empty string for registry-only bundled rows with no local-loader entry |
| `whenToUse` / `argumentHint` | Omitted when empty. Registry-only bundled fallback rows currently omit both even when the in-session command has them |
| `conditional` | `true` when the skill activates only for configured paths |
| `errors` | Config or bundled-registry failures. A config load error still lists personal/project/built-in rows and skips plugin skills |

Text mode prints one line per skill, sorted by origin then name:

```text
[built-in] verify — Plan and run a concrete verification pass.
[personal] my-notes — Consult personal project notes.
[plugin] demo-skill — Use the demo plugin workflow.
```

Errors go to stderr with an `agenc: ` prefix. Both text and JSON return **0**
after emitting the document, so callers must inspect `errors[]`.

Workspace is `process.cwd()`. Home and plugin storage follow
`AGENC_HOME` and the captured `pluginStorageRoot`
(`AGENC_PLUGIN_CACHE_DIR` replaces `$AGENC_HOME/plugins` as one unit).
No daemon or session is required. `--bare` is a session ingress flag and does
not change this CLI; a `--bare` TUI session still skips skill discovery for
that session only.

#### Constraints

- The parser accepts only `agenc skills list` and optional `--json`.
  `agenc skills`, `agenc skills --help`, `agenc skills install <name>`, and any
  extra flag return `null` from `parseAgenCSkillsCliArgs` and fall through
  to the default CLI route, which treats the tokens as a **session prompt**.
  Use `agenc help skills` for syntax.
- Top-level `agenc help` / `agenc --help` does not list this command.
- This is not `agenc plugin`. Skills are authored capabilities; plugins
  are the installable distribution unit.
- This inventory is not identical to `/skills`. It includes inactive
  path-conditional rows with `conditional: true` and preserves same-name rows
  from different origins. It omits MCP skills, live invocation state, the
  effective skill-root summary, and the builtin-plugin command seam. Therefore,
  an in-package plugin skill (none are registered today) can appear in
  `/skills` and remain absent from `agenc skills list`.
- Duplicate `origin:name` keys keep the first row (local snapshot before
  the bundled-registry fallback).

---

## Plugins

### Defaults

- `[plugins] enabled = false` in `defaultConfig()`. It gates configured entries
  and auto-discovered plugins, including user-scope installs. The install CLI
  writes an enabled config entry and turns this gate on.
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
agenc plugin marketplace catalog [--product <id>] [--json]
agenc plugin marketplace install <plugin@marketplace> [--product <id>] [--scope user|project] [--force] [--json]
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

### Catalog and qualified install

`plugin marketplace list` reports configured marketplaces, not the plugins
inside them. Desktop and scripts use:

```bash
agenc plugin marketplace catalog --product desktop --json
agenc plugin marketplace install flash-board@agenc-plugins --product desktop --json
```

`catalog` serializes every configured marketplace's installable plugins
(product-filtered; `NOT_AVAILABLE` excluded) into one schema-versioned
JSON document (`kind: agenc.plugin.marketplace.catalog`). A broken
marketplace becomes an `errors[]` entry; partial success is still a
usable catalog. JSON mode always exits 0 after emitting a document, so callers
must inspect `errors[]`; text mode exits 1 when every configured marketplace
failed.

A fresh profile has no marketplaces. The first catalog request registers
the official `agenc-plugins` marketplace
(`https://agenc.tech/plugins/marketplace.json`) unless
`AGENC_SKIP_OFFICIAL_MARKETPLACE=1`. An offline first run still returns
an empty catalog rather than failing the CLI.

Each catalog row carries the absolute marketplace `root`. When artwork is
available, it also carries `logoPath` and `logoRoot`; `logoPath` is proven with
`realpath` to sit inside `logoRoot`. Prefetched artwork uses a cache outside the
marketplace root, so clients must validate against `logoRoot`, not `root`.
Clients serve artwork under their own trusted scheme; they must not guess paths.
Card prefetch for SHA-pinned `github.com` git sources reads the plugin
manifest at the pinned commit and caches logo / display name /
description / version / bounded interface copy / skill and command rows
under the marketplace store. Only `github.com` + an explicit `sha`
qualify. Relative paths containing `..` are rejected. A missing logo is
a generic card, never a broken catalog.

`install` resolves `plugin@marketplace` (last-`@` split). A bare name is
accepted only when exactly one configured marketplace offers that plugin
to the requested product; ambiguity is an error. The JSON result reports
`signatureVerified` (see [Publisher signatures](#publisher-signatures)).
`--scope` is `user` or `project` (not `local`). The install result carries the
manifest interface (logo stripped; artwork travels as a verified path) and
command rows. A subsequent `plugin list --json` also includes skill rows read
from each skill directory's `SKILL.md` frontmatter.

### Publisher signatures

Remote plugin resolution (`resolvePluginSource` in
`runtime/src/plugins/resolution.ts`) verifies an Ed25519 publisher signature
against a local keyring. Marketplace install sets `requireSignature` when the
marketplace `sourceType` is not `local` (`installRequiresSignature` in
`catalog-cli.ts`). There is no `agenc plugin sign` command and no shipped
default keyring.

#### When verification runs

| Path | Signature check |
| --- | --- |
| `agenc plugin install ./dir` | Never. The CLI does not pass `requireSignature`. |
| Marketplace install from a **local** marketplace | Not required, even when its catalog row points at a remote source. |
| Marketplace install from a non-local marketplace (`sourceType` git or url), including a bundled `./path` directory | Required. `installPluginOp` verifies a directory before copying it. A missing `.agenc-plugin/signature.json` fails the install and leaves the configured plugin list unchanged. |
| Resolver for git / npm / tarball / mcpb outside marketplace install | Required by default unless the caller passes `requireSignature: false`. Structured git using a `file:` URL or absolute filesystem path is local and is not required by that default. |

Callers must treat `signatureVerified: false` as **unverified**, not as a pass.
The shipped CLI and `/plugins` marketplace paths require a verified result for
non-local marketplaces. A successful non-local marketplace install reporting
`false` is an invariant failure.

#### Keyring

Default path: `$AGENC_HOME/plugin-publishers.json`. The resolver accepts an
in-process `publishersPath` override; there is no operator CLI for it.

```json
{
  "publishers": {
    "tetsuo": {
      "publicKey": "<base64 DER SPKI Ed25519>"
    }
  }
}
```

A publisher entry may be that base64 string directly. A parsed keyring without
a usable entry for the named publisher throws
`plugin publisher is not trusted: <name>`. Missing, unreadable, or malformed
keyrings surface their filesystem or JSON error. A well-formed public key and
signature that do not verify throw
`plugin signature verification failed for publisher <name>`; malformed key
material can surface a crypto parsing error.

#### Signature file

`.agenc-plugin/signature.json`:

```json
{
  "publisher": "tetsuo",
  "signature": "<base64 Ed25519>",
  "files": {
    "skills/SKILL.md": "sha256:<64 lowercase hex>"
  }
}
```

The signed payload is UTF-8 JSON `{ manifestSha256, files }`. `files` is
sorted by path; digests normalize to `sha256:<hex>` (`sha256:` prefix
optional on input). `plugin.json` is hashed as `manifestSha256` and omitted
from `files`. `signature.json` and `.agenc-plugin/agenc-install.json` are
omitted. `.git` / `.hg` / `.svn` are ignored. Symlinks fail closed.
Signature paths must stay inside the plugin root (no `..`, no absolute
paths). Resolver defaults: depth **32**, **4096** files, **200 MiB**.

A later `verifyResolvedPluginSignature` on the install destination still
succeeds for a signed copy because install metadata is excluded from the
payload.

#### Troubleshooting

| Symptom | What to check |
| --- | --- |
| `plugin signature is required` | A required install lacks `.agenc-plugin/signature.json`. Direct local `plugin install ./dir` does not take this path. |
| `plugin publisher is not trusted` | The parsed `$AGENC_HOME/plugin-publishers.json` has no usable key for that publisher. Missing, unreadable, or malformed keyrings report their underlying error instead. |
| `signatureVerified: false` after marketplace install | Expected only for a local marketplace or a custom caller that disabled the requirement. A successful non-local marketplace install returning false violates the shipped path's invariant. |
| `payload digest set does not match` / `digest mismatch` | Extra, missing, or edited regular payload files vs `files`. The manifest, `signature.json`, install metadata, and `.git` / `.hg` / `.svn` directories are excluded as described above. |

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
