# AgenC Architecture

A current map of how `agenc` is put together (runtime **0.17.0**). For the
user-facing CLI, quick start, and install paths see [`../README.md`](../README.md)
and [`quickstart.md`](quickstart.md). Reference docs for operators and embedders:

| Doc                                                                              | Scope                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`reference/daemon.md`](reference/daemon.md)                                     | Daemon process, socket, protocol, lifecycle                                  |
| [`reference/providers.md`](reference/providers.md)                               | Built-in providers, defaults, credentials, local context-window probes       |
| [`reference/autonomy.md`](reference/autonomy.md)                                 | Budget, heartbeat, cron delivery, hooks HTTP                                 |
| [`design/execution-admission-kernel.md`](design/execution-admission-kernel.md)   | Live durable budget/admission design                                         |
| [`design/durable-runs-effects-events.md`](design/durable-runs-effects-events.md) | Canonical run journal, effects, terminal results, replay, and crash recovery |
| [`gateway.md`](gateway.md)                                                       | Channel gateway operator guide                                               |
| [`sdk.md`](sdk.md)                                                               | `@tetsuo-ai/agenc-sdk` embedding API                                         |

## Process model

`agenc` is **daemon-backed**. Three cooperating pieces:

```
┌─────────────────────┐     autostart / attach      ┌──────────────────────────┐
│  Launcher           │ ──────────────────────────► │  Daemon (app-server)     │
│  packages/agenc     │                             │  runtime/src/app-server  │
│  @tetsuo-ai/agenc   │                             │  one per AGENC_HOME      │
└──────────┬──────────┘                             └────────────▲─────────────┘
           │                                                     │
           │  delegates to runtime bin                           │ JSON-RPC
           ▼                                                     │ over local socket
┌─────────────────────┐                             ┌────────────┴─────────────┐
│  Runtime CLI/TUI    │ ──────────────────────────► │  Clients                 │
│  @tetsuo-ai/runtime │                             │  TUI · print · agents    │
│                     │                             │  gateway · remote · SDK  │
└─────────────────────┘                             └──────────────────────────┘
```

1. **Launcher** (`packages/agenc`, published as `@tetsuo-ai/agenc`) — the
   binary a user installs (`agenc`). It resolves the platform runtime (dev
   `file:` link or downloaded tarball from `tetsuo-ai/agenc-releases`),
   optionally autostarts the local daemon, then execs the runtime entry.
   Autostart is on by default; disable with `AGENC_DAEMON_AUTOSTART=0`.
2. **Daemon** (`runtime/src/app-server`) — the local control plane. **One per
   `AGENC_HOME`**. Owns agent/session lifecycle, JSON-RPC dispatch, command
   execution, provider-key vending, permission requests, realtime methods,
   health, recovery, and background-agent attachment. Clients authenticate
   with a cookie on a Unix socket or Windows named pipe (optional WebSocket
   transport).
3. **Clients** — interactive **TUI**, one-shot **print / `--no-tui`**,
   **background agents**, the **channel gateway**, **remote control**, and
   the embedding **SDK**. Real work flows through the daemon; the TUI is a
   view onto daemon-owned sessions.

Everything past the launcher lives in the single runtime workspace
(`@tetsuo-ai/runtime`). The launcher is intentionally tiny.

### Packages

