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
| `/goal` | | Set an end condition the agent works toward until verified checks and an independent reviewer agree it is met; `/goal` alone shows status. See [goal.md](goal.md) |
| `/login` | | Sign in with your AgenC account |
| `/logout` | | Sign out of your AgenC account |
| `/whoami` | `account` | Show the signed-in AgenC account |
| `/subscription` | `billing` | Show your AgenC plan and billing URL |
| `/usage` | | Show AgenC plan usage and the balance or usage of each connected provider; `/usage <provider>` (for example `/usage ollama`) shows one provider in detail. See [`/usage`](#usage) |
| `/grok-login` | `xai-login` | Sign in with X for Grok subscription access (optional `device` flow). Headless: `agenc grok-login` |
| `/grok-logout` | `xai-logout` | Sign out of the xAI / Grok OAuth session |
| `/openai-login` | `chatgpt-login` | Sign in with ChatGPT for OpenAI subscription access |
| `/openai-logout` | `chatgpt-logout` | Sign out of the OpenAI / ChatGPT OAuth session |
| `/cost` | `stats` | Show session cost, token usage, and per-agent spend |
| `/model` | | Switch the model (picker or pass a name). Type in the picker to search its models by ID or name; Esc clears the search. The session keeps its reasoning effort if the new model accepts it; otherwise the new model runs at its default and the switch says so |
| `/provider` | | Switch the LLM provider for subsequent turns. Reasoning effort carries over as with `/model` |
| `/effort` | | Show or set reasoning effort for the current model (the exact model catalog levels, including `minimal` where supported; `default` clears the session's effort, so every model it switches to runs at its own default) |
| `/resolve` | `resolve-effects` | Resolve a blocked unknown-outcome tool effect in the **live** session (`<call-id> <disposition> [<evidence-ref> <evidence-sha256>]`). Resume a settled terminal first. |
| `/swarm` | | Show or set conservative adaptive routing (`on`, `off`, `status`) |
| `/ledger` | `wallet` | Ledger wallet CLI: `status`, `install`, `session`, `discover`, `balances`, `operations`, `receive`, `send`, `swap`, `earn`, `ring`, `help` |
| `/permissions` | `approvals`, `allowed-tools` | Manage permission mode and rules |
| `/plan` | | Enter plan mode or display the current plan (read-only tools) |
| `/agents` | | Manage agents — opens a picker |
| `/tasks` | `jobs`, `bashes` | Show live background tasks and spawned agents |
| `/todos` | `todo` | Show the session todo lists |
| `/config` | | Manage configuration — opens a picker |
| `/theme` | | Choose the color theme. The picker previews each theme as the selection moves, Enter saves it as `tui.theme` and Esc keeps the current one; `/theme <name>` sets one directly. See [`/theme`](#theme) |
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
`config`, `theme`, `keybindings`, `hooks`, `skills`, `mcp`, `remote`, `plugins`, `memory/slash`,
`resume`, `rewind`, `init`, `output-style`, `clear`, `session-compact`,
`compaction-operator`, `coordinator`, `diff`, `protocol`, `exit`). Related:
[grok-oauth.md](../grok-oauth.md), [cli.md](cli.md) (compaction operator),
[security/mobile-ledger-transfer.md](../security/mobile-ledger-transfer.md).

---

## Bridge command policy

`runtime/src/commands/bridge-policy.ts` defines the fixed bridge allowlist
and the shared `isBridgeSafeCommand` predicate. The CLI, dispatcher, and
command-object exports use that same predicate. Commands outside the list
require direct CLI confirmation when `runSlashCommand` receives
`bridge: true`.

The policy accepts exact canonical names. Raw aliases such as `/reset` for
`/clear` remain blocked over the bridge. A resolved command object is checked
by its canonical `name`; its aliases and displayed name cannot grant bridge
access. Local JSX commands are rejected even when their name is allowlisted.
Local dispatch without `bridge: true` retains normal alias handling.

Prompt commands are not in the fixed allowlist.
`isBridgeForwardablePromptCommand` identifies prompt objects for a separate
prompt-forwarding path. That predicate does not authorize local command
execution or bypass tool permissions. A parsed name alone never grants
prompt-forwarding access.

Change the allowlist in the policy module and update the expected names in
`runtime/tests/commands/bridge-policy.test.ts` when approving another command.
The adapters and command-object set derive their membership from that list.

## `/login`

`/login` signs into the AgenC account for account features. It does not provide
models or change the selected provider. Use `/grok-login` for Grok,
`/openai-login` for OpenAI, or `/providers` to configure your own provider key.

## `/usage`

`/usage` lists every provider with a key set (an
environment variable or a key saved in `/provider`) whose API reports a balance
or usage for that same key. All lookups run at once with a 5 second timeout per
request, and a provider that fails shows one dim line such as
`Ollama Cloud  usage unavailable (HTTP 401)` without holding up the others.

`/usage <provider>` shows one provider in detail. `/usage ollama` means Ollama
Cloud, since a local Ollama server has no account.

| Provider | Summary | Detail adds | Endpoint |
| --- | --- | --- | --- |
| Ollama Cloud | plan credits left and reset date (or session and weekly limits on legacy plans), purchased credits, last 24 hours, top two models | plan period, last 7 days, web search and fetch, spend per model | `GET /api/balance`, `GET /api/usage` |
| OpenRouter | account credits left | credits used, this key's daily, weekly, monthly and total spend, key limit, free model requests, key expiry | `GET /api/v1/credits`, `GET /api/v1/key` |
| DeepSeek | balance per currency | granted and topped-up balance, whether API calls are allowed | `GET /user/balance` |
| Venice AI | USD balance, plus DIEM and bundled credits when present | DIEM refresh date, API tier and access, key expiry | `GET /api/v1/api_keys/rate_limits` |
| Kimi (Moonshot) | available balance and money owed | voucher and cash balance | `GET /v1/users/me/balance` |
| abliteration.ai | credits left | credits used | `GET /v1/credits` |

Each request goes only to the origin the provider's chat adapter would use, so a
key never travels where that provider's chat requests could not. OpenRouter,
DeepSeek, Venice and abliteration.ai follow their resolved base URL (the
registry default, `providers.<id>.base_url` in config, or the provider's
`*_BASE_URL` override). The Ollama Cloud and Kimi adapters are pinned to
`https://ollama.com/v1` and `https://api.moonshot.ai/v1` and refuse any other
endpoint, so with a different `base_url` their usage shows
`usage unavailable (custom endpoint)` and no request is sent. Redirects are
refused and keys are never printed. Providers whose APIs need an admin or
management key for billing (OpenAI, Anthropic, xAI, Mistral) or document no
balance API for API keys (Gemini, Groq, Cerebras, NVIDIA NIM, Meta, Qwen, Z.AI, MiniMax, GitHub
Copilot, Amazon Bedrock) are not listed. There is no AgenC account model-usage section.

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
with `mid_turn_compact_skipped` (`warning` cause `mid_turn_compact_failed`,
`stopReason: "compact_failed"`). The canonical terminal is `turn_failed`
with code `compact_failed`. Keep-alive sessions stay promptable, while
daemon-backed `--print` / `--no-tui` exits 1.
Env catalog: [env.md](env.md). Session survival:
[daemon.md](daemon.md#compact-skip-stays-per-turn).
The transaction itself has a 900 s wall budget
([CP-0006](../design/critical-path/0006-compaction-transaction.md#compaction-transaction-wall-budget)).

Successful transactional compaction reports its durable attempt ID in the
command result. A replacement-history boundary also displays the ID, so it
remains available in transcript history. `/compact-rollback` and
`/compact-retain` accept that ID; it is also recorded on the
`compaction_committed` payload and retention pin. Both commands refuse during
an active turn (`ACTIVE_TURN`). Syntax:
[cli.md](cli.md#compaction-operator-commands).

## `/theme`

`/theme` opens a picker of the color themes `tui.theme` accepts: `auto`,
`dark`, `light`, `light-daltonized`, `dark-daltonized`, `light-ansi`,
`dark-ansi` and `olive`. Moving the selection repaints the screen in that
theme, and the picker draws a short sample conversation, because the
transcript is hidden while a picker is open.

| Key | Effect |
| --- | --- |
| Up / Down (or `k` / `j`) | Move and preview |
| Enter | Save the highlighted theme as `tui.theme` in your user `config.toml` and close |
| Esc (or `q`) | Close and keep the theme you had. Ctrl+C or any other close does the same |

`/theme <name>` saves a theme without the picker, in any case. An unknown
name returns an error that lists the valid names and saves nothing. `auto`
follows the terminal background: olive on a dark terminal, light on a light
one.

The saved theme is the same setting `/config` shows and first-run setup
writes, so new sessions start with it, and `/config reload` after a hand edit
of `config.toml` applies it at once. If a project, managed or command-line
layer sets its own `tui.theme`, that layer still wins: `/theme` saves your
choice and says which layer keeps its theme in effect.

These are color themes only. The lean agent mode started with `--light` is a
different setting.

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
  [<evidence-ref> <evidence-sha256>]
```

With only the call id and a disposition, you attest the outcome from your own
knowledge (for example, "that stopped MCP call never reached anything that
writes"). Core records the attestation itself as the operator evidence: the
reference `operator-attestation:<session>:<call-id>` and the SHA-256 of the
canonical attestation (reviewer, disposition, time). Pass an evidence
reference and its SHA-256 instead when you hold a receipt or ticket. Only a
client attached to the session can resolve it, and the recorded reviewer is
that client, not a name given in the command.

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

Current `close_agent` / `assign_task` / `send_message` argument and identity
refusals already attest `confirmed_no_effect` and should not appear as
pending reviews. The same applies to `assign_task`'s four typed pre-marker
admission rejections. If a later FileWrite / Bash / spawn is still gated
after one of those messages, the call reached shutdown, mailbox delivery, or
an unclassified path, or the journal predates that attestation. Operator detail:
[agents.md](agents.md#agent-validation-refusals).

---

## Notes

| Topic | Fact |
| --- | --- |
| Surfaces | Some commands declare `supportedSurfaces` (e.g. `/hooks` → `runtime`, `daemon-tui`); default is all surfaces when omitted |
| Protocol verbs | Default: honest stub unless `[protocol] enabled = true` + `adapter = "marketplace-cli"`; mutating verbs stay owner-gated. Never available in a session created with a `toolPolicy` (they refuse before any process starts) |
| `/provider` vs config | Slash name `/provider`; persisted field `model_provider` |
| Help groups | Presentation metadata in `runtime/src/commands/help-groups.ts` |
| Plugin-added commands | Plugins can register additional commands outside this minimal registry (see [skills-plugins.md](skills-plugins.md)) |

Related: [cli.md](cli.md) (top-level `agenc` subcommands).
