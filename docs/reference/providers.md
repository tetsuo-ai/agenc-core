# Providers reference

Built-in model providers for AgenC **0.17.0**. Source of truth:
`runtime/src/llm/registry/provider-info.ts`
(`BUILT_IN_PROVIDER_DEFINITIONS`). Each row owns the display name, defaults,
ordered credential and endpoint environment ingress names, and first-run
access metadata. Exported default maps are mechanically derived views of
those rows.

CLI: `agenc providers` · `agenc login` · `agenc config` · `/provider` and
`/model` in the TUI.

## Defaults

| Setting | Value |
| --- | --- |
| Default provider | `grok` (xAI) |
| Fresh-config session model | `grok-4.6` (`defaultConfig().model`) |
| Provider-map fallback (`BUILT_IN_PROVIDER_DEFAULT_MODELS.grok`) | `grok-4.6` |
| Managed OpenRouter paid default | `x-ai/grok-4.5` |
| Config keys | `model_provider`, `model` in `config.toml` |
| Env overrides | `AGENC_PROVIDER`, `AGENC_MODEL` |

Bare interactive startup with a fresh install uses the **config** default
(`grok-4.6`). When only the direct `grok` provider slug is resolved without an
explicit model, the registry also uses **`grok-4.6`**. Managed OpenRouter is a
separate provider route and its paid default remains **`x-ai/grok-4.5`**.

## Single provider authority

Startup provider selection is explicit and layered. Before managed policy is
applied, `--provider` wins over `AGENC_PROVIDER`, which wins over
`model_provider` in the selected profile or `config.toml`; the fallback is
`grok`. Administrator-managed configuration is the final layer and may replace
or lock that result. A provider-qualified `--model` selection is resolved as
one provider/model pair. Credentials, OAuth tokens, base URLs, and local
endpoint availability never choose a provider.

The client captures this selection once and binds it to a session-owned
provider service before daemon work begins. `/provider` replaces that binding
for only the current session. It does not stamp `process.env`, change the
daemon default, or affect concurrent sessions. `AGENC_PROVIDER` is the only
provider-selection environment variable.

Live provider selection accepts canonical slugs only. The retired selector
spellings `xai`, `custom`, and `openai_compatible` are rejected at strict-v2
config, environment, CLI, session-switch, and factory boundaries with their
replacement. The explicit v1 migration path translates them to `grok` and
`openai-compatible` and refuses conflicts. Unknown configured provider slugs
are rejected; provider tables use the same canonical built-in registry.

Grok credential resolution:

1. **Stored `/grok-login` OAuth token** (always wins while present — env API
   keys are ignored). See [grok-oauth.md](../grok-oauth.md).
2. Explicit session/API key when no OAuth token
3. `XAI_API_KEY`
4. `GROK_API_KEY`

### Grok defaults and catalog entries

`grok-4.6` is the provider-map default for direct `grok` sessions and a full
catalog entry. Fresh `config.toml` seeds `model = "grok-4.6"`. The runtime
catalog for Grok 4.6 exposes:

| Property | Value |
| --- | --- |
| Context window | 500,000 tokens |
| Input modalities | text and image |
| Runtime features | function tools, parallel tool calls, structured output, search integration |
| Reasoning effort | `low`, `medium`, `high`, `xhigh`; model default `high` |
| Standard token rates below 200k prompt tokens | $2.00 / 1M input, $0.50 / 1M cached input, $6.00 / 1M output |

`grok-4.5` remains a selectable 500k-context catalog entry with the same input
modalities and runtime features. Its short-context cached-input rate is
$0.30 / 1M, versus $0.50 / 1M for Grok 4.6; it supports
`low`/`medium`/`high` reasoning and is still the managed OpenRouter paid
default. The xAI reasoning gate is fail-closed: Grok 4.3, Grok 4.5, Grok 4.6,
and the documented 4.20 multi-agent family may receive the provider parameter;
unknown variants have it stripped instead of inheriting support from a name
prefix. Grok 4.3's catalog default effort is `low`; Grok 4.5 and Grok 4.6
default to `high`.