| Package                                       | Role                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/agenc` (`@tetsuo-ai/agenc`)         | Public launcher + postinstall runtime ensure                           |
| `packages/agenc-sdk` (`@tetsuo-ai/agenc-sdk`) | Zero-dep embedding/control client for the daemon protocol              |
| `runtime` (`@tetsuo-ai/runtime`)              | Full runtime: CLI, daemon, TUI, session/agent engine, tools, providers |

## Runtime subsystems (`runtime/src`)

| Dir                                                                      | Responsibility                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/`                                                                   | Order-safe CLI wrapper (`agenc.ts`), implementation (`agenc-main.ts`), and subcommand adapters: auth, config, mcp, doctor, init, providers, state, budget, gateway, remote, security, onboard, update, trajectories, …                           |
| `app-server/`                                                            | Daemon: transports, JSON-RPC dispatch, agent/session lifecycle, durable run inspection/replay, auth, health, background-agent runner, command exec, realtime, overload limits                                                                  |
| `app-server-client/`                                                     | In-process / client helpers for talking to the daemon                                                                                                                                                                                          |
| `app-server-protocol/`                                                   | Shared protocol constants (e.g. portal default local endpoint)                                                                                                                                                                                 |
| `session/`                                                               | Session engine: turn loop, transcript, canonical append-only rollout journal + `index.json`, persist-before-publish events, resume, cost, autonomous mode                                                                                      |
| `agents/`                                                                | Background-agent state, registry, roles, mailbox, worktree isolation, multi-agent v2 tools, CSV jobs (`agents/jobs/`), `WorkflowTool` DAG (`agents/workflow-*.ts`), delegate/fork                                                                 |
| `workflow/`                                                              | M5 verified-change pipeline (`agenc run start`). Not the `WorkflowTool` DAG.                                                                                                                                                                    |
| `auth/`                                                                  | Local and remote auth backends, native secure storage credential namespaces, BYOK precedence, provider auth selection, session auth metadata                                                                                                                                                   |
| `llm/`                                                                   | Provider-neutral client/request shaping, provider-aware complete-request [token accounting](design/provider-aware-token-accounting.md), model catalog, retries, streaming, wire adapters, OAuth refresh                                                                                                       |
| `tools/`                                                                 | Built-in model tools (Bash, File read/write/edit, `apply_patch`, Web fetch/search, LSP, MCP, Agent/subagent, Task*, …)                                                                                                                         |
| `tool-registry.ts` / `tools.ts`                                          | Tool registration and assembly entry points                                                                                                                                                                                                    |
| `permissions/`                                                           | Trust, approval policy, rules, modes, sandbox policy, unattended policy, guardian/classifier, audit log                                                                                                                                        |
| `sandbox/`                                                               | OS sandbox: Linux `bwrap` via `agenc-linux-sandbox` with `agenc-landlock-run` fallback; macOS in-tree Seatbelt (`engine/seatbelt.ts` + `/usr/bin/sandbox-exec`); Windows restricted-token fail-closed. Lifecycle brokers are separate (`agenc-process-broker`, `agenc-process-job-broker.exe`). See [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md). |
| `mcp-client/` / `mcp-server/` / `mcp/`                                   | Outbound MCP client, server framework, and serve bootstrap                                                                                                                                                                                     |
| `gateway/`                                                               | Channel gateway as a **daemon client**: Telegram, Discord, Slack, WebChat, stdio; pairing, bindings, approvals, session routing, untrusted framing, hooks HTTP, cron delivery, optional media/onchain helpers. See [`gateway.md`](gateway.md). |
| `heartbeat/`                                                             | Proactive ticks: policy, `HEARTBEAT.md` reader, runner, scheduler, gateway/budget wire. See [`reference/autonomy.md`](reference/autonomy.md).                                                                                                  |
| `budget/`                                                                | Daemon-owned execution admission, hierarchical budgets, concurrency, cancellation, and durable reconciliation. See [`design/execution-admission-kernel.md`](design/execution-admission-kernel.md).                                             |
| `phases/`                                                                | Turn phases: stream model, execute tools, commit, stop hooks, post-sample recovery, continuation nudge                                                                                                                                         |
| `hooks/`                                                                 | Configured lifecycle hooks (PreToolUse / PostToolUse / Stop / …) and hook engine                                                                                                                                                               |
| `elicitation/`                                                           | Structured user-input / MCP elicitation request-response                                                                                                                                                                                       |
| `memory/` / `memdir/`                                                    | Project/session memory extraction, storage, aging, retrieval; full-corpus FTS index (`derived-indexes/memory-v1.sqlite`); team memory paths. See [memory.md](reference/memory.md).                                                             |
| `config/`                                                                | Config schema, loader, migrations, profiles, model/provider resolution                                                                                                                                                                         |
| `state/`                                                                 | On-disk SQLite project state, migrations, rebuildable run/effect/journal projections, recovery, pruning, agent-runs, health stats                                                                                                              |
| `durability/`                                                            | Crash failpoints and immutable, atomic artifact publication                                                                                                                                                                                    |
| `secrets/`                                                               | Secret redaction / sanitizer                                                                                                                                                                                                                   |
| `transaction-guard/`                                                     | Opt-in local SLM guard for Solana-like mutating tool calls                                                                                                                                                                                     |
| `unified-exec/` / `pty/` / `shell-command/`                              | Process execution, PTY helpers, shell parsing/safety                                                                                                                                                                                           |
| `commands/`                                                              | Slash-command registry and TUI/headless command implementations                                                                                                                                                                                |
| `plugins/` / `skills/` / `outputStyles/`                                 | Plugin manifests/marketplace/registration; skill loading; output styles                                                                                                                                                                        |
| `prompts/`                                                               | System prompt assembly, sections, attachments                                                                                                                                                                                                  |
| `cost/`                                                                  | Session cost tracker + hook                                                                                                                                                                                                                    |
| `coordinator/`                                                           | Coordinator mode (orchestrate via spawned agents)                                                                                                                                                                                              |
| `planning/`                                                              | Plan files and exit-plan approval                                                                                                                                                                                                              |
| `thread-store/`                                                          | Live thread + file thread store for rollouts                                                                                                                                                                                                   |
| `tasks/`                                                                 | Task UI / task store surface for agent work items                                                                                                                                                                                              |
| `file-watcher/`                                                          | Workspace file-watch helpers                                                                                                                                                                                                                   |
| `transport/`                                                             | Transport fallback ladder                                                                                                                                                                                                                      |
| `services/`                                                              | Wire-layer helpers the turn loop and daemon call: LLM API adapters (`api/`), compaction (`compact/`), LSP, Ledger wallet CLI, code prediction, MCP transport glue, memory extraction, autoFix post-tool hook, heap watchdog. Most of these are not separate CLIs.                                                                                                                                                                                |
| `search/`                                                                | Persistent fuzzy file index used by `fs.fuzzy_search`                                                                                                                                                                                          |
| `workspace/`                                                             | Editor mutation leases and topology fences for BUFFER (`workspace.editor.*`)                                                                                                                                                                   |
| `contracts/`                                                             | Frozen run/admission/CSV/invocation types shared by daemon, SDK, and tests                                                                                                                                                                     |
| `recovery/`                                                              | Crash/recovery helpers for in-flight work                                                                                                                                                                                                      |
| `onboarding/`                                                            | Guided `agenc onboard` wizard UI                                                                                                                                                                                                               |
| `eval/`                                                                  | Diagnostic agent-eval report schema (runner lives under `runtime/scripts` + `runtime/eval`)                                                                                                                                                    |
| `eval-contract/`                                                         | Immutable task/preregistration/evidence/score contract v1                                                                                                                                                                                      |
| `eval-suites/`                                                           | Versioned competitive/trust suite definitions, catalog, schedule compiler, and validators                                                                                                                                                      |
| `tui/`                                                                   | Terminal UI (custom Ink reconciler fork under `tui/ink`)                                                                                                                                                                                       |
| `entrypoints/`                                                           | Public/SDK type entry surfaces                                                                                                                                                                                                                 |
| `protocol/`                                                              | Marketplace protocol A1/A2 (read-only CLI adapter + types); mutating claim verbs reserved / owner-gated                                                                                                                                        |
| `bootstrap/` / `lifecycle/` / `conversation/`                            | Bootstrap state, shutdown/signals, conversation token-budget and realtime                                                                                                                                                                      |
| `constants/` / `types/` / `errors/` / `utils/` / `context/` / `schemas/` | Shared constants, pure types, error shaping, utilities                                                                                                                                                                                         |
| `browser/`                                                               | Isolated Chromium CDP driver + SSRF proxy for the LIVE `Browser` tool                                                                                                                                                                          |
| `build/` / `version.ts` / `index.ts`                                     | Feature flags, version stamp (`0.17.0`), public barrel                                                                                                                                                                                         |

