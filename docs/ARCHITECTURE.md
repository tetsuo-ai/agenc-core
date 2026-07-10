# AgenC Architecture

A current map of how `agenc` is put together (runtime **0.3.0**). For the
user-facing CLI, quick start, and install paths see [`../README.md`](../README.md)
and [`quickstart.md`](quickstart.md). Reference docs for operators and embedders:

| Doc | Scope |
| --- | --- |
| [`reference/daemon.md`](reference/daemon.md) | Daemon process, socket, protocol, lifecycle |
| [`reference/providers.md`](reference/providers.md) | Built-in providers, defaults, credentials |
| [`reference/autonomy.md`](reference/autonomy.md) | Budget, heartbeat, cron delivery, hooks HTTP |
| [`design/budget-enforcement.md`](design/budget-enforcement.md) | Budget design + live wire-up |
| [`gateway.md`](gateway.md) | Channel gateway operator guide |
| [`sdk.md`](sdk.md) | `@tetsuo-ai/agenc-sdk` embedding API |

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
   with a cookie on a Unix socket (optional WebSocket transport).
3. **Clients** — interactive **TUI**, one-shot **print / `--no-tui`**,
   **background agents**, the **channel gateway**, **remote control**, and
   the embedding **SDK**. Real work flows through the daemon; the TUI is a
   view onto daemon-owned sessions.

Everything past the launcher lives in the single runtime workspace
(`@tetsuo-ai/runtime`). The launcher is intentionally tiny.

### Packages

| Package | Role |
| --- | --- |
| `packages/agenc` (`@tetsuo-ai/agenc`) | Public launcher + postinstall runtime ensure |
| `packages/agenc-sdk` (`@tetsuo-ai/agenc-sdk`) | Zero-dep embedding/control client for the daemon protocol |
| `runtime` (`@tetsuo-ai/runtime`) | Full runtime: CLI, daemon, TUI, session/agent engine, tools, providers |

## Runtime subsystems (`runtime/src`)

| Dir | Responsibility |
| --- | --- |
| `bin/` | CLI entry (`agenc.ts`) and subcommand adapters: auth, config, mcp, doctor, init, providers, state, budget, gateway, remote, security, onboard, update, trajectories, … |
| `app-server/` | Daemon: transports, JSON-RPC dispatch, agent/session lifecycle, auth, health, background-agent runner, command exec, realtime, overload limits |
| `app-server-client/` | In-process / client helpers for talking to the daemon |
| `app-server-protocol/` | Shared protocol constants (e.g. portal default local endpoint) |
| `session/` | Session engine: turn loop, transcript, append-only rollout store + `index.json`, resume, cost, autonomous mode |
| `agents/` | Background-agent state, registry, roles, mailbox, worktree isolation, workflow runner, delegate/fork |
| `auth/` | Local and remote auth backends, BYOK precedence, provider auth selection, session auth state |
| `llm/` | Provider-neutral client/request shaping, model catalog, retries, streaming, wire adapters, OAuth refresh |
| `tools/` | Built-in model tools (Bash, File read/write/edit, `apply_patch`, Web fetch/search, LSP, MCP, Agent/subagent, Task*, …) |
| `tool-registry.ts` / `tools.ts` | Tool registration and assembly entry points |
| `permissions/` | Trust, approval policy, rules, modes, sandbox policy, unattended policy, guardian/classifier, audit log |
| `sandbox/` | OS sandbox launch helpers (bubblewrap/Landlock on Linux, Seatbelt on macOS via `@anthropic-ai/sandbox-runtime`) |
| `mcp-client/` / `mcp-server/` / `mcp/` | Outbound MCP client, server framework, and serve bootstrap |
| `gateway/` | Channel gateway as a **daemon client**: Telegram, Discord, Slack, WebChat, stdio; pairing, bindings, approvals, session routing, untrusted framing, hooks HTTP, cron delivery, optional media/onchain helpers. See [`gateway.md`](gateway.md). |
| `heartbeat/` | Proactive ticks: policy, `HEARTBEAT.md` reader, runner, scheduler, gateway/budget wire. See [`reference/autonomy.md`](reference/autonomy.md). |
| `budget/` | Cumulative daily/monthly spend ledger + `BudgetEnforcer` admit/reconcile. See [`design/budget-enforcement.md`](design/budget-enforcement.md). |
| `phases/` | Turn phases: stream model, execute tools, commit, stop hooks, post-sample recovery, continuation nudge |
| `hooks/` | Configured lifecycle hooks (PreToolUse / PostToolUse / Stop / …) and hook engine |
| `elicitation/` | Structured user-input / MCP elicitation request-response |
| `memory/` / `memdir/` | Project/session memory extraction, storage, aging, retrieval; team memory paths |
| `config/` | Config schema, loader, migrations, profiles, model/provider resolution |
| `state/` | On-disk SQLite project state, migrations, recovery, pruning, agent-runs, health stats |
| `secrets/` | Secret redaction / sanitizer |
| `transaction-guard/` | Opt-in local SLM guard for Solana-like mutating tool calls |
| `unified-exec/` / `pty/` / `shell-command/` | Process execution, PTY helpers, shell parsing/safety |
| `commands/` | Slash-command registry and TUI/headless command implementations |
| `plugins/` / `skills/` / `outputStyles/` | Plugin manifests/marketplace/registration; skill loading; output styles |
| `prompts/` | System prompt assembly, sections, attachments |
| `cost/` | Session cost tracker + hook |
| `coordinator/` | Coordinator mode (orchestrate via spawned agents) |
| `personality/` | Personality migration / resolution helpers |
| `planning/` | Plan files and exit-plan approval |
| `thread-store/` | Live thread + file thread store for rollouts |
| `tasks/` | Task UI / task store surface for agent work items |
| `file-watcher/` | Workspace file-watch helpers |
| `transport/` | Transport fallback ladder |
| `services/` | Concrete provider/API wire layer, caching, and related services |
| `recovery/` | Crash/recovery helpers for in-flight work |
| `onboarding/` | Guided `agenc onboard` wizard UI |
| `eval/` | Agent-eval report schema (runner lives under `runtime/scripts` + `runtime/eval`) |
| `tui/` | Terminal UI (custom Ink reconciler fork under `tui/ink`) |
| `entrypoints/` | Public/SDK type entry surfaces |
| `protocol/` | Shared protocol helpers |
| `bootstrap/` / `lifecycle/` / `conversation/` | Bootstrap state, shutdown/signals, conversation token-budget and realtime |
| `constants/` / `types/` / `errors/` / `utils/` / `context/` / `schemas/` | Shared constants, pure types, error shaping, utilities |
| `build/` / `version.ts` / `index.ts` | Feature flags, version stamp (`0.3.0`), public barrel |

