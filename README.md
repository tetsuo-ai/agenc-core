# AgenC Core

> Daemon-backed coding agent: interactive TUI, headless print mode, background
> agents, multi-channel gateway, budget-bounded autonomy, and a typed embedding SDK.

![status](https://img.shields.io/badge/status-stable-brightgreen)
![version](https://img.shields.io/badge/version-0.17.0-blue)
![node](https://img.shields.io/badge/node-26.x-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%E2%80%A2%200%20%40ts--nocheck-3178C6?logo=typescript&logoColor=white)

**AgenC Core** is the implementation repository for the `agenc` CLI. A local
daemon owns agent/session lifecycle, permissions, provider calls, and command
execution. The interactive TUI, headless `--print` / `--no-tui` CLI, background
agents, channel gateway, and remote phone bridge are all clients of that daemon.

| Package | Path | Role |
| --- | --- | --- |
| `@tetsuo-ai/agenc` `0.17.0` | `packages/agenc/` | Public launcher binary |
| `@tetsuo-ai/runtime` `0.17.0` | `runtime/` | Daemon, TUI, tools, providers, tests |
| `@tetsuo-ai/agenc-sdk` `0.3.0` | `packages/agenc-sdk/` | Typed embedding SDK (daemon protocol) |

Documentation map: [`docs/INDEX.md`](docs/INDEX.md). Architecture:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). CLI reference:
[`docs/reference/cli.md`](docs/reference/cli.md).

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

- **Daemon-backed process model** — launcher → daemon (`app-server`) → TUI /
  print / agents / gateway clients. One control plane per `AGENC_HOME`.
- **Two front-ends** — interactive React TUI and headless one-shot mode
  (`agenc -p|--print`, `agenc --no-tui`).
- **Background agents** — fire-and-forget sessions (`agenc agent start|list|
  attach|stop|logs`), attachable and resumable, independent of the foreground UI.
- **Channel gateway** — Telegram, Discord, Slack, WebChat, and stdio channels;
  pairing, bindings, in-channel approvals. See [`docs/gateway.md`](docs/gateway.md).
- **Budget-bounded execution** — daemon-owned reservations, hierarchical caps,
  concurrency, cancellation, and evidence across interactive/background work,
  including heartbeat / cron / hooks. Design:
  [`docs/design/execution-admission-kernel.md`](docs/design/execution-admission-kernel.md).
- **Guided onboarding** — `agenc onboard` includes AgenC account sign-in,
  X / xAI sign-in for Grok, provider API keys, and local providers without
  requiring slash commands; follow-on acts: `identity`, `channel`, `autonomy`,
  `recap` (personas, channels, budget/heartbeat/webhooks).
- **Remote control** — pair iOS or Android with `agenc remote on|off|status`;
  co-drive chats, receive background completion/attention events, and settle
  permissions from the phone. Android can route an explicit, physically
  approved `@ledger` SOL transfer to a Ledger Flex. See
  [`docs/remote-control.md`](docs/remote-control.md) and the
  [Ledger security contract](docs/security/mobile-ledger-transfer.md).
- **Ledger Wallet CLI** — Ledger hardware-wallet requests route through a
  bundled skill and a read-only CLI status tool. If the official
  `wallet-cli` is missing, AgenC asks before downloading anything; an approved
  `/ledger install` (or agent install action) resolves
  `@ledgerhq/wallet-cli@latest`, verifies the platform package's SHA-512
  integrity, and installs it under `AGENC_HOME`.
- **Built-in tools** — Bash, file read/write/edit, transactional `apply_patch`,
  web fetch/search, LSP, MCP, sub-agents; read-before-write and atomic-patch safety.
- **Browser automation** — the `Browser` tool drives an isolated Chromium over a
  CDP pipe with stable accessibility refs (navigate, snapshot, click, type,
  screenshot, tabs). All egress routes through an SSRF proxy that blocks
  private/loopback/metadata addresses by default; dedicated profile, never your
  real one.
- **MCP** — outbound MCP client and MCP server (`agenc mcp serve|…`), including
  enterprise XAA (SEP-990).
- **Layered safety** — permission modes, opt-in OS sandbox (bubblewrap/Landlock
  on Linux, Seatbelt on macOS), `agenc security audit [--fix]`.
- **In-terminal workbench** — project explorer, code preview, and editable
  `BUFFER` (embedded `nvim --embed` preferred). See
  [`docs/embedded-neovim-buffer.md`](docs/embedded-neovim-buffer.md).
- **16 built-in providers** — default provider **grok**; fresh-config session
  model **grok-4.6** (fresh config and direct-provider map). **Grok 4.6** has a
  500k context window, low/medium/high/xhigh reasoning (catalog
  `defaultReasoningLevel` is high; `defaultConfig().reasoning_effort` is
  **medium** and bootstrap copies that onto the session),
  vision, tools, and structured output; **Grok 4.5** and **Grok 4.3** remain
  selectable in the catalog; also
  openai, anthropic, ollama, lmstudio, openai-compatible, openrouter, groq,
  deepseek, gemini, mistral, nvidia-nim, minimax, github, amazon-bedrock, agenc.
  See [`docs/reference/providers.md`](docs/reference/providers.md).
- **Grok OAuth:** sign in with X during onboarding, via `/grok-login`, or `agenc grok-login` for
  subscription Grok access without an API key
  ([`docs/grok-oauth.md`](docs/grok-oauth.md)).
- **Embedding SDK** — `@tetsuo-ai/agenc-sdk` for socket / subprocess embedding.
  See [`docs/sdk.md`](docs/sdk.md).
- **Durable sessions** — append-only rollout logs + SQLite state; `--continue` /
  `--resume`. Optional local trajectory export for training data
  ([`docs/trajectory-training-data.md`](docs/trajectory-training-data.md)).

## Project status

**Current version in tree: 0.17.0.** Runtime and launcher are versioned
`0.17.0`; the embedding SDK package is `0.3.0`. The public launcher is
[`@tetsuo-ai/agenc`](https://www.npmjs.com/package/@tetsuo-ai/agenc). The root
workspace is non-publishable (`"private": true`); the GitHub source repository
is public so npm can issue verifiable provenance. Type-clean: **0**
`@ts-nocheck`. MIT licensed
([`LICENSE`](LICENSE)).

Shipped in this line: unified Agent/Editor workspace with AI-assisted embedded
Neovim, durable recovery and transactional compaction, scalable workflow and
CSV scheduling, bounded project and memory indexes, provider-aware token
accounting, multi-channel gateway, Browser tool, budget-bounded autonomy,
Ledger verification, and the independently versioned SDK.

## Requirements

- Standalone installations carry a private, verified **Node.js 26.5.0** runtime
  (module ABI 147); no host Node installation is required. Source checkouts,
  the npm launcher, and the SDK require Node.js `>=26.5 <27`; see the
  [supported-host matrix](docs/install.md#supported-hosts).
- **npm `11.17.0`** (exactly pinned by `packageManager` and `devEngines`).
- **ripgrep (`rg`)** on `PATH` for file search (`agenc doctor` reports status).
- Linux source builds require a C11 compiler available as **`cc`** to build
  the bundled process-containment broker. Published standalone/runtime
  artifacts already include that broker.
- **A provider** before real model calls. Default: **xAI** via `XAI_API_KEY`
  (also accepts `GROK_API_KEY`); default model `grok-4.6` (`AGENC_MODEL`
  overrides). Inspect with `agenc providers`, `agenc login`, `agenc config`.

## Quick start

Five-minute path: [`docs/quickstart.md`](docs/quickstart.md). Install details:
[`docs/install.md`](docs/install.md). Migrations:
[OpenClaw](docs/migrate-from-openclaw.md) · [Hermes](docs/migrate-from-hermes.md).

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
```

Or:

```bash
npm install -g @tetsuo-ai/agenc
agenc --help
```

From this checkout:

```bash
npm ci
npm run build
node runtime/bin/agenc --help
npm run start                 # interactive TUI
```

First-run / re-run setup:

```bash
agenc onboard                 # provider, key, theme, first chat
agenc onboard --status        # non-interactive posture for scripts
agenc security audit
agenc doctor
```

Print / one-shot:

```bash
agenc --no-tui "summarize this repository"
agenc --print --output-format stream-json "summarize this repository"
```

## Usage

Full flag and subcommand reference: [`docs/reference/cli.md`](docs/reference/cli.md).
`agenc help` / `agenc help <command>` print live help (top-level `formatCliHelpText`
is not exhaustive; dispatch is).

### Command surface

```text
agenc [options] [PROMPT]
agenc -p|--print [options] [PROMPT]
agenc --no-tui [options] [PROMPT]
agenc help [command]
agenc init [--force]
agenc doctor [--json]
agenc onboard [--status [--json] | --reset]
agenc onboard identity|channel|autonomy|recap
agenc update [--check] [--pin <x.y.z>] [--json]
agenc security audit [--json] [--fix]
agenc gateway run [--stdio] [--webchat] [--heartbeat] [--hooks]
agenc gateway status [--json]
agenc gateway pairing list [--json] | pairing revoke <channel> <peerId>
agenc gateway install-service
agenc budget status [--json]
agenc remote on|off|status
agenc login | logout | whoami
agenc providers [--json] [--no-local-check]
agenc config <show|get|set|unset|validate|edit|path>
agenc plugin|plugins <command>
agenc permissions <list|approve|revoke>
agenc state export <agent-id> | import
agenc trajectories export [--format sft|dpo] [--dir <path>] [--out <file>]
agenc daemon start [--foreground] | stop | status | reload | restart
agenc agent start|list|attach|stop|logs
agenc mcp <serve|add|list|get|remove|…|doctor|xaa>
```

Common session flags:

```text
-p, --print
--output-format <text|json|stream-json>
--input-format <stream-json>
--no-tui
--bare
-c, --continue
-r, --resume <session-id>
--profile <name>
--provider <name>
--model <id|provider:id>
--permission-mode <mode>
--autonomous
--dangerously-bypass-approvals-and-sandbox
--image <file|url|data-url>
```

### Daemon and agents

```bash
agenc daemon status
agenc daemon start [--foreground]
agenc agent start "fix the failing parser test"
agenc agent list
```

Launcher autostarts the daemon unless `AGENC_DAEMON_AUTOSTART=0`.

### Gateway and autonomy

```bash
agenc gateway run --stdio
agenc gateway run --webchat
AGENC_TELEGRAM_BOT_TOKEN=… agenc gateway run
agenc gateway run --heartbeat --hooks
agenc budget status
agenc onboard autonomy
```

### Auth and remote

Remote account login uses `https://id.agenc.ag`:

```bash
AGENC_AUTH_BACKEND=remote agenc login
agenc remote on
```

Managed OpenRouter models: [`docs/managed-openrouter.md`](docs/managed-openrouter.md).
VPS deploy: [`docs/deploy/vps.md`](docs/deploy/vps.md).

## Configuration

Runtime state lives under absolute `AGENC_HOME` (default `~/.agenc`; relative
values are rejected): daemon pid/cookie/
socket, config, sessions, gateway, budget ledger, logs. Keep it on a local,
single-host filesystem with working SQLite file locks and atomic rename;
shared NFS/SMB/multi-host container volumes are rejected for runtime locks.

| Setting | Purpose |
| --- | --- |
| `AGENC_HOME` | Root for on-disk state (default `~/.agenc`) |
| `XAI_API_KEY` / `GROK_API_KEY` | Default provider credentials |
| `AGENC_MODEL` | Override default model (`grok-4.6`) |
| `AGENC_AUTH_BACKEND` | `local` or `remote` |
| `AGENC_DAEMON_AUTOSTART=0` | Disable launcher daemon autostart |
| `AGENC_DAEMON_READY_TIMEOUT_MS` | Launcher daemon-ready timeout |
| `AGENC_TRAJECTORY_EXPORT_DIR` / `_PATH` | Opt-in local trajectory JSONL |
| `AGENC_BROWSER_*` | Browser tool: `_EXECUTABLE`, `_HEADLESS`, `_ALLOW_PRIVATE_NETWORK`, `_PROFILE_DIR`, `_NO_SANDBOX`, `_NAV_TIMEOUT_MS` |
| `config.toml` (`agenc config`) | Providers, MCP, permissions, budget, browser, plugins |

Trajectory export is off by default; when enabled it writes redacted local JSONL
after the primary session log is durable.

## Architecture

| Path | Purpose |
| --- | --- |
| `runtime/` | CLI, daemon, TUI, agents, providers, tools, MCP, permissions, sandbox, tests |
| `packages/agenc/` | Published launcher + runtime tarball tooling |
| `packages/agenc-sdk/` | Typed daemon protocol client |
| `packaging/` | systemd / launchd / Windows service templates, installer site, Docker, Homebrew |

Process model: **launcher** → **daemon** → **clients** (TUI, print, agents,
gateway, remote connector, SDK consumers). Full map:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

From the repo root:

```bash
npm ci
npm run build              # esbuild + declarations → runtime/dist + VERSION
npm run typecheck          # tsc --noEmit (0 errors)
npm run test:fast          # classify the branch; typecheck + affected tests
npm test                   # full hermetic suite for releases and high-risk changes
npm --workspace=@tetsuo-ai/runtime run test:host-functional
                           # fast host-only check; not an egress authority
npm run test:cross-repo    # explicit contracts for separately checked-out repos
npm run test:live          # explicit provider/browser/devnet tests (may incur cost)
npm run test:bun           # isolated Bun suite
npm run validate:runtime   # typecheck + build + PTY startup smoke
npm run check:agent-surface-contract
npm run check:required-gates # release attestation contract; clean Linux checkout
npm run check:clean-build  # two installs + byte-identical OCI builds + hardened smoke
```

`package-lock.json` is the dependency contract. Use `npm ci` for a checkout;
use `npm install` only when intentionally updating that lock. The clean-build
gate requires a clean committed tree, compares two isolated installs and all
release-facing package artifacts byte-for-byte, then uses two additional
pristine trees and a verified, digest-pinned BuildKit toolchain to compare every
OCI blob before smoke-testing the proven image under a hardened daemon profile.

Runtime-scoped gates (`npm --workspace=@tetsuo-ai/runtime run <name>`):

```text
check:tui-runtime-startup   # real PTYs for agenc / agenc --dangerously-bypass-approvals-and-sandbox
check:tui-e2e               # TUI scenarios (-- --filter <name>)
check:daemon-errors
check:llm-pipeline
check:local-vllm
check:e2e-all
check:unused                # knip (informational)
```

The full `npm test` release gate runs on a Linux Docker host in a pinned Node 26.5.0
image with no external network interface (private loopback only), a recursively
read-only checkout, private IPC/tmpfs state, and a seccomp/ptrace process-tree
supervisor. Before repository code executes, both the client and a trusted
preflight container reject socket, FIFO, device, or unknown nodes in every host
bind input. Pathname Unix sockets are limited to canonical, symlink-free paths
under private `/tmp` or `/run`; the sole compatibility alias is the image's
verified `/var/run/nscd/socket` → private `/run` path.

The authoritative boundary requires a local Docker Engine and CLI 25.0 or newer
negotiating Engine API 1.44 or newer, on a Linux 5.12-or-newer x64 or arm64 host
with `CONFIG_SECCOMP` enabled and an OCI runtime that supports recursive
read-only bind mounts. Docker 25.0/API 1.44 introduced the recursive read-only
bind controls used here, and Linux 5.12 is required to enforce them; the
observer also uses `PTRACE_GET_SYSCALL_INFO` (Linux 5.3) and `openat2` (Linux
5.6). Startup aborts before repository code executes if the platform preflight
or native canaries cannot prove these capabilities. See Docker's
[25.0 release notes](https://docs.docker.com/engine/release-notes/25.0/),
[API 1.44 history](https://docs.docker.com/reference/api/engine/version-history/#v144-api-changes),
[recursive bind-mount documentation](https://docs.docker.com/engine/storage/bind-mounts/#recursive-mounts),
[seccomp prerequisites](https://docs.docker.com/engine/security/seccomp/), and
the Linux [`ptrace(2)`](https://man7.org/linux/man-pages/man2/ptrace.2.html) and
[`openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html#HISTORY)
histories. The 25.0 floor is a capability minimum, not a patching recommendation;
operators should use a maintained Docker release.

The Docker seccomp allowlist is content-pinned from Moby's reviewed
[`seccomp/v0.2.3` profile](https://github.com/moby/profiles/blob/seccomp/v0.2.3/seccomp/default.json)
(tag commit `f1a0fd6b5a369fca061b041539129661ed337ef5`) and snapshotted before the
daemon consumes it. Docker's `none` network namespace (loopback only) plus the
constrained mount set is the authoritative public-egress prevention. The
supervisor adds fail-sticky defense in depth: it follows detached descendants,
rejects selected observed network and observer-bypass calls, preserves real
process signal semantics, and verifies blocked and allowed paths with native
canaries before starting TypeScript or Vitest. Its attempt evidence is not an
adversarially complete syscall ledger because pointer/path arguments can race.
The boundary assumes a trusted local Docker daemon and stable host bind inputs
during a run; a hostile host requires immutable snapshots instead of live
binds. The command never pulls the pinned image; provision the exact digest
printed by the fail-closed startup diagnostic outside the test command.

Inside that OS boundary, the suite also strips ambient credentials and live
opt-ins before modules load and uses a JavaScript network tripwire for clearer
call-site evidence. Live tests preserve operator credentials only through the
explicit `npm run test:live` surface. `test:host-functional` retains the fast
host-only defense-in-depth run, but it is not an authoritative release gate.
Contracts that inspect separately checked-out AgenC repositories run only via
`npm run test:cross-repo`; they are not a clean-checkout or release gate.
The optional design-audit browser is likewise an explicit external process:
it receives background-network suppression flags, but only `npm test` provides
the authoritative OS egress boundary.

Ordinary pull requests run one Ubuntu job. It typechecks the
runtime and asks Vitest to run tests related to files changed from `main`.
Launcher, SDK, and gate-policy checks run only when files in those areas change.
Documentation-only PRs do not start a hosted workflow. Run a focused regression test
locally when a change needs coverage that Vitest cannot infer from imports.
Classification, `--base`, fail-closed deletion mapping, and typecheck-only
native / policy-inventory surfaces are in
[`docs/ci-required-gates.md`](docs/ci-required-gates.md#fast-testfast-checks).

The full platform matrix is manual. Run it for release candidates or when a
change depends on Linux kernel sandboxing, PowerShell, Neovim, macOS, or Windows
behavior. Releases still run the full local and hosted verification at exact
current `main`.

Doc index: [`docs/INDEX.md`](docs/INDEX.md). Local contributor notes may live in a gitignored `AGENTS.md`.

## Security

```bash
agenc security audit
agenc security audit --fix
```

Permission modes gate shell and file mutation; OS sandbox is opt-in. Mutating
file tools enforce read-before-write / mtime checks; `apply_patch` is
transactional. Optional SLM transaction guard for Solana-like tool calls:
[`docs/security/slm-transaction-guard.md`](docs/security/slm-transaction-guard.md).

Restricted runtime modes keep broad read access while `workspace_write`
continues to constrain writes to the workspace and approved temporary paths.
Explicit deny-read rules still override that read baseline. Mobile Ledger
requests add a separate current-turn, one-shot route plus physical device
approval; they do not weaken filesystem or generic tool approval rules.

Service templates under `packaging/` run `agenc daemon start --foreground`.
SBOM: `npm run sbom`, `npm run check:sbom`.

## Contributing

1. Branch off `main` (never commit directly).
2. Prefer revert-sensitive regression tests for bug fixes.
3. Run `npm run test:fast` for an ordinary code change, then add the focused
   package or subsystem check that covers the changed behavior. Use `npm test`
   and the platform matrix for releases and broad or platform-specific changes.
4. Conventional commits (`fix(runtime): …`); squash-merge PRs. Do not bypass
   hooks (`--no-verify`).

The pre-commit hook in `.githooks/` checks the staged diff for whitespace errors:

```bash
git config core.hooksPath .githooks
```

## License

MIT. Top-level [`LICENSE`](LICENSE) and runtime / launcher package metadata.
The root package remains `"private": true` (implementation workspace, not the
npm publish unit); that setting is unrelated to GitHub repository visibility.