## State on disk (`AGENC_HOME`, default `~/.agenc`)

The daemon and runtime persist under one home. Relocate with an absolute
`AGENC_HOME=/path`; relative values are rejected.

| Path                                                               | Purpose                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `daemon.sock`                                                      | Unix domain socket (clients + SDK); Windows uses a stable per-home named pipe instead                                                 |
| `daemon.cookie`                                                    | Shared secret for local client auth (0600)                                                                                           |
| `daemon.pid`                                                       | Detached daemon PID                                                                                                                  |
| `daemon.log`                                                       | Daemon log sink                                                                                                                      |
| `daemon-snapshot.json` / runtime info files                        | Restart/recovery metadata                                                                                                            |
| `config.toml`                                                      | Operator config (`[budget]`, `[heartbeat]`, providers, …)                                                                            |
| `auth.json`                                                        | Non-secret auth identity, subscription, and timestamp metadata                                                                       |
| `runtime/<version>/<artifact-key>-sha256-<digest>/`                | Immutable content-addressed, ABI-keyed runtimes; staged/backup promotion is crash-recoverable                                        |
| `runtime/.activation-lock.sqlite` / `.activation-transaction.json` | `AGENC_HOME` activation lock and durable roll-forward journal; canonical wrapper locks live in a private per-user registry           |
| `gateway/`                                                         | Gateway sessions map, pairing, webchat token, heartbeat session id, control plane                                                    |
| `projects/<slug>/`                                                 | Per-project SQLite state (including execution admission, run/effect projections, and schema-v18 bounded recovery evidence) + canonical `sessions/<id>/` rollouts |
| `projects/<slug>/agenc-state_1.pre-v15.sqlite`                     | Automatic verified rollback snapshot created before upgrading an existing project database to schema v15                             |
| `sessions/` (project-scoped)                                       | Canonical append-only JSONL rollouts + advisory `index.json` (atomic tmp+fsync+rename)                                               |
| `derived-indexes/memory-v1.sqlite`                                 | Rebuildable full-corpus memory FTS cache (not source authority). See [memory.md](reference/memory.md).                               |
| logs / state DBs                                                   | SQLite state + logs databases under project/home layout                                                                              |

