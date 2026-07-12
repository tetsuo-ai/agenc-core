# Config reference

Operator config for AgenC **0.4.1**. Sources of truth:

| Concern | Path |
| --- | --- |
| Schema + defaults | `runtime/src/config/schema.ts` |
| Env layering | `runtime/src/config/env.ts` |
| Profiles | `runtime/src/config/profiles.ts` |
| TOML load | `runtime/src/config/loader.ts` |
| CLI | `runtime/src/bin/config-cli.ts` → `agenc config` |

On-disk file: **`$AGENC_HOME/config.toml`** (default `~/.agenc/config.toml`).
`AGENC_HOME` env relocates the whole home.

---

## Load order

1. Built-in `defaultConfig()`
2. `config.toml` (right-biased merge)
3. Named profile (`--profile` / `AGENC_PROFILE`) — only overridable keys
4. Env overrides (`applyEnvOverrides`) — env wins over TOML

Unknown top-level TOML keys are preserved on `_unknown` (forward-compat), not
dropped. TOML aliases remapped before normalize:

| TOML alias | Canonical key |
| --- | --- |
| `tools` | `tools_config` |
| `model_reasoning_effort` | `reasoning_effort` |
| `model_reasoning_summary` | `reasoning_summary` |
| `agents.max_threads` | `agent_max_threads` |
| `agents.max_depth` | `agent_max_depth` |

---

## Defaults (`defaultConfig()`)

| Key | Default |
| --- | --- |
| `model` | `grok-4.3` |
| `model_provider` | `grok` |
| `approval_policy` | `on-request` |
| `sandbox_mode` / `sandbox.mode` | `workspace-write` |
| `reasoning_effort` | `medium` |
| `approvals_reviewer` | `user` |
| `agent_max_depth` | `1` |
| `auth.backend` | `remote` |
| `auth.managedKeys.enabled` | `true` |
| `plugins.enabled` | `false` |
| `mcp.server.enabled` | `false` |
| `daemon.transport` | `unix` |
| `daemon.autostart` | `true` |
| `permissions.default_mode` | `on-request` |
| `max_turns` | unset (no cap; optional runaway-loop backstop) |
| `stream_watchdog_timeout_ms` | `30000` |
| `toolBudget` | 32 calls/turn · 256k B/call · 2M B/turn |
| `project_doc_max_bytes` | `32768` |

`[budget]`, `[heartbeat]`, and `[transaction_guard]` are **off** unless set
(see [autonomy.md](autonomy.md), [security/slm-transaction-guard.md](../security/slm-transaction-guard.md)).

---

## Major sections

### Top-level model / runtime

```toml
model = "grok-4.3"
model_provider = "grok"
approval_policy = "on-request"   # untrusted | on-failure | on-request | never
sandbox_mode = "workspace-write" # read-only | workspace-write | danger-full-access
reasoning_effort = "medium"      # minimal | low | medium | high | xhigh
personality = "none"             # none | friendly | pragmatic
max_output_tokens = 8192
max_budget_usd = 5.0
autonomous_mode = false
coordinator_mode = false
```

| Env | Config field |
| --- | --- |
| `AGENC_MODEL` | `model` |
| `AGENC_PROVIDER` | `model_provider` (`xai` → `grok`) |
| `AGENC_HOME` | `agenc_home` |
| `AGENC_WORKSPACE` | `workspace` |
| `AGENC_SIMPLE` | `simpleMode` |
| `AGENC_AUTONOMOUS` | `autonomous_mode` |
| `AGENC_MAX_OUTPUT_TOKENS` | `max_output_tokens` |
| `AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS` | `capped_default_max_output_tokens` |
| `AGENC_MAX_BUDGET_USD` | `max_budget_usd` |

`AGENC_COORDINATOR_MODE` is **not** applied via `applyEnvOverrides`. It is a
runtime feature-gated env read by `coordinator/coordinatorMode.ts` (and the
`/coordinator` slash command); set `coordinator_mode` in TOML for the config
field, or use the env for runtime toggle when the `COORDINATOR_MODE` feature
flag is on.

API keys are **not** written into the config snapshot; resolve via provider envs
(see [providers.md](providers.md)).

### `[auth]`

```toml
[auth]
backend = "remote"   # local | remote

[auth.managedKeys]
enabled = true
```

| Env | Effect |
| --- | --- |
| `AGENC_AUTH_BACKEND` | `local` or `remote` |
| `AGENC_AUTH_MANAGED_KEYS_ENABLED` | boolean-like |

### `[providers.<slug>]`

```toml
[providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "https://api.openai.com/v1"
default_model = "gpt-5"
context_window_tokens = 128000
max_output_tokens = 16384
fallback_models = ["gpt-4.1"]
```

