# Configuration reference

AgenC has one runtime configuration authority: the immutable schema-v2
snapshot produced from `config.toml`, supported environment overrides, CLI
overrides, and managed policy. Runtime code does not read the retired
operator `$AGENC_HOME/settings.json`, a second operator JSON schema, or mutable
provider-selection environment state after startup capture.

The implementation sources of truth are:

| Concern | Source |
| --- | --- |
| Types, accepted keys, validation, defaults | `runtime/src/config/schema.ts` |
| Layering and repository security | `runtime/src/config/repository.ts` |
| Environment-to-config projection | `runtime/src/config/env.ts` |
| Explicit migration | `runtime/src/config/migration.ts` |
| TOML serialization and edits | `runtime/src/config/serialize.ts`, `runtime/src/config/edit.ts` |
| CLI | `runtime/src/bin/config-cli.ts` |

Every active file must start with:

```toml
config_version = 2
```

The user file is `$AGENC_HOME/config.toml`, normally
`~/.agenc/config.toml`. `AGENC_HOME` moves the complete AgenC home: config,
runtime state, trust data, daemon identity, caches, migration journals, and
the native secure storage namespace. `AGENC_CONFIG_DIR` is removed from normal
runtime use; only the migration command may inspect it.

## Authority boundaries

| Data | Sole owner |
| --- | --- |
| Operator configuration and managed policy | schema-v2 `config.toml` plus explicit env/CLI layers |
| Runtime facts, observations, caches, and UI acknowledgements | versioned internal `state.json` |
| Project trust decisions | `trusted-projects.json` |
| Provider credentials | native secure storage or documented credential environment variables |
| Gateway credentials | home-bound native secure storage or documented one-shot credential environment variables |
| Session startup authority such as `--bare`, shell/temp/plugin roots, and the untrusted-command capability | typed daemon `runtimeOptions`, captured once |

Removed operator `settings.json` files are migration inputs only.
`$AGENC_HOME/keybindings.json`, project `.mcp.json`, managed
`managed-mcp.json`, and `gateway/config.json` are likewise retired migration
inputs. They are never loaded as runtime configuration. The migration planner
losslessly converts supported `mcpServers` entries into the matching scope's
`mcp_servers` table and moves gateway policy into `[gateway]`; unsupported or
conflicting definitions block the plan instead of being dropped. Plugin MCP
servers and package defaults live only in `.agenc-plugin/plugin.json`, under
`mcpServers` and `settings` respectively. A plugin-root `.mcp.json` or
`settings.json` is rejected with move/remove or reinstall guidance. These are
not operator-config surfaces. Manifest-sensitive keys are ignored. State cannot contain config,
executable policy, trust decisions, or credentials. A violation fails closed
with migration guidance.

Retired keybinding JSON is converted block-for-block to `tui.keybindings`.
String actions remain in `bindings`; JSON `null` entries become `unbind`
entries because TOML has no null value. Unknown fields, actions, contexts,
malformed chords, duplicate JSON keys, normalized alias collisions, and
disagreement with existing canonical keybindings block the migration.

Theme is an operator preference at `tui.theme` in `config.toml`. Accepted values are
`auto`, `dark`, `light`, `light-daltonized`, `dark-daltonized`, `light-ansi`,
and `dark-ansi`; `system` is not a value. `auto` first uses `$COLORFGBG` when
available, otherwise starts with a dark fallback, and an OSC 11 terminal
background response can then update the detected light/dark palette.

`--bare` is the CLI ingress for the typed `runtimeOptions.simpleMode` value;
embedding clients carry the same required typed value on the daemon protocol.
The client passes that immutable value to the daemon and turn loop. The
removed environment aliases `AGENC_SIMPLE` and `AGENC_BARE` are rejected.
For hooks, this owner value is a hard execution policy, not another spelling
of the mutable/persisted `hooksDisabled` setting: `/hooks enable` cannot lift
it and recovery never writes bare mode into the session toggle.
`--bare` also takes precedence over `runtimeOptions.allowUntrustedHooks`; an
untrusted-command capability cannot lift hard hook suppression.

## Layer order

Later layers win:

1. Built-in defaults
2. Plugin-supplied defaults
3. User `$AGENC_HOME/config.toml`
4. Project `.agenc/config.toml`
5. Local `.agenc/config.local.toml`
6. Explicit `--config` file
7. Named profile selected by `--profile` or `AGENC_PROFILE`
8. Supported environment overrides
9. CLI overrides
10. Administrator-managed base file and lexically sorted drop-ins

The platform-managed root is `/etc/agenc` on Linux,
`/Library/Application Support/AgenC` on macOS, and `%ProgramData%\AgenC` on
Windows. The managed base file is `config.toml`; drop-ins are under `config.d/`.
Managed Markdown assets use `.agenc/` below that same captured root. The
`AGENC_MANAGED_INSTRUCTIONS` override selects the managed instruction file;
its `rules/` directory is always beside that file.

Plain objects deep-merge. Arrays replace the lower-priority array; they do not
concatenate. The resolved snapshot and its nested values are frozen.

Schema v2 is closed. Unknown top-level or block keys, duplicate TOML keys,
invalid values, unsupported versions, non-files, and unsafe managed sources
are errors. Managed files cannot be symlinks and, on POSIX, cannot be group-
or world-writable.

Project and local files cannot grant execution authority. They cannot set
`approval_policy`, change `project_root_markers`, add allow rules or write
directories, weaken `sandbox_mode`, enable network/GPU/escape switches, make
sandbox startup fail open, add sandbox exceptions, or install
`tui.keybindings` (including command-bearing mappings). Plugin defaults also
cannot install keybindings. Suppressed values are reported as ignored. Before
the project is trusted, only restrictive `permissions`, `sandbox_mode`, and
`sandbox` values are active. A session that captured
`runtimeOptions.allowUntrustedHooks` may also retain the project and local
`[hooks]` command maps for the session hook policy to evaluate. This exception
does not retain any other repository executable setting. Project and local
`statusLine` and `fileSuggestion` commands remain ignored, as does any attempt
to enable or install executable `autoFix` commands. Other repository values are
reported as ignored.

## Migration and removed surfaces

The runtime accepts only schema v2. The migration planner is the sole code
allowed to understand removed files or names. It reports conflicts instead of
guessing and writes a journal. Replaced non-secret inputs are archived so their
file changes can be rolled back. Retired plaintext credentials are different:
apply writes them to the home-bound native secure storage first and then permanently
deletes standalone plaintext sources or rewrites `auth.json` to metadata-only
content, without creating a secret-bearing archive. Rollback never recreates
plaintext credentials or removes the successfully migrated secure-storage copy.

