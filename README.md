# AgenC Core

> A daemon-backed, terminal-native coding agent — autonomous background agents,
> an in-terminal editor workbench, MCP-native tools, and OS-sandboxed execution.

![status](https://img.shields.io/badge/status-pre--release-orange)
![version](https://img.shields.io/badge/version-0.2.0-blue)
![node](https://img.shields.io/badge/node-%E2%89%A5%2025-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%E2%80%A2%200%20%40ts--nocheck-3178C6?logo=typescript&logoColor=white)
![tests](https://img.shields.io/badge/tests-12k%2B%20vitest-brightgreen)

**AgenC Core** is the implementation repository for the `agenc` CLI — an agent
that reads your code, runs commands, and edits files from the terminal. It is
**daemon-backed**: a local daemon owns agent/session lifecycle, command
execution, permissions, and provider calls, while the interactive TUI, the
one-shot `--print` CLI, and background agents are all clients of it. The live
implementation is concentrated in `runtime/`, with the published launcher
package in `packages/agenc/` and daemon service templates in `packaging/`.

For the subsystem map and how the pieces fit together, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Contents

- [Features](#features)
- [Project status](#project-status)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Two front-ends, one engine** — an interactive custom React **TUI** and a
  headless one-shot mode (`agenc --print "…"`), both driven by the same
  daemon-owned session engine.
- **Background & autonomous agents** — fire-and-forget agents that run
  independently of the foreground UI, each in its own git worktree, attachable
  and resumable.
- **Built-in tools** — Bash, file read/write/edit, transactional `apply_patch`,
  web fetch/search, LSP, MCP, and recursive sub-agents — with read-before-write
  and atomic-patch safety.
- **MCP-native** — an outbound MCP **client** (tool/resource/prompt bridges) and
  an MCP **server** framework, including enterprise XAA (SEP-990) auth.
- **Layered safety** — a mode-based permission system plus an opt-in OS sandbox
  (bubblewrap/Landlock on Linux, Seatbelt on macOS) for shell execution.
- **In-terminal workbench** — project explorer, code preview, and an editable
  `BUFFER` surface that prefers an embedded `nvim --embed`.
- **Provider-neutral** — defaults to xAI (`grok-4.3`); also speaks native
  Gemini, Amazon Bedrock, the Anthropic SDK, OpenAI-compatible HTTP, and local
  Ollama.
- **Durable sessions** — append-only rollout logs + SQLite state written
  atomically, with `--continue` / `--resume`.

## Project status

Pre-release (`0.2.0`). The public launcher package
[`@tetsuo-ai/agenc`](https://www.npmjs.com/package/@tetsuo-ai/agenc) is
published at `0.2.0`; the root repo and runtime workspace remain private
implementation packages. The codebase is **type-clean** (`0` `@ts-nocheck`,
`tsc` at 0 errors) with 12k+ passing tests, and the daemon / persistence /
permission cores are mature (WAL SQLite, atomic rollout writes, an AST-backed
Bash permission layer, transactional file edits). The repository is MIT
licensed; see [`LICENSE`](LICENSE).

## Requirements

- **Node.js `>= 25`** (declared in `runtime/package.json` engines).
- **npm `11.x`** (declared via `packageManager`).
- **ripgrep (`rg`)** on `PATH` for file search. No binary is bundled, so
  install it from your package manager (`brew install ripgrep`,
  `apt install ripgrep`, `winget install BurntSushi.ripgrep.MSVC`) and confirm
  `rg --version`. Without it `Glob` fails and `Grep` drops to a slower
  pure-JS fallback; `agenc doctor` reports the status with a fix hint.
- **A provider** before real model calls. The default is **xAI**
  (`XAI_API_KEY`, also accepts `GROK_API_KEY`); the default model is `grok-4.3`
  (`AGENC_MODEL` overrides). Gemini accepts `GEMINI_API_KEY`,
  `GOOGLE_API_KEY`, `GEMINI_ACCESS_TOKEN`, or Google ADC credentials; Vertex
  Gemini can be selected with project/location settings. Inspect setup with
  `agenc providers`, `agenc login`, and `agenc config`.

## Quick start

Install with the one-line installer (macOS/Linux; verifies the runtime
tarball's sha256 and wires the daemon as a user service — see
[`docs/install.md`](docs/install.md)):

```bash
curl -fsSL <installer-url>/install.sh | sh
```

Or install the published launcher:

```bash
npm install -g @tetsuo-ai/agenc
agenc --help
```

Or build from this source checkout:

```bash
npm install
npm run build
node runtime/bin/agenc --help
```

Start the interactive TUI:

```bash
npm run start
```

### First-run onboarding

On a clean `AGENC_HOME`, the TUI walks new users through:

```text
Preflight -> Theme -> Provider -> API key -> Connection check -> Security -> Terminal setup
```

The API key step verifies and saves a BYOK provider key before the connection
check runs. If the user skips the key, the connection check still runs next and
reports whether the selected provider is ready, local-only, managed by the
AgenC account, or missing credentials.

Run a one-shot prompt without the TUI:

```bash
node runtime/bin/agenc --no-tui "summarize this repository"
```

Emit structured output from print mode for scripts/CI:

```bash
node runtime/bin/agenc --print --output-format stream-json "summarize this repository"
```

Initialize local project config:

```bash
node runtime/bin/agenc init
node runtime/bin/agenc config validate
```

`agenc init` scans the current repository before writing `AGENC.md`, using
README files, manifests, scripts, and top-level structure to seed project
instructions. Use `agenc init --force` to replace an existing file.

## Usage

### Command surface

```text
agenc [options] [PROMPT]
agenc -p|--print [options] [PROMPT]
agenc help [command]
agenc init [--force]
agenc <login|logout|whoami>
agenc providers [--json] [--no-local-check]
agenc config <show|get|set|unset|validate|edit|path>
agenc plugin <command> [options]
agenc permissions <command>
agenc state <export <agent-id>|import>
agenc daemon <start [--foreground]|stop|status|reload|restart>
agenc agent <start <objective>|list|attach <id>|stop <id>|logs <id>>
agenc mcp <serve|add|list|get|remove|add-json|add-from-agenc-desktop|reset-project-choices|doctor|xaa>
agenc doctor [--json]
```

`agenc doctor` diagnoses the installation and environment (version, install
type, ripgrep status, auto-update permissions, PATH/glob warnings + fixes);
`--json` emits the raw diagnostic. `agenc mcp doctor` does the MCP-specific
checks, and `agenc mcp xaa` (`setup|login|show|clear`) drives the Cross-App
Access / Enterprise Managed Authorization flow (SEP-990) for enterprise-managed
MCP servers.

Remote account login uses the hosted AgenC backend at `https://id.agenc.ag`.
Set the backend to `remote` to sign in through the hosted browser flow:

```bash
AGENC_AUTH_BACKEND=remote agenc login
```

If managed model keys are enabled for the account, also enable managed key
vending locally:

```bash
AGENC_AUTH_BACKEND=remote AGENC_AUTH_MANAGED_KEYS_ENABLED=true agenc login
```

Paid hosted model access currently routes through the AgenC OpenRouter gateway.
See [`docs/managed-openrouter.md`](docs/managed-openrouter.md) for the model
surface, output-token caps, and budget-limit behavior.

Common flags:

```text
-p, --print                                   headless one-shot mode
--output-format <text|json|stream-json>       set print-mode output format
--input-format <stream-json>                  read print-mode JSONL input
--no-tui                                       run without the TUI
--continue                                     continue the latest session
--resume <session-id>                          resume a specific session
--profile <name>                               use a named config profile
--provider <name>                              override the provider
--model <id|provider:id>                       override the model
--permission-mode <mode>                       set the approval mode
--autonomous, --proactive                      enable autonomous ticks
--dangerously-bypass-approvals-and-sandbox     bypass approvals + sandbox
--yolo                                          alias for the bypass flag
--allow-dangerously-skip-permissions           skip approval prompts
--image <file|url|data-url>                    attach an image
```

Use `agenc help <command>` for command-specific help.

Slash commands in the TUI include `/init`, which runs the same analyzed project
instruction generator, and `/output-style` / `/style`, which lists or switches
the active output style for the current project. `/output-style:new <name>`
starts an agent-authored style file under `.agenc/output-styles/`.

### Daemon

The daemon is the local control plane — it owns agent/session lifecycle,
JSON-RPC dispatch, command execution, provider-key vending, permission requests,
realtime methods, health checks, and background-agent attachment.

```bash
node runtime/bin/agenc daemon status
node runtime/bin/agenc daemon start [--foreground]
node runtime/bin/agenc daemon reload
node runtime/bin/agenc daemon restart
node runtime/bin/agenc daemon stop
```

The launcher in `packages/agenc/` autostarts the daemon before invoking runtime
commands unless `AGENC_DAEMON_AUTOSTART=0`; the launcher's daemon-ready timeout
is `AGENC_DAEMON_READY_TIMEOUT_MS`.

### Background agents

Daemon-managed sessions that run independently of the foreground TUI:

```bash
node runtime/bin/agenc agent start "fix the failing parser test"
node runtime/bin/agenc agent start --unattended-allow read,grep "audit imports"
node runtime/bin/agenc agent list
node runtime/bin/agenc agent attach <agent-id>
node runtime/bin/agenc agent logs <agent-id>
node runtime/bin/agenc agent stop <agent-id>
```

### Workbench & editing

The TUI includes a **workbench** — a project explorer, a read-only code preview,
and an editable `BUFFER` surface for editing files without leaving the terminal.
`BUFFER` supports three editor providers:

- **Embedded Neovim** (preferred) — AgenC launches `nvim --embed` and owns
  process lifecycle, rendering, and file safety, while Neovim owns Vim semantics.
- **Inline fallback** — a basic built-in editor used only when Neovim is
  unavailable; fallback-only, and it does not claim exact Vim behavior.
- **External editor** — explicit handoff to `$VISUAL`/`$EDITOR` (`nvim`, `vim`,
  `vi`, `nano`, …).

> **Security note:** in `auto` mode the embedded-Neovim path loads your full
> Neovim config (`init.lua`) and plugins, which execute as your user. See
> [`docs/embedded-neovim-buffer.md`](docs/embedded-neovim-buffer.md) for the
> trust boundary and how to run Neovim isolated under unattended agents.

The embedded-Neovim PTY lifecycle (including the "kill the TUI mid-edit and
leave no orphaned `nvim` child" guarantee) is exercised by the
`check:tui-workbench-buffer-neovim` scenario gate.

## Configuration

Runtime state lives under `AGENC_HOME` (default `~/.agenc`) — the daemon's pid
file, cookie, socket, config, per-project state, sessions, and logs all share
that home. Key knobs:

| Setting | What it does |
| --- | --- |
| `AGENC_HOME` | Root for all on-disk state (default `~/.agenc`). |
| `XAI_API_KEY` / `GROK_API_KEY` | xAI credentials (default provider). |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API-key credentials. |
| `GEMINI_ACCESS_TOKEN` | Gemini bearer token credential; Google ADC is also supported. |
| `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` | Optional Vertex Gemini project/location inference. |
| `AGENC_MODEL` | Override the default model (`grok-4.3`). |
| `AGENC_LOCAL_VLLM_BASE_URL` | Local vLLM/OpenAI-compatible smoke endpoint (default `http://127.0.0.1:8000/v1`). |
| `AGENC_LOCAL_VLLM_MODEL` | Optional model override for `npm run check:local-vllm`. |
| `AGENC_DAEMON_AUTOSTART=0` | Disable launcher daemon autostart. |
| `AGENC_DAEMON_READY_TIMEOUT_MS` | Launcher daemon-ready timeout. |
| `AGENC_TRAJECTORY_EXPORT_PATH` | Opt-in local JSONL trajectory export file, or a directory for per-session files. |
| `AGENC_TRAJECTORY_EXPORT_DIR` | Opt-in local JSONL trajectory export directory. |
| `config.toml` (via `agenc config`) | Persisted config: providers, MCP servers, permissions, profiles. |

AgenC does not emit product event streams or hosted trace exports. Diagnostics
are local, and trajectory export is off by default; when enabled with the
environment variables above it writes redacted rollout items to local JSONL
after the primary session log has been durably written.

## Architecture

| Path | Package | Purpose |
| --- | --- | --- |
| `runtime/` | `@tetsuo-ai/runtime` | The runtime: CLI, daemon, TUI, agent/session engine, providers, MCP, permissions, sandbox, tools, tests. |
| `packages/agenc/` | `@tetsuo-ai/agenc` | Public launcher: installs `agenc`, autostarts the daemon, delegates to the runtime. |
| `packaging/` | — | systemd / launchd / Windows service templates for `agenc daemon start --foreground`. |

Principal runtime subsystems (`runtime/src`):

```text
bin/            CLI entrypoint + subcommand adapters
app-server/     the daemon: dispatch, transports, auth, lifecycle, health
session/        session store, turns, transcript, rollout, autonomous mode
agents/         background-agent state, registry, worktree, status
llm/            provider-neutral model/client/request handling
services/       concrete provider wire layer, caching, cost
tools/          built-in model tools
permissions/    trust, approval, permission rules, sandbox policy
sandbox/        OS sandbox launch helpers
mcp-client/     outbound MCP client (tool/resource/prompt bridges)
mcp-server/     MCP server framework + transports
config/ state/  config schema/store/migrations, SQLite project state
auth/           local/remote auth backends and BYOK precedence
commands/       slash-command registry and TUI/headless command handlers
plugins/        plugin manifests, registration, marketplaces, and CLI
hooks/          configured hooks and hook execution engine
elicitation/    structured user-input requests and responses
memory/ memdir/ project/session memory storage and retrieval
transaction-guard/  opt-in SLM tool-call guard (see Security)
unified-exec/ pty/  process execution and PTY helpers
tui/            the custom React terminal UI
```

The full subsystem map (process model, on-disk state, render stack) is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

From the repo root:

```bash
npm run typecheck        # tsc --noEmit (keep at 0 errors)
npm run build            # esbuild bundle + declarations → runtime/dist + VERSION
npm run test             # typecheck + full vitest suite
npm run test:bun         # isolated Bun suite (one file per process)
npm run validate:runtime # typecheck + build + PTY startup smoke
npm run check:local-vllm # local vLLM/OpenAI-compatible /models + chat smoke
```

Runtime-scoped gates (`npm --workspace=@tetsuo-ai/runtime run <name>`):

```bash
check:tui-runtime-startup   # launch agenc / agenc --yolo in real PTYs
check:tui-e2e               # TUI scenario suite (-- --filter <name>)
check:daemon-errors
check:llm-pipeline
check:local-vllm           # local-only OpenAI-compatible endpoint smoke
check:e2e-all               # daemon-errors + llm-pipeline + tui-e2e
check:unused                # knip (unused exports/files/deps)
```

`check:local-vllm` refuses non-loopback endpoints unless `--allow-nonlocal` is
passed explicitly. For Ollama's OpenAI-compatible local endpoint, use
`AGENC_LOCAL_VLLM_BASE_URL=http://127.0.0.1:11434/v1`.

`check:tui-runtime-startup` imports the built TUI bundle and launches `agenc`
and `agenc --yolo` in real pseudo-terminals at several viewport sizes — keep it
in the validation path for anything touching the TUI, daemon startup, package
entrypoints, or built artifacts.

`npm run build` compiles the runtime with `esbuild`, emits declarations with
`tsc`, writes `runtime/dist/VERSION`, copies runtime policy assets, and verifies
the package entrypoints. The generated `runtime/dist/` tree is build output, not
source.

## Security

Run `agenc security audit` (add `--fix` for safe permission fixes) to check
daemon exposure, AgenC-state file permissions, config integrity, and
permission-mode blast radius; it exits non-zero on critical findings and warns
automatically on `agenc daemon start`.

Shell execution and file mutation flow through a mode-based permission layer; an
opt-in OS sandbox confines shell commands at the kernel level (bubblewrap /
Landlock on Linux, Seatbelt on macOS). Mutating tools are guarded — file edits
enforce read-before-write + mtime-drift checks, and `apply_patch` applies
multi-file patches transactionally (plan → commit → roll back on any failure).

The runtime also ships an **opt-in SLM transaction guard** (CourtGuard-style)
for Solana transaction-like tool calls: it runs at the tool-dispatch boundary
before execution, fails closed, defaults to local Ollama (`gemma4:e4b`), and has
an explicit DevNet live-validation path. See
[`docs/security/slm-transaction-guard.md`](docs/security/slm-transaction-guard.md).

> Daemon service supervisor templates live under `packaging/`
> (`systemd/agenc-daemon.service`, `launchd/dev.agenc.daemon.plist`,
> `windows/agenc-daemon.xml`); each runs `agenc daemon start --foreground`.

Release supply-chain artifacts are generated from the committed npm lockfile:
`npm run sbom -- --output dist/agenc-core.spdx.json` writes an SPDX 2.3 SBOM,
and `npm run check:sbom` validates the generated document shape. The launcher
release workflow uploads that SBOM next to the runtime tarballs and publishes
`@tetsuo-ai/agenc` with npm provenance enabled.

## Contributing

1. **Branch off `main`** (never commit directly to it).
2. Make the change with a **revert-sensitive** test where a bug is involved.
3. Verify locally — this checkout has no hosted CI workflow, so local gates are
   authoritative:
   - `npm run typecheck` → **0 errors** (and no new `@ts-nocheck`),
   - `npm run test` → green,
   - `npm run check:tui-runtime-startup --workspace=@tetsuo-ai/runtime` for
     TUI/daemon/entrypoint changes.
4. Use **conventional commits** (`fix(runtime): …`); open a PR and squash-merge.
   Don't bypass git hooks (`--no-verify`).

A pre-commit hook is provided in `.githooks/` (build + PTY startup smoke); enable
it with `git config core.hooksPath .githooks`.

## License

MIT. The top-level license file and the runtime / launcher package metadata all
declare MIT. The root workspace stays `private` because it is an implementation
monorepo, not the package published to npm.
