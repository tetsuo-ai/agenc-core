# CLI reference

Live help: `agenc help` and `agenc help <topic>`. Sources:
`runtime/src/bin/*-cli.ts`, `runtime/src/app-server/{daemon,agent}-cli.ts`,
`runtime/src/plugins/cli/pluginCliCommands.ts`,
`runtime/src/permissions/permission-cli.ts`, and top-level
`formatCliHelpText()` in `runtime/src/bin/agenc.ts`.

**Note:** top-level `formatCliHelpText()` is incomplete relative to real
dispatch (for example `doctor`, `remote`, and the full `gateway` surface are
wired and have topic help but may not appear in the top-level usage block).
This page documents the **dispatched** surface.

Version: **0.6.0**. Default session provider **grok**, fresh-config session model
**grok-4.5** (see [providers.md](providers.md)).

---

## Default modes

```text
agenc [options] [PROMPT]
agenc -p|--print [options] [PROMPT]
agenc --no-tui [options] [PROMPT]
```

With no subcommand, AgenC starts the interactive TUI (or continues/resumes a
session when those flags are set). A positional prompt without `--print` /
`--no-tui` still goes through the normal startup path.

### Global / session options

From `formatCliHelpText()`:

| Flag | Meaning |
| --- | --- |
| `-h`, `--help` | Show top-level help |
| `--version` | Print `agenc <version>` |
| `-p`, `--print` | Headless one-shot print mode |
| `--output-format <format>` | Print mode output: `text`, `json`, or `stream-json` |
| `--input-format <format>` | Print mode input: `stream-json` |
| `--no-tui` | Force one-shot CLI mode (no interactive TUI) |
| `-c`, `--continue` | Continue the latest project session |
| `-r`, `--resume <session-id>` | Resume a prior project session in the TUI |
| `--profile <name>` | Named config profile |
| `--provider <name>` | Override provider for this session |
| `--model <id\|provider:id>` | Override model for this session |
| `--permission-mode <mode>` | Override startup permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`, `auto` (internal-only `unattended` / `bubble` are not CLI addressable) |
| `--autonomous`, `--proactive` | Enable autonomous tick mode |
| `--dangerously-bypass-approvals-and-sandbox` | Bypass approvals and sandbox checks |
| `--yolo` | Alias for approval/sandbox bypass |
| `--allow-dangerously-skip-permissions` | Skip approval prompts |
| `--image <file\|url\|data-url>` | Attach a startup image |

### Print-mode notes

- `--print` / `-p` and `--no-tui` select non-interactive runs suitable for
  scripts and CI.
- `--output-format stream-json` with `--input-format stream-json` is the
  protocol used by the SDK subprocess transport
  (`promptViaSubprocess` in `@tetsuo-ai/agenc-sdk`).
- `--output-format json` emits a single structured result; `text` is human
  stdout.

### Examples

```bash
agenc
agenc "summarize this repository"
agenc --no-tui "run the tests and report failures"
agenc --print --output-format stream-json "summarize this repository"
agenc --resume <session-id>
agenc help permissions
```

---

## `help`

```text
agenc help [command]
```

Topics include (among others): `agent`, `init`, `login` / `logout` / `whoami`,
`daemon`, `remote`, `mcp`, `doctor`, `onboard`, `security`, `update`, `gateway`,
`budget`, `permissions`, `plugin` / `plugins`, `providers`, `config`, `state`,
`trajectories`. Unknown topics error with a pointer to `agenc help`.

---

## `init`

```text
agenc init [--force]
```

Creates project-level files in the current directory:

- `.agenc/config.json`
- `AGENC.md`

| Option | Meaning |
| --- | --- |
| `--force` | Overwrite existing AgenC project files |

```bash
agenc init
agenc init --force
```

---

## `doctor`

```text
agenc doctor
agenc doctor --json
```

Diagnoses installation and environment: version, install type, ripgrep, update
permissions, transaction-guard, PATH/glob warnings, with suggested fixes.
`--json` emits the raw diagnostic.

MCP-specific diagnostics: `agenc mcp doctor`.

---

## `onboard`

```text
agenc onboard
agenc onboard identity
agenc onboard channel
agenc onboard autonomy
agenc onboard recap
agenc onboard --status
agenc onboard --status --json
agenc onboard --reset
```

| Form | Meaning |
| --- | --- |
| (no args) | Interactive setup wizard (provider, key, theme, first chat); re-runs even after a completed first run |
| `identity` | Act 2a — name your agent (persona workspace + one-time naming ritual) |
| `channel` | Act 2b — connect Telegram / Discord / Slack / WebChat with live token checks + pairing walkthrough |
| `autonomy` | Act 3 — budget cap, heartbeat, cron, webhooks (guardrails first) |
| `recap` | Posture summary + starter prompts |
| `--status` | Non-interactive wizard completion + daemon status (scripts) |
| `--json` | With `--status`: JSON report |
| `--reset` | Clear wizard completed/seen flags so it shows again on next interactive start |

Act subcommands do not accept extra arguments.

---

## `update`

```text
agenc update
agenc update --check
agenc update --pin <x.y.z>
```

| Option | Meaning |
| --- | --- |
| `--check` | Report whether an update is available; no downloads or writes |
| `--json` | Machine-readable result on stdout |
| `--pin <x.y.z>` | Install a specific release instead of latest |
| `--repo <owner/name>` | Release repository override |
| `--manifest-url <url>` | Manifest override (`file://` allowed for testing) |
| `--wrapper <path>` | Explicit wrapper script to repoint |