The same explicit transaction repairs the historical native secure storage namespace
split. Older builds left a relocated `AGENC_HOME` on the unscoped service name,
while an explicitly set `AGENC_CONFIG_DIR` hashed that directory even when it
was the default `~/.agenc` path. `migrate check` reads the exact retired and
canonical identities, reports any top-level credential conflict without
printing secret values, and records only hashes and field names. `apply`
rechecks both records and commits the merged canonical blob while preserving
unrelated namespaces.

On macOS and Linux, every historical service name is ownership-ambiguous. An
unscoped name can be shared by the default and relocated homes, and a scoped
`AGENC_CONFIG_DIR` name used only 32 hash bits, so a different directory may
collide with it. Migration therefore copies these records into the canonical
home-bound namespace but retains the old record by default. On macOS and
Linux, destructive retirement requires the operator to pass
`--retire-shared-secure-storage` to both the reviewed check and apply. Before
using that flag, stop every older AgenC process and independently confirm that
no default home, relocated home, or colliding directory still owns the record;
keep those processes stopped until apply completes.

Linux uses its bundled Secret Service helper to enumerate every collection.
Read, update, and delete refuse multiple records for the exact service/account
identity; a single existing item is updated or deleted in its own collection.
This replaces the mismatched all-collection lookup, default-collection store,
and broad clear behavior of the retired `secret-tool` adapter. The macOS helper
similarly enumerates all Security.framework matches, rejects an ambiguous
service/account identity, and updates or deletes only the unique persistent
item reference instead of using the line-limited `security` interactive CLI.
Successful writes are read back and byte-compared before they are reported.
Both helpers keep credential bytes on stdin/stdout and reject records at or
above 16 MiB without changing the prior record.

Current AgenC writers serialize native secure storage changes with the home-bound
transaction lock. Secret Service does not provide compare-and-swap: a foreign
writer that ignores that lock can race between search, mutation, and
verification. The Linux helper never uses replace-after-absence and never
restores a captured old value. It rejects duplicate, changed-item, or
changed-payload verification and compensates only the exact item returned by
its own failed creation. The retired-writer quiescence requirement above is
therefore load-bearing for destructive migration.

Windows DPAPI records are home-relative and exact: a distinct retired file is
deleted after the reviewed canonical commit, while a default-home file whose
historical shell `USER` differs from the stable operating-system account is
re-encrypted in place. Ordinary startup never reads or falls back to any
retired identity.

The canonical secure-storage account is captured from a durable operating-system
identity, not the mutable shell `USER` value: POSIX uses numeric `uid:<uid>` and
Windows uses the DPAPI-bound `current-user` identity. Explicit migration
reconstructs the historical `USER`-derived account. If the original account
name is no longer in the environment, pass
`--retired-secure-storage-account <name>` to both check and apply; the value selects only
the retired source and never changes ordinary runtime identity.

In this reference, **retired** means there is no ordinary runtime reader,
fallback, alias, or precedence rule left. A retired name may appear only in
the explicit, one-way migration/rejection boundary so existing installations
can be diagnosed and converted without silently guessing.

```text
agenc config migrate check [--confirm-retired-writers-stopped] [--retire-shared-secure-storage] [--retired-secure-storage-account <name>]
agenc config migrate apply [--confirm-retired-writers-stopped] [--retire-shared-secure-storage] [--retired-secure-storage-account <name>]
agenc config migrate rollback <journal-id>
```

Run check and apply without the flag to copy and retain a shared unscoped
source. On an exact-record backend, if destructive retirement is safe, review
a check with the flag and pass the same flag to apply. The flag is an explicit
ownership and process-quiescence assertion, not a general migration
prerequisite; it is refused when the backend cannot identify one exact record.
Any migration that deletes or rewrites a retired plaintext credential source,
or deletes a native secure storage source, requires
`--confirm-retired-writers-stopped` on apply. This is an explicit assertion
that every old AgenC process capable of recreating a source or stale-writing a
credential blob was stopped before the reviewed check and will remain stopped
through apply. The final transaction rechecks every migrated credential leaf
and every sanitized path, but no lock can coordinate binaries that predate the
lock contract.

Ordinary startup, config reads, reloads, `config set`, and `config edit` never
parse, archive, or rewrite retired inputs. Use the explicit check/apply flow for
every v1 TOML, JSON, state, trust, or credential migration.

Run `migrate check` and review its conflicts before `apply`. If the native
secure storage is unavailable, or its existing value conflicts with the retired source,
apply leaves every plaintext source untouched and performs no migration. Once
a credential source has been deleted or sanitized, recovery is intentionally
one-way: config and state files may be restored, while the credential remains
only in the native secure storage.

Examples of migration-only names include `tools`, `sandbox_policy`,
`editorMode`, `enabledPlugins`, `effortLevel`, profile `web_search`/`tools`,
camel-case hook events, per-tool `defaultPermissionMode`/`approval_mode`, and
per-tool booleans/`enabled`. The retired `tools_config.web_search` spelling is
migrated to the exact `WebSearch` dispatch name; inert `view_image`/`ViewImage`
settings are dropped. Retired JSON `xaaIdp` is migrated to `xaa_idp`; no secret
is copied. Retired project `.mcp.json` and managed `managed-mcp.json`
`mcpServers` objects are converted to scoped `mcp_servers` tables. Runtime-only
transports, OAuth blocks, dynamic header helpers, and other fields without a
lossless canonical representation are reported as conflicts. Retired gateway
policy JSON moves to `[gateway]`. Plaintext `gateway/env`,
`gateway/hooks-token`, and `gateway/webchat-token` inputs move one way into the
native secure storage and are deleted only after its commit succeeds. These
removed names are rejected in a v2 document. The migration-only `_unknown`
normalization side table exists only to report unmapped v1/JSON data;
`_unknown` itself is not accepted in schema v2.

An explicit provider route comes from `--provider`, `AGENC_PROVIDER`, or
`model_provider`. A model-only layer (`--model`, `AGENC_MODEL`, or `model`)
resolves its provider from the model catalog or a provider-qualified model
name. Ambiguous model-only selections are rejected. Every route converges on
the same captured provider/model authority.

## Built-in defaults

Anything not listed is unset/off unless its subsystem table below says
otherwise.