Login tokens, provider BYOK keys, remote bearers, and persisted remote
subprocess credentials are not file state. They live only in the native OS
secure storage, in home-scoped `localAuth`, `remoteAuth`, and
`remoteRuntimeAuth` namespaces; OpenAI/ChatGPT OAuth uses the separate
`openAiOauth` namespace. GitHub Models access/OAuth tokens, xAI OAuth, and
AgenC AI subscription OAuth use the `githubModels`, `xaiOauth`, and
`agencAiOauth` namespaces respectively. Gemini access-token and Application
Default Credentials auth has no provider-specific secure-storage namespace; Gemini API
keys explicitly saved through local BYOK live under `localAuth.byokKeys`.
Native updates use a cross-process
locked read-modify-write so one namespace cannot overwrite another, and an
OAuth refresh compare-and-swaps the credential version it read before making
the network request. Read caches, refresh single-flights, and refresh lock
paths are keyed by that same explicit home, so two homes cannot share or
overwrite credentials in one process. `auth.json` is a
metadata projection; `byok-keys.json` and the former `.agenc/remote` token
files, plus ProviderCode `auth.json`, are one-way migration inputs only and are
never ordinary runtime authorities. Every native adapter is bound to the
resolved `HomeContext`; macOS caches, Linux service names, and Windows DPAPI
paths/entropy cannot be redirected by later ambient environment changes.
macOS credential CRUD goes through the bundled `agenc-keychain-helper`, which
enumerates Security.framework generic-password matches and mutates only one
verified persistent reference; ambiguity fails closed. Credential bytes cross
that helper boundary only through stdin/stdout, never process arguments,
successful writes are byte-verified, and records at or above 16 MiB are
rejected before a write.

Optional trajectory export writes redacted rollout items via
`AGENC_TRAJECTORY_EXPORT_PATH` or `AGENC_TRAJECTORY_EXPORT_DIR`.

### Durable run event path

The rollout JSONL is the event authority. SQLite lifecycle/effect/query tables
are rebuildable projections, and `thread_rollout_items` is
the replay index. Durable events are sequenced, appended, and fsynced before
they reach either live subscriber surface:

```text
event stamp -> rollout append + fsync -> EventLog / txEvent publish
                    |
                    +-> thread_rollout_items -> run.replay / run.evidence
                    +-> durability projections (landed at schema v15; live
                        registry continues through v27) -> run.status / run.result
```

Effects add `effect_intent` before physical dispatch, followed by a proven
`effect_result` or an honest `effect_unknown_outcome`. Only operations whose
contract is explicitly `idempotent` carry an idempotency key or qualify for
replay. Side-effecting and interactive work never receives an arbitrary
exactly-once claim. Terminal results are immutable within a lifecycle epoch;
an explicit reopen creates the next epoch and keeps prior results. The final
automatic execution event is `run_terminal`; a stopped-session operator may
later take the exclusive rollout lease to append review evidence without
resuming execution. The terminal result's `lastSequence` remains that terminal
snapshot coordinate even when the audit-journal tail advances.