Installer-style installs extract the new runtime under
`<AGENC_HOME>/runtime/<version>/` with sha256 verification, then repoint the
`agenc` wrapper. A running daemon keeps the old version until
`agenc daemon restart`.

npm-launcher installs update with:

```bash
npm install -g @tetsuo-ai/agenc@latest
```

---

## `security`

```text
agenc security audit
agenc security audit --fix
agenc security audit --json
```

Checks daemon exposure, AgenC-state file permissions, config integrity, and
permission-mode blast radius. Exit **1** on critical findings.

| Option | Meaning |
| --- | --- |
| `--fix` | Apply safe permission fixes (`chmod` 700/600 on AgenC state only; never edits config or environment) |
| `--json` | Emit report as JSON |

Only subcommand: `audit`.

---

## `gateway`

```text
agenc gateway run [--stdio] [--webchat] [--heartbeat] [--hooks]
agenc gateway install-service
agenc gateway status [--json]
agenc gateway pairing list [--json]
agenc gateway pairing pending [--json]
agenc gateway pairing approve <channel> <peerId>
agenc gateway pairing revoke <channel> <peerId>
```

| Subcommand | Meaning |
| --- | --- |
| `run` | Start the gateway (runs until Ctrl-C). `--stdio` local dev channel; `--webchat` loopback token-gated browser UI; `--heartbeat` proactive budget-bounded ticks (`HEARTBEAT.md`); `--hooks` webhook hooks. Telegram when `AGENC_TELEGRAM_BOT_TOKEN` is set (Discord/Slack via their bot tokens / gateway config). |
| `install-service` | Install + start the always-on gateway user service (systemd or launchd; reads gateway/env) |
| `status` | Channels, DM policies, bindings, paired-sender counts |
| `pairing list` | Paired senders per channel |
| `pairing pending` | Pending pairing requests (codes not yet approved) |
| `pairing approve` | Approve a pending peer (`<channel> <peerId>`) |
| `pairing revoke` | Remove a paired sender |

Config: `<AGENC_HOME>/gateway/config.json` (fail-closed defaults when absent).

Narrative guide: [`../gateway.md`](../gateway.md).

---

## `budget`

```text
agenc budget status [--json]
agenc budget reset <agent>
```

Cost-bounded autonomy. Read-only except `reset`. Enforced daemon-side around
autonomous turns; **disabled by default**.

| Subcommand | Meaning |
| --- | --- |
| `status` | Policy + per-agent spend vs caps |
| `reset <agent>` | Clear an agent's spend and un-pause it |

Configure via `[budget]` in `config.toml` or `AGENC_BUDGET*` env vars.
Ledger: `<AGENC_HOME>/budget/ledger.json`.

Design: [`../design/budget-enforcement.md`](../design/budget-enforcement.md).

---

## `remote`

```text
agenc remote on
agenc remote status
agenc remote off
```