## State on disk (`AGENC_HOME`, default `~/.agenc`)

The daemon and runtime persist under one home. Relocate with `AGENC_HOME=/path`.

| Path | Purpose |
| --- | --- |
| `daemon.sock` | Unix domain socket (clients + SDK) |
| `daemon.cookie` | Shared secret for local client auth (0600) |
| `daemon.pid` | Detached daemon PID |
| `daemon.log` | Daemon log sink |
| `daemon-snapshot.json` / runtime info files | Restart/recovery metadata |
| `config.toml` | Operator config (`[budget]`, `[heartbeat]`, providers, …) |
| `auth.json` | Stored credentials / auth backend state |
| `budget/ledger.json` | Cumulative spend ledger (0600, atomic writes) |
| `gateway/` | Gateway sessions map, pairing, webchat token, heartbeat session id, control plane |
| `projects/<slug>/` | Per-project SQLite state + `sessions/<id>/` rollouts |
| `sessions/` (project-scoped) | Append-only JSONL rollouts + advisory `index.json` (atomic tmp+fsync+rename) |
| logs / state DBs | SQLite state + logs databases under project/home layout |

Optional trajectory export writes redacted rollout items via
`AGENC_TRAJECTORY_EXPORT_PATH` or `AGENC_TRAJECTORY_EXPORT_DIR`.

## Client surfaces

| Surface | How it attaches | Notes |
| --- | --- | --- |
| Interactive TUI | Runtime CLI → daemon | Default `agenc` |
| Print / headless | `agenc --no-tui` / `-p` | Stream-json capable; auto-denies unhandled permissions |
| Background agents | `agent.*` daemon methods / `agenc agent …` | Per-run `AgentBudgetConfig` caps only (not cumulative budget) |
| Channel gateway | `agenc gateway run` via SDK | Telegram, Discord, Slack, WebChat, stdio |
| Hooks HTTP | Gateway hooks server | `POST /hooks/agent` (loopback, bearer token) |
| Cron delivery | Gateway cron delivery loop | Delivery-tagged tasks from `.agenc/scheduled_tasks.json` |
| Embedding SDK | `@tetsuo-ai/agenc-sdk` `connect()` | Typed JSON-RPC client; also `promptViaSubprocess()` |
| Remote control | `agenc remote` / remote auth backend | See [`remote-control.md`](remote-control.md) |

## Tools, permissions & sandbox

Model tools live in `runtime/src/tools`. Before a tool runs, the permission
layer resolves an approval decision from the active mode and rule set.

