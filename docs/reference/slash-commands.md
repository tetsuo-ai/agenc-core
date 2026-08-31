# Slash commands reference

User-invocable TUI / daemon slash palette. Registry:
`runtime/src/commands/registry.ts` (`buildDefaultRegistry`). Unlisted commands
are not dispatchable through that registry.

Parse/dispatch: `runtime/src/commands/dispatcher.ts` (`/name args`).

**Provider command is `/provider`**, not `/model-provider`. Config key remains
`model_provider` / env `AGENC_PROVIDER`.

---

## Registered commands

Order matches `buildDefaultRegistry`.

| Command | Aliases | Purpose |
| --- | --- | --- |
| `/help` | | Show help and available commands |
| `/hello` | | Print a greeting card with the current model and workspace |
| `/status` | | Show current session and runtime status |
| `/login` | | Sign in with your AgenC account |
| `/logout` | | Sign out of your AgenC account |
| `/whoami` | `account` | Show the signed-in AgenC account |
| `/subscription` | `billing` | Show your AgenC plan and billing URL |
| `/usage` | | Show hosted model usage for your AgenC plan |
| `/grok-login` | `xai-login` | Sign in with X for Grok subscription access (optional `device` flow). Headless: `agenc grok-login` |
| `/grok-logout` | `xai-logout` | Sign out of the xAI / Grok OAuth session |
| `/openai-login` | `chatgpt-login` | Sign in with ChatGPT for OpenAI subscription access |
| `/openai-logout` | `chatgpt-logout` | Sign out of the OpenAI / ChatGPT OAuth session |
| `/cost` | `stats` | Show session cost, token usage, and per-agent spend |
| `/model` | | Switch the model (picker or pass a name) |
| `/provider` | | Switch the LLM provider for subsequent turns |
| `/effort` | | Show or set reasoning effort for the current model (`low` / `medium` / `high` / `xhigh` when the catalog allows it; `default` restores the model default) |
| `/resolve` | `resolve-effects` | Resolve a blocked unknown-outcome tool effect in the **live** session (`<call-id> <disposition> <evidence-ref> <evidence-sha256>`). Resume a settled terminal first. |
| `/swarm` | | Show or set conservative adaptive routing (`on`, `off`, `status`) |
| `/ledger` | `wallet` | Ledger wallet CLI: `status`, `install`, `session`, `discover`, `balances`, `operations`, `receive`, `send`, `swap`, `earn`, `ring`, `help` |
| `/permissions` | `approvals`, `allowed-tools` | Manage permission mode and rules |
| `/plan` | | Enter plan mode or display the current plan (read-only tools) |
| `/agents` | | Manage agents — opens a picker |
| `/tasks` | `jobs`, `bashes` | Show live background tasks and spawned agents |
| `/todos` | `todo` | Show the session todo lists |
| `/config` | | Manage configuration — opens a picker |
| `/keybindings` | | Scaffold and edit canonical `tui.keybindings`, then reload config |
| `/hooks` | | Inspect and test AgenC hook configuration |
| `/skills` | | Manage project skills and show loaded skill roots |
| `/mcp` | | Show and manage MCP servers |
| `/remote` | | Link this machine to the AgenC phone app |
| `/plugins` | `plugin`, `marketplace` | Show and manage AgenC plugins |
| `/memory` | | Open AgenC memory editor (TUI; headless points at TUI) |
| `/resume` | `sessions` | List resumable sessions for this project |
| `/rewind` | | Restore the code and/or conversation to a previous point |
| `/init` | | Analyze this repository and write `.agenc/config.toml` plus `AGENC.md` |
| `/output-style` | `style` | Switch the active output style |
| `/output-style:new` | | Author a new **user** output style under `$AGENC_HOME/output-styles/` (default `~/.agenc/output-styles/`) |
| `/clear` | `reset`, `new` | Clear session history and caches |
| `/compact` | | Compact the current conversation |
| `/compact-rollback` | | Restore a committed compaction source history (`<attempt-id> [--branch <session-id>]`) |
| `/compact-retain` | | Extend a compaction rollback-retention deadline (`<attempt-id> --until <ISO-8601>`) |
| `/context` | `ctx` | Show current context usage |
| `/coordinator` | `fleet` | Show or toggle coordinator (orchestrator) mode |
| `/diff` | | Show uncommitted changes (`git diff HEAD` + untracked) |
| `/claim` | | Protocol: claim an open marketplace task (gated by `[protocol]`) |
| `/delegate` | | Protocol: delegate a task step (owner-gated; often stub) |
| `/proof` | | Protocol: generate or verify a proof (owner-gated; often stub) |
| `/settle` | | Protocol: submit completion / settle escrow (owner-gated) |
| `/stake` | | Protocol: inspect or adjust protocol stake (owner-gated) |
| `/exit` | `quit` | Shut down the session cleanly and exit |

Sources: `runtime/src/commands/*.ts(x)` modules imported by
`buildDefaultRegistry` in `registry.ts` (`help`, `hello`, `status`, `auth`,
`xai-auth`, `openai-auth`, `cost`, `model`, `provider`, `effort`, `resolve`, `swarm`,
`ledger`, `permissions`, `plan`, `agent-management`, `tasks`, `todos`,
`config`, `keybindings`, `hooks`, `skills`, `mcp`, `remote`, `plugins`, `memory/slash`,
`resume`, `rewind`, `init`, `output-style`, `clear`, `session-compact`,
`compaction-operator`, `coordinator`, `diff`, `protocol`, `exit`). Related:
[grok-oauth.md](../grok-oauth.md), [cli.md](cli.md) (compaction operator),
[security/mobile-ledger-transfer.md](../security/mobile-ledger-transfer.md).