Admitted child and review runs have their own canonical journals. A failure
after spawn dispatch but before child construction seals a minimal failed or
cancelled journal, and a terminal `(runId, epoch)` cannot acquire a fresh
writer under another rollout path. Resource cleanup failures after terminal
commit are warnings; a journal-seal failure still fails the run.

Cursor replay uses per-run `(sequence, eventId)` identities. Retention,
compaction, corruption truncation, and bounded live-buffer eviction surface an
explicit `event_gap`; a cursor beyond the canonical tail surfaces
`cursor_ahead`. Neither case advances silently. Details and the 15-point
`SIGKILL` acceptance matrix are in
[`design/durable-runs-effects-events.md`](design/durable-runs-effects-events.md).

### Strict recovery evidence

Canonical recovery and conversational indexing have distinct contracts.
Descriptor-pinned canonical content is validated as one strict source before
any projection transaction begins: malformed JSON, duplicate object keys,
unsupported schemas, mixed legacy/sequenced lanes, sequence defects,
canonical identity conflicts, terminal-binding defects, and trusted digest
mismatches fail the whole projection. The ordinary rollout index may still
skip malformed rows because it is not executable recovery authority.

The strict file mechanism holds the session lease and one read-only source
descriptor across two bounded scans. Validation uses a disk-backed uniqueness
registry and retains no event array; the digest-anchored second pass emits one
row at a time inside the SQLite projection transaction. The final descriptor
identity, size, mtime, and digest proof runs immediately before commit. Named
ceilings cover line bytes, source bytes, event count, aggregate two-pass read
bytes, elapsed scan time, and descriptor reservations. Integrity ceilings are
quarantine reasons; aggregate time/byte and descriptor pressure remain
retryable operational failures.

Do not confuse this with `runtime/src/recovery/` (stream/model fallback
ladder, `post-sample-recovery`). Journal quarantine lives in `state/`.

Schema v18 adds bounded `run_recovery_quarantine`,
`run_recovery_quarantine_observations`, `run_recovery_deferred`, and immutable
`run_recovery_abandonments` metadata. Identical observations increment their
existing incident or block; recurrence after resolution creates a linked new
generation. Only old resolved history may be pruned. Active and abandoned
evidence is never removed to make a run executable. Local `agenc state recovery
… list/show` commands inspect redacted metadata even when the daemon cannot
start. The normal CLI installs the strict rescan/retry/abandon adapter.
Startup, on-demand inspection, stale-tool restoration, final recoverable-run
loading, and admission-journal convergence all consume the same active
quarantine, active deferral, and permanent abandonment exclusion contract.

`AGENC_HOME` is a single-host trust and locking boundary. It must live on a
local filesystem with reliable SQLite OS locks and atomic same-filesystem
rename, and must not be shared between machines or containers. Runtime
installation fails closed when the owning filesystem cannot be proven local.
Canonical wrapper locks live in persistent OS-account state rather than mutable
environment-derived runtime directories: Linux `~/.local/state/AgenC`, macOS
`~/Library/Application Support/AgenC`, and Windows
`os.userInfo().homedir/.agenc-state`. Account-state ownership, permissions,
symlinks, filesystem locality, and stable file identity are validated before
lock creation; Windows lock paths are NTFS-only and do not accept ReFS.

## Client surfaces

| Surface           | How it attaches                            | Notes                                                         |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Interactive TUI   | Runtime CLI → daemon                       | Default `agenc`                                               |
| Print / headless  | `agenc --no-tui` / `-p`                    | Stream-json capable; auto-denies unhandled permissions        |
| Background agents | `agent.*` daemon methods / `agenc agent …` | Per-run `AgentBudgetConfig` caps only (not cumulative budget) |
| Channel gateway   | `agenc gateway run` via SDK                | Telegram, Discord, Slack, WebChat, stdio                      |
| Hooks HTTP        | Gateway hooks server                       | `POST /hooks/agent` (loopback, bearer token)                  |
| Cron delivery     | Gateway cron delivery loop                 | Delivery-tagged tasks from `.agenc/scheduled_tasks.json`      |
| Embedding SDK     | `@tetsuo-ai/agenc-sdk` `connect()`         | Typed JSON-RPC client; also `promptViaSubprocess()`           |
| Remote control    | `agenc remote` / remote auth backend       | See [`remote-control.md`](remote-control.md)                  |

### Attachment and capability delivery

