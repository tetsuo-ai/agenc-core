# AgenC Core

AgenC Core is the implementation repository for the `agenc` coding-agent CLI.
The current runtime is daemon-backed: the public launcher starts or attaches the
local daemon, and the terminal UI, one-shot CLI mode, background agents, MCP
surface, permissions, tools, and provider calls all run through the runtime
workspace.

This repo is no longer the old multi-product scaffold. The live implementation
is concentrated in `runtime/`, with a small public launcher package in
`packages/agenc/` and daemon service templates in `packaging/`.

For how the pieces fit together see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
for the development workflow see [`AGENTS.md`](AGENTS.md).

## Packages

| Path | Package | Purpose |
| --- | --- | --- |
| `packages/agenc/` | `@tetsuo-ai/agenc` | Public CLI launcher. Installs the `agenc` binary, autostarts the daemon when needed, then delegates to the runtime binary. |
| `runtime/` | `@tetsuo-ai/runtime` | The AgenC runtime: CLI, daemon, TUI, agent/session engine, providers, MCP, permissions, sandboxing, tools, and tests. |
| `packaging/` | n/a | Linux systemd, macOS launchd, and Windows service templates for running `agenc daemon start --foreground`. |

## Requirements

- Node.js `>=25.0.0` for runtime development.
- npm `11.x` as declared by `packageManager`.
- A configured provider or auth session before real model calls. The default
  provider is **xAI** (`XAI_API_KEY`, also accepts `GROK_API_KEY`); the default
  model is `grok-4.3` (`AGENC_MODEL` overrides). Use `agenc providers`,
  `agenc login`, and `agenc config` to inspect setup.

Runtime state is stored under `AGENC_HOME` when set, otherwise `~/.agenc`.
The daemon uses the same home for its pid file, cookie, socket, config, project
state, sessions, and logs.

## Quick Start

```bash
npm install
npm run build
node runtime/bin/agenc --help
```

Start the interactive TUI:

```bash
npm run start
```

Run a one-shot prompt without the TUI:

```bash
node runtime/bin/agenc --no-tui "summarize this repository"
```

Initialize local project config:

```bash
node runtime/bin/agenc init
node runtime/bin/agenc config validate
```

## CLI Surface

Top-level runtime commands:

```text
agenc [options] [PROMPT]
agenc -p|--print [options] [PROMPT]
agenc help [command]
agenc init [--force]
agenc <login|logout|whoami>
agenc providers [--json] [--no-local-check]
agenc config <command> [args]
agenc plugin <command> [options]
agenc permissions <command>
agenc state export <agent-id>
agenc state import
agenc daemon start [--foreground]
agenc daemon <stop|status|reload|restart>
agenc agent start <objective>
agenc agent list
agenc agent attach <id>
agenc agent stop <id>
agenc agent logs <id>
agenc mcp <serve|add|list|get|remove|add-json|add-from-agenc-desktop|reset-project-choices|doctor|xaa>
agenc doctor [--json]
```

`agenc doctor` diagnoses the installation and environment (version, install
type, ripgrep status, auto-update permissions, and PATH/glob warnings with
suggested fixes); `--json` emits the raw diagnostic. For MCP-server-specific
checks use `agenc mcp doctor`.

The `agenc mcp` subcommands cover MCP server management plus two auth helpers:
`doctor` (diagnose MCP configuration) and `xaa` (`setup|login|show|clear` for
Cross-App Access / Enterprise Managed Authorization, SEP-990 — the IdP-brokered
auth flow used by enterprise-managed MCP servers).

Common flags:

```text
-p, --print
--no-tui
--continue
--resume <session-id>
--profile <name>
--provider <name>
--model <id|provider:id>
--permission-mode <mode>
--autonomous, --proactive
--dangerously-bypass-approvals-and-sandbox
--yolo
--allow-dangerously-skip-permissions
--image <file|url|data-url>
```

Use `agenc help <command>` for command-specific help.

## Daemon Runtime

The daemon is the local control plane. It owns agent/session lifecycle,
JSON-RPC dispatch, command execution, provider key vending, permission requests,
realtime methods, health checks, and background-agent attachment.

Useful commands:

```bash
node runtime/bin/agenc daemon status
node runtime/bin/agenc daemon start
node runtime/bin/agenc daemon start --foreground
node runtime/bin/agenc daemon reload
node runtime/bin/agenc daemon restart
node runtime/bin/agenc daemon stop
```

The public launcher in `packages/agenc/` autostarts the daemon before invoking
runtime commands unless `AGENC_DAEMON_AUTOSTART=0` is set. The default daemon
ready timeout is controlled by `AGENC_DAEMON_READY_TIMEOUT_MS`.