Pair this machine with the AgenC phone app via the signed relay.

| Subcommand | Meaning |
| --- | --- |
| `on` | Pair (first run shows a code) then keep the host reachable |
| `status` | Whether this host is linked to a phone |
| `off` | Forget this host's pairing locally |

| Environment | Default |
| --- | --- |
| `AGENC_BACKEND_URL` | `https://id.agenc.ag` |
| `AGENC_DAEMON_URL` | `ws://127.0.0.1:7766` |

Requires a signed-in remote auth session for pairing. Guide:
[`../remote-control.md`](../remote-control.md).

---

## Auth: `login` | `logout` | `whoami`

```text
agenc login
agenc logout
agenc whoami
```

| Command | Meaning |
| --- | --- |
| `login` | Sign in using the configured AgenC auth backend |
| `logout` | Clear the current AgenC auth session |
| `whoami` | Show the current AgenC auth identity |

```bash
AGENC_AUTH_BACKEND=remote agenc login
```

No extra arguments on these commands.

---

## `providers`

```text
agenc providers [--json] [--no-local-check]
```

Provider readiness: BYOK key status, local server health, AgenC subscription tier.

| Option | Meaning |
| --- | --- |
| `--json` | Machine-readable JSON |
| `--no-local-check` | Skip localhost health probes |

Built-in provider slugs: `grok`, `openai`, `anthropic`, `ollama`, `lmstudio`,
`openai-compatible`, `openrouter`, `groq`, `deepseek`, `gemini`, `mistral`,
`nvidia-nim`, `minimax`, `github`, `amazon-bedrock`, `agenc`.

---

## `config`

```text
agenc config show
agenc config get <dot.path>
agenc config set <dot.path> <value>
agenc config unset <dot.path>
agenc config validate
agenc config edit
agenc config path
```

| Command | Meaning |
| --- | --- |
| `show` | Effective config snapshot |
| `get` | One effective config value |
| `set` | Write one value to `config.toml` |
| `unset` | Remove one value from `config.toml` |
| `validate` | Validate `config.toml` and schema blocks |
| `edit` | Open `config.toml` in the configured editor |
| `path` | Print the `config.toml` path |

Values parse as TOML when possible (`true`, `123`, `["a"]`, `{ enabled = true }`);
unquoted single-line text is stored as a string.

```bash
agenc config set permissions.default_mode never
agenc config set plugins.enabled true
agenc config validate
```

---

## `plugin` / `plugins`

```text
agenc plugin <command> [options]
```

(`plugins` is accepted as a help-topic alias.)

| Command | Meaning |
| --- | --- |
| `list [--json]` | List installed plugins |
| `validate <path> [--marketplace] [--json]` | Validate plugin or marketplace manifest |
| `install <path> [--scope <user\|project\|local>]` | Install a local plugin directory |
| `uninstall <name> [--scope …]` | Remove an installed plugin |
| `update <name> [--source <path>]` | Refresh an installed plugin from its source |
| `enable <name> [--path <path>]` | Enable a plugin in user config |
| `disable <name>` | Disable a plugin in user config |
| `disable-all` | Disable every currently enabled plugin |
| `marketplace list [--json]` | List configured marketplaces |
| `marketplace add <path\|git\|url\|github> [--name <name>]` | Add marketplace |
| `marketplace remove <name>` | Remove a marketplace |
| `marketplace upgrade [name]` | Refresh git or local marketplaces |

Install options: `--name`, `--force`, `--keep-data`. Marketplace options:
`--ref`, `--sparse`.

---

## `permissions`

```text
agenc permissions list [--json] [--agent <id>|--session <id>]
agenc permissions approve [--persist <user|project|local>] <rule>
agenc permissions revoke [--persist <user|project|local>] <rule>
agenc permissions approve --session <id> [--scope <once|session|agent>] <request-id>
agenc permissions revoke --session <id> [--reason <text>] <request-id>
```

List, update permission rules, or resolve live permission requests.

```bash
agenc permissions list
agenc permissions approve --persist project 'Read(./src/**)'
agenc permissions approve --session session_123 call_456
```

---

## `state`

```text
agenc state export <agent-id>
agenc state import
```

| Command | Meaning |
| --- | --- |
| `export <agent-id>` | Print a JSON state export for one agent |
| `import` | Read a JSON state export from stdin and import it |