Most conversation notifications are attachment-bound: a client attaches to a
session and receives its transcript/tool stream. Authenticated initialize
capabilities add two deliberate exceptions for mobile clients:

- `portal.mobile.status.push.v1` fans out global `event.agent_status` frames so
  a background phone can observe completion without attaching every chat;
- `portal.ledger.solana.sign.v1` selects one capable phone for a typed client
  action and keeps a bounded replay while the daemon session is live.

The client multiplexer deduplicates logical registrations by physical delivery
key. Status is an observer feed; Ledger is a single-consumer action. Interactive
responses (`tool.approve`, `tool.deny`, `elicitation.respond`) bypass the normal
per-connection FIFO because they may unblock its head request, but they remain
subject to ordinary overload limits. Details:
[`remote-control.md`](remote-control.md) and
[`security/mobile-ledger-transfer.md`](security/mobile-ledger-transfer.md).

## Tools, permissions & sandbox

Model tools live in `runtime/src/tools`. Before a tool runs, the permission
layer resolves an approval decision from the active mode and rule set.

**Permission modes** (`runtime/src/types/permissions.ts`,
`runtime/src/permissions/permission-mode.ts`):

| Mode                | Role                                                            |
| ------------------- | --------------------------------------------------------------- |
| `default`           | Ask on request for sensitive tools                              |
| `acceptEdits`       | Auto-allow file edits; still ask for riskier actions            |
| `plan`              | Plan-only posture; mutating work gated until exit-plan approval |
| `bypassPermissions` | Restricted. Skips prompts down to a deny floor after exact-workspace consent. The dangerous startup flag also disables sandboxing. |
| `dontAsk`           | Deny when would-ask (no interactive prompt)                     |
| `auto`              | Classifier-assisted auto mode (feature-gated)                   |
| `unattended`        | Background-agent policy (allowlist/denylist / pause)            |
| `bubble`            | Bubble permission decisions to a parent context                 |

When enabled, the OS sandbox confines shell execution at the kernel level.
`bypassPermissions` waives approval prompts and leaves the configured sandbox
intact. `--dangerously-bypass-approvals-and-sandbox` selects bypass mode and
`danger-full-access` together.

The TUI requires `/permissions accept-bypass` before switching to
`bypassPermissions`. AgenC stores that consent against the workspace's
canonical path and directory identity. A configured bypass default does not
grant consent by itself.

The `read_only` and `workspace_write` runtime profiles retain a full-disk read
baseline, matching the live policy's empty allow-read semantics. Explicit
deny-read entries still win. `workspace_write` grants writes only to the
workspace, approved temporary paths, and other explicit write entries; write
checks run against the canonical permission profile on every resolved target.
On macOS the profile is enforced by Seatbelt, and on Linux by the configured
platform helper. This is a read-scope compatibility fix, not full-disk write
authority. On Linux the helper must sit outside the writable workspace; a
home-directory workspace fails that test and the remediation is to open a
project directory, not to reinstall. See
[tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md).

Mutating tools are guarded: file edits enforce read-before-write + mtime-drift
checks; `apply_patch` applies multi-file patches transactionally.

Full LIVE tool name catalog (by family), dual-catalog warning (LIVE vs TUI
pool), and sandbox details:
[`reference/tools-permissions-sandbox.md`](reference/tools-permissions-sandbox.md).

## Turn phases (`runtime/src/phases`)

One sampling iteration of the turn loop (`session/run-turn.ts`) runs an ordered
phase machine. Module files under `runtime/src/phases/` own the heavy steps;
`TurnState` documents the same numbering.

| #   | Stage                | Module / site                    | Role                                                                                              |
| --- | -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `prepareContext`     | inline in `session/run-turn.ts`  | Build messages for query, attachments, compact, request contract                                  |
| 2   | `streamModel`        | `phases/stream-model.ts`         | Stream provider response; capture assistant + tool-use blocks (may start streaming tool dispatch) |
| 3   | `postSampleRecovery` | `phases/post-sample-recovery.ts` | Run recovery ladder on stream outcome / withheld errors                                           |
| 4   | `continuationNudge`  | `phases/continuation-nudge.ts`   | Nudge re-entry when the model stopped without required follow-up                                  |
| 5   | `executeTools`       | `phases/execute-tools.ts`        | Drain / finalize tool dispatch → tool results                                                     |
| 6   | `commit`             | `phases/commit.ts`               | Terminal commit for the iteration; may re-enter via stop-hooks                                    |

