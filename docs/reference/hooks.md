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
| `PreCompact` | Before context compaction. Can add focus instructions; cannot restore tools. |
| `PostCompact` | After a durable `compaction_committed`. Observes the replacement; cannot change the catalog. |

CamelCase and lowerCamel aliases normalize (e.g. `preToolUse` → `PreToolUse`).

A `PreToolUse` **allow** does not skip tools that set
`requiresUserInteraction()` (`AskUserQuestion` and the other input
prompts). Those calls still reach the answer-bearing resolver. A hook
**deny** still wins. See
[tools-permissions-sandbox.md](tools-permissions-sandbox.md#interactive-tool-prompts).

The SDK type list in `entrypoints/sdk/coreTypes.ts` (`HOOK_EVENTS`) is **wider**
(e.g. `SubagentStart`, `Setup`, `ConfigChange`, `InstructionsLoaded`, …). Those
extra names are for the broader runtime/SDK surface; **TOML `hooks` validation
only accepts the table above**.

`PreCompact` / `PostCompact` do not change the admitted summary catalog.
`invokeCompactionProvider` always sends `tools: []` and
`toolRouting: { allowedToolNames: [] }`, and hook output cannot change those
options. `PreCompact` may return `newCustomInstructions`; those merge into the
summary focus prompt and **do** count against the summary window. If
`PreCompact` fails or throws, compaction continues without its focus text.
`PostCompact` runs only after a flushed `compaction_committed` and receives
`compact_summary`. Details:
[mcp.md](mcp.md#compaction-summaries-stay-tool-free).

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
- Outbound skill/session **HTTP hooks** resolve through `ssrfGuardedLookup`
  (`runtime/src/utils/hooks/ssrfGuard.ts`). Private, link-local, CGNAT,
  reserved/docs/benchmark/multicast, and cloud-metadata addresses are
  blocked, including IPv4-mapped and scoped IPv6 forms. **Loopback is
  allowed** for local-dev policy servers. When a process or sandbox proxy
  is active, that proxy performs DNS and applies its own allowlist instead.
  Cron delivery webhooks are stricter: they reuse the browser public-egress
  classifier and **block loopback**. See
  [autonomy.md](autonomy.md#webhook-destinations-pinned-fail-closed).

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
Project- and local-scope installs are repository-controlled and do not
contribute hooks (same strip as plugin MCP). Use `--scope user`. See
[skills-plugins.md](skills-plugins.md#plugin-mcp-servers).

### UserPromptSubmit

Canonical ingress is `prepareUserPromptForTurn`
(`runtime/src/hooks/user-prompt-ingress.ts`). Local CLI turns, daemon
`message.send` / `message.stream`, and `agent.create` first content
all go through it. Hooks run **exactly once** against the original
display text (`hookPrompt`, else `userPromptDisplayText`). File
mentions expand only after the turn is allowed. Hook
`additionalContext` is appended after that expansion so repository
text cannot change hook input.

`--bare` / `hardSuppressed` skips the hook loop. Daemon **editor**
submissions (`editorInteraction` set) skip it too. BUFFER / Neovim
requests do not start configured lifecycle or prompt hooks. See
[the embedded Neovim buffer contract](../embedded-neovim-buffer.md).

#### How a command hook refuses one prompt

Configured `UserPromptSubmit` commands (`configured-hooks.ts`
`createUserPromptSubmitHook`) can refuse the **current** prompt in
three forms. `UserPromptSubmit` does not filter entries by `matcher`.
Every enabled entry runs in configuration order. The first result that
blocks or stops ends evaluation, so later hooks do not run. A thrown
hook emits a warning and evaluation continues with the next entry.

| Hook result | Session event `cause` | Blocks the prompt? |
| --- | --- | --- |
| Exit code **2** with non-empty stderr | `user_prompt_submit_hook_blocked` | Yes |
| JSON `decision: "block"` plus a non-empty `reason` | `user_prompt_submit_hook_blocked` | Yes |
| JSON `continue: false` (optional `stopReason`) | `user_prompt_submit_hook_stopped` | Yes |
| Hook function throws (SDK/plugin callback or unexpected adapter throw) | `user_prompt_submit_hook_threw` | No. Remaining hooks still run. |

Exit 2 with empty stderr, or `decision: "block"` without a non-empty
`reason`, is recorded as a hook-output issue and does **not** block.
Other non-zero exits are non-blocking errors.

To deny one prompt with a reason on stderr:

```toml
[[hooks.UserPromptSubmit]]
hooks = [{ type = "command", command = "/usr/local/bin/deny-secrets.sh", timeout_ms = 5000 }]
```

```bash
#!/bin/sh
# stdin is JSON: { hook_event_name, prompt, permission_mode, cwd, ... }
printf '%s\n' "policy denied: prompt mentions a secret path" >&2
exit 2
```

The equivalent structured stdout is:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "decision": "block",
    "reason": "policy denied: prompt mentions a secret path"
  }
}
```

On a block the runtime emits a session **`warning`** and returns
`PreparedUserPrompt.blocked`. It emits no `error` or `user_message`,
does not expand file mentions, and does not start `runTurn`.
Daemon callers surface that as JSON-RPC `-32602` with
`data.code: "PROMPT_BLOCKED"` (`AgenCDaemonAgentLifecycleError`).
The TUI prints the three causes above as transcript warnings
(`USER_VISIBLE_WARNING_CAUSES` in `tui/session-transcript.ts`).

A throw is a warning only. It never flips the run to `error` and
never refuses the prompt.

#### Daemon sessions stay promptable

A blocked follow-up is a **per-prompt** refusal. The runner keeps
`agent.status` off `error`, so a later allowed `message.send` can
start a turn. If a legacy-format `type: "error"` with
`cause: "user_prompt_submit_hook_blocked"` crosses the live event-log
bridge, the daemon applies `statusProjection: "session_only"`.
An event received before attach stays in the runner's in-memory buffer.
Attach later delivers it as `event.session_event`. The bridge does not
emit `event.agent_status` or change run status. The rule applies to live
events and the pre-attach buffer. Events seeded from an older persisted
rollout remain outside this bridge and its in-memory attach replay.

`agent.create` with blocked **first** content follows startup failure
semantics. Start fails with `PROMPT_BLOCKED`, the unpublished bootstrap
is shut down, and no agent is published.

See [daemon prompt-block behavior](daemon.md#prompt-hook-blocks-stay-per-prompt)
for operator details.

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
| UserPromptSubmit ingress | `runtime/src/hooks/user-prompt-ingress.ts`, `user-prompt-submit.ts` |
| Settings hook Zod | `runtime/src/schemas/hooks.ts` |
| SDK event enum (wider) | `runtime/src/entrypoints/sdk/coreTypes.ts` |
| Slash command | `runtime/src/commands/hooks.ts` |
| Gateway HTTP | `runtime/src/gateway/hooks.ts` |
| Outbound HTTP-hook SSRF | `runtime/src/utils/hooks/ssrfGuard.ts`, `runtime/src/utils/hooks/execHttpHook.ts` |