## Background Agents

Background agents are daemon-managed sessions that can run independently of the
foreground TUI.

```bash
node runtime/bin/agenc agent start "fix the failing parser test"
node runtime/bin/agenc agent start --unattended-allow read,grep "audit imports"
node runtime/bin/agenc agent list
node runtime/bin/agenc agent attach <agent-id>
node runtime/bin/agenc agent logs <agent-id>
node runtime/bin/agenc agent stop <agent-id>
```

## Workbench & Editing

The interactive TUI includes a **workbench** — a project explorer, a read-only
code preview surface, and an editable `BUFFER` surface for editing files without
leaving the terminal. The BUFFER surface supports three editor providers:

- **Embedded Neovim** (preferred): AgenC launches `nvim --embed` and owns its
  process lifecycle, rendering, and file safety, while Neovim owns Vim
  semantics. This is the enterprise-grade editing path.
- **Inline fallback**: a basic built-in editor used only when Neovim is
  unavailable. It is fallback-only and does not claim exact Vim behavior.
- **External editor**: explicit handoff to `$VISUAL`/`$EDITOR` (e.g. `nvim`,
  `vim`, `vi`, `nano`) for users who prefer their own editor.

> Security note: in `auto` mode the embedded-Neovim path loads your full Neovim
> configuration (`init.lua`) and plugins, which execute as your user. See
> [`docs/embedded-neovim-buffer.md`](docs/embedded-neovim-buffer.md) for the
> trust boundary and how to run Neovim isolated under unattended agents.

The embedded-Neovim PTY lifecycle (including the "kill the TUI mid-edit and
leave no orphaned `nvim` child" guarantee) is exercised by the
`check:tui-workbench-buffer-neovim` scenario gate, run in CI.

## Runtime Layout

```text
runtime/
  bin/                executable shims for built runtime entrypoints
  scripts/            build and validation gates
  src/
    agents/           background-agent state, registry, worktree, status
    app-server/       daemon dispatcher, transports, auth, lifecycle, health
    bin/              CLI entrypoint and subcommand adapters
    commands/         slash-command registry and command implementations
    config/           config schema, profiles, store, migrations
    llm/              provider-neutral model/client/request handling
    mcp-client/       MCP client manager, tools, prompts, resources
    mcp-server/       MCP server framework and transports
    permissions/      trust, approval, sandbox, and permission rules
    sandbox/          sandbox policies and launch helpers
    session/          session store, turns, transcript, autonomous mode
    tasks/            local task abstractions used by TUI/runtime flows
    tools/            built-in model tools
    tui/              Ink/React terminal UI
  tests/              runtime-aligned Vitest suites
```

## Development Commands

From the repo root:

```bash
npm run typecheck
npm run build
npm run test
npm run validate:runtime
```

Runtime-specific gates:

```bash
npm --workspace=@tetsuo-ai/runtime run typecheck
npm --workspace=@tetsuo-ai/runtime run build
npm --workspace=@tetsuo-ai/runtime test
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
npm --workspace=@tetsuo-ai/runtime run check:tui-e2e
npm --workspace=@tetsuo-ai/runtime run check:daemon-errors
npm --workspace=@tetsuo-ai/runtime run check:llm-pipeline
npm --workspace=@tetsuo-ai/runtime run check:e2e-all
```

`check:tui-runtime-startup` imports the built TUI bundle and launches `agenc`
and `agenc --yolo` in real pseudo-terminals at multiple viewport sizes. Keep it
in the validation path for changes touching the TUI, daemon startup, package
entrypoints, or built artifacts.

`check:tui-e2e` runs the scenario suite under `runtime/scripts/check-tui-e2e/`.
Use `-- --filter <name>` to run one scenario while debugging.

## Security Guardrails

The runtime includes an opt-in CourtGuard-style SLM transaction guard for
Solana transaction-like tool calls. It runs at the tool-dispatch boundary before
execution, defaults to local Ollama `gemma4:e4b`, and has an explicit DevNet
live validation path. See `docs/security/slm-transaction-guard.md`.

## Build Output

`npm run build` compiles the runtime with `tsup`, writes `runtime/dist/VERSION`,
copies runtime policy assets, and verifies package entrypoints. The generated
`runtime/dist/` tree is build output and is not source.

## Service Templates

Daemon supervisor templates live under `packaging/`:

- `packaging/systemd/agenc-daemon.service`
- `packaging/launchd/dev.agenc.daemon.plist`
- `packaging/windows/agenc-daemon.xml`

Each runs:

```bash
agenc daemon start --foreground
```