`phases/stop-hooks.ts` is not a separate numbered stage: stop-hook blocking is
evaluated from `commit` (and can set `transition` so the outer loop re-enters).
`phases/events.ts` is the phase-yielded event envelope for the TUI / clients.

Continue reasons and terminal reasons live on `session/turn-state.ts`
(`ContinueReason`, `TerminalReason`).

## Recovery ladder (`runtime/src/recovery`)

When the last assistant message (or stream error) matches more than one
recovery condition, triggers are evaluated in a **fixed priority order**
(I-10). Source of truth: `recovery/triggers.ts` (`I10_TRIGGER_ORDER` /
`buildDefaultTriggerOrder`). Orchestration + re-entry cap:
`recovery/fallback-ladder.ts` (`RecoveryLadder`, `MAX_RECOVERY_REENTRIES = 5`).

| Order | Trigger name                | Intent                                               |
| ----- | --------------------------- | ---------------------------------------------------- |
| 1     | `isWithheld413`             | Prompt-too-long → collapse / reactive recovery       |
| 2     | `isWithheldMedia`           | Media-too-large → reactive recovery (skips collapse) |
| 3     | `isWithheldMaxOutputTokens` | Max-output-tokens → escalate or continuation         |
| 4     | `stopHookBlocking`          | Stop-hook inject + re-enter                          |
| 5     | `streamingFallbackOccured`  | Streaming fallback tombstone + recreate executor     |
| 6     | `FallbackTriggeredError`    | Model fallback swap                                  |

Related modules: `api-errors.ts` (match predicates), `model-fallback.ts`,
`max-output-tokens.ts`, `reconnection.ts`, `tombstone.ts`,
`withhold-cascading.ts`. Do not reorder the trigger array without updating
the I-10 tests that pin `I10_TRIGGER_ORDER`.

## LLM / providers

Default provider is **`grok`** (xAI). Model defaults are dual-sourced:

| Source                                                          | Grok default        | Evidence                                    |
| --------------------------------------------------------------- | ------------------- | ------------------------------------------- |
| Fresh `defaultConfig().model`                                   | **`grok-4.6`**      | `runtime/src/config/schema.ts`              |
| Provider-map fallback (`BUILT_IN_PROVIDER_DEFAULT_MODELS.grok`) | **`grok-4.6`**      | `runtime/src/llm/registry/provider-info.ts` |
| Managed OpenRouter paid first model                             | **`x-ai/grok-4.5`** | `subscription-managed-models.ts`            |

Bare interactive startup with an empty/fresh config uses the **config** default
(`grok-4.6`). The direct Grok provider map also uses **4.6**; paid managed
OpenRouter intentionally remains on **`x-ai/grok-4.5`**.
API key resolution for grok: `XAI_API_KEY` → `GROK_API_KEY`. The retired
`AGENC_XAI_API_KEY` alias is rejected at ingress.

`grok-4.6` is a full catalog entry (500k context, text/image, tools, structured
output, low/medium/high/xhigh effort with high default); `grok-4.5` remains a
selectable entry. Model metadata
and cost assumptions: [`reference/providers.md`](reference/providers.md).

There are **16 built-in provider slugs**. Full table, env vars, base URLs,
and how local servers publish a context window:
[`reference/providers.md`](reference/providers.md).
`runtime/src/llm/registry/provider-info.ts` contains one authored definition
row per slug. That row owns its display name, default model and base URL,
onboarding classification, and ordered API-key/base-URL environment names;
the exported lookup maps are derived projections rather than parallel tables.

`runtime/src/llm` is provider-neutral; concrete HTTP/SDK shims live under
`llm/providers/` and `services/`.

## Autonomy stack (budget · heartbeat · cron · hooks)

Autonomous surfaces share one design: **fail closed, never silent spend**.

| Surface                       | Module                                  | Daemon execution admission?                                                        |
| ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| Heartbeat ticks               | `heartbeat/` (wired from gateway run)   | **Yes**, inside its daemon-owned background session                                |
| Cron delivery                 | `gateway/cron-delivery.ts`              | **Yes**, inside its daemon-owned background session                                |
| Hooks HTTP                    | `gateway/hooks.ts`                      | **Yes**, inside its daemon-owned background session; denial is HTTP 429            |
| Interactive TUI / print turns | `session/`                              | **Yes** at model/tool boundaries; `[budget]` windows require `enforce_interactive` |
| Background agent runs         | `app-server/background-agent-runner.ts` | **Yes**; unattended admission policy without enabling keepalive ticks              |

