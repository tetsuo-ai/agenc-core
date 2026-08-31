# Environment variables

This is the authoritative, name-complete catalog of environment variables
read by the AgenC runtime. Configuration values are applied by the canonical
layered repository. Session-sensitive values are captured by the creating
client, sent as a complete snapshot to the daemon, and bound to that session.
An empty client value clears the corresponding daemon-start value. Long-lived
sessions never rediscover provider or model selection from `process.env`.

An explicit startup provider comes from `--provider`, `AGENC_PROVIDER`, or
`model_provider` in `config.toml`. A model-only layer (`--model`, `AGENC_MODEL`,
or `model`) also selects its provider when the model catalog or a
provider-qualified model name identifies one. Credential presence never
selects a provider. `/provider` changes the current session's provider service;
it does not mutate process env or other concurrent sessions.

Boolean-like values that go through `applyEnvOverrides` treat
`1`, `true`, `yes`, `on` as true and `0`, `false`, `no`, `off` as false.

## Home, model, session

| Var | Effect |
| --- | --- |
| `AGENC_HOME` | Config and daemon home. Must be an absolute path; relative input is rejected. Default `$HOME/.agenc` |
| `AGENC_WORKSPACE` | Workspace root override |
| `AGENC_MODEL` | Session model (`grok-4.6` when unset and config is fresh) |
| `AGENC_PROVIDER` | Canonical provider slug. Retired selector spellings are rejected; use `grok` and `openai-compatible` directly |
| `AGENC_EFFORT_LEVEL` | Reasoning effort captured into canonical session config: `low`, `medium`, `high`, `xhigh`, or `none`; other values are rejected |
| `AGENC_PROFILE` | Named config profile (`--profile`) |
| `AGENC_AUTONOMOUS` | Truthy enables autonomous tick mode |
| `AGENC_MAX_OUTPUT_TOKENS` | Positive integer output-token budget |
| `AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS` | Boolean-like; 8k default plus retry mode |
| `AGENC_MAX_BUDGET_USD` | Positive number session cost budget |
| `AGENC_MAX_TURNS` | Positive integer turn-loop cap when `max_turns` is not in TOML |
| `AGENC_AGENT_MAX_DEPTH` | Non-negative subagent nesting cap projected to `agent_max_depth`; `0` disables spawning |
| `AGENC_COORDINATOR_MODE` | Overrides `coordinator_mode` both ways when the `COORDINATOR_MODE` build flag is on (it is on in `runtime/src/build/feature.ts`). `0` / `false` / `off` force off |
| `AGENC_STREAM_IDLE_TIMEOUT_MS` | Stream idle deadline in milliseconds. Unset or `0` means no idle deadline |
| `AGENC_MARKETPLACE_CLI` | Path to marketplace-cli (`[protocol].cli_path`) |

## Provider credentials and endpoints

These values are captured for each daemon client. They are credentials or
settings for an already-selected provider; none of them selects a provider.
Credential values are not written into the canonical config snapshot.

| Provider | Vars |
| --- | --- |
| grok | `XAI_API_KEY`, `GROK_API_KEY` (key order); `XAI_BASE_URL`, `GROK_BASE_URL` (endpoint aliases); `AGENC_XAI_STORE` and the `AGENC_XAI_*` capability switches below; `AGENC_GROK_CLI` and `AGENC_GROK_ACP_PERMISSIONS` for composer sessions |
| OpenAI | `OPENAI_API_KEY`, `PROVIDER_CODE_API_KEY`, `PROVIDER_CODE_ACCOUNT_ID`, `PROVIDER_CODE_OAUTH_CLIENT_ID`, `PROVIDER_CODE_OAUTH_CALLBACK_PORT`, `CHATGPT_ACCOUNT_ID`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, `OPENAI_AUTH_HEADER`, `OPENAI_AUTH_HEADER_VALUE`, `OPENAI_AUTH_SCHEME`, `OPENAI_API_FORMAT` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY`, then `OPENAI_API_KEY`; `OPENAI_COMPATIBLE_BASE_URL`, then `OPENAI_BASE_URL`, then `OPENAI_API_BASE` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` |
| LM Studio | `LMSTUDIO_API_KEY`, `LMSTUDIO_BASE_URL` |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `AGENC_OPENROUTER_HTTP_REFERER`, `AGENC_OPENROUTER_TITLE` |
| Groq | `GROQ_API_KEY`, `GROQ_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` |
| Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_ACCESS_TOKEN`, `GEMINI_AUTH_MODE` (`api-key`, `access-token`, or `adc`), `GEMINI_BASE_URL`, `GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_VERTEX_LOCATION`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_CACHED_CONTENT` |
| Mistral | `MISTRAL_API_KEY`, `MISTRAL_BASE_URL` |
| NVIDIA NIM | `NVIDIA_API_KEY`, `NVIDIA_BASE_URL` |
| MiniMax | `MINIMAX_API_KEY`, `MINIMAX_BASE_URL` |
| GitHub | `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_BASE_URL` |
| Ollama | `OLLAMA_BASE_URL` (session wire and `/api/show` metadata probe) |
| Amazon Bedrock | access (required): `AWS_BEDROCK_ACCESS_KEY_ID`, then `AWS_ACCESS_KEY_ID`; secret (required): `AWS_BEDROCK_SECRET_ACCESS_KEY`, then `AWS_SECRET_ACCESS_KEY`; session token (optional): `AWS_BEDROCK_SESSION_TOKEN`, then `AWS_SESSION_TOKEN`; endpoint: `AWS_BEDROCK_BASE_URL`; region: `AWS_BEDROCK_REGION`, then `AWS_REGION`, then `AWS_DEFAULT_REGION` |
| AgenC managed auth | `AGENC_API_KEY`, `AGENC_ACCOUNT_ID`, `AGENC_BASE_URL`; descriptor variants `AGENC_API_KEY_FILE_DESCRIPTOR`, `AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR`; OAuth/session vars are cataloged below. `AGENC_API_KEY` authenticates managed AgenC APIs and is not a provider BYOK key alias |