```bash
agenc state export agent_123 > state.json
agenc state import < state.json
```

---

## `trajectories`

```text
agenc trajectories export [options]
```

Curates redacted trajectory exports written by the session sink (enable with
`AGENC_TRAJECTORY_EXPORT_DIR=<dir>`, then run sessions) into training-data JSONL.
If the dir env is unset, `--dir` can also fall back to the parent of
`AGENC_TRAJECTORY_EXPORT_PATH`. Local file processing only — no network.

Only trajectories that completed at least one turn with no error event, no
abort/interrupt, and no user tool-use rejection are kept.

| Option | Meaning |
| --- | --- |
| `--format <sft\|dpo>` | Output format (default `sft`). `sft`: chat-schema conversations; `dpo`: prompt/chosen/rejected pairs from thread-rollback regenerations |
| `--dir <path>` | Export dir or single `.jsonl` to read (defaults from env) |
| `--out <file>` | Write JSONL here instead of stdout |

`--require-eval-passed` is **not** available (exported records carry no
evaluation outcome field).

Guide: [`../trajectory-training-data.md`](../trajectory-training-data.md).

---

## `daemon`

```text
agenc daemon start
agenc daemon start --foreground
agenc daemon stop
agenc daemon status
agenc daemon reload
agenc daemon restart
```

| Command | Meaning |
| --- | --- |
| `start` | Start the local AgenC daemon |
| `start --foreground` | Run the daemon in the current process |
| `stop` | Stop the local AgenC daemon |
| `status` | Show local daemon status |
| `reload` | Reload daemon configuration in place |
| `restart` | Stop and start the local AgenC daemon |

Service templates under `packaging/` invoke `agenc daemon start --foreground`.
Launcher autostart: `AGENC_DAEMON_AUTOSTART=0` disables; ready timeout
`AGENC_DAEMON_READY_TIMEOUT_MS`.

---

## `agent`

```text
agenc agent start [--unattended-allow <tools>] [--unattended-deny <tools>] <objective>
agenc agent list
agenc agent attach <id>
agenc agent stop <id>
agenc agent logs <id>
```

Background agents managed by the daemon.

| Command | Meaning |
| --- | --- |
| `start` | Start a background agent with an objective string |
| `list` | Show active background agents |
| `attach <id>` | Attach to a running agent |
| `stop <id>` | Stop a running agent |
| `logs <id>` | Print an agent's full local log and transcript |

```bash
agenc agent start "fix the failing parser test"
agenc agent start --unattended-allow read,grep "audit imports"
```

---

## `mcp`

```text
agenc mcp serve [--transport <stdio|sse>]
agenc mcp add …
agenc mcp list
agenc mcp get
agenc mcp remove
agenc mcp add-json
agenc mcp add-from-agenc-desktop
agenc mcp reset-project-choices
agenc mcp doctor
agenc mcp xaa
```

| Command | Meaning |
| --- | --- |
| `serve` | Expose AgenC tools as an MCP server |
| `add` | Add an MCP server |
| `list` | List configured MCP servers |
| `get` | Show one MCP server |
| `remove` | Remove an MCP server |
| `add-json` | Add an MCP server from JSON |
| `add-from-agenc-desktop` | Import servers from AgenC Desktop config |
| `reset-project-choices` | Reset project MCP approval choices |
| `doctor` | Diagnose MCP configuration |
| `xaa` | Manage XAA IdP authentication (SEP-990) |

| Option (selected) | Meaning |
| --- | --- |
| `serve --transport <stdio\|sse>` | Transport for serve |
| `add -t, --transport <stdio\|sse\|http>` | Transport for add |
| `-s, --scope <scope>` | Config scope for add/remove/import (default user for add/add-json) |
| `-e, --env <KEY=value>` | Environment variable for stdio add |
| `-H, --header <K: V>` | Header for HTTP/SSE add |
| `--client-secret` | Prompt for remote MCP OAuth client secret |

```bash
agenc mcp serve --transport stdio
agenc mcp list
```

---

## See also

- Documentation map: [`../INDEX.md`](../INDEX.md)
- Architecture: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Product README: [`../../README.md`](../../README.md)