Budget caps default **disabled**, but admission and concurrency remain active.
Inspect durable accounting with `agenc run status|replay|evidence`.

Heartbeat: **disabled by default**, interval **1800s**, env
`AGENC_HEARTBEAT*`. Full operator guide: [`reference/autonomy.md`](reference/autonomy.md).

## TUI

The TUI is a **custom `react-reconciler` Ink fork** under
`runtime/src/tui/ink` (own renderer, double-buffered frame diffing, event
dispatch, bidi/ANSI) — not the upstream `ink` package. On top: app shell,
prompt input, transcript, and the **workbench** (project explorer, preview,
and editable `BUFFER`).

BUFFER prefers a supervised `nvim --embed` workspace session. Neovim owns
editing, modes, command-line UI, messages, popups, buffers, and plugins; AgenC
attaches a line-grid UI, renders that native grid into the measured center
pane, routes terminal input, and owns process and file-safety boundaries.
Loaded and hidden Neovim buffers form one safety unit: navigation reuses the
session, dirty state is aggregated across the buffer manifest, and a workbench
transition cannot abandon edits in a non-active buffer. See
[`embedded-neovim-buffer.md`](embedded-neovim-buffer.md).

A throwing frame is contained; the next frame full-repaints rather than
crashing the process.

## Build, test & release

- **Build** — `esbuild` bundles the runtime to `runtime/dist`, `tsc` emits
  declarations, `dist/VERSION` is stamped, package entrypoints verified.
- **Type-check** — `tsc --noEmit`, kept at **0 errors** with **0 `@ts-nocheck`**.
- **Tests** — large vitest suite under `runtime/tests`, isolated Bun suite,
  PTY/e2e scenario gates (`check:tui-e2e`, `check:e2e-all`, …).
- **Reproducible packages** — the committed root lock and exact npm version
  drive `npm ci`; release runtime tarballs normalize ordering, timestamps,
  ownership, and modes. `npm run check:clean-build` compares two isolated
  installs and package builds under different umasks, then uses two additional
  pristine checkouts to prove byte-identical recursive OCI layouts with an
  exact Buildx client and digest-pinned BuildKit daemon.
- **Local required verification** — the complete platform-independent stable
  contract runs locally. GitHub Actions adds `default-suite` (four Ubuntu
  Vitest shards plus runtime typecheck, no Docker hermetic/red-probe path)
  and capability lanes: Linux-kernel sandbox, PowerShell, Neovim (five
  OS/arch; hosted PTY scenarios are Linux/Darwin only), macOS native,
  Windows native. Each PR records the exact locally tested SHA,
  commands, results, and skips before merge; release verification
  repeats the gates at exact current `main` before any release tag exists.
  GitHub remains the branch/PR/merge record. Candidate macOS/Windows
  inventories are in [ci-required-gates.md](ci-required-gates.md), not a
  one-probe summary. Those hosted jobs do not replace the local test plan.
  The repository-scoped App/ruleset
  implementation is retained as
  an inactive optional design, not a current merge requirement. Reproduction
  and trust boundaries are documented in
  [`ci-required-gates.md`](ci-required-gates.md).

Root development loop (from repo root):

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:required-gates
npm run validate:runtime
npm run check:clean-build
```

The clean-build comparison covers the dependency inventory, runtime and SDK
output/declarations, canonical runtime tarball and metadata, all three npm
packages, and repository SPDX SBOM. Byte identity is scoped to the same source
and recorded toolchain; hosted macOS and Windows runner images can evolve
between runs. Docker inputs are digest-, version-, or signed-snapshot-pinned;
the gate exports two no-cache OCI layouts with fixed compatibility,
compression, and timestamp policy, validates the descriptor graph, compares
every compressed blob, then starts the bound image under read-only-root,
capability-free, no-network hardening and verifies native socket credentials.

## Current status (0.17.0)

Daemon-backed process model, multi-provider LLM layer, permissions/sandbox,
gateway multi-channel surface, heartbeat + cron delivery + hooks with
budget gating, and the public launcher/SDK packages are in place. Remaining
pre-GA product backlog is tracked in [`roadmap.md`](roadmap.md); local engineers may keep a gitignored `TODO.md`.