| Path | Default |
| --- | --- |
| `config_version` | `2` |
| `model` | `grok-4.6` |
| `model_provider` | `grok` |
| `approval_policy` | `on-request` |
| `sandbox_mode` | `workspace-write` |
| `reasoning_effort` | `medium` |
| `approvals_reviewer` | `user` |
| `agent_max_depth` | `1` |
| `auth.backend` | `remote` |
| `auth.managedKeys.enabled` | `true` |
| `plugins.enabled` | `false` |
| `plugins.allowlist` | `[]` (empty means no filter; only a non-empty list restricts) |
| `mcp.server.enabled` | `false` |
| `mcp.server.transport` | `stdio` |
| `daemon.autostart` | `true` |
| `gateway.defaultAgent` | `default` |
| `gateway.hooks.enabled` | `false` |
| `project_root_markers` | `.git`, `package.json`, `Cargo.toml`, `pyproject.toml` |
| `project_doc_max_bytes` | `32768` |
| `providers.grok.web_search` | `true` |
| `providers.grok.x_search` | `true` |
| `providers.grok.code_execution` | `true` |
| `providers.grok.enable_image_search` | `true` |
| `providers.grok.enable_image_understanding` | `true` |
| `providers.grok.enable_video_understanding` | `true` |
| `buffer.provider` | `auto` |
| `buffer.show_tabs` | `auto` |
| `buffer.neovim.init` | `auto` |
| `buffer.neovim.startup_timeout_ms` | `10000` |
| `buffer.neovim.operation_timeout_ms` | `10000` |
| `buffer.neovim.cleanup_timeout_ms` | `1000` |
| `buffer.prediction.enabled` | `ask` |
| `buffer.prediction.debounce_ms` | `160` |
| `buffer.prediction.timeout_ms` | `2500` |
| `buffer.prediction.max_output_tokens` | `256` |
| `tui.theme` | `dark` |
| `tui.showTurnDuration` | `true` |
| `tui.terminalProgressBarEnabled` | `true` |
| `tui.copyOnSelect` | `true` |
| `tui.flickerFreeMode` | `true` |
| `tui.prStatusFooterEnabled` | `true` |
| `ideConnector.autoInstallExtension` | `true` |
| `teammates.mode` | `auto` |
| `teammates.preferTmuxOverIterm2` | `false` |
| `speculationEnabled` | `true` |
| `fileCheckpointingEnabled` | `true` |
| `transcriptPersistenceEnabled` | `true` |
| `promptSuggestionEnabled` | `false` |
| `agent.budget` | no caps |
| `agent.retention.completed_days` | `30` |
| `agent.retention.failed_days` | `90` |
| `agent.retention.snapshot_days` | `3` |
| `agent.retention.snapshot_max_count` | `10000` |
| `agent.retention.snapshot_max_bytes` | `67108864` |

`max_turns` and `stream_watchdog_timeout_ms` are unset by default. An unset
turn cap does not impose a synthetic stop. An unset stream watchdog permits
provider silence indefinitely; set the timeout to `0` to explicitly disable
it as well. `[budget]`, `[heartbeat]`, `[browser]`, and
`[transaction_guard]` apply their documented subsystem defaults when absent.