Aliases in a row are evaluated from left to right after trimming empty values.
They do not cross provider boundaries unless the row explicitly lists the
shared alias. In particular, LM Studio does not inherit `OPENAI_API_KEY` or
`OPENAI_BASE_URL`. `OPENAI_API_BASE` applies only to `openai` and
`openai-compatible`. The same endpoint aliases feed the context-window
metadata probe; see [providers.md](providers.md#local-context-windows).

Amazon Bedrock uses the required access/secret pair for direct SigV4 signing;
the session token is optional. Only the Bedrock variables in the table are
consumed by this provider.

`PROVIDER_CODE_OAUTH_CLIENT_ID` overrides the OpenAI browser-login client ID.
`PROVIDER_CODE_OAUTH_CALLBACK_PORT` overrides its loopback callback port
(default `1455`; valid range `1` to `65535`). These values are captured at login
ingress and are also used by token refresh; later process-environment changes
cannot redirect an in-flight login. A credential saved by `agenc openai-login`
wins over `OPENAI_API_KEY` only for the selected `openai` provider. Its stored
subscription access token also wins over `PROVIDER_CODE_API_KEY` on ChatGPT
subscription requests; that variable is an explicit fallback, not a second
stored credential path.

Gemini project identity has one ordered surface: `GEMINI_PROJECT_ID` wins over
`GOOGLE_CLOUD_PROJECT`. Other Google project-name aliases are not consumed.
`GEMINI_AUTH_MODE` restricts resolution to exactly the named method and rejects
values other than `api-key`, `access-token`, or `adc`. An explicit Gemini API
key passed by an embedding caller wins over captured API-key inputs only in
automatic or `api-key` mode; it cannot override forced `access-token` or `adc`
mode. With no mode, the credential order is
`GEMINI_API_KEY`, `GOOGLE_API_KEY`, a saved Gemini BYOK key,
`GEMINI_ACCESS_TOKEN`, then file-backed ADC. A saved BYOK key participates only
in automatic or `api-key` mode; forcing `access-token` or `adc` cannot be
overridden by a stale saved key.

Gemini ADC uses one file from immutable/trusted runtime context: a captured
`GOOGLE_APPLICATION_CREDENTIALS` path, or the standard gcloud ADC file for the
platform account when no explicit path was supplied. An explicit path is
authoritative and does not fall through when missing. Only
`authorized_user` and `service_account` credential documents in the public
`googleapis.com` universe are accepted. AgenC does not load external-account,
impersonation, executable, or URL-bearing credential configurations; run
gcloud or a workload-identity helper outside AgenC and provide a captured
`GEMINI_ACCESS_TOKEN` when those flows are required. AgenC also does not run
gcloud or query a metadata server during ADC resolution.

Set `GEMINI_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT` when the credential does not
identify the Vertex resource project. Set `GEMINI_VERTEX_LOCATION` or its
documented fallback `GOOGLE_CLOUD_LOCATION` for the Vertex location.
`GOOGLE_CLOUD_QUOTA_PROJECT` is the separate quota/billing project and never
replaces resource-project selection.

`GEMINI_BASE_URL` is a native Gemini-protocol API root. AgenC does not infer,
append, or strip an OpenAI-compatible `/openai` surface. Developer API roots
must use `/v1beta`; Vertex roots must identify the matching
`projects/{project}/locations/{location}` native publisher resource. A custom
root must directly accept native `models/*:generateContent` requests. Without
an explicit base URL, access-token and ADC modes require both the resource
project and Vertex location so AgenC can derive one unambiguous native root.

Proxy routing uses `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase
forms `http_proxy`, `https_proxy`, `no_proxy`. `PATH` is captured so provider
helpers and local-provider executables resolve against the client's path, not
the daemon's startup path.

TLS trust configuration is captured with the session environment as well:
`SSL_CERT_FILE` selects the CA bundle used by Node/OpenSSL clients, while
`CURL_CA_BUNDLE` and `REQUESTS_CA_BUNDLE` select CA bundles for spawned curl
and Python Requests helpers. These variables change certificate trust only;
they do not select a provider or endpoint.

Auth backend:

| Var | Effect |
| --- | --- |
| `AGENC_AUTH_BACKEND` | `local` or `remote` |
| `AGENC_AUTH_MANAGED_KEYS_ENABLED` | Boolean-like managed-keys switch |
| `AGENC_REMOTE_AUTH_TOKEN` | Explicit process/session remote bearer. Overrides a stored native secure storage bearer and is never persisted to `auth.json` |

Persisted local-login tokens, saved BYOK keys, remote bearers, and remote
subprocess credentials live only in the home-scoped native OS credential
secure storage. Descriptor variables are transient ingress; after a successful read,
child-process continuity uses the native secure storage rather than a token file.

Remote MCP `authorization_env` fields accept only names under the reserved
prefix `AGENC_CREDENTIAL_` (shown as `AGENC_CREDENTIAL_*`). The creating client captures those values into
the immutable session snapshot; a daemon never inherits them from its own
startup environment or accepts arbitrary environment names over the protocol.

Grok OAuth: [grok-oauth.md](../grok-oauth.md). Provider map:
[providers.md](providers.md).

## Daemon

| Var | Effect |
| --- | --- |
| `AGENC_DAEMON_AUTOSTART` | `0` disables autostart |
| `AGENC_DAEMON_READY_TIMEOUT_MS` | Ready-wait. Launcher default 2000 ms; runtime/SDK default 45000 ms |
| `AGENC_DAEMON_REQUEST_TIMEOUT_MS` | Per-request RPC timeout (SDK default 30000 ms) |
| `AGENC_DAEMON_MAX_OLD_SPACE_MB` | Detached daemon V8 heap cap (default 4096) |
| `AGENC_DAEMON_MAX_QUEUED_REQUESTS`, `AGENC_DAEMON_MAX_IN_FLIGHT_REQUESTS` | RPC overload bounds |
| `AGENC_DAEMON_REQUEST_RATE_PER_SECOND`, `AGENC_DAEMON_REQUEST_BURST` | Per-client rate limiter |
| `AGENC_DAEMON_WEBSOCKET_HOST` | Optional WebSocket bind host (default `127.0.0.1`) |
| `AGENC_DAEMON_WEBSOCKET_PORT` | Port (default 7766) |
| `AGENC_DAEMON_WEBSOCKET_PATH` | Path (default `/`) |
| `AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK` | `1` allows a non-loopback bind |
| `AGENC_DAEMON_URL` | Explicit remote daemon endpoint |

Autostart retry cap and TUI fallback: [daemon.md](daemon.md).

## Browser, budget, heartbeat, sandbox, xAI tools

These have their own pages. Short map:

| Family | Vars | Doc |
| --- | --- | --- |
| Browser | `AGENC_BROWSER_EXECUTABLE`, `AGENC_BROWSER_HEADLESS`, `AGENC_BROWSER_ALLOW_PRIVATE_NETWORK`, `AGENC_BROWSER_PROFILE_DIR`, `AGENC_BROWSER_NO_SANDBOX`, `AGENC_BROWSER_NAV_TIMEOUT_MS` | [browser.md](../browser.md) |
| Budget | `AGENC_BUDGET`, `AGENC_BUDGET_DAILY_USD`, `AGENC_BUDGET_MONTHLY_USD`, `AGENC_BUDGET_DAILY_TOKENS`, `AGENC_BUDGET_MONTHLY_TOKENS`, `AGENC_BUDGET_SOFT_THRESHOLD`, `AGENC_BUDGET_ENFORCE_INTERACTIVE` | [autonomy.md](autonomy.md) |
| Admission concurrency | `AGENC_ADMISSION_GLOBAL_CONCURRENCY` (64), `AGENC_ADMISSION_WORKSPACE_CONCURRENCY` (32), `AGENC_ADMISSION_SESSION_CONCURRENCY` (8), `AGENC_ADMISSION_PARENT_CONCURRENCY` (4), `AGENC_ADMISSION_PROVIDER_CONCURRENCY` (16) | [autonomy.md](autonomy.md) |
| Heartbeat | `AGENC_HEARTBEAT`, `AGENC_HEARTBEAT_INTERVAL`, `AGENC_HEARTBEAT_ACTIVE_HOURS`, `AGENC_HEARTBEAT_TARGET`. `skip_when_busy` has no env (TOML only, default true) | [autonomy.md](autonomy.md) |
| Transaction guard | `AGENC_TRANSACTION_GUARD`, `AGENC_TRANSACTION_GUARD_MODEL`, `AGENC_TRANSACTION_GUARD_OLLAMA_URL`, `AGENC_TRANSACTION_GUARD_FAIL_MODE`, `AGENC_TRANSACTION_GUARD_TIMEOUT_MS`, `AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES` | [slm-transaction-guard.md](../security/slm-transaction-guard.md) |
| Web search | `AGENC_WEB_SEARCH_ENDPOINT`, `AGENC_WEB_SEARCH_KIND`, `AGENC_WEB_SEARCH_API_KEY` | [config.md](config.md) |
| Trajectories | `AGENC_TRAJECTORY_EXPORT_DIR`, `AGENC_TRAJECTORY_EXPORT_PATH` | [trajectory-training-data.md](../trajectory-training-data.md) |

## TUI and BUFFER

| Var | Effect |
| --- | --- |
| `AGENC_ONBOARDING` | First-run wizard control captured for the owning TUI session. `force` shows the wizard even after completion; `0`, `false`, or `off` suppress it. Unset follows persisted `onboarding.json` state |
| `AGENC_TUI_WORKBENCH` | `0` uses classic fullscreen instead of workbench |
| `AGENC_NO_FLICKER` | `0` disables fullscreen; `1` forces it on, including under tmux `-CC`. When unset, tmux `-CC` disables fullscreen; otherwise `tui.flickerFreeMode` is authoritative and defaults to on |
| `AGENC_DISABLE_MOUSE` | Disables mouse tracking |
| `AGENC_DISABLE_MOUSE_CLICKS` | Disables click handling |
| `AGENC_DISABLE_TERMINAL_TITLE` | Leaves the terminal title alone |
| `AGENC_SCROLL_SPEED` | Scroll multiplier |
| `AGENC_BUFFER_PROVIDER` | BUFFER provider override |
| `AGENC_BUFFER_NVIM` | nvim executable / enablement (see BUFFER doc) |
| `AGENC_REVIEWER_ID` | Reviewer identity for `agenc state resolve-tool-call` |
| `COLORFGBG` | Seeds the `auto` theme from terminal foreground/background indexes before the OSC 11 background query can respond |

[tui-workbench.md](tui-workbench.md),
[embedded-neovim-buffer.md](../embedded-neovim-buffer.md).

## Gateway and remote

Channel tokens live in env, not in TOML:

| Var | Channel |
| --- | --- |
| `AGENC_TELEGRAM_BOT_TOKEN` | One-shot Telegram credential; onboarding persists it only in the home-bound native secure storage |
| `AGENC_DISCORD_BOT_TOKEN` | One-shot Discord credential; onboarding persists it only in the home-bound native secure storage |
| `AGENC_SLACK_BOT_TOKEN`, `AGENC_SLACK_APP_TOKEN` | One-shot Slack credentials; onboarding persists them only in the home-bound native secure storage |
| `AGENC_WEBCHAT_TOKEN` | One-shot WebChat bearer override; generated persistent tokens live only in the native secure storage |
| `AGENC_HOOKS_TOKEN` | One-shot gateway hooks bearer override. Persistent generated tokens live only in the native secure storage. |

[gateway.md](../gateway.md), [remote-control.md](../remote-control.md).

## Feature switches operators actually set

These are captured once at client/session ingress, usually boolean-like.
Defaults are "feature on unless the disable var is set" unless noted.

| Var | Typical use |
| --- | --- |
| `AGENC_DISABLE_AUTO_COMPACT` | Skip automatic compaction |
| `AGENC_DISABLE_COMPACT` | Skip compaction |
| `AGENC_AUTO_COMPACT_WINDOW` | Positive integer context-window override used by compaction thresholds |
| `AGENC_AUTOCOMPACT_PCT_OVERRIDE` | Percentage `1` to `100`; can only make automatic compaction fire earlier than the safety default |
| `AGENC_DISABLE_LSP` | Do not start LSP |
| `AGENC_DISABLE_CRON` | Skip local cron delivery |
| `AGENC_DISABLE_BACKGROUND_TASKS` | Block background tasks |
| `AGENC_CODE_MODE` | `1`/`true`/`on` plus resolvable `quickjs-emscripten` registers LIVE `exec`/`wait` |
| `AGENC_SHELL` | Absolute executable path whose filename is `bash` or `zsh`; an unsupported or non-executable explicit path fails instead of falling back |
| `AGENC_SHELL_PREFIX` | Wrap bash/hook command argv (POSIX) |
| `AGENC_TMPDIR` | Exact session temp root for sandbox and permission paths. Child processes receive the same root as `TMPDIR`, `TEMP`, and `TMP` |
| `AGENC_PLUGIN_CACHE_DIR` | Explicit sole plugin storage root (the versioned cache remains its `cache/` child). CLI/runtime ingress captures it once; `AgencClient` callers pass `pluginStorageRoot` directly |
| `AGENC_SKIP_OFFICIAL_MARKETPLACE` | `1` stops the first marketplace catalog on a profile with none configured from auto-registering the official `agenc-plugins` marketplace |
| `AGENC_ALLOW_UNTRUSTED_HOOKS` | Permit command hook effects in an untrusted workspace; captured once at runtime ingress; see below |
| `AGENC_ENABLE_TASKS` | TUI task-board pool only. LIVE Task* tools are always registered and deferred |
| `AGENC_USE_NATIVE_FILE_SEARCH` | Native fuzzy file index path |
| `AGENC_DISABLE_LANDLOCK_FALLBACK` | Do not use the Landlock helper when bubblewrap cannot run |
| `AGENC_LINUX_SANDBOX_EXE` | Override the Linux sandbox helper path |
| `AGENC_DISABLE_EXTRACT_MEMORIES` | Skip turn-end memory extraction |
| `AGENC_POLICY_LIMITS_URL` | Override hosted policy-limits URL (default `https://id.agenc.ag/v1/policy-limits`) |

Every CLI runtime ingress captures `AGENC_ALLOW_UNTRUSTED_HOOKS` once as
`runtimeOptions.allowUntrustedHooks`. It is not mutable daemon environment
state. Pane teammates receive the captured boolean through the canonical child
runtime projection. SDK clients send the typed capability explicitly when they
create an agent.

The capability permits command effects only. It never permits HTTP, prompt, or
agent hook effects, and `--bare` still suppresses every session hook extension
point.

Exact enablement still depends on the call site. If a switch does nothing in
your build, `agenc doctor` and the feature flag in
`runtime/src/build/feature.ts` are the next places to look.

## Complete advanced and runtime-managed name index

The sections above explain the common operator controls. The index below makes the reference name-complete for advanced, diagnostic, compatibility, and runtime-managed inputs that production code still reads. These are not additional provider authorities. Names described as runtime-managed are set by AgenC launchers, sandboxes, teammates, or test runners and normally should not be exported by an operator.

### AGENC_A*

`AGENC_ACCESSIBILITY`, `AGENC_ADAPTIVE_DRAIN`, `AGENC_ADDITIONAL_DIRECTORIES_AGENC_MD`, `AGENC_AFTER_LAST_COMPACT`, `AGENC_AGENT`, `AGENC_AGENT_COLOR`, `AGENC_AGENT_LIST_IN_MESSAGES`, `AGENC_AGENT_SDK_CLIENT_APP`, `AGENC_AGENT_SDK_VERSION`, `AGENC_AUTOCOMPACT_PCT_OVERRIDE`, `AGENC_AUTO_BACKGROUND_TASKS`, `AGENC_AUTO_COMPACT_WINDOW`.

### AGENC_B*

`AGENC_BACKEND_URL`, `AGENC_BASE_REF`, `AGENC_BASH_MAINTAIN_PROJECT_WORKING_DIR`, `AGENC_BASH_SANDBOX_SHOW_INDICATOR`, `AGENC_BLOCKING_LIMIT_OVERRIDE`, `AGENC_BRIEF`, `AGENC_BUBBLEWRAP`, `AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS`, `AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS`, `AGENC_BUFFER_NVIM_SESSION`, `AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS`, `AGENC_BUFFER_NVIM_TIMEOUT_MS`, `AGENC_BUFFER_NVIM_USE_INIT`, `AGENC_BUILD_COMMIT`, `AGENC_BUILD_ID`.

### AGENC_C*

`AGENC_CHROME_PERMISSION_MODE`, `AGENC_CLIENT_CERT`, `AGENC_CLIENT_KEY`, `AGENC_CLIENT_KEY_PASSPHRASE`, `AGENC_CLI_ENTRY_DISABLE`, `AGENC_COMMIT_LOG`, `AGENC_COMPACT_BLOCKING_LIMIT_OVERRIDE`, `AGENC_COWORK_MEMORY_EXTRA_GUIDELINES`, `AGENC_COWORK_MEMORY_PATH_OVERRIDE`, `AGENC_CUSTOM_OAUTH_URL`, `AGENC_CWD`.

### AGENC_D*

`AGENC_DAEMON_AUTOSTART_FAILURE`, `AGENC_DAEMON_COOKIE`, `AGENC_DAEMON_RUN`, `AGENC_DAEMON_STARTUP_GUARD_TOKEN`, `AGENC_DEBUG_LOGS_DIR`, `AGENC_DEBUG_LOG_LEVEL`, `AGENC_DEBUG_PROMPT_SUGGESTION`, `AGENC_DEBUG_REPAINTS`, `AGENC_DEBUG_SESSION_MEMORY`, `AGENC_DIAGNOSTICS_FILE`, `AGENC_DISABLE_1M_CONTEXT`, `AGENC_DISABLE_AGENC_MDS`, `AGENC_DISABLE_ATTACHMENTS`, `AGENC_DISABLE_COMMAND_INJECTION_CHECK`, `AGENC_DISABLE_COST_SUMMARY`, `AGENC_DISABLE_FAST_MODE`, `AGENC_DISABLE_NONESSENTIAL_TRAFFIC`, `AGENC_DISABLE_PRECOMPACT_SKIP`, `AGENC_DISABLE_SESSION_MEMORY_COMPACT`, `AGENC_DISABLE_TOOL_REMINDERS`, `AGENC_DISABLE_VIRTUAL_SCROLL`, `AGENC_DISCORD_GROUP_ADDRESSING`, `AGENC_DONT_INHERIT_ENV`, `AGENC_DRAIN_K_SIGMA`, `AGENC_DRAIN_MARGIN_MULT`, `AGENC_DRAIN_MIN_SAMPLES`, `AGENC_DRAIN_PERCENTILE`, `AGENC_DRAIN_RAISE_CAP`, `AGENC_DRAIN_RING_CAP`, `AGENC_DRAIN_SAFE_MIN_MS`, `AGENC_DUMP_AUTO_MODE`.

### AGENC_E*

`AGENC_EMIT_TOOL_USE_SUMMARIES`, `AGENC_ENABLE_EXTENDED_KEYS`, `AGENC_ENABLE_SESSION_MEMORY_COMPACT`, `AGENC_ENABLE_TOKEN_USAGE_ATTACHMENT`, `AGENC_ENABLE_XAA`, `AGENC_ENTRYPOINT`, `AGENC_ENVIRONMENT_KIND`, `AGENC_EXPERIMENTAL_AGENT_TEAMS`.

### AGENC_F*

`AGENC_FILE_READ_MAX_OUTPUT_TOKENS`.

### AGENC_G*

`AGENC_GATEWAY_AGENT_PERMISSION_MODE`, `AGENC_GATEWAY_AGENT_UNATTENDED_ALLOW`, `AGENC_GATEWAY_AGENT_UNATTENDED_DENY`, `AGENC_GATEWAY_HELIUS_API_KEY`, `AGENC_GATEWAY_HELIUS_DAILY_LIMIT`, `AGENC_GATEWAY_HELIUS_ENABLED`, `AGENC_GATEWAY_HELIUS_KEY_FILE`, `AGENC_GATEWAY_HELIUS_MAX_TOKEN_ACCOUNTS`, `AGENC_GATEWAY_HELIUS_PER_PEER_LIMIT`, `AGENC_GATEWAY_HELIUS_REQUESTS_PER_SECOND`, `AGENC_GATEWAY_HELIUS_TOKEN_ALIASES`, `AGENC_GATEWAY_MEME_ENABLED`, `AGENC_GATEWAY_VOICE_ENABLED`, `AGENC_GATEWAY_X_SEARCH_ENABLED`, `AGENC_GLOB_TIMEOUT_SECONDS`, `AGENC_GROK_ACP_PERMISSIONS`.

### AGENC_H*

`AGENC_HOST_PLATFORM`.

### AGENC_I*

`AGENC_IDE_HOST_OVERRIDE`, `AGENC_IDE_SKIP_AUTO_INSTALL`, `AGENC_IDE_SKIP_VALID_CHECK`, `AGENC_INSTALL_MANIFEST_URL`, `AGENC_INSTALL_REPO`, `AGENC_INTERNAL_ARTIFACTORY_BASE_URL`, `AGENC_INTERNAL_ARTIFACTORY_REGISTRY_URL`.

### AGENC_J*

`AGENC_JOB_DIR`, `AGENC_JSONL_TRANSCRIPT`.

### AGENC_L*

`AGENC_LINUX_SANDBOX_ACTIVE`, `AGENC_LOCAL_OAUTH_API_BASE`, `AGENC_LOCAL_OAUTH_APPS_BASE`, `AGENC_LOCAL_OAUTH_CONSOLE_BASE`, `AGENC_LOGIN_NO_TUI`.

### AGENC_M*

`AGENC_MANAGED_HOME`, `AGENC_MANAGED_INSTRUCTIONS`, `AGENC_MAX_CONTEXT_TOKENS`, `AGENC_MAX_SESSION_READ_CONTENT_BYTES`, `AGENC_MAX_TOOL_DRAIN_MS`, `AGENC_MAX_TOOL_RESULT_WINDOW_FRACTION`, `AGENC_MAX_TOOL_USE_CONCURRENCY`, `AGENC_MCP_INSTR_DELTA`, `AGENC_MESSAGING_SOCKET`, `AGENC_MICROCOMPACT_CLEAR_AFTER_MS`, `AGENC_MICROCOMPACT_CLEAR_THINKING`, `AGENC_MICROCOMPACT_CLEAR_TOOL_RESULTS`, `AGENC_MICROCOMPACT_CLEAR_TOOL_USES`.

### AGENC_O*

`AGENC_OAUTH_CLIENT_ID`, `AGENC_OAUTH_TOKEN`, `AGENC_ONBOARDING`, `AGENC_OPENAI_CONTEXT_WINDOWS`, `AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW`, `AGENC_OPENAI_MAX_OUTPUT_TOKENS`, `AGENC_ORGANIZATION_UUID`, `AGENC_OVERRIDE_DATE`.

### AGENC_P*

`AGENC_PERMISSION_TIMEOUT_MS`, `AGENC_PLAN_MODE_INTERVIEW_PHASE`, `AGENC_PLAN_MODE_REQUIRED`, `AGENC_PLAN_V2_AGENT_COUNT`, `AGENC_PLAN_V2_EXPLORE_AGENT_COUNT`, `AGENC_PLUGIN_DATA`, `AGENC_PLUGIN_GIT_TIMEOUT_MS`, `AGENC_PLUGIN_MCP_SERVER`, `AGENC_PLUGIN_NAME`, `AGENC_PLUGIN_ROOT`, `AGENC_PLUGIN_SANDBOX`, `AGENC_POST_FOR_SESSION_INGRESS`, `AGENC_POST_FOR_SESSION_INGRESS_V2`, `AGENC_PROJECT_DIR`, `AGENC_PROVIDER_MANAGED_BY_HOST`, `AGENC_PROXY_READY`, `AGENC_PROXY_RESOLVES_HOSTS`, `AGENC_PWSH_PARSE_TIMEOUT_MS`.

### AGENC_R*

`AGENC_REMOTE`, `AGENC_REMOTE_AUTH_LOGIN_POLL_URL`, `AGENC_REMOTE_AUTH_LOGIN_START_URL`, `AGENC_REMOTE_AUTH_ME_URL`, `AGENC_REMOTE_AUTH_MODEL_URL`, `AGENC_REMOTE_AUTH_TIER_URL`, `AGENC_REMOTE_AUTH_TOKEN`, `AGENC_REMOTE_AUTH_URL`, `AGENC_REMOTE_AUTH_USAGE_URL`, `AGENC_REMOTE_DEBUG`, `AGENC_REMOTE_MEMORY_DIR`, `AGENC_REMOTE_SESSION_ID`, `AGENC_ROLLOUT_TRACE_ROOT`.

### AGENC_S*

`AGENC_SANDBOX_DEVICE_BINDS`, `AGENC_SAVE_HOOK_ADDITIONAL_CONTEXT`, `AGENC_SESSIONEND_HOOKS_TIMEOUT_MS`, `AGENC_SESSION_ACCESS_TOKEN`, `AGENC_SESSION_KIND`, `AGENC_SESSION_LOG`, `AGENC_SESSION_NAME`, `AGENC_SKIP_PROMPT_HISTORY`, `AGENC_SLACK_GROUP_ADDRESSING`, `AGENC_SLOW_OPERATION_THRESHOLD_MS`, `AGENC_SSE_PORT`, `AGENC_STALL_TIMEOUT_MS_FOR_TESTING`, `AGENC_SUBPROCESS_ENV_NO_SCRUB`, `AGENC_SYNTAX_HIGHLIGHT`.

### AGENC_T*

`AGENC_TASK_LIST_ID`, `AGENC_TEAMMATE_COMMAND`, `AGENC_TELEGRAM_ADMIN_PEER_IDS`, `AGENC_TELEGRAM_BOT_USERNAME`, `AGENC_TELEGRAM_DEBUG_UPDATES`, `AGENC_TELEGRAM_GROUP_ADDRESSING`, `AGENC_TELEGRAM_OWNER_CLAIM_CODE`, `AGENC_TELEGRAM_RICH_MESSAGES`, `AGENC_TEST_DURABILITY_FAILPOINT`, `AGENC_TEST_DURABILITY_FAILPOINT_ACTION`, `AGENC_TEST_DURABILITY_FAILPOINT_MARKER`, `AGENC_TEST_DURABILITY_FAILPOINT_TOKEN`, `AGENC_TMUX_TRUECOLOR`, `AGENC_TOKEN_BUDGET_CHECK_INTERVAL`, `AGENC_TOOL_RESULT_BUDGET_CHARS`, `AGENC_TOOL_RESULT_OFFLOAD_BYTES`, `AGENC_TRANSPORT`, `AGENC_TUI_COMPLETION_PIPELINE_LOG`, `AGENC_TUI_GLYPHS`, `AGENC_TWO_STAGE_CLASSIFIER`.

### AGENC_U*

`AGENC_USE_CCR_V2`, `AGENC_USE_DATA_STDIN`.

### AGENC_V*

`AGENC_VERIFY_PLAN`.

### AGENC_W*

`AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR`, `AGENC_WORKER_EPOCH`.

## External, platform, and runtime-managed inputs

The runtime also reads the names below directly. They are not competing
configuration stores and none selects a provider. Provider/library names keep
the spelling required by that external API; OS, terminal, CI, and hosting
names are environment discovery; runtime-managed names are set by an AgenC
launcher, child process, integration, or test runner.

| Family | Direct inputs |
| --- | --- |
| Supervised child-process controls | `AGENC_BOUND_READ_USE_NOFOLLOW`, `AGENC_PROCESS_WATCHDOG_CONFIG` |
| Anthropic-compatible client controls | `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_UNIX_SOCKET`, `API_TIMEOUT_MS`, `AZURE_OPENAI_API_VERSION`, `MAX_THINKING_TOKENS` |
| Search and custom HTTP connectors | `APP_URL`, `BING_API_KEY`, `EMBEDDED_SEARCH_TOOLS`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `JINA_API_KEY`, `LINKUP_API_KEY`, `MOJEEK_API_KEY`, `PROJECT_DOMAIN`, `TAVILY_API_KEY`, `WEB_AUTH_HEADER`, `WEB_AUTH_SCHEME`, `WEB_BODY_TEMPLATE`, `WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS`, `WEB_CUSTOM_ALLOW_HTTP`, `WEB_CUSTOM_ALLOW_PRIVATE`, `WEB_CUSTOM_MAX_BODY_KB`, `WEB_CUSTOM_TIMEOUT_SEC`, `WEB_HEADERS`, `WEB_JSON_PATH`, `WEB_KEY`, `WEB_METHOD`, `WEB_PARAMS`, `WEB_PROVIDER`, `WEB_QUERY_PARAM`, `WEB_SEARCH_API`, `WEB_SEARCH_PROVIDER`, `WEB_URL_TEMPLATE`, `YOU_API_KEY` |
| MCP transport and OAuth tuning | `ENABLE_MCP_LARGE_OUTPUT_FILES`, `MAX_MCP_OUTPUT_TOKENS`, `MCP_CLIENT_SECRET`, `MCP_OAUTH_CLIENT_METADATA_URL`, `MCP_SERVER_CONNECTION_BATCH_SIZE`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `MCP_XAA_IDP_CLIENT_SECRET` |
| Runtime, update, and test controls | `ATOMIC_CHAT_BASE_URL`, `BASH_MAX_OUTPUT_LENGTH`, `DEBUG`, `DEBUG_SDK`, `DISABLE_AUTOUPDATER`, `DISABLE_COST_WARNINGS`, `DISABLE_ERROR_REPORTING`, `DISABLE_EXTRA_USAGE_COMMAND`, `DISABLE_INSTALLATION_CHECKS`, `DISABLE_INTERLEAVED_THINKING`, `ENABLE_LOCKLESS_UPDATES`, `ENABLE_PID_BASED_VERSION_LOCKING`, `ENABLE_SESSION_PERSISTENCE`, `FORCE_AUTOUPDATE_PLUGINS`, `FORCE_CODE_TERMINAL`, `IS_DEMO`, `LOCAL_BRIDGE`, `SESSION_INGRESS_URL`, `SLASH_COMMAND_TOOL_CHAR_BUDGET`, `TASK_MAX_OUTPUT_LENGTH`, `TEST_ENABLE_SESSION_PERSISTENCE`, `USE_BUILTIN_RIPGREP`, `USE_LOCAL_OAUTH`, `USE_STAGING_OAUTH`, `UV_THREADPOOL_SIZE`, `WALLET_PASS` |
| Auth and hosted integration metadata | `CURSOR_TRACE_ID`, `GITHUB_DEVICE_FLOW_CLIENT_ID`, `SESSIONNAME`, `SPACE_CREATOR_USER_ID`, `USER_TYPE` |

`API_TIMEOUT_MS` is captured in the provider binding used by each request.
Timeout messages do not display the daemon process's current value because it
may differ from the session binding.

MCP transport tuning, helper execution, interpolation, and reconnection use
the creating client's immutable session snapshot. The daemon does not re-read
these values from its startup environment after a connection is created.
Standard process and desktop discovery inputs:

| Family | Direct inputs |
| --- | --- |
| Home, user, temp, and application data | `APPDATA`, `FULLNAME`, `HOME`, `LOCALAPPDATA`, `LOGNAME`, `NAME`, `ProgramData`, `REALNAME`, `TEMP`, `TMPDIR`, `USER`, `USERNAME`, `USERPROFILE` |
| Shell, editor, locale, and process execution | `BROWSER`, `ComSpec`, `EDITOR`, `LANG`, `LC_ALL`, `LC_TERMINAL`, `LC_TIME`, `MSYSTEM`, `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, `P4PORT`, `PATH`, `PATHEXT`, `SHELL`, `SystemRoot`, `VISUAL`, `VSCODE_GIT_ASKPASS_MAIN`, `VisualStudioVersion`, `WINDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` |
| Terminal detection and styling | `ALACRITTY_LOG`, `BAT_THEME`, `COLORTERM`, `ConEmuANSI`, `ConEmuPID`, `ConEmuTask`, `GNOME_TERMINAL_SERVICE`, `ITERM_SESSION_ID`, `KITTY_WINDOW_ID`, `KONSOLE_VERSION`, `PTYXIS_VERSION`, `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`, `STY`, `TERMINAL_EMULATOR`, `TERMINATOR_UUID`, `TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TILIX_ID`, `TMUX`, `TMUX_PANE`, `VTE_VERSION`, `WSL_DISTRO_NAME`, `WT_SESSION`, `XTERM_VERSION`, `ZED_TERM`, `__CFBundleIdentifier` |

CI and hosting discovery inputs:

`AWS_EXECUTION_ENV`, `AWS_LAMBDA_FUNCTION_NAME`, `AZURE_FUNCTIONS_ENVIRONMENT`,
`BUILDKITE`, `CF_PAGES`, `CI`, `CIRCLECI`, `CODESPACES`,
`COO_RUNNING_ON_HOMESPACE`, `DENO_DEPLOYMENT_ID`, `DYNO`, `FLY_APP_NAME`,
`FLY_MACHINE_ID`, `GITHUB_ACTIONS`, `GITHUB_ACTOR`, `GITHUB_ACTOR_ID`,
`GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_ID`, `GITHUB_REPOSITORY_OWNER`,
`GITHUB_REPOSITORY_OWNER_ID`, `GITLAB_CI`, `GITPOD_WORKSPACE_ID`,
`KUBERNETES_SERVICE_HOST`, `K_SERVICE`, `NETLIFY`,
`RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_SERVICE_NAME`, `RENDER`, `REPL_ID`,
`REPL_SLUG`, `VERCEL`, `WEBSITE_SITE_NAME`, `WEBSITE_SKU`.

## Removed and rejected names

Here, **removed** or **retired** means there is no ordinary runtime reader,
fallback, alias, or precedence rule. A name can remain only at an explicit
migration or rejection boundary. The runtime rejects removed authority aliases
even when their value is `0` or `false`; it does not silently assign precedence
to them. See [config.md](config.md#migration-and-removed-surfaces) for the
migration contract.

| Removed | Replacement |
| --- | --- |
| `AGENC_CONFIG_DIR` | `AGENC_HOME` (moves config, state, daemon identity, plugin storage defaults, and secure-storage namespace together) |
| `AGENC_REMOTE_TOKEN_DIR`, `AGENC_SESSION_INGRESS_TOKEN_FILE` | No replacement. Persisted remote credentials use the home-scoped native secure storage; descriptors and direct token env vars remain transient inputs |
| `PROVIDER_CODE_AUTH_JSON_PATH`, `PROVIDER_CODE_HOME` | No runtime replacement. ProviderCode credentials come from explicit credential env vars or the home-scoped native secure storage; retired `auth.json` is migration-only input |
| `AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT` | No runtime replacement. The explicit migration check reports this unsupported retired PasswordVault source and requires export through a supported prior version; ordinary runtime never enables it |
| `AGENC_SIMPLE`, `AGENC_BARE` | `--bare` |
| `AGENC_XAI_API_KEY` | `XAI_API_KEY` or the documented `GROK_API_KEY` alias |
| `AGENC_MCP_SERVERS` | `[mcp_servers]` in canonical `config.toml`, managed with `agenc mcp add/remove` |
| `AGENC_ENV_FILE` | No operator replacement. Setup and SessionStart hooks receive a session-owned output path in this variable. |
| `AGENC_SUBPROCESS_ENV_SCRUB` | Remove it. Subprocess secret scrubbing is the default; `AGENC_SUBPROCESS_ENV_NO_SCRUB` is the deliberate trusted opt-out. |
| `OPENAI_MODEL`, `OPENAI_COMPATIBLE_MODEL`, `ANTHROPIC_MODEL`, `OLLAMA_MODEL`, `LMSTUDIO_MODEL`, `OPENROUTER_MODEL`, `GROQ_MODEL`, `DEEPSEEK_MODEL`, `GEMINI_MODEL`, `MISTRAL_MODEL`, `NVIDIA_MODEL`, `MINIMAX_MODEL`, `GITHUB_MODEL`, `AWS_BEDROCK_MODEL` | `AGENC_MODEL`, `--model`, or `model` in `config.toml` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_CUSTOM_MODEL_OPTION` | Use the canonical provider model catalog and session-owned model selection |
| `AGENC_SUBAGENT_MODEL` | Set a model in the agent definition or Agent tool call; otherwise the child inherits its session model |
| `AGENC_AUTO_MODE_MODEL` | No separate classifier model. The permission classifier inherits the canonical session model |
| `DISABLE_AUTO_COMPACT` | `AGENC_DISABLE_AUTO_COMPACT` |
| `DISABLE_COMPACT` | `AGENC_DISABLE_COMPACT` |
| `AGENC_PROVIDER=xai` | `AGENC_PROVIDER=grok` |
| `AGENC_PROVIDER=custom`, `AGENC_PROVIDER=openai_compatible` | `AGENC_PROVIDER=openai-compatible` |
| `AGENC_DISABLE_STREAM_WATCHDOG` | `AGENC_STREAM_IDLE_TIMEOUT_MS=0` |
| `AGENC_ENABLE_STREAM_WATCHDOG` | A positive `AGENC_STREAM_IDLE_TIMEOUT_MS` or `stream_watchdog_timeout_ms` in `config.toml` |
| `AGENC_ALWAYS_ENABLE_EFFORT` | Canonical provider capability configuration plus `AGENC_EFFORT_LEVEL` |
| `AGENC_HEARTBEAT_MODEL`, `AGENC_HEARTBEAT_AGENT` | No replacement. They never affected production heartbeat turns, which use the canonical gateway daemon session |
| `AGENC_GATEWAY_HOOKS_TOKEN` | `AGENC_HOOKS_TOKEN` |
| `AGENC_SPECULATION_ENABLED` | `speculationEnabled` in `config.toml` |
| `AGENC_DISABLE_GIT_INSTRUCTIONS` | `includeGitInstructions` in `config.toml` |
| `AGENC_DISABLE_AUTO_MEMORY` | `autoMemoryEnabled` in `config.toml` |
| `AGENC_DISABLE_FILE_CHECKPOINTING`, `AGENC_ENABLE_SDK_FILE_CHECKPOINTING` | `fileCheckpointingEnabled` in `config.toml` |
| `AGENC_USE_READABLE_STDIN` | `AGENC_USE_DATA_STDIN=1` |
| `AGENC_USE_POWERSHELL_TOOL` | No registration switch. PowerShell availability is detected on Windows; `defaultShell` in `config.toml` selects the interactive default |

`AGENC_CONFIG_DIR` is inspected only to locate or reject an ambiguous explicit
home migration, including the historical native secure storage namespace it selected.
Ordinary runtime identity comes only from `AGENC_HOME`; see the config
migration reference for copy/retain and exact-retirement rules. The removed
watchdog switches, the effort switch, `AGENC_SIMPLE`, and `AGENC_BARE` are
rejection-only diagnostics. None can select runtime behavior. Every removed
name is rejected whenever defined, including `0`, `false`, or an empty string.
Retired `AGENC_PROVIDER` values are also rejected at live startup; they are
translated only while explicitly migrating a v1 config.

## Related

- [config.md](config.md) TOML keys
- [cli.md](cli.md) flags that overlap these vars
- [daemon.md](daemon.md) socket and autostart