Optional: `capability_overrides`, nested `fallback` (`targets`, `models`,
`max_failures`, `statuses`).

### `[permissions]`

```toml
[permissions]
default_mode = "on-request"   # ApprovalPolicy
# defaultMode = "default"     # PermissionMode (settings-style)
allow = ["Read", "Glob"]
deny = ["Bash(rm *)"]
ask = ["Write"]
additionalDirectories = ["/extra/root"]
```

Rule strings: `Tool` or `Tool(filter)` form (`permissions/rules.ts`). Deep
reference: [tools-permissions-sandbox.md](tools-permissions-sandbox.md).

### Sandbox

```toml
sandbox_mode = "workspace-write"

[sandbox]
mode = "workspace-write"   # off | read-only | workspace-write

[sandbox_policy]
mode = "workspace-write"
network_access = false
writable_roots = ["/tmp/work"]
```

### `[tools]` → `tools_config`

```toml
[tools]
web_search = true
web_search_endpoint = "https://…"
web_search_endpoint_kind = "duckduckgo"  # duckduckgo | searxng | brave | json
view_image = true
enabled_tools = ["Bash", "Read"]
disabled_tools = []
```

Env (search backend): `AGENC_WEB_SEARCH_ENDPOINT`, `AGENC_WEB_SEARCH_KIND`,
`AGENC_WEB_SEARCH_API_KEY` (secrets never in TOML).

### `[mcp]` and `[mcp_servers.<name>]`

```toml
[mcp.server]
enabled = false
transport = "stdio"   # stdio | sse
# port = 0
# host = "127.0.0.1"

[mcp_servers.docs]
transport = "stdio"
command = "npx"
args = ["-y", "some-mcp-server"]
# enabled = true
# required = false
# timeout = 30000
```

Full MCP surface: [mcp.md](mcp.md).

### `[plugins]`

```toml
[plugins]
enabled = false
dirs = ["~/src/my-plugins"]
allowlist = []

[plugins.plugins.example]
enabled = true
path = "./plugins/example"
# source = "…"
# version = "1.0.0"
# required = false
```

Also top-level `enabledPlugins` map (settings-style enable flags). Default:
plugins **disabled**. CLI: `agenc plugin …` · [skills-plugins.md](skills-plugins.md).

### `[budget]`

```toml
[budget]
enabled = true
daily_usd = 5.0
monthly_usd = 50.0
# daily_tokens = 2_000_000
# monthly_tokens = 20_000_000
soft_threshold = 0.8
enforce_interactive = false
```

Env: `AGENC_BUDGET`, `AGENC_BUDGET_DAILY_USD`, `AGENC_BUDGET_MONTHLY_USD`,
`AGENC_BUDGET_DAILY_TOKENS`, `AGENC_BUDGET_MONTHLY_TOKENS`,
`AGENC_BUDGET_SOFT_THRESHOLD`, `AGENC_BUDGET_ENFORCE_INTERACTIVE`.
Details: [autonomy.md](autonomy.md).

### `[heartbeat]`

```toml
[heartbeat]
enabled = true
interval_seconds = 1800
# model = "…"
# active_hours = [8, 22]   # [startHour, endHour) local 24h
skip_when_busy = true
# agent = "default"
# target_channel = "telegram"
# target_conversation = "…"
```

Env: `AGENC_HEARTBEAT`, `AGENC_HEARTBEAT_INTERVAL`, `AGENC_HEARTBEAT_MODEL`,
`AGENC_HEARTBEAT_ACTIVE_HOURS`, `AGENC_HEARTBEAT_TARGET`, `AGENC_HEARTBEAT_AGENT`.

### `[transaction_guard]`

```toml
[transaction_guard]
enabled = false
model = "gemma4:e4b"
endpoint = "http://127.0.0.1:11434"
fail_mode = "closed"   # open | closed
```

Env (env > config > defaults): `AGENC_TRANSACTION_GUARD` (`slm` enables; other
non-empty disables), `AGENC_TRANSACTION_GUARD_MODEL`,
`AGENC_TRANSACTION_GUARD_OLLAMA_URL`, `AGENC_TRANSACTION_GUARD_FAIL_MODE`,
plus timeout/size knobs `AGENC_TRANSACTION_GUARD_TIMEOUT_MS`,
`AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES`.

### `[agent]`

Per-run / retention for background agents (and shared tracker surfaces):

```toml
[agent.budget]
# token_cap = 2_000_000
# dollar_cap = 10.0
# wall_clock_seconds = 3600

[agent.retention]
completed_days = 30
failed_days = 90
snapshot_days = 3
snapshot_max_count = 10000
snapshot_max_bytes = 67108864
# rollout_days = 90   # optional; unset = no rollout pruning
```