On a keep-alive (interactive) session, hitting `max_turns`,
`max_budget_usd`, or the no-progress backstop ends that **turn** only.
Send another prompt; the session stays running. One-shot
(`--print` / `--no-tui`) agents still fail the run. See
[daemon.md](daemon.md#interactive-session-survival).

## Similar names that are not duplicate authorities

| Paths | Difference |
| --- | --- |
| `model` and `providers.<provider>.default_model` | `model` is the configured startup selection; provider `default_model` is that provider's fallback when no model is configured or selected. A live session can select a different model with `/model`. |
| `approval_policy` and `permissions.defaultMode` | `approval_policy` is the tool-approval baseline; `defaultMode` selects the user-facing session mode. A configured `bypassPermissions` default takes effect only when exact-workspace consent is already present. |
| `mcp` and `mcp_servers` | `mcp.server` exposes AgenC as an MCP server; `mcp_servers.<server>` connects AgenC to external MCP servers. |
| `plugins.plugins.<plugin>.mcp_servers` and `mcp_servers` | The former is plugin-owned and namespaced; the latter is operator-owned global MCP configuration. |
| `budget` and `agent.budget` | `budget` is recurring daily/monthly autonomy accounting; `agent.budget` caps one background-agent run. |
| `sandbox_mode` and `sandbox` | `sandbox_mode` chooses the isolation level; `sandbox` supplies policy details for that one mode. There is no nested mode alias. |

## Complete schema-v2 catalog

The following is exhaustive. Angle-bracket segments are operator-chosen table
names; `[]` denotes an array entry. Open maps accept keys at the indicated
`<name>` path. Every other block is closed and rejects unknown fields.

### Core and runtime selection

| Path | Type / meaning |
| --- | --- |
| `config_version` | Required integer `2` on disk. The in-memory field is `configVersion`. |
| `model` | Configured startup model slug. A live session selection is separate. |
| `model_provider` | Configured startup canonical provider slug. Strict v2 rejects the retired `xai`, `custom`, and `openai_compatible` selector spellings. |
| `approval_policy` | `untrusted`, `on-failure`, `on-request`, or `never`. |
| `sandbox_mode` | `read-only`, `workspace-write`, or `danger-full-access`. |
| `reasoning_effort` | `low`, `medium`, `high`, `xhigh`, or `none`. |
| `reasoning_summary` | `auto`, `concise`, `detailed`, or `none`. |
| `approvals_reviewer` | `user` or `auto_review`. |
| `model_verbosity` | `low`, `medium`, or `high`. |
| `service_tier` | `priority` or `flex`. |
| `personality` | `none`, `friendly`, or `pragmatic`. |
| `agent_max_threads` | Positive concurrent-agent thread cap. |
| `agent_max_depth` | Non-negative subagent nesting cap. |
| `project_root_markers` | String array used to find the canonical project root. |
| `project_doc_max_bytes` | Positive instruction-document byte ceiling. |
| `experimental_realtime_start_instructions` | Realtime start instruction override. |
| `experimental_realtime_ws_backend_prompt` | Realtime websocket backend prompt override. |
| `max_output_tokens` | Positive global model-output limit. |
| `capped_default_max_output_tokens` | Boolean capped-default/retry behavior. |
| `max_turns` | Positive loop backstop. |
| `max_budget_usd` | Positive session cost cap. |
| `autonomous_mode` | Boolean autonomous runtime mode. |
| `coordinator_mode` | Boolean coordinator-only main-session behavior. |
| `stream_watchdog_timeout_ms` | Non-negative inter-chunk idle timeout; `0` disables. |

Project-root discovery happens before project and local configuration can be
loaded. Its marker authority is therefore limited to the built-in/plugin/user
pre-root layers, an explicit `--config` file, and managed policy (which may
override the earlier markers). An explicit `--config` marker list participates
in root discovery even though the rest of that flag-selected layer merges after
project/local configuration. Project/local files, profiles, and late synthetic
CLI flags cannot change `project_root_markers`; attempting to inject the field
from a late CLI layer is rejected.

### Top-level operator preferences

| Paths | Meaning |
| --- | --- |
| `autoUpdates`, `autoUpdatesChannel` | Update enablement and `latest`/`stable` channel. Absent enablement preserves the updater default. |
| `respectGitignore`, `includeGitInstructions` | Git-aware discovery and instruction behavior. |
| `transcriptPersistenceEnabled` | Persist session transcripts (default `true`). Retention is configured only by `agent.retention.rollout_days`. |
| `outputStyle` | Named assistant response style. |
| `defaultShell` | `bash` or `powershell`. |
| `language` | Preferred response language. |
| `syntaxHighlightingDisabled` | Disable TUI syntax highlighting. |
| `alwaysThinkingEnabled`, `showThinkingSummaries` | Thinking display preferences. |
| `spinnerTipsEnabled` | Show prompt/chrome hints. |
| `promptSuggestionEnabled` | Enable background next-prompt suggestions (default `false`). |
| `swarmMode`, `fastMode` | Agent-swarm and fast-mode preferences. |
| `plansDirectory` | Plan artifact directory. |
| `prefersReducedMotion` | Reduced-motion preference. |
| `autoMemoryEnabled`, `autoMemoryDirectory` | Automatic-memory enablement and directory. |
| `autoDreamEnabled`, `autoDreamMinHours`, `autoDreamMinSessions` | Automatic-dream scheduling. |
| `ideConnector`, `ideConnector.autoInstallExtension` | IDE connector block and automatic supported-extension installation. |
| `teammates`, `teammates.mode`, `teammates.defaultModel`, `teammates.preferTmuxOverIterm2` | Teammate block, execution mode, optional default model, and terminal-backend preference. Set `defaultModel = "inherit"` to follow the leader model; omit it to use the built-in teammate default. |
| `speculationEnabled` | Enable speculative execution where supported. |
| `fileCheckpointingEnabled` | Enable file-history checkpoints for edits. |

### Managed-policy top-level keys

These are typed in the same schema and normally supplied only by the managed
layer.

| Paths | Type / meaning |
| --- | --- |
| `availableModels` | Allowed model string array. |
| `modelOverrides`, `modelOverrides.<model>` | Open model-to-model override map. |
| `allowedMcpServers`, `allowedMcpServers[]` | MCP allow entries. |
| `allowedMcpServers[].serverName`, `allowedMcpServers[].serverCommand`, `allowedMcpServers[].serverUrl` | Name, command-vector, or URL matcher for one allow entry. |
| `deniedMcpServers`, `deniedMcpServers[]` | MCP deny entries with the same three fields. |
| `deniedMcpServers[].serverName`, `deniedMcpServers[].serverCommand`, `deniedMcpServers[].serverUrl` | Name, command-vector, or URL matcher for one deny entry. |
| `disableAllHooks`, `allowManagedHooksOnly` | Hook disable/managed-only policy. |
| `allowedHttpHookUrls`, `httpHookAllowedEnvVars` | HTTP-hook URL and interpolation allowlists. |
| `allowManagedPermissionRulesOnly` | Ignore non-managed permission rule arrays. |
| `allowManagedMcpServersOnly` | Ignore non-managed MCP allow entries. |
| `strictPluginOnlyCustomization` | Boolean or array of `skills`, `agents`, `hooks`, `mcp`. |
| `strictKnownMarketplaces`, `strictKnownMarketplaces[]` | Allowed marketplace-source patterns. |
| `blockedMarketplaces`, `blockedMarketplaces[]` | Blocked marketplace-source patterns. |
| `forceLoginOrgUUID` | Required login organization UUID. |
| `skipWebFetchPreflight` | Boolean preflight bypass policy. |
| `minimumVersion` | Minimum allowed AgenC version. |
| `disableAutoMode` | Literal `disable`. This key exists only at top level. |
| `agencMdExcludes` | Instruction-discovery exclusion array. |
| `pluginTrustMessage` | Managed plugin-trust message. |

Marketplace source objects use one `source` discriminator: `url` (`url`,
optional `headers`), `github` (`repo`, optional `ref`, `path`, `sparsePaths`),
`git` (`url`, optional `ref`, `path`, `sparsePaths`), `npm` (`package`),
`file`/`directory` (`path`), `hostPattern` (`hostPattern`), or `pathPattern`
(`pathPattern`).

### Sandbox and shell environment

| Paths | Type / meaning |
| --- | --- |
| `sandbox` | Sandbox detail block. |
| `sandbox.network_access` | Explicit network boolean. |
| `sandbox.allow_gpu` | macOS Metal GPU opt-in. |
| `sandbox.autoAllowBashIfSandboxed` | Bash auto-approval policy inside the sandbox. |
| `sandbox.allowUnsandboxedCommands` | Explicit unsandboxed-command escape policy. |
| `sandbox.enableWeakerNestedSandbox` | Weaker nested-isolation opt-in. |
| `sandbox.enableWeakerNetworkIsolation` | Weaker network-isolation opt-in. |
| `sandbox.excludedCommands` | Commands excluded from sandbox execution. |
| `sandbox.network` | Network-policy block. Unknown fields are rejected. |
| `sandbox.network.allowedDomains` | Domain allowlist string array. |
| `sandbox.network.allowManagedDomainsOnly` | Use only managed allowed-domain inputs. |
| `sandbox.network.allowUnixSockets` | Allowed Unix-socket path string array. |
| `sandbox.network.allowAllUnixSockets` | Boolean opt-out from Unix-socket blocking. |
| `sandbox.network.allowLocalBinding` | Allow binding local listening sockets. |
| `sandbox.network.httpProxyPort` | HTTP proxy TCP port, integer `1..65535`. |
| `sandbox.network.socksProxyPort` | SOCKS proxy TCP port, integer `1..65535`. |
| `sandbox.filesystem` | Filesystem-policy block. Unknown fields are rejected. |
| `sandbox.filesystem.allowWrite` | Additional writable-path string array. |
| `sandbox.filesystem.denyWrite` | Denied writable-path string array. |
| `sandbox.filesystem.denyRead` | Denied readable-path string array. |
| `sandbox.filesystem.allowRead` | Paths re-allowed inside denied read regions. |
| `sandbox.filesystem.allowManagedReadPathsOnly` | Use only managed read-path allow inputs. |
| `sandbox.ignoreViolations`, `sandbox.ignoreViolations.<name>` | Violation category-to-string-array map. |
| `sandbox.ripgrep` | Custom ripgrep block. Unknown fields are rejected. |
| `sandbox.ripgrep.command` | Required non-empty ripgrep-compatible command. |
| `sandbox.ripgrep.args` | Optional command-argument string array. |
| `shell_environment_policy` | Explicit child-shell environment injection block. |
| `shell_environment_policy.set`, `shell_environment_policy.set.<name>` | Explicit non-secret string environment map. Credential-like names (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AUTHORIZATION`, and related families) are rejected; supply credentials through the documented process environment or native secure storage instead. |

### Authentication, providers, and profiles

| Paths | Type / meaning |
| --- | --- |
| `auth` | Authentication policy block. |
| `auth.backend` | `local` or `remote`. |
| `auth.managedKeys` | Managed-key block. |
| `auth.managedKeys.enabled` | Boolean managed-key enablement. |
| `providers`, `providers.<provider>` | Provider definitions keyed only by canonical built-in provider slug. Unknown and retired names are rejected. Provider credentials use each provider's documented canonical environment variable or native secure storage; the retired `api_key_env` indirection is rejected. |
| `providers.<provider>.base_url` | Provider API base URL. |
| `providers.<provider>.default_model` | Provider fallback model. |
| `providers.<provider>.context_window_tokens` | Positive context window. On `ollama` / `lmstudio` this explicit value wins; on `openai-compatible` a live `/v1/models` window overrides it. See [providers.md](providers.md#local-context-windows). |
| `providers.<provider>.max_output_tokens` | Positive provider output cap. |
| `providers.<provider>.timeout_ms` | Non-negative provider request/stream idle timeout; `0` disables. |
| `providers.<provider>.capability_overrides` | Capability override block. |
| `providers.<provider>.capability_overrides.supportsToolUse`, `providers.<provider>.capability_overrides.supportsPromptCaching`, `providers.<provider>.capability_overrides.supportsContextEdits` | Boolean tool/cache/context capabilities. |
| `providers.<provider>.capability_overrides.supportsImageInput`, `providers.<provider>.capability_overrides.supportsAudioInput`, `providers.<provider>.capability_overrides.supportsAudioOutput` | Boolean media capabilities. |
| `providers.<provider>.capability_overrides.supportsProviderNativeWebSearch`, `providers.<provider>.capability_overrides.supportsExtendedThinking` | Boolean native search/thinking capabilities. |
| `providers.<provider>.capability_overrides.acceptsImageHistory`, `providers.<provider>.capability_overrides.acceptsAudioHistory`, `providers.<provider>.capability_overrides.acceptsThinkingHistory`, `providers.<provider>.capability_overrides.acceptsReasoningEffort` | Boolean accepted-history/effort capabilities. |
| `providers.<provider>.web_search`, `providers.<provider>.x_search`, `providers.<provider>.code_execution` | Grok-only native web, X, and code capabilities; rejected on every other provider. |
| `providers.<provider>.enable_image_search`, `providers.<provider>.enable_image_understanding`, `providers.<provider>.enable_video_understanding` | Grok-only native media capabilities; rejected on every other provider. |
| `providers.<provider>.collections` | Grok-only native collection-search block. |
| `providers.<provider>.collections.enabled`, `providers.<provider>.collections.max_num_results`, `providers.<provider>.collections.vector_store_ids` | Collection enablement, positive result cap, and vector-store ID list. |
| `providers.<provider>.remote_mcp` | Grok-only server-side MCP block. |
| `providers.<provider>.remote_mcp.enabled`, `providers.<provider>.remote_mcp.servers`, `providers.<provider>.remote_mcp.servers[]` | Remote-MCP enablement and server entries. |
| `providers.<provider>.remote_mcp.servers[].server_url`, `providers.<provider>.remote_mcp.servers[].server_label`, `providers.<provider>.remote_mcp.servers[].server_description` | Required HTTPS server URL, required label, and optional description. |
| `providers.<provider>.remote_mcp.servers[].allowed_tools`, `providers.<provider>.remote_mcp.servers[].authorization_env` | Optional tool allowlist and an `AGENC_CREDENTIAL_*` session-snapshot secret name. Plaintext authorization and arbitrary environment names are rejected. |
| `providers.<provider>.fallback` | Structured fallback policy. |
| `providers.<provider>.fallback.max_failures`, `providers.<provider>.fallback.statuses` | Failure count and HTTP status list. |
| `providers.<provider>.fallback.targets`, `providers.<provider>.fallback.targets[]` | Structured fallback targets. |
| `providers.<provider>.fallback.targets[].provider`, `providers.<provider>.fallback.targets[].model`, `providers.<provider>.fallback.targets[].reason` | Optional canonical provider, required model, optional reason. Retired selector spellings are rejected. |
| `profiles`, `profiles.<profile>` | Named selection bundles. |
| `profiles.<profile>.model`, `profiles.<profile>.model_provider` | Model/provider override. Provider values follow the same strict canonical-selector rule as root `model_provider`. |
| `profiles.<profile>.approval_policy`, `profiles.<profile>.sandbox_mode` | Approval/sandbox override. |
| `profiles.<profile>.reasoning_effort`, `profiles.<profile>.reasoning_summary` | Reasoning overrides. |
| `profiles.<profile>.approvals_reviewer`, `profiles.<profile>.model_verbosity`, `profiles.<profile>.service_tier`, `profiles.<profile>.personality` | Reviewer/presentation overrides. |
| `profiles.<profile>.tools_config` | Profile-local tool block with the same fields as `tools_config`. |
| `profiles.<profile>.tools_config.web_search_endpoint`, `profiles.<profile>.tools_config.web_search_endpoint_kind` | Search URL and `duckduckgo`/`searxng`/`brave`/`json` decoder. |
| `profiles.<profile>.tools_config.enabled_tools`, `profiles.<profile>.tools_config.disabled_tools` | Exact tool-name allow/disable arrays. |
| `profiles.<profile>.tools_config.<tool>.default_permission_mode` | Exact-name per-tool approval default. |

### Tools and permissions

| Paths | Type / meaning |
| --- | --- |
| `tools_config` | Tool policy block. There is no `[tools]` alias in v2. |
| `tools_config.web_search_endpoint` | Search backend URL. |
| `tools_config.web_search_endpoint_kind` | `duckduckgo`, `searxng`, `brave`, or `json`. |
| `tools_config.enabled_tools`, `tools_config.disabled_tools` | Exact tool-name arrays. |
| `tools_config.<tool>` | Exact dispatch-name block for any registered tool. Quote names containing dots in TOML, for example `[tools_config."system.bash"]`. |
| `tools_config.<tool>.default_permission_mode` | `untrusted`/`on-failure`/`on-request`/`never` approval default. Per-tool `enabled` is not accepted. |
| `permissions` | Session-mode and rule block. |
| `permissions.allow`, `permissions.deny`, `permissions.ask` | `Tool` or `Tool(filter)` rule arrays. |
| `permissions.additionalDirectories` | Additional permission-scope directories. |
| `permissions.defaultMode` | Default mode: `default`, `acceptEdits`, `plan`, `dontAsk`, or `auto`. `bypassPermissions` is accepted only with durable exact-workspace consent; configuring it does not create consent. Internal `bubble`/`unattended` modes cannot be configured. |
| `permissions.bypassPermissionsMode` | `allow` makes the restricted bypass mode available. It does not grant or persist consent. `disable` prohibits it. Project and local configuration cannot enable bypass mode. |

### MCP and protocol

| Paths | Type / meaning |
| --- | --- |
| `mcp`, `mcp.server` | AgenC MCP server-mode block. |
| `mcp.server.enabled` | Boolean, default false. |
| `mcp.server.transport` | `stdio` or `sse`. |
| `mcp.server.port`, `mcp.server.host` | SSE listener port and host. |
| `mcp.server.workspace` | Absolute workspace required for daemon SSE autostart. |
| `mcp_servers`, `mcp_servers.<server>` | Named external MCP connections. Server identifiers are 1 to 256 ASCII letters, numbers, colons, hyphens, or underscores; `.` is reserved as the tool-identity delimiter. |
| `mcp_servers.<server>.transport` | `stdio`, `sse`, `http`, or `websocket`. |
| `mcp_servers.<server>.command`, `mcp_servers.<server>.args`, `mcp_servers.<server>.cwd` | Stdio process launch fields. |
| `mcp_servers.<server>.env`, `mcp_servers.<server>.env.<name>`, `mcp_servers.<server>.env_vars` | Literal environment map and inherited variable-name array. |
| `mcp_servers.<server>.endpoint`, `mcp_servers.<server>.headers`, `mcp_servers.<server>.headers.<name>` | Remote URL and header map. |
| `mcp_servers.<server>.enabled`, `mcp_servers.<server>.required`, `mcp_servers.<server>.timeout` | Enablement, required-startup policy, and timeout. |
| `mcp_servers.<server>.default_tools_approval_mode` | Server-wide approval default. |
| `mcp_servers.<server>.enabled_tools`, `mcp_servers.<server>.disabled_tools` | Tool arrays. |
| `mcp_servers.<server>.tools`, `mcp_servers.<server>.tools.<name>` | Per-tool blocks. |
| `mcp_servers.<server>.tools.<name>.default_permission_mode` | Per-tool approval default. Enablement belongs only in the server lists. |
| `xaa_idp` | Non-secret OIDC metadata shared by MCP Cross-App Access. IdP tokens and client secrets remain in native secure storage. |
| `xaa_idp.issuer`, `xaa_idp.client_id` | HTTPS OIDC issuer and registered client ID. Loopback HTTP is accepted only for local development. |
| `xaa_idp.callback_port` | Optional fixed loopback callback TCP port (`1..65535`). |
| `protocol` | Marketplace protocol transport block. |
| `protocol.enabled` | Boolean master switch, default false. |
| `protocol.adapter` | Must be `marketplace-cli` exactly when `protocol.enabled = true`; omit it when disabled. |
| `protocol.cli_path` | Trusted local marketplace CLI path. |

### Hooks

`hooks` is an event map. The only event keys are `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `SessionStart`,
`SubagentStop`, `SessionEnd`, `Notification`, `Stop`, `StopFailure`,
`PreCompact`, and `PostCompact`.

| Paths | Type / meaning |
| --- | --- |
| `hooks`, `hooks.<event>`, `hooks.<event>[]` | Event map and matcher array. |
| `hooks.<event>[].matcher`, `hooks.<event>[].enabled` | Optional matcher and enablement. |
| `hooks.<event>[].hooks`, `hooks.<event>[].hooks[]` | Command-hook array. |
| `hooks.<event>[].hooks[].type` | Required literal `command`. |
| `hooks.<event>[].hooks[].command` | Required command string. |
| `hooks.<event>[].hooks[].timeout_ms`, `hooks.<event>[].hooks[].enabled`, `hooks.<event>[].hooks[].statusMessage` | Optional timeout, enablement, and status text. |

### Plugins and plugin preferences

| Paths | Type / meaning |
| --- | --- |
| `plugins` | Plugin discovery and registration. |
| `plugins.dirs`, `plugins.enabled`, `plugins.allowlist` | Search directories, global switch, and allowlist. An empty allowlist applies no filter. A non-empty list matches the manifest name or an installed `name@marketplace` identity. An unqualified `name` also matches its marketplace-qualified identity. Discovery paths, directory names, and `plugins.plugins` keys are not authorization aliases. |
| `plugins.plugins`, `plugins.plugins.<plugin>` | Named plugin map of plugin blocks. |
| `plugins.plugins.<plugin>.enabled`, `plugins.plugins.<plugin>.path` | Plugin enablement and local path. |
| `plugins.plugins.<plugin>.mcp_servers`, `plugins.plugins.<plugin>.mcp_servers.<name>` | Plugin-owned MCP server map. |
| `plugins.plugins.<plugin>.mcp_servers.<name>.enabled`, `plugins.plugins.<plugin>.mcp_servers.<name>.default_tools_approval_mode` | Server switch and approval default. |
| `plugins.plugins.<plugin>.mcp_servers.<name>.enabled_tools`, `plugins.plugins.<plugin>.mcp_servers.<name>.disabled_tools` | Tool arrays. |
| `plugins.plugins.<plugin>.mcp_servers.<name>.tools`, `plugins.plugins.<plugin>.mcp_servers.<name>.tools.<name>` | Per-tool blocks. |
| `plugins.plugins.<plugin>.mcp_servers.<name>.tools.<name>.default_permission_mode` | Per-tool approval default. Enablement belongs only in the server lists. |
| `pluginConfigs`, `pluginConfigs.<plugin>` | Plugin preference map. |
| `pluginConfigs.<plugin>.mcpServers`, `pluginConfigs.<plugin>.mcpServers.<server>`, `pluginConfigs.<plugin>.mcpServers.<server>.<name>` | Open per-server maps for manifest-declared non-sensitive preferences. Sensitive fields belong only in the native secure storage and are rejected here. |
| `pluginConfigs.<plugin>.options`, `pluginConfigs.<plugin>.options.<name>` | Open maps for manifest-declared non-sensitive plugin values: string, number, boolean, or string array. Sensitive fields belong only in the native secure storage and are rejected here. |

### LSP, IDE, attachments, and private paths

| Paths | Type / meaning |
| --- | --- |
| `lsp_servers`, `lsp_servers.<server>` | Named language server configs. |
| `lsp_servers.<server>.command`, `lsp_servers.<server>.args`, `lsp_servers.<server>.workspaceFolder` | Launch command and workspace. |
| `lsp_servers.<server>.env`, `lsp_servers.<server>.env.<name>` | String environment map. |
| `lsp_servers.<server>.extensionToLanguage`, `lsp_servers.<server>.extensionToLanguage.<name>` | Required extension-to-language map. |
| `lsp_servers.<server>.initializationOptions` | Arbitrary initialization value. |
| `lsp_servers.<server>.startupTimeout`, `lsp_servers.<server>.maxRestarts` | Startup/restart limits. |
| `attachments`, `attachments.allowedRoots` | Extra roots allowed for `@file` attachment reads. |

### TUI, editor, commands, and presentation

| Paths | Type / meaning |
| --- | --- |
| `tui`, `tui.vimMode` | TUI block and vim-keybinding switch. |
| `tui.theme` | `auto`, `dark`, `light`, one of the daltonized palettes, or one of the ANSI palettes. |
| `tui.showTurnDuration`, `tui.terminalProgressBarEnabled`, `tui.copyOnSelect` | Turn-duration display, terminal progress, and selection-copy switches. |
| `tui.flickerFreeMode`, `tui.prStatusFooterEnabled` | Flicker reduction and pull-request footer switches. |
| `tui.keybindings`, `tui.keybindings[]` | Ordered canonical keybinding override blocks. This is operator-only: user config may set it and the final managed layer may replace and lock the complete array; plugin/project/local layers are ignored with diagnostics. |
| `tui.keybindings[].context` | Required registered TUI context such as `Chat`, `Global`, `Buffer`, or `BufferHost`. |
| `tui.keybindings[].bindings` | Chord-to-action map. `command:<name>` is accepted only in `Chat`. |
| `tui.keybindings[].bindings.<name>` | Operator-chosen chord mapped to a registered action or a `command:<name>` binding. |
| `tui.keybindings[].unbind` | Chords to unbind explicitly. A chord cannot also occur in `bindings`, including through aliases. |
| `buffer` | Embedded editor block. |
| `buffer.provider` | `auto`, `neovim`, `inline`, or `external`. |
| `buffer.show_tabs` | `auto`, `always`, or `never`. |
| `buffer.neovim` | Neovim process block. |
| `buffer.neovim.executable`, `buffer.neovim.init`, `buffer.neovim.discovery_timeout_ms` | Executable, `auto`/`user`/`clean` init, and discovery timeout. |
| `buffer.neovim.startup_timeout_ms`, `buffer.neovim.operation_timeout_ms`, `buffer.neovim.cleanup_timeout_ms` | Process timeouts. |
| `buffer.prediction` | Code prediction block. |
| `buffer.prediction.enabled`, `buffer.prediction.debounce_ms`, `buffer.prediction.timeout_ms`, `buffer.prediction.max_output_tokens` | `ask`/`on`/`off` and limits. |
| `buffer.prediction.provider`, `buffer.prediction.model` | Optional independent route. |
| `statusLine`, `statusLine.type`, `statusLine.command`, `statusLine.padding` | Operator-owned status command; `type` is literal `command`. Project/local layers cannot install it. Execution follows session command-hook policy and `--bare` suppression. |
| `fileSuggestion`, `fileSuggestion.type`, `fileSuggestion.command` | Operator-owned file suggestion command; `type` is literal `command`. Project/local layers cannot install it. Execution follows session command-hook policy and `--bare` suppression. |
| `attribution`, `attribution.commit`, `attribution.pr` | Commit and pull-request attribution strings. |
| `worktree`, `worktree.symlinkDirectories`, `worktree.sparsePaths` | Worktree directory/sparse-checkout arrays. |
| `spinnerVerbs`, `spinnerVerbs.mode`, `spinnerVerbs.verbs` | `append`/`replace` verb customization. |

```toml
[tui]
keybindings = [
  { context = "Chat", bindings = { "ctrl+x ctrl+e" = "chat:externalEditor" } },
  { context = "Global", unbind = ["ctrl+t"] },
]
```

Run `/keybindings` to create a small canonical scaffold and open a private,
validated edit snapshot of `config.toml`. The edit is committed through the
locked config writer and reloaded through `ConfigStore`; there is no separate
keybinding file or watcher.

### Automation, agents, and durability

| Paths | Type / meaning |
| --- | --- |
| `autoFix`, `autoFix.enabled`, `autoFix.lint`, `autoFix.test` | Operator-owned post-edit lint/test commands; enabled requires at least one command. Project/local layers cannot enable it or install executable commands. Execution follows session command-hook policy and `--bare` suppression. |
| `autoFix.maxRetries` | Integer `0..10`, runtime default `3`. |
| `autoFix.timeout` | Integer `1000..300000` ms, runtime default `30000`. |
| `autoMode`, `autoMode.allow`, `autoMode.soft_deny`, `autoMode.environment` | Classifier allow/soft-deny/environment arrays. |
| `agent`, `agent.budget`, `agent.budget.token_cap`, `agent.budget.dollar_cap`, `agent.budget.wall_clock_seconds` | Per-run caps. |
| `agent.retention`, `agent.retention.completed_days`, `agent.retention.failed_days`, `agent.retention.snapshot_days` | Retention days. |
| `agent.retention.snapshot_max_count`, `agent.retention.snapshot_max_bytes`, `agent.retention.rollout_days` | Snapshot/rollout retention. |
| `durableTurns` | Durable-turn block. |
| `durableTurns.checkpoint`, `durableTurns.checkpoint.enabled`, `durableTurns.checkpoint.minIntervalMs` | Checkpoint switch and throttle. |
| `durableTurns.resume`, `durableTurns.resume.onRestart` | Resume-on-restart switch. Default `true`. The removed `resume.policy` key is stripped on migrate; it is not an operator setting. |
| `durableTurns.resume.requireLease`, `durableTurns.resume.buildPinning` | Lease and build-pinning guards. Both default `true`. Resume fail-closes when an enabled guard finds a lease or build-id mismatch. The switches enable or disable individual guards. They do not select an idempotent replay policy. |

### Gateway

| Paths | Type / meaning |
| --- | --- |
| `gateway` | Operator-owned channel and inbound-hook policy. Project/local layers cannot set it. |
| `gateway.defaultAgent` | Non-empty default agent label. |
| `gateway.channels`, `gateway.channels.<name>` | Named channel-policy map. |
| `gateway.channels.<name>.dmPolicy` | Required `pairing`, `allowlist`, `open`, or `disabled`. |
| `gateway.channels.<name>.allowlist` | Optional non-empty peer-ID strings. |
| `gateway.bindings`, `gateway.bindings[]` | Conversation-to-agent binding array. |
| `gateway.bindings[].agent`, `gateway.bindings[].channelId` | Required non-empty strings. |
| `gateway.bindings[].peerId`, `gateway.bindings[].groupId` | Optional exact peer/group selectors. |
| `gateway.hooks`, `gateway.hooks.enabled` | Inbound-hook block and switch. |
| `gateway.hooks.host`, `gateway.hooks.port` | Optional non-empty host and port `0..65535`. |
| `gateway.hooks.allowNonLoopback` | Explicit non-loopback bind opt-in. |

Gateway bot tokens and generated hook/WebChat bearer tokens are not config.
They live in the home-bound native secure storage or a documented one-shot
environment ingress.

### Daemon, browser, budget, heartbeat, and transaction guard

| Paths | Type / meaning |
| --- | --- |
| `daemon`, `daemon.autostart` | Daemon block and automatic daemon startup. The local daemon transport is fixed by the platform runtime. |
| `browser` | Chromium execution policy. |
| `browser.executable_path`, `browser.profile_dir` | Browser binary/profile paths. |
| `browser.headless`, `browser.allow_private_network`, `browser.no_sandbox` | Security/runtime booleans. |
| `browser.navigation_timeout_ms` | Navigation timeout. |
| `budget` | Recurring cost/token policy. |
| `budget.enabled`, `budget.daily_usd`, `budget.monthly_usd` | Enablement and dollar caps. |
| `budget.daily_tokens`, `budget.monthly_tokens` | Token caps. |
| `budget.soft_threshold`, `budget.enforce_interactive` | Warning fraction and interactive enforcement. |
| `heartbeat` | Autonomous tick policy. |
| `heartbeat.enabled`, `heartbeat.interval_seconds` | Enablement and cadence. |
| `heartbeat.active_hours`, `heartbeat.skip_when_busy` | Active `[start,end)` hours and busy behavior. |
| `heartbeat.target_channel`, `heartbeat.target_conversation` | Optional paired delivery target. |
| `transaction_guard` | Local SLM transaction classifier. |
| `transaction_guard.enabled`, `transaction_guard.model`, `transaction_guard.endpoint` | Enablement and Ollama route. |
| `transaction_guard.fail_mode` | `open` or `closed`. |
| `transaction_guard.timeout_ms`, `transaction_guard.max_docket_bytes` | Positive request deadline and maximum serialized docket size. |

### Grok/xAI server-tool policy

`providers.grok` applies only to direct xAI/Grok inference, not OpenRouter.

| Paths | Type / meaning |
| --- | --- |
| `providers.grok` | Canonical Grok provider settings and native capability profile. The retired `[llm.xai]` block is rejected by ordinary loading and handled only by explicit migration. |
| `providers.grok.web_search`, `providers.grok.x_search`, `providers.grok.code_execution` | Native web, X, and code tools. |
| `providers.grok.enable_image_search`, `providers.grok.enable_image_understanding`, `providers.grok.enable_video_understanding` | Native media capabilities. |
| `providers.grok.collections` | Native collection search. |
| `providers.grok.collections.enabled`, `providers.grok.collections.vector_store_ids`, `providers.grok.collections.max_num_results` | Collection controls. |
| `providers.grok.remote_mcp` | xAI server-side MCP. |
| `providers.grok.remote_mcp.enabled`, `providers.grok.remote_mcp.servers`, `providers.grok.remote_mcp.servers[]` | Enablement and server entries. |
| `providers.grok.remote_mcp.servers[].server_url`, `providers.grok.remote_mcp.servers[].server_label`, `providers.grok.remote_mcp.servers[].server_description` | Server identity. |
| `providers.grok.remote_mcp.servers[].allowed_tools` | Tool allowlist. |
| `providers.grok.remote_mcp.servers[].authorization_env` | Name of a dedicated `AGENC_CREDENTIAL_*` environment variable containing the authorization value. These dynamic secrets are captured per client and cleared between daemon sessions. Other names and plaintext `authorization` are rejected. |

## CLI

```text
agenc config show
agenc config get <dot.path>
agenc config set <dot.path> <toml-value>
agenc config unset <dot.path>
agenc config validate
agenc config edit
agenc config path
agenc config migrate check [--confirm-retired-writers-stopped] [--retire-shared-secure-storage] [--retired-secure-storage-account <name>]
agenc config migrate apply [--confirm-retired-writers-stopped] [--retire-shared-secure-storage] [--retired-secure-storage-account <name>]
agenc config migrate rollback <journal-id>
```

Values parse as TOML (`true`, integers, arrays, and inline tables). Dot paths
split on `.`; use `edit` when an operator-chosen table name itself contains a
dot.

```bash
agenc config get model
agenc config set permissions.defaultMode auto
agenc config set tools_config.disabled_tools '["WebSearch"]'
agenc config validate
```

The TUI command is `/config`.
Environment overrides and removed names are cataloged in [env.md](env.md).
