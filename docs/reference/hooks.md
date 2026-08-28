# Hooks reference

Two different “hooks” surfaces:

| Surface | What it is | Primary code |
| --- | --- | --- |
| **Session lifecycle hooks** | Config/plugin shell (and related) handlers on turn events | `runtime/src/hooks/`, `config/schema.ts` `hooks`, `schemas/hooks.ts` |
| **Gateway Hooks HTTP** | Loopback `POST /hooks/agent` automation → one agent turn | `runtime/src/gateway/hooks.ts` |

Do not confuse them. Gateway HTTP is documented in depth under
[autonomy.md](autonomy.md#hooks-http-runtimesrcgatewayhooksts) and
[gateway.md](../gateway.md).

---

## Session lifecycle hooks

### Events (`HOOK_EVENT_NAMES` in config schema)

These are the events accepted on the **`[hooks]` TOML map** and the
configured-hook engine (`runtime/src/hooks/engine/discovery.ts`):

| Event | Summary (from `/hooks` metadata) |
| --- | --- |
| `PreToolUse` | Before tool execution; matcher `tool_name` |
| `PostToolUse` | After successful tool execution |
| `PostToolUseFailure` | After tool failure |
| `PermissionRequest` | When a permission dialog is shown |
| `UserPromptSubmit` | User prompt submitted; can block |
| `SessionStart` | New session; matcher `source` |
| `SubagentStop` | Spawned agent finished; matcher `agent_type` |
| `SessionEnd` | Session shutdown (fire-and-forget) |
| `Notification` | Waiting on user (e.g. permission); fire-and-forget |
| `Stop` | Before concluding the response |
| `StopFailure` | Turn ended on API error |
| `PreCompact` | Before context compaction |
| `PostCompact` | After compaction |

CamelCase and lowerCamel aliases normalize (e.g. `preToolUse` → `PreToolUse`).

The SDK type list in `entrypoints/sdk/coreTypes.ts` (`HOOK_EVENTS`) is **wider**
(e.g. `SubagentStart`, `Setup`, `ConfigChange`, `InstructionsLoaded`, …). Those
extra names are for the broader runtime/SDK surface; **TOML `hooks` validation
only accepts the table above**.

### Config map shape

`HooksMap`: event name → array of matchers; each matcher has optional
`matcher` / `enabled` and a list of **command** hooks.

Schema-validated command hook (`HookCommand`):

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `"command"` | Required; only command type in TOML config path |
| `command` | string | Shell command to run |
| `timeout_ms` | positive int | Optional |
| `enabled` | bool | Optional (default on) |
| `statusMessage` | string | Optional spinner text |

```toml
[[hooks.PreToolUse]]
matcher = "system.bash"
enabled = true
hooks = [
  { type = "command", command = "/path/to/check-bash.sh", timeout_ms = 5000, statusMessage = "pre-bash hook" },
]
```

Flattened runtime entries carry `source: "config"`, `sourcePath`, and index
(`IndividualHookConfig` in `hooks/engine/types.ts`).

### Skill frontmatter hook kinds

Skill frontmatter has its own typed metadata surface. Its `hooks:` block is
validated by `runtime/src/schemas/hooks.ts` and supports `command`, `prompt`,
`http`, and `agent` hooks, including permission-rule `if` filters, timeouts in
**seconds**, and kind-specific fields. It does not create another operator
configuration file.

Canonical `config.toml` and inline plugin-manifest hook declarations both use
the command-only `validateHooksConfig` path described above. A plugin can also
ship skill frontmatter; those hooks retain their skill provenance and use the
skill metadata schema.

### Security

Every session has one hook execution policy. The policy checks the captured
runtime options, project trust, and hook effect before anything runs.

- Internal callback and function hooks use code already loaded by AgenC. They
  do not require workspace trust.
- Command, HTTP, prompt, and agent hook effects require a trusted workspace.
- An operator may set `AGENC_ALLOW_UNTRUSTED_HOOKS=1` at startup to permit
  command effects in an untrusted workspace. AgenC captures the value once as
  `runtimeOptions.allowUntrustedHooks`. The capability also covers
  command-backed `statusLine`, `fileSuggestion`, and `autoFix`. It never
  permits HTTP, prompt, or agent effects.
- Pane teammates inherit the captured boolean through the same child runtime
  projection as shell, temporary-directory, and plugin-storage authority.
  AgenC does not install it as mutable shared daemon state, so later process
  environment changes cannot alter a running session.
- SDK embedders pass the typed capability explicitly after vetting the
  workspace.
- AgenC redacts secrets from configured-hook diagnostics where that path is
  wired (`configured-hooks.ts`).

`--bare` is an immutable, run-owned hard suppression boundary for **every**
session hook extension point: configured commands, plugin/SDK callbacks,
prompt/HTTP/agent hooks, tool and permission hooks, lifecycle hooks, async-hook
responses, and internal post-sampling hooks. Hook registration may still be
visible for inspection, but no callback, subprocess, request, or background
hook task is executed for that run.

`--bare` takes precedence over `runtimeOptions.allowUntrustedHooks`. The
command capability cannot lift hard hook suppression.

This hard state is separate from the mutable session switch:

- `hardSuppressed` comes only from the owning run's captured `simpleMode`.
- `disabled` is the operator-controlled, durably persisted session switch.
- `effectiveDisabled` is true when either state is true.

Consequently, `/hooks enable` can clear `disabled` but cannot lift `--bare`.
Status and mutation responses report why execution remains suppressed instead
of claiming hooks were enabled.

### Engine

| Module | Role |
| --- | --- |
| `hooks/engine/discovery.ts` | Flatten + group by event |
| `hooks/engine/dispatcher.ts` | Match patterns, run hooks |
| `hooks/engine/command-runner.ts` | Spawn shell |
| `hooks/engine/output-parser.ts` | Parse hook stdout / hookSpecificOutput |
| `hooks/configured-hooks.ts` | Install into session lifecycle targets |
| `hooks/user-prompt-submit.ts` | UserPromptSubmit adapter |

Plugin hooks merge via `plugins/registration/load-plugin-hooks.ts`.

### TUI: `/hooks`

```text
/hooks
/hooks list
/hooks show <event> [index]
/hooks validate
/hooks enable | disable
/hooks test <event> [index]
/hooks diagnostics
/hooks clear-diagnostics
```

- No args / interactive: menu (`hooks-menu.tsx`) when runtime available
- Against daemon: `enable`/`disable` use `session.hooks.setDisabled`.
  `test` and `clear-diagnostics` may still report deferred.
- A daemon-backed TUI always reads and mutates the daemon-owned runtime, even
  when its bridge session also contains a local inspection runtime.
- Under `--bare`, `test` is recorded as skipped and `enable` changes only the
  mutable switch; the UI continues to report immutable suppression.
- Description: “Inspect and test AgenC hook configuration”

---

## Gateway Hooks HTTP (pointer)

Automation entry only — **not** PreToolUse/PostToolUse.

| Item | Value |
| --- | --- |
| Enable | Gateway config / `agenc gateway run --hooks` + token |
| Endpoint | `POST /hooks/agent` |
| Default port | `8377` |
| Auth | `Authorization: Bearer <token>` (query tokens rejected) |
| Budget | Same autonomous envelope; refuse → HTTP **429** |
| Permissions | Deny tool permission requests |

Full request shape, security table, and operator checklist:
[autonomy.md — Hooks HTTP](autonomy.md#hooks-http-runtimesrcgatewayhooksts).

---

## Source map

| Concern | Path |
| --- | --- |
| Config events + validation | `runtime/src/config/schema.ts` (`HOOK_EVENT_NAMES`, `validateHooksConfig`) |
| Session hook runtime | `runtime/src/hooks/` |
| Settings hook Zod | `runtime/src/schemas/hooks.ts` |
| SDK event enum (wider) | `runtime/src/entrypoints/sdk/coreTypes.ts` |
| Slash command | `runtime/src/commands/hooks.ts` |
| Gateway HTTP | `runtime/src/gateway/hooks.ts` |