Default `agent.budget` is empty (no per-run cap).

### `durableTurns` (typed, not a known TOML key today)

`DurableTurnsConfig` is typed on `AgenCConfig` and used by the turn loop
(`session/run-turn.ts`, `session/durable-turns`), but **`durableTurns` is not
in `KNOWN_CONFIG_KEYS`**. A `[durableTurns]` block in `config.toml` is currently
preserved under `_unknown` rather than applied as typed config.

Operational control is primarily via env:

| Env | Effect |
| --- | --- |
| `AGENC_DURABLE_TURNS` | Enable/disable durable-turn checkpointing |
| `AGENC_DURABLE_TURNS_RESUME` | Resume-on-restart policy control |

Runtime defaults (when enabled programmatically / via env) treat resume-on-restart
as **on** unless disabled. Prefer env + tests over inventing TOML until the key
lands in `KNOWN_CONFIG_KEYS`.

### `[daemon]`

```toml
[daemon]
transport = "unix"   # unix | stdio
autostart = true
```

### `[protocol]`

Marketplace protocol slash surface (`/claim`, …). **Disabled by default.**

```toml
[protocol]
enabled = false
adapter = "marketplace-cli"   # null | marketplace-cli
# cli_path = "/path/to/agenc-marketplace"
```

### `[[` / `[profiles.<name>]`

Named override bundles. Only these keys apply (others silently ignored):

`model`, `model_provider`, `approval_policy`, `sandbox_mode`,
`reasoning_effort`, `approvals_reviewer`, `model_verbosity`, `service_tier`,
`personality`, `web_search`, `tools`.

```toml
[profiles.yolo]
model = "grok-4.3"
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

Select: `agenc --profile yolo` or `AGENC_PROFILE=yolo`.

### `[hooks]`

Session lifecycle command hooks (not gateway HTTP). See [hooks.md](hooks.md).

```toml
[[hooks.PreToolUse]]
matcher = "Bash"
enabled = true
hooks = [
  { type = "command", command = "echo pre-tool", timeout_ms = 5000 },
]
```

### `[browser]`

Operational settings for the LIVE `Browser` tool (isolated Chromium). Enable
the tool via `tools_config`; this block only tunes how it runs. Full guide:
[browser.md](../browser.md). Source: `runtime/src/browser/config.ts`.

```toml
[browser]
# executable_path = "/usr/bin/chromium"
headless = true
allow_private_network = false   # SSRF: private/loopback blocked by default
# profile_dir = "~/.agenc/browser/profile"
no_sandbox = false              # set true in some containers
navigation_timeout_ms = 30000
```

| Env | Effect |
| --- | --- |
| `AGENC_BROWSER_EXECUTABLE` | Chromium binary path |
| `AGENC_BROWSER_HEADLESS` | on/off (default on) |
| `AGENC_BROWSER_ALLOW_PRIVATE_NETWORK` | on/off (default off) |
| `AGENC_BROWSER_PROFILE_DIR` | dedicated profile dir |
| `AGENC_BROWSER_NO_SANDBOX` | Chromium `--no-sandbox` |
| `AGENC_BROWSER_NAV_TIMEOUT_MS` | navigation timeout ms |

### Other known blocks

| Key | Role |
| --- | --- |
| `lsp_servers` | Language server spawn configs |
| `statusLine` / `outputStyle` | TUI status line items / theme |
| `attachments.allowedRoots` | Extra `@file` mention roots |
| `editorMode` | `default` \| `vim` |
| `tui` / `tuiLayout` | TUI vim flag; layout mode / side pane |
| `shell_environment_policy` | Shell env inherit / exclude / set |
| `toolBudget` | Per-turn tool call/byte caps |
| `experiments` | Open map of flags |
| `ideConnector` / `privateStorage` / `managedWorkspaces` | Optional IDE / storage / workspace lists |
| `autoUpdates` | Present on type; auto-updater reads global config, not a hard default here |

Deferred keys (accepted into `_unknown` today; see schema `DEFERRED_*` comments):
e.g. `notify`, `history`, `log_dir`, `file_opener`, `env`, `apiKeyHelper`,
`cleanupPeriodDays`.

---

## CLI: `agenc config`

```text
agenc config show
agenc config get <dot.path>
agenc config set <dot.path> <value>
agenc config unset <dot.path>
agenc config validate
agenc config edit
agenc config path
```

- Values parse as TOML when possible (`true`, `123`, arrays, inline tables).
- Dot paths split on `.` — use `edit` for keys with literal dots.
- Examples:

```bash
agenc config get model
agenc config set permissions.default_mode never
agenc config set plugins.enabled true
agenc config validate
```

TUI: `/config` (alias `/settings`). Full CLI map: [cli.md](cli.md).
