# AgenC Architecture

A map of how `agenc` is put together. For the user-facing CLI, quick start, and
development loop see [`../README.md`](../README.md).

## Process model

`agenc` is **daemon-backed**. There are three cooperating pieces:

1. **Launcher** (`packages/agenc`, `@tetsuo-ai/agenc`) — the published binary a
   user installs. It autostarts (or attaches to) the local daemon, then delegates
   to the runtime binary. Autostart can be disabled with `AGENC_DAEMON_AUTOSTART=0`.
2. **Daemon** (`runtime/src/app-server`) — the local control plane. One per
   `AGENC_HOME`. It owns agent/session lifecycle, JSON-RPC dispatch, command
   execution, provider-key vending, permission requests, realtime methods, health
   checks, and background-agent attachment. Clients talk to it over a local
   socket (pid file + cookie auth).
3. **Clients** — the interactive **TUI** (`runtime/src/tui`), the one-shot
   `--no-tui`/`--print` CLI, and background agents. All real work flows through
   the daemon; the TUI is a view onto daemon-owned sessions.

Everything past the launcher lives in the single runtime workspace
(`@tetsuo-ai/runtime`). The launcher is intentionally tiny.

## Runtime subsystems (`runtime/src`)

| Dir | Responsibility |
| --- | --- |
| `bin/` | CLI entrypoint (`agenc.ts`) + subcommand adapters (auth, config, mcp, doctor, init, providers, state, daemon). |
| `app-server/`, `app-server-client/`, `app-server-protocol/` | The daemon: transports, JSON-RPC dispatch, auth, lifecycle, health, and the client side. |
| `session/` | Session engine: turn loop, transcript, the append-only rollout store + `index.json` snapshot, autonomous mode, resume. |
| `agents/` | Background-agent state, registry, worktree isolation, status. |
| `auth/` | Local and remote auth backends, BYOK precedence, provider auth selection. |
| `llm/` | Provider-neutral model/client/request handling, the model-capability catalog, retries, streaming. |
| `services/api/` | Concrete provider wire layer (xAI/Anthropic-SDK/OpenAI-compatible shims), caching, cost. |
| `tools/` | Built-in model tools (Bash, File read/write/edit, `apply_patch`, Web fetch/search, LSP, MCP, Agent/subagent, Task* …). |
| `permissions/` | Trust, approval policy, permission rules, sandbox policy, the `unattended` background-agent policy. Permission types are single-sourced in `types/permissions.ts`. |
| `sandbox/` | OS sandbox launch helpers (wraps `@anthropic-ai/sandbox-runtime`: bubblewrap/Landlock on Linux, Seatbelt on macOS). |
| `mcp-client/` / `mcp-server/` | Outbound MCP client (tool/resource/prompt bridges) and the MCP server framework. |
| `commands/` | Slash-command registry and command implementations for TUI/headless dispatch. |
| `plugins/`, `skills/`, `outputStyles/` | Plugin manifests, marketplace sources, registration for commands/tools/hooks/MCP/LSP/agents/output styles, and skill loading. |
| `hooks/`, `elicitation/` | Configured hook execution and structured user-input request/response plumbing. |
| `memory/`, `memdir/` | Project/session memory extraction, storage, aging, and retrieval. |
| `config/`, `state/`, `secrets/` | Config schema/store/migrations, on-disk SQLite project state, secret handling. |
| `transaction-guard/` | Opt-in local SLM transaction guard for Solana-like mutating tool calls. |
| `unified-exec/`, `pty/` | Process execution, command monitoring, and PTY helpers. |
| `eval/` | Local agent-evaluation report schema and validator. |
| `tui/` | The terminal UI. |
| `utils/` | Shared utilities: messages, bash parsing, model tables, file persistence, plugin helpers, sandbox helpers, and compatibility shims. |

## State on disk (`AGENC_HOME`, default `~/.agenc`)

The daemon and runtime persist everything under one home: the daemon pid file,
auth cookie, and socket; config (`config.toml`) and credentials (`auth.json`,
plus the global `.agenc*.json`); per-project SQLite state; per-session rollout
logs (append-only JSONL + an advisory `index.json` snapshot, written atomically
via tmp+fsync+rename); and logs. `AGENC_HOME=/custom` relocates all of it
consistently.

## TUI

The TUI is built on a **custom `react-reconciler` Ink fork** under
`runtime/src/tui/ink` (its own renderer, double-buffered frame diffing, event
dispatch, bidi/ANSI handling) — not the upstream `ink` package. On top sit the
app shell, the prompt input, the transcript, and the **workbench** (project
explorer, read-only preview, and an editable `BUFFER` surface that prefers an
embedded `nvim --embed`). See [`embedded-neovim-buffer.md`](embedded-neovim-buffer.md).

The render loop is self-healing: a throwing frame is contained and the next
frame full-repaints rather than crashing the process.

## Tools, permissions & sandbox

Model tools live in `runtime/src/tools`. Before a tool runs, the permission
layer (`runtime/src/permissions`) resolves an approval decision from the active
mode (`default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`, `auto`,
`unattended`, `bubble`) and the rule set. When enabled, the OS sandbox confines
shell execution at the kernel level. `--yolo` / bypass mode waives approval
prompts down to a deny floor — there is no kernel confinement unless the sandbox
is explicitly enabled.

Mutating tools are guarded: file edits enforce read-before-write + mtime-drift
checks, and `apply_patch` applies multi-file patches as a transaction
(plan in memory → commit → roll back on any failure) so a partial patch can't
corrupt the tree.

## LLM / providers

The default provider is **xAI** (`XAI_API_KEY`/`GROK_API_KEY`, model
`grok-4.3`). `runtime/src/llm` is provider-neutral; `runtime/src/services/api`
holds the concrete wire shims (xAI, the Anthropic SDK, OpenAI-compatible HTTP
protocol, Ollama for the local SLM guard). The OS-sandbox dependency,
`@anthropic-ai/sandbox-runtime`, is Anthropic's openly-published Apache-2.0
research-preview sandboxing tool (`srt`) — a normal, integrity-pinned registry
dependency, not vendored source.

## Build, test & gates

- **Build** — `esbuild` bundles the runtime to `runtime/dist`, `tsc` emits
  declarations, `dist/VERSION` is stamped, policy assets are copied, and the 4
  package entrypoints are verified.
- **Type-check** — `tsc --noEmit`, kept at **0 errors** with **0 `@ts-nocheck`**.
- **Tests** — ~12,000 vitest tests, plus an isolated Bun suite (one file per
  process) and PTY/e2e scenario gates.
- **Remote CI** — no `.github` workflow is present in this checkout; local gates
  are authoritative.

## Current status

The codebase is type-clean (0 `@ts-nocheck`, `tsc` 0), the full suite is green,
and the daemon/persistence/permission cores are mature (WAL SQLite, atomic
rollout writes, an AST-backed Bash permission layer, transactional file edits).
The public launcher package is published, the repository has a top-level MIT
license, and known pre-GA gaps are tracked separately: cross-platform runtime
artifacts, observability wiring, release hardening, and deciding whether hosted
CI is worth re-enabling.
