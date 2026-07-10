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
matcher = "Bash"
enabled = true
hooks = [
  { type = "command", command = "/path/to/check-bash.sh", timeout_ms = 5000, statusMessage = "pre-bash hook" },
]
```

Flattened runtime entries carry `source: "config"`, `sourcePath`, and index
(`IndividualHookConfig` in `hooks/engine/types.ts`).

### Extended hook kinds (settings / schema package)

`runtime/src/schemas/hooks.ts` also defines discriminated hook kinds for
settings-style config: `command`, `prompt`, `http`, `agent` (with optional
`if` permission-rule filters, timeouts in **seconds**, async flags, etc.).
That Zod surface is broader than the TOML `validateHooksConfig` command-only
path. Prefer matching the path you edit (TOML vs settings JSON).

### Security

- Config/plugin **command** hooks run arbitrary shell → require a **trusted**
  workspace (`isProjectTrustedSync`), unless
  `AGENC_ALLOW_UNTRUSTED_HOOKS=1|true|yes` (automation opt-in).
- Secrets redacted in diagnostics where wired (`configured-hooks.ts`).

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
- Against daemon: `test` and `clear-diagnostics` may report deferred;
  `enable`/`disable` need daemon RPC support
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