---

## `/login`

`/login` signs into the AgenC account. The PromptInput footer
[usesAnthropicAccountFlow](../../runtime/src/utils/model/providers.ts) gates
the login prompt to first-party providers (`anthropic`, `amazon-bedrock`). A
Grok or openai-compatible BYOK session does not show it when the provider
selection is correct. Use `/grok-login` for Grok and `/openai-login` only for
the `openai` provider. The `openai-compatible` provider uses
`OPENAI_COMPATIBLE_API_KEY`, its documented fallback, or a provider-scoped
saved BYOK credential. See
[env.md](env.md#provider-credential-isolation).

## `/swarm`

| Invocation | Effect |
| --- | --- |
| `/swarm` or `/swarm status` | Show the effective and saved mode plus active and idle/reusable local-agent counts |
| `/swarm on` | Persist swarm mode and enable root-turn adaptive routing |
| `/swarm off` | Persist swarm mode off |

The no-argument form reports status; it does not toggle. The status count
classifies `local_agent` tasks in `pending`/`running` as active and `idle` as
reusable.

When enabled, the next eligible root turn receives one conservative routing
decision. Sequential remains the default. Qualifying parallel work
force-selects `spawn_agent` for the first provider request, requiring at least
one real worker-spawn attempt and allowing two workers or a ceiling of four.
Synthetic/mailbox follow-up turns coordinate existing receipts instead of
recursively spawning replacements.

The forced tool selection does not force admission or the maximum count,
create worktrees, approve tools, or bypass permission, sandbox, capacity,
admission, or budget controls. Plan mode remains non-mutating. If
`spawn_agent` is unavailable, AgenC reports that boundary and continues
locally. Turning swarm mode off does not disable explicit use of the
multi-agent tools. Full routing, receipt, and integration semantics:
[swarm-orchestration.md](../design/swarm-orchestration.md).

## `/compact`

`/compact [focus]` runs a manual transactional compaction
(`manualCompactCall` → `compactConversation`). Optional args are custom
focus instructions, not a keep-count. It refuses while
`session.activeTurn` is set.

The daemon-backed TUI has no in-process `newDefaultTurnWithSubId`. It calls
`session.partialCompactFromMessage` with `messageOrdinal: 0` and
`direction: "from"` for a full forward compact. The daemon emits the
authoritative `history_replaced` event and returns the operator display text.

Neither `AGENC_DISABLE_COMPACT` nor `AGENC_DISABLE_AUTO_COMPACT` disables
this command. They are not interchangeable on the automatic path: the
mid-turn outer gate consults only `AGENC_DISABLE_AUTO_COMPACT`. Setting
`AGENC_DISABLE_COMPACT` alone still trips that gate, then
`autoCompactIfNeeded` returns `wasCompacted: false`, and the turn ends
with `mid_turn_compact_skipped`. Env catalog: [env.md](env.md).

Successful transactional compaction reports its durable attempt ID in the
command result. A replacement-history boundary also displays the ID, so it
remains available in transcript history. `/compact-rollback` and
`/compact-retain` accept that ID; it is also recorded on the
`compaction_committed` payload and retention pin. Both commands refuse during
an active turn (`ACTIVE_TURN`). Syntax:
[cli.md](cli.md#compaction-operator-commands).

## `/permissions`

`/permissions` opens the permission editor. The command also accepts `list`,
`add`, `remove`, `export`, and `mode` subcommands.

`bypassPermissions` requires separate consent. Run `/permissions accept-bypass`
to record consent for the exact canonical workspace path and directory
identity, then run `/permissions mode bypassPermissions`. The
consent is stored in permission-owned runtime state and is loaded by later
sessions for that same workspace. It does not apply to another path or to a
replacement directory at the same path. Managed policy may disable bypass
mode.

## `/resolve`

`/resolve` settles one `unknown_outcome` tool effect **inside a live
session**. It is the same daemon path as `session.resolveToolCall`.

```text
/resolve <call-id> <confirmed_committed|confirmed_no_effect|remains_unknown> \
  <evidence-ref> <evidence-sha256>
```

Resume first (`--resume` / `/resume`) when the previous epoch ended as
`completed`, `failed`, or `cancelled`. Pending reviews do not block those
settled terminals from reopening. Side-effecting tools stay gated until the
review lands. An `unknown_outcome` terminal remains non-resumable through the
public agent path. After stopping the session, the offline
`agenc state resolve-tool-call` command can append review evidence for a
projected unknown-outcome effect, but it does not make that terminal resumable.
A dangling intent has no settlement record and cannot be resolved by either
review command.

The command never reruns the tool or rewrites the physical outcome as
success. Full reopen table:
[durable-runs-effects-events.md](../design/durable-runs-effects-events.md#resume-and-effect-review).

---

## Notes

| Topic | Fact |
| --- | --- |
| Surfaces | Some commands declare `supportedSurfaces` (e.g. `/hooks` → `runtime`, `daemon-tui`); default is all surfaces when omitted |
| Protocol verbs | Default: honest stub unless `[protocol] enabled = true` + `adapter = "marketplace-cli"`; mutating verbs stay owner-gated |
| `/provider` vs config | Slash name `/provider`; persisted field `model_provider` |
| Help groups | Presentation metadata in `runtime/src/commands/help-groups.ts` |
| Plugin-added commands | Plugins can register additional commands outside this minimal registry (see [skills-plugins.md](skills-plugins.md)) |

Related: [cli.md](cli.md) (top-level `agenc` subcommands), [tui-workbench.md](tui-workbench.md).