Sources checked for the Grok 4.5 catalog entry on 2026-07-10:
[xAI Grok 4.5](https://docs.x.ai/developers/grok-4-5),
[models](https://docs.x.ai/developers/models), and
[pricing](https://docs.x.ai/developers/pricing). Model access can still depend
on account and region; the runtime reports the provider error without replacing
the configured model. See the [0.16.0 release notes](../releases/0.16.0.md) for
the Grok 4.6 default and capability change.

**Composer / ACP models** (`grok-composer-*`) are not ordinary chat endpoints —
they run only through the Grok Build CLI ACP path. See
[grok-oauth.md](../grok-oauth.md#composer-models-acp).

## Built-in providers (16)

| Slug | Display name | Default model | Default base URL | Ordered credential env aliases | Ordered endpoint env aliases | Onboarding access |
| --- | --- | --- | --- | --- | --- | --- |
| `grok` | xAI Grok | `grok-4.6` | `https://api.x.ai/v1` | `XAI_API_KEY`, `GROK_API_KEY` | `XAI_BASE_URL`, `GROK_BASE_URL` | `api-key` |
| `openai` | OpenAI | `gpt-5` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_API_BASE` | `api-key` |
| `anthropic` | Anthropic | `claude-opus-4-7` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `api-key` |
| `ollama` | Ollama | `llama3.3` | `http://localhost:11434` | _(none)_ | `OLLAMA_BASE_URL` | `local` |
| `lmstudio` | LM Studio | `gpt-4o-mini` | `http://localhost:1234/v1` | `LMSTUDIO_API_KEY` (optional) | `LMSTUDIO_BASE_URL` | `local` |
| `openai-compatible` | OpenAI-compatible | `local-model` | `http://localhost:8000/v1` | `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_API_KEY` | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` | `local` |
| `openrouter` | OpenRouter | `x-ai/grok-4.5` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `api-key` |
| `groq` | Groq | `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `GROQ_BASE_URL` | `api-key` |
| `deepseek` | DeepSeek | `deepseek-v4-flash` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `api-key` |
| `gemini` | Gemini | `gemini-2.5-pro` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `GEMINI_BASE_URL` | `api-key` |
| `mistral` | Mistral | `mistral-medium-latest` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` | `api-key` |
| `nvidia-nim` | NVIDIA NIM | `nvidia/llama-3.1-nemotron-70b-instruct` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | `NVIDIA_BASE_URL` | `api-key` |
| `minimax` | MiniMax | `MiniMax-M2.5` | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` | `api-key` |
| `github` | GitHub Copilot | `gpt-5.3-codex` | `https://api.githubcopilot.com` | `GITHUB_TOKEN`, `GH_TOKEN` | `GITHUB_BASE_URL` | `api-key` |
| `amazon-bedrock` | Amazon Bedrock | `amazon.nova-pro-v1:0` | `https://bedrock-runtime.us-east-1.amazonaws.com` | access: `AWS_BEDROCK_ACCESS_KEY_ID`, `AWS_ACCESS_KEY_ID`; secret: `AWS_BEDROCK_SECRET_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`; optional session: `AWS_BEDROCK_SESSION_TOKEN`, `AWS_SESSION_TOKEN` | `AWS_BEDROCK_BASE_URL` | `environment` |
| `agenc` | AgenC | `agenc` | `https://id.agenc.ag/v1` | _(managed auth; no BYOK key alias)_ | `AGENC_BASE_URL` | `managed` |

`openrouter` remains an `api-key` first-run route, but a signed-in AgenC
subscription can supply its managed key access when that feature is enabled.
Amazon Bedrock is an environment-only first-run route because SigV4 requires
both an access-key ID and secret access key. The optional session token is used
when present. AgenC's one-field BYOK paste/store path does not accept or persist
a partial Bedrock credential set.

## Auth model

Provider credential values are owned by the **auth backend** or transient BYOK
ingress, not by the provider registry. The registry stores only non-secret
metadata, including the ordered environment variable names above. It never
stores credential values.

- **Local BYOK** — explicit provider environment keys are transient inputs;
  keys saved through AgenC live only in the home-scoped native credential
  secure storage. `auth.json` contains non-secret identity/timestamp metadata only.
- **Remote / managed** — `auth.backend = "remote"` with managed keys
  (`agenc` provider requires managed auth). The stored bearer is native secure storage
  state. An explicit constructor token wins over `AGENC_REMOTE_AUTH_TOKEN`,
  which wins over the stored bearer; explicit overrides are not copied into
  `auth.json`.
- **OpenAI / ChatGPT OAuth** — `agenc openai-login` stores one home-scoped
  native `openAiOauth` record. While `openai` is selected, that stored sign-in
  wins over `OPENAI_API_KEY`; it never affects `openai-compatible` or another
  provider. ChatGPT-only accounts use the first-party subscription backend,
  while eligible platform accounts use the exchanged API key. Both modes
  reject a custom `OPENAI_BASE_URL` until `agenc openai-logout` removes the
  stored sign-in. Subscription requests use the same stored access token and
  account ID; `PROVIDER_CODE_API_KEY` is only a fallback when no usable stored
  subscription credential exists. The runtime never reads
  `~/.providerCode/auth.json`,
  `PROVIDER_CODE_AUTH_JSON_PATH`, or `PROVIDER_CODE_HOME`; those paths and the
  retired native `agenc` credential field are explicit one-way migration
  inputs only. Reads, refreshes, and clears stay bound to the client's captured
  `HomeContext`, and refresh compare-and-swap preserves a newer login.
  List reachable models with `agenc openai-models --json`
  (`{ok, models, authMode}`; tokens never in the output). See
  [cli.md](cli.md#openai-models).
- **Provider-native tokens** — GitHub Models, xAI OAuth, and AgenC AI
  subscription OAuth persist only in the home-scoped native `githubModels`,
  `xaiOauth`, and `agencAiOauth` namespaces. Their production APIs require an
  explicit `HomeContext`; cache/single-flight/refresh-lock state is isolated by
  home, and refresh writes compare-and-swap the exact credential version they
  exchanged so a newer login always wins. Gemini access-token and Application
  Default Credentials auth has no provider-specific secure-storage namespace. Gemini API
  keys explicitly saved through local BYOK live under `localAuth.byokKeys`.
- **Discovery** — `agenc providers` reports readiness (credentials present, local
  server health for Ollama/LM Studio/openai-compatible, subscription tier)
  without changing the selected provider. It uses the same ordered registry
  aliases as provider construction and reports the alias that actually won.
  A stored Grok OAuth bearer outranks stale shell keys; LM Studio never borrows
  an OpenAI key or endpoint for discovery or model-metadata probes.

See `runtime/src/auth/` and `runtime/src/llm/discovery/provider-discovery.ts`.
`byok-keys.json`, bearer fields in `auth.json`, and `.agenc/remote` credential
files, plus ProviderCode `auth.json`, are retired migration inputs, not
compatibility fallbacks.

## Config & env

```toml
# ~/.agenc/config.toml (illustrative)
model_provider = "grok"
model = "grok-4.6"

[providers.openrouter]
# provider-specific overrides live under [providers.<slug>] when configured
```

```bash
export AGENC_PROVIDER=openrouter
export AGENC_MODEL=x-ai/grok-4.5
export OPENROUTER_API_KEY=…
```

The built-in table above is exhaustive and ordered. An alias is never borrowed
by another provider unless that provider row explicitly lists it. LM Studio,
for example, does not inherit OpenAI credentials or endpoints. Bedrock supports
only the access, secret, optional session-token, endpoint, and region variables
listed here. Region selection is `AWS_BEDROCK_REGION`, then `AWS_REGION`, then
`AWS_DEFAULT_REGION`. Without `AWS_BEDROCK_BASE_URL`, that resolved region
produces `https://bedrock-runtime.<region>.amazonaws.com`; without a region,
the registry default is `us-east-1`. No additional AWS credential sources are
consumed by this direct SigV4 provider. Bedrock model discovery and token
counting receive the same captured credentials explicitly; they do not invoke
the AWS SDK profile, shared-file, instance-metadata, or web-identity chains.

## Local context windows

How AgenC learns the token budget for a local or OpenAI-compatible model.
Admission uses that number as the right-hand side of
`accounted input + reserved output <= context window`. Planning against the
128k conservative fallback when the server is actually 2k–32k is how a local
turn ends in truncation or a refused request.

| Area | Path |
| --- | --- |
| Live / config / registry lookup | `runtime/src/llm/model-metadata.ts` (`ModelMetadataResolver`) |
| Session model info | `runtime/src/llm/model-registry.ts`, `models-manager.ts` |
| Bootstrap attach | `runtime/src/bin/bootstrap.ts` (`StaticModelsManager.getModelInfo`) |
| Admission identity + window | `runtime/src/budget/admitted-model-call.ts` |
| Last-resort static table | `runtime/src/utils/context.ts` (`getContextWindowForModel`) |
| Fallback constant | `OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW` = **128_000** |

### Resolution order (session start)

`ModelRegistry.resolve` (async, used by `getModelInfo`) walks this chain and
stops at the first usable window. Each live HTTP probe has a **1s** timeout
(`DEFAULT_METADATA_TIMEOUT_MS`). A failed or empty probe is ignored, not
trusted.

1. **Live endpoint, `openai-compatible` only** — when a base URL is configured
   or present in the environment, the live window wins over
   `providers.openai-compatible.context_window_tokens`. Explicit
   `max_output_tokens` still wins.
2. **Explicit config** — `providers.<slug>.context_window_tokens`. If the
   model is also in the built-in catalog, the value is capped at the catalog
   maximum.
3. **Built-in catalog / name heuristic** — skipped for providers that prefer
   a live or registry lookup (`ollama`, `lmstudio`, `openai-compatible`,
   `openrouter`, or any live-metadata provider with a configured/env base
   URL).
4. **Live endpoint** — see the probe table below.
5. **Public registries** — OpenRouter `/api/v1/models` (OpenRouter only),
   then models.dev, then the LiteLLM price/context map.
6. **Built-in heuristic** again, if one exists and was skipped earlier.
7. **Conservative fallback** — **128_000** tokens,
   `source: "conservative_fallback"`,
   `usedFallbackModelMetadata: true`.

`resolveSync` (the `/model` picker list) never probes a server. It only sees
explicit config, the built-in heuristic, or 128k. The admitted session window
can therefore be smaller than the picker after the live probe returns.

Live metadata providers: `grok`, `openai`, `ollama`, `lmstudio`,
`openai-compatible`, `groq`, `deepseek`. Grok / OpenAI / Groq / DeepSeek
are probed only when `providers.<slug>.base_url` or that provider's endpoint
env is set.

### Local probes (recorded against live servers)

| Runtime | Probe | Field | Notes |
| --- | --- | --- | --- |
| Ollama | `POST {origin}/api/show` `{"model":"<slug>"}` | `model_info["<arch>.context_length"]` | Architecture is not derivable from the model name (`qwen2.context_length`, `phi2.context_length`). Suffix match only. Ollama's `/v1/models` is never consulted — it has no window. |
| llama.cpp | `GET {base}/v1/models` | `meta.n_ctx`, else `meta.n_ctx_train` | **Served** window wins. `llama-server -c 4096` on a 32k model refuses at 4097. |
| vLLM | `GET {base}/v1/models` | `max_model_len` | Compatible surface already answers; no second probe. |
| LM Studio | `GET {base}/v1/models` | whatever that surface reports | No dedicated native probe. Does not borrow `OPENAI_BASE_URL` or `OPENAI_API_KEY`. |

`/v1` and `/v1/` collapse onto the same Ollama origin
(`ollamaShowUrlFromBaseUrl`). `OLLAMA_BASE_URL` is honored on the metadata
path; a non-default host must not be probed at `localhost` while the session
talks to another box.

`openai-compatible` and `lmstudio` pointed at an Ollama endpoint try
`/v1/models` first. If that list has no window, they POST `/api/show`. A
non-Ollama server that 404s the native endpoint is left on the usual
fallback chain; the extra POST does not fail the session.

Malformed Ollama lengths (`0`, `-1`, `1.5`, the string `"32768"`, `null`)
are ignored rather than trusted.

There is no headless LM Studio recording in tree. Users still get whatever
window the compatible surface reports.

### How admission consumes the number

`runAdmittedModelCall` takes the first positive integer among:

1. Request `contextWindowTokens`
2. The provider execution profile
3. `session.modelInfo.contextWindow`, but only when the session slug equals
   the admitted model
4. `getContextWindowForModel` (catalog / OpenAI-compatible table / 128k)

Config and recovery often pass `provider:model` (`ollama:qwen3-coder:30b`).
`providerLocalModelSlug` strips an exact, case-insensitive provider-name
prefix and leaves later colons alone (`qwen3-coder:30b`,
`amazon.nova-pro-v1:0`). Without that strip, Ollama rejects the prefixed
name and the session-window lookup misses `modelInfo`.

`ollama`, `lmstudio`, and `openai-compatible` cost rows are
`localZeroCost: true` (zero USD). A zero-rate row without that flag still
counts as unpriced under a hard USD cap
(`held_unknown(unpriced_provider_response)`).

When the resolver used the 128k fallback,
`effectiveContextWindowPercent` is **100**. A live or catalog window uses
**95**.

### Operator override

```toml
# ~/.agenc/config.toml
[providers.ollama]
context_window_tokens = 32768
# max_output_tokens = 8192
```

On `openai-compatible`, a live `/v1/models` window overrides
`context_window_tokens`. On `ollama` and `lmstudio`, the explicit value
wins and the live probe is not consulted.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Local turn denied `context_window_exceeded` or the server refuses a short prompt | The live TUI shows the reason code and suggests `/compact`; it does not show the accounting values. Confirm the model is pulled, the endpoint env matches the session host, and `/api/show` or `/v1/models` reports a positive integer window. If diagnostics resolve to 128000 and neither configuration nor selected-model metadata declares it, the OpenAI-compatible fallback may have been used. A configured output reserve can consume a large share of a small window, so inspect `providers.<slug>.max_output_tokens` too. |
| Streamed answer vanished; `AdmissionStepConflictError` / empty `lastAgentMessage` | Admission compares model ids case-insensitively and ignores path segments before the final slash. If the conflict remains, inspect the requested and reported execution identities and the other persisted step data. |
| `OLLAMA_BASE_URL` sessions still look at localhost for the window | Metadata used to ignore the env and probe the built-in default. Current code uses the same ingress alias as the provider factory. |
| Picker shows 128k, session later uses 32k | Picker is `resolveSync`. The admitted window comes from the async live probe at session start. |
| llama.cpp refuses just past 4096 on a 32k GGUF | Window is `meta.n_ctx` (what `-c` loaded), not `n_ctx_train`. |
| Hard USD cap holds every Ollama/LM Studio success as unpriced | Those three local slugs must resolve to the `localZeroCost` rows. A prefixed model id that was not stripped used to miss both the window and the free cost entry. |
| Compatible server 404s `/api/show` | Expected for non-Ollama runtimes. The probe is best-effort; a working `/v1/models` window is enough. |
| Empty LM Studio/openai-compatible or Gemini answer that is not `context_window_exceeded` | Check for a wire 400 (llama.cpp grammar or Gemini schema) or the **8192** grammar-constrained-provider output ceiling. See [provider-tool-compat.md](../provider-tool-compat.md). |
| A later ChatGPT subscription request fails with `Unsupported parameter: previous_response_id` | Subscription requests are `store: false`. The continuation optimizer never attaches `previous_response_id` from an unstored response. The prompt-cache key is kept; the incremental delta is skipped. |
| ChatGPT / Responses refuses to continue after an interrupted tool turn | An unmatched `function_call` in history is closed with a synthetic `function_call_output` marked `interrupted`. The session stays usable; the model must not wait on that call id. |
| ChatGPT subscription 400s on `max_output_tokens` | Uncapped calls no longer require a provider-enforced output ceiling. Hard token or USD caps still demand a real ceiling and authoritative usage. |

See [provider-aware token accounting](../design/provider-aware-token-accounting.md)
for how the resolved window is enforced. Grammar-safe schemas, the local
tool catalog, Qwen3 `/no_think`, and Gemini's function-declaration
allowlist are documented on that compatibility page.

## Responses history and continuation

OpenAI-compatible Responses backends treat an unmatched `function_call`
as unresolved session state. `closeDanglingFunctionCalls`
(`runtime/src/llm/wire/responses-openai.ts`) inserts a synthetic
`function_call_output` immediately after every unmatched call so history
always pairs. The output text is an interrupted marker, not a fake
success.

`previous_response_id` can only reference a **stored** response. When
the request snapshot has `store: false` (ChatGPT subscription is always
stateless), the continuation optimizer keeps `prompt_cache_key` and
skips the incremental delta. Chaining an unstored id used to reject
every later request of a subscription conversation once tools or
history made it an extension.

Under a hard aggregate token or USD cap, admission still requires a
provider-enforced `max_output_tokens` and authoritative usage. Without
that cap, providers that reject an output ceiling (ChatGPT
subscription) admit without one. Reported, priced provider usage is reconciled;
missing usage or pricing is held unknown after dispatch.

## Wire layer

| Layer | Path |
| --- | --- |
| Registry / provider metadata | `runtime/src/llm/registry/provider-info.ts` |
| Model catalog | `runtime/src/llm/registry/model-catalog.ts` |
| Context-window resolver | `runtime/src/llm/model-metadata.ts` |
| Responses continuation / `store: false` | `runtime/src/llm/shape-request.ts` |
| Dangling function-call pairing | `runtime/src/llm/wire/responses-openai.ts` |
| Provider-neutral HTTP client / retry loop | `runtime/src/llm/client.ts`, `client-session.ts` |
| Stream idle deadline | `runtime/src/llm/stream-watchdog.ts` |
| Per-provider modules | `runtime/src/llm/providers/*` |
| HTTP / SDK services | `runtime/src/services/` |
| Capabilities | `runtime/src/llm/provider-capabilities.ts` |

`ProviderHttpClientSession` owns these defaults for adapters that use the
provider-neutral HTTP client:

- request max retries: **4**
- stream max retries: **5**
- stream idle timeout: **unset** (0). Silence does not end a turn unless you
  set `stream_watchdog_timeout_ms` or `AGENC_STREAM_IDLE_TIMEOUT_MS`

Model-provider streaming uses HTTP/SSE. The daemon, realtime connector, MCP,
and gateway have separate WebSocket transports; they are not provider
capabilities and are not described by the LLM provider registry.

Its retry behavior is:

- **429 is not retried** (`retry429: false`). 5xx and transport (network/timeout)
  are. Caller abort is not. One extra TLS-cert retry on attempt 0 only.
- **Retry-After > 300s** aborts the retry.
- Session backoff base is **200 ms**.
- After budget admission, model calls set `singleWireAttempt: true`: **no HTTP
  retry** on that lease. A retry needs a new reservation.
Grok uses an SDK transport with a distinct retry contract: its default budget
is **2**, `maxRetries` can override it, and the SDK owns retry eligibility and
backoff. A `singleWireAttempt` still forces that SDK budget to **0**. Those are
provider-specific transport semantics, not provider-registry metadata and not
the `ProviderHttpClientSession` policy above.

Grok OAuth: expired bearer is often **403**. Refresh on 401 and 403, two
attempts, then quarantine a dead rotating refresh token. Admitted Grok turns
do **not** in-band retry; they pre-flight refresh if the stored token is near
expiry. See [grok-oauth.md](../grok-oauth.md).

Grok server tools (`web_search`, `x_search`, `code_interpreter`, `file_search`,
MCP) cannot be counted before the turn. Admission reserves the **full context
window** for those tools so later usage does not trip `provider_overrun`.

## OpenAI-compatible chat-completions wire

This section describes request and response shaping on the chat-completions
path. A provider identity does not guarantee this transport: some providers,
including GitHub for qualifying models, can use Responses instead. Native
`ollama` uses the Ollama SDK. The `lmstudio` and `openai-compatible` slugs take
the grammar, reduced-catalog, output-ceiling, and Qwen3 paths described below;
pointing `openai-compatible` at an Ollama HTTP port still selects those paths.

Source: `runtime/src/llm/wire/think-tags.ts`, `capability-gating.ts`,
`chat-completions.ts`; streaming split in
`runtime/src/llm/providers/openai/adapter.ts`.

### Think tags and `reasoning_content`

Reasoning models disagree about where chain-of-thought goes.

| Source | What AgenC does |
| --- | --- |
| Streaming `delta.reasoning_content` | Emits hidden thinking events and stays out of visible assistant text. |
| Non-streaming `message.reasoning_content` | Becomes visible assistant content only when `message.content` is absent, null, or otherwise not text/content blocks. A string `content`, including an empty string, takes precedence. |
| Leading `<think>...</think>` or `◁think▷...◁/think▷` in `content` | First leading block (whitespace before the opener allowed) moves to thinking. Text after the closer is the answer. |
| Literal `<think>` later in the answer | Left visible. Only a marker that opens at the start of the assistant message starts a block. |
| Opener with no closer | Remainder is thinking. The generation died mid-thought; it is not an answer. |

`ThinkTagStreamFilter` holds marker prefixes that straddle SSE chunks so
neither channel retracts text it already emitted. `flush()` at stream end
drains the buffer to the channel the state says it belongs to.

The non-streaming fallback is implemented by
`parseChatCompletionsResponse`; it differs deliberately from streaming
channel separation.

### Capability field strip

`chatCompletionsCapabilityHintsForProvider` strips fields the destination
rejects or silently ignores. An undefined `acceptsX` flag still means
"include if the caller supplied a value."

| Field | Who gets it |
| --- | --- |
| `reasoning_effort` | OpenAI reasoning-family slugs (`gpt-5`, `o1`, `o3`, `o4`, `codex`, `chatgpt-5`). Grok 4.3 / 4.5 / 4.6, `grok-4-20-multi-agent` / `grok-4.20-multi-agent`, and `grok-build-latest`. NVIDIA NIM families below, and only values in that family's enum. Everyone else: stripped. `/effort` on a local model is a no-op on the wire. |
| `service_tier` | `openai` and `azure-openai` only |
| `stream_options.include_usage` | Default **on**. `STREAM_USAGE_INCOMPATIBLE_PROVIDERS` is currently empty, and no operator or per-instance override is wired. |

NVIDIA NIM `reasoning_effort` enums (hosted schemas, 2026-08):

| Family | Allowed values |
| --- | --- |
| `kimi-k3` | `low`, `high`, `max` |
| `deepseek-v4-pro` / `deepseek-v4-flash` | `none`, `high`, `max` |
| `gpt-oss-<N>b` | `low`, `medium`, `high` |
| `nemotron-3-super` | `none`, `low`, `high` |
| `nemotron-3-ultra` | `none`, `medium`, `high` |

Other NIM models (Kimi K2.x, MiniMax M3, plain Llama instruct) do not get
the field. They think through `chat_template_kwargs` or not at all.

### Local output ceiling and `/no_think`

For `lmstudio` and `openai-compatible` only
(`GRAMMAR_CONSTRAINED_TOOL_PROVIDERS`):

- **Output ceiling 8192** (`outputTokensCeiling`). The request
  wire field is `max_tokens`, set to `min(requested, 8192)`. The internal
  `maxOutputTokens` option and `max_output_tokens` setting supply the requested
  value. Non-local OpenAI chat-completions requests use
  `max_completion_tokens`. The runtime default remains
  `DEFAULT_MAX_OUTPUT_TOKENS` (**32_000**); this ceiling applies only to the
  two grammar-constrained slugs.
- **`/no_think` system suffix** when the model slug matches `qwen3` /
  `qwen-3`. Qwen3 hybrid thinking honors that line. LM Studio ignores
  `chat_template_kwargs.enable_thinking`, so this path uses the prompt
  switch for llama.cpp-served Qwen.

Native `ollama` gets neither the ceiling nor `/no_think`.

Grammar-safe tool schemas and the reduced local catalog:
[provider-tool-compat.md](../provider-tool-compat.md).

### Operator pitfalls

| Symptom | Cause | What to do |
| --- | --- | --- |
| Transcript shows `<think>...</think>` | The request did not use this chat-completions shaping, or the marker was not at the start of the assistant message | Use `lmstudio` / `openai-compatible` for the local chat-completions path. A mid-answer `<think>` is left visible on purpose |
| LM Studio/openai-compatible turn ends after a long generation | The fixed 8192 output ceiling may have ended generation, or an unclosed leading think block remained in the thinking channel | Inspect the finish reason and provider diagnostics; an unclosed leading block is not visible answer text |
| `/effort` on Ollama / LM Studio / compatible does nothing | `reasoning_effort` is stripped for those slugs | Expected. Pin a model that documents the field, or use the `/no_think` Qwen3 switch |
| `failed to parse grammar` on the first tool turn | llama.cpp rejected a tool-schema keyword | `lmstudio` / `openai-compatible` now sanitize to the GBNF-safe subset. A leftover 400 is a keyword those servers still reject |
| LM Studio/openai-compatible model cannot call a team, task, or MCP tool | The reduced local profile does not include that tool | `system.searchTools` cannot bypass the local allowlist. Use another provider slug when the full catalog is required |
| Compatible-to-Ollama session looks different from `ollama:` | Same HTTP server, different adapter and gates | Native `ollama` is the SDK path. `openai-compatible` pointing at Ollama is the gated chat-completions path |

## Related docs

- Tool / provider compatibility (object root, grammar-safe schemas, local catalog): [`../provider-tool-compat.md`](../provider-tool-compat.md)
- Token admission invariant: [`../design/provider-aware-token-accounting.md`](../design/provider-aware-token-accounting.md)
- Managed OpenRouter path: [`../managed-openrouter.md`](../managed-openrouter.md)
- Onboarding: `agenc onboard`