**Permission modes** (`runtime/src/types/permissions.ts`,
`runtime/src/permissions/permission-mode.ts`):

| Mode | Role |
| --- | --- |
| `default` | Ask on request for sensitive tools |
| `acceptEdits` | Auto-allow file edits; still ask for riskier actions |
| `plan` | Plan-only posture; mutating work gated until exit-plan approval |
| `bypassPermissions` | YOLO-style: skip prompts down to a deny floor (`--yolo`) |
| `dontAsk` | Deny when would-ask (no interactive prompt) |
| `auto` | Classifier-assisted auto mode (feature-gated) |
| `unattended` | Background-agent policy (allowlist/denylist / pause) |
| `bubble` | Bubble permission decisions to a parent context |

When enabled, the OS sandbox confines shell execution at the kernel level.
`--yolo` / bypass waives approval prompts — it does **not** enable kernel
confinement unless the sandbox is explicitly on.

Mutating tools are guarded: file edits enforce read-before-write + mtime-drift
checks; `apply_patch` applies multi-file patches transactionally.

## LLM / providers

Default provider is **`grok`** (xAI), default model **`grok-4.3`**
(`config` defaults and `BUILT_IN_PROVIDER_DEFAULT_MODELS` in
`runtime/src/llm/registry/provider-info.ts`). API key resolution for grok:
`XAI_API_KEY` → `GROK_API_KEY` → `AGENC_XAI_API_KEY`.

There are **16 built-in provider slugs**. Full table, env vars, and base URLs:
[`reference/providers.md`](reference/providers.md).

`runtime/src/llm` is provider-neutral; concrete HTTP/SDK shims live under
`llm/providers/` and `services/`.

## Autonomy stack (budget · heartbeat · cron · hooks)

Autonomous surfaces share one design: **fail closed, never silent spend**.

| Surface | Module | Cumulative `BudgetEnforcer`? |
| --- | --- | --- |
| Heartbeat ticks | `heartbeat/` (wired from gateway run) | **Yes** (`wire.ts` + `runner.ts`) |
| Cron delivery | `gateway/cron-delivery.ts` | **Yes** (agent id `cron:<taskId>`) |
| Hooks HTTP | `gateway/hooks.ts` | **Yes** (agent id `hook:<name>`; 429 on refuse) |
| Interactive TUI / print turns | `session/` | **No** (unless `enforce_interactive`) |
| Background agent runs | `app-server/background-agent-runner.ts` | **No** — **per-run** `[agent.budget]` only |

Budget primitive: `runtime/src/budget/`. Defaults **disabled**. Ledger:
`$AGENC_HOME/budget/ledger.json`. CLI: `agenc budget status|reset`.

Heartbeat: **disabled by default**, interval **1800s**, env
`AGENC_HEARTBEAT*`. Full operator guide: [`reference/autonomy.md`](reference/autonomy.md).

## TUI

The TUI is a **custom `react-reconciler` Ink fork** under
`runtime/src/tui/ink` (own renderer, double-buffered frame diffing, event
dispatch, bidi/ANSI) — not the upstream `ink` package. On top: app shell,
prompt input, transcript, and the **workbench** (project explorer, preview,
editable `BUFFER` preferring embedded `nvim --embed`). See
[`embedded-neovim-buffer.md`](embedded-neovim-buffer.md).

A throwing frame is contained; the next frame full-repaints rather than
crashing the process.

## Build, test & release

- **Build** — `esbuild` bundles the runtime to `runtime/dist`, `tsc` emits
  declarations, `dist/VERSION` is stamped, package entrypoints verified.
- **Type-check** — `tsc --noEmit`, kept at **0 errors** with **0 `@ts-nocheck`**.
- **Tests** — large vitest suite under `runtime/tests`, isolated Bun suite,
  PTY/e2e scenario gates (`check:tui-e2e`, `check:e2e-all`, …).
- **Local gates are authoritative** for correctness (no hosted test CI in
  this checkout). Release workflow builds per-platform runtime tarballs on
  demand (`workflow_dispatch` / release packaging under `packages/agenc` and
  `.github` workflows); binaries publish to public `tetsuo-ai/agenc-releases`.

Root development loop (from repo root):

```bash
npm install
npm run build
npm run typecheck
npm test
npm run validate:runtime
```

## Current status (0.3.0)

Daemon-backed process model, multi-provider LLM layer, permissions/sandbox,
gateway multi-channel surface, heartbeat + cron delivery + hooks with
budget gating, and the public launcher/SDK packages are in place. Remaining
pre-GA work is tracked in `TODO.md`.
