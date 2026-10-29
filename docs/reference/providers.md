# Providers reference

Built-in model providers for AgenC **0.19.22**. Source of truth:
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
| OpenRouter default | `x-ai/grok-4.5` |
| Config keys | `model_provider`, `model` in `config.toml` |
| Env overrides | `AGENC_PROVIDER`, `AGENC_MODEL` |

Bare interactive startup with a fresh install uses the **config** default
(`grok-4.6`). When only the direct `grok` provider slug is resolved without an
explicit model, the registry also uses **`grok-4.6`**. OpenRouter uses your own
key and its default remains **`x-ai/grok-4.5`**.

## Gemini reasoning effort

Core defaults to `gemini-3.8-flash` for the Gemini provider. Gemini 4 Argon
(`gemini-4-argon`) leads the model list but is not the default: Google does
not offer it on the free tier, and it costs more per token. Choose it with
`/model` or an explicit model setting. `gemini-3.1-pro-preview` remains
selectable the same way.

`gemini-3.7-flash` and `gemini-3.5-flash` are deprecated. Google answers them
with `gemini-3.8-flash` and `gemini-3.6-flash`, so AgenC hides them from the
model list, keeps saved settings that name them working, and prices them as
the model that answers.

The native Gemini adapter sends an explicit effort as
`generationConfig.thinkingConfig.thinkingLevel`. The model catalog, `/effort`,
child-agent and role overrides, and provider/model switch checks use the same
supported-level metadata.

| Model | Explicit levels | Provider default when omitted |
| --- | --- | --- |
| `gemini-4-argon` | `low`, `medium`, `high` | `medium` |
| `gemini-3.8-flash` | `low`, `medium`, `high` | `medium` |
| `gemini-3.1-pro-preview` | `low`, `medium`, `high` | `high` |
| `gemini-3.6-flash` | `minimal`, `low`, `medium`, `high` | `medium` |
| `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` | `minimal`, `low`, `medium`, `high` | `minimal` |
| `gemini-3.7-flash` (deprecated) | `low`, `medium`, `high` | `medium` |
| `gemini-3.5-flash` (deprecated) | `minimal`, `low`, `medium`, `high` | `medium` |
| `gemini-3-flash-preview` | `minimal`, `low`, `medium`, `high` | `high` |
| `gemini-3-pro-preview` | `low`, `high` | `high` |

Gemini 4 Argon shares one 1,048,576-token window between input, thinking and
output. A streamed response may use 65,536 output tokens, and a non-streaming
call at most 32,768, so AgenC lowers the limit it sends on non-streaming calls
to that model. Thinking tokens count toward the limit.

An unconfigured Gemini session leaves thinking controls out of the request.
An explicit `reasoning_effort = "none"` also omits the control, even when
another configured effort would otherwise apply. Neither case disables the
model's thinking. `/effort default` removes the saved override and clears the
session's effort. A provider or model switch keeps an effort the new model
accepts. It drops any other level and says so, and the new model runs at its
default. A cleared or dropped effort stays cleared: the configured
`reasoning_effort` does not refill it, so each model the session switches to
runs at its own default until a level is chosen again.

Unsupported explicit levels fail before a request is sent. AgenC does not
translate `minimal`, `xhigh`, or `max` into a different Gemini level. Unknown
model variants do not inherit levels from a name prefix. Gemini 2.5 Pro,
Flash, and Flash-Lite use `thinkingBudget` on the native `generateContent`
API, so AgenC does not accept named effort levels for those models or invent
a token-budget conversion.

Sources checked on 2026-09-08 and again on 2026-10-28: Google's
[native ThinkingConfig reference](https://ai.google.dev/api/generate-content#ThinkingConfig),
[thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking),
[Gemini 4 Argon guide](https://ai.google.dev/gemini-api/docs/generate-content/latest-model), and
[Gemini 3 guide](https://ai.google.dev/gemini-api/docs/gemini-3).

### Gemini prices, logging and credits

Several Gemini prices are introductory and change on a date Google announces:
Gemini 4 Argon from December 1, 2026, and 3.8 Flash, 3.6 Flash and Robotics
ER 2 from January 1, 2027. AgenC records both prices and bills each call at
the rate in effect when it ran, switching at 00:00 UTC on the first day of the
new price. A Gemini model with no price row shows its cost as unknown; AgenC
never borrows another model's price for it.

Since October 26, 2026, new paid Gemini API projects keep `generateContent`
requests in their AI Studio logs unless a request sets `store` to `false`.
AgenC sends `store: false` on every request to the Gemini Developer API and to
a custom `GEMINI_BASE_URL`. Vertex AI requests leave the field out. This does
not stop the abuse-monitoring logs Google keeps on paid requests.

When the Prepay credit balance of a billing account reaches zero, the Gemini
API answers HTTP 402 for every key on it. AgenC stops the turn instead of
retrying and says to add credits or turn on auto-reload.

### Gemini tool calls and thought signatures

Gemini 3 and newer put a thought signature on the first function call of each
step. Google refuses a request with HTTP 400 when a step of the current turn
comes back without one, and it treats a call that follows a text part as the
start of a new run that needs its own. AgenC returns each call with the
signature Google gave it, keeps the calls of a step together, and sends the
declared call name. That holds after a resume and after a compaction too, also
when the durable record had to redact the call's text or arguments: the record
keeps the signatures without that text.

A step that this model did not produce has no signature to return, for example
after a mid-turn fallback to another model or provider. AgenC then sends
Google's documented placeholder, `skip_thought_signature_validator`, on the
first call of each run of calls in that step. Earlier turns are not validated
and go back as they are.

Each function call goes back with its call id, and each function response
names the id of its call. The results of one step travel in one user content,
after all the calls of that step.

Sources checked on 2026-10-28: Google's
[thought signatures guide](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) and
[function calling guide](https://ai.google.dev/gemini-api/docs/generate-content/function-calling).

### New Gemini models

A Gemini chat model that Google lists in `GET /v1beta/models` works before
AgenC registers it. Select it with `--model` or `/model <id>`. With an API key,
the session reads Google's list and takes the model's context window, output
limit and thinking flag from it. Until AgenC registers the model, it runs at
its own default thinking level (an effort setting is not sent), and its cost
shows as unknown. Registering it adds the price, the thinking levels and the
model list entry.
The Interactions API's level abstraction for Gemini 2.5 does not apply to
AgenC's native `generateContent` requests.

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

| Selectable model | Context | Input | Reasoning effort | Base rates per 1M input / cached / output |
| --- | --- | --- | --- | --- |
| `grok-4.7` | 500,000 | text and image | `low`, `medium`, `high`, `xhigh`; default `high` | $2 / $0.50 / $6 |

Grok 4.7 preserves encrypted reasoning on Responses resends and durable history.
The session default remains `grok-4.6`.

Grok 4.7 and Grok 4.6 have a Fast tier: xAI priority processing at 2x the
token rates, on API-key billing only. See
[Fast mode and service tiers](#fast-mode-and-service-tiers).

`grok-4.5` remains a selectable 500k-context catalog entry with the same input
modalities and runtime features. Its short-context cached-input rate is
$0.30 / 1M, versus $0.50 / 1M for Grok 4.6; it supports
`low`/`medium`/`high` reasoning and remains the direct OpenRouter
default. The xAI reasoning gate is fail-closed: Grok 4.3, Grok 4.5, Grok 4.6, Grok 4.7,
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

## Built-in providers (25)

| Slug | Display name | Default model | Default base URL | Ordered credential env aliases | Ordered endpoint env aliases | Onboarding access |
| --- | --- | --- | --- | --- | --- | --- |
| `grok` | xAI Grok | `grok-4.6` | `https://api.x.ai/v1` | `XAI_API_KEY`, `GROK_API_KEY` | `XAI_BASE_URL`, `GROK_BASE_URL` | `api-key` |
| `openai` | OpenAI | `gpt-5` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_API_BASE` | `api-key` |
| `anthropic` | Anthropic | `claude-opus-5-5` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `api-key` |
| `ollama` | Ollama | `llama3.3` | `http://localhost:11434` | _(none)_ | `OLLAMA_BASE_URL` | `local` |
| `lmstudio` | LM Studio | `gpt-4o-mini` | `http://localhost:1234/v1` | `LMSTUDIO_API_KEY` (optional) | `LMSTUDIO_BASE_URL` | `local` |
| `openai-compatible` | OpenAI-compatible | `local-model` | `http://localhost:8000/v1` | `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_API_KEY` | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` | `local` |
| `openrouter` | OpenRouter | `x-ai/grok-4.5` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `api-key` |
| `venice` | Venice AI | `zai-org-glm-5-2` (offline fallback) | `https://api.venice.ai/api/v1` | `VENICE_API_KEY` | `VENICE_BASE_URL` | `api-key` |
| `abliteration` | abliteration.ai | `abliterated-model-large-v2` | `https://api.abliteration.ai/v1` | `ABLIT_KEY`, `ABLITERATION_API_KEY` | `ABLITERATION_BASE_URL` | `api-key` |
| `groq` | Groq | `openai/gpt-oss-120b` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `GROQ_BASE_URL` | `api-key` |
| `deepseek` | DeepSeek | `deepseek-flash` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `api-key` |
| `meta` | Meta | `muse-wonder-1.0` | `https://api.meta.ai/v1` | `MODEL_API_KEY` | `META_BASE_URL` | `api-key` |
| `qwen` | QwenCloud Pay-As-You-Go | `qwen3.8-max` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY`, `QWEN_API_KEY` | `DASHSCOPE_BASE_URL`, `QWEN_BASE_URL` | `api-key` |
| `qwen-token-plan` | QwenCloud Token Plan | `qwen3.8-max` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `QWEN_TOKEN_PLAN_API_KEY`, `DASHSCOPE_TOKEN_PLAN_API_KEY` | `QWEN_TOKEN_PLAN_BASE_URL`, `DASHSCOPE_TOKEN_PLAN_BASE_URL` | `api-key` |
| `ollama-cloud` | Ollama Cloud | `deepseek-v4.1-flash` | `https://ollama.com/v1` | `OLLAMA_API_KEY` | None (fixed Cloud endpoint) | `api-key` |
| `cerebras` | Cerebras | `gpt-oss-120b` | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | `CEREBRAS_BASE_URL` | `api-key` |
| `zai` | Z.AI | `glm-5.3` | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` | `ZAI_BASE_URL` | `api-key` |
| `zai-coding-plan` | Z.AI Coding Plan | `glm-5.3` | `https://api.z.ai/api/coding/paas/v4` | `ZAI_CODING_PLAN_API_KEY` | `ZAI_CODING_PLAN_BASE_URL` | `api-key` |
| `gemini` | Gemini | `gemini-3.8-flash` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `GEMINI_BASE_URL` | `api-key` |
| `kimi` | Kimi (Moonshot) | `kimi-k3` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | _(fixed global endpoint)_ | `api-key` |
| `mistral` | Mistral | `mistral-medium-latest` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` | `api-key` |
| `nvidia-nim` | NVIDIA NIM | `nvidia/nemotron-3-super-120b-a12b` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | `NVIDIA_BASE_URL` | `api-key` |
| `minimax` | MiniMax | `MiniMax-M2.5` | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` | `api-key` |
| `github` | GitHub Copilot | `gpt-5.3-codex` | `https://api.githubcopilot.com` | `GITHUB_TOKEN`, `GH_TOKEN` | `GITHUB_BASE_URL` | `api-key` |
| `amazon-bedrock` | Amazon Bedrock | `amazon.nova-pro-v1:0` | `https://bedrock-runtime.us-east-1.amazonaws.com` | access: `AWS_BEDROCK_ACCESS_KEY_ID`, `AWS_ACCESS_KEY_ID`; secret: `AWS_BEDROCK_SECRET_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`; optional session: `AWS_BEDROCK_SESSION_TOKEN`, `AWS_SESSION_TOKEN` | `AWS_BEDROCK_BASE_URL` | `environment` |

`openrouter` uses your own OpenRouter key, including for free models. AgenC
accounts do not supply provider credentials or model access.

For current Claude models, limits and thinking behavior, see
[Anthropic models](./anthropic-models.md).

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
- **AgenC account**: `auth.backend = "remote"` controls account sign-in only.
  Account identity, remote access, and desktop sync do not grant model access.
  The account bearer remains in native secure storage.
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
  Within an OpenAI provider instance, concurrent 401 failures share one
  refresh for the credentials used by those requests. Delayed failures from
  older credentials cannot invalidate a refreshed session. Cancelling a chat
  or stream stops that caller's wait without cancelling the shared refresh.
  Genuine refresh exhaustion stays in effect until the provider is recreated
  after login. Single-wire requests never refresh or mark refresh exhausted.
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

Meta Model API uses `MODEL_API_KEY`, the key variable Meta documents for the
Model API, sent as a bearer token. Meta's own Muse Code CLI reads
`META_API_KEY` instead; AgenC does not read that variable. Muse Spark models use
the OpenAI-compatible `/chat/completions` transport and Muse Wonder uses
`/responses` (below). The default model is `muse-wonder-1.0`. The LLM
catalog includes `muse-wonder-1.0`, `muse-spark-1.3`,
`muse-spark-1.3-contributor`, `muse-spark-1.2`,
`muse-spark-1.2-contributor`, and `muse-spark-1.1`. The `/models` entries
`muse-image-1.0` and `muse-voice-transcribe-1.0` are media APIs, so they remain
excluded from the chat/session model picker. `muse-image-1.0` is instead the
native Meta backend for the model-facing `ImagineImage` tool. Muse Spark (and
any other tool-capable reasoning provider) can invoke that tool when
`MODEL_API_KEY` is configured; tool availability is not restricted by the
reasoning provider slug.

Muse Spark is registered with a 1,048,576-token context window and a
131,072-token maximum output. Its supported reasoning levels are `minimal`,
`low`, `medium`, `high`, and `xhigh` (default `medium`); standard-tier
`muse-spark-1.3` also accepts `max`. The API rejects `none`, and `max` is not
available on the other registered models. See Meta's
[reasoning guide](https://dev.meta.ai/docs/reasoning). The chat models accept image input, JSON-schema structured
output, and parallel function calls. Meta accepts only `tool_choice: "auto"`
and rejects `stop`, so AgenC normalizes those controls before sending a
request. Streams must include a terminal `finish_reason`; malformed or cut
streams fail instead of being accepted as completed answers, and tool calls
require `finish_reason: "tool_calls"` before dispatch. This follows Meta's
[Chat Completions contract](https://dev.meta.ai/docs/protocols/chat-completions).
Per-token prices for every registered Muse model come from Meta's
[pricing page](https://dev.meta.ai/docs/pricing-rate-limits).

Muse Wonder (`muse-wonder-1.0`) uses Meta's Responses API. It is the only Meta
surface that carries the model's reasoning from one turn to the next; Chat
Completions redacts reasoning for external keys
([protocols](https://dev.meta.ai/docs/protocols),
[reasoning](https://dev.meta.ai/docs/reasoning)). Requests are stateless
(`store: false`) and ask for `reasoning.encrypted_content`. Each encrypted
reasoning item stays with the assistant message it preceded and goes back on
later requests to the same provider and model, in the same position as OpenAI
replay. A model or provider switch drops it. Meta replay is always on for Muse
Wonder, because the model cannot run without reasoning;
`AGENC_OPENAI_REASONING_REPLAY` does not apply to it. Assistant text from a turn
that also called tools goes back with `phase: "commentary"`, as Meta's
[Responses guide](https://dev.meta.ai/docs/protocols/responses) requires for
intermediate text before a function call.

Muse Wonder takes `reasoning.effort` values `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`. Its catalog default is `high`, which model pickers such as
Desktop start at; a session that sets no effort uses the global
`reasoning_effort` default (`medium`). Meta rejects `none`, so AgenC omits it
and the model reasons at its own default level. An unset reasoning summary requests
`auto`. Tool choice follows the same `auto`-only rule as Muse Spark, and
structured output uses `text.format`. The model is registered with a
1,048,576-token context window. Meta does not publish a separate output limit
for Muse Wonder, so AgenC keeps the 131,072-token limit Meta documents for
Muse Spark on the same endpoints. Usage reports cached input tokens and
reasoning tokens. A stream that ends with an `error` event or `response.failed`
carrying `server_shutting_down`, `service_overloaded`, `backend_unavailable`,
or `server_error` is retried like a server error; a 402 billing error is
terminal ([error handling](https://dev.meta.ai/docs/error-handling)).

Muse Wonder Full is not on the Model API. Meta offers it only inside its Muse
Code CLI on the Power Usage and Maximum Usage subscription plans, and that
subscription credential works only in Muse Code, so AgenC does not register it
([models](https://dev.meta.ai/docs/models),
[subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions)).

MiniMax keeps AgenC's 131,072-token output reservation while its [API reference](https://platform.minimax.io/docs/api-reference/text-chat-openai)
sets exact upper limits of 524,288 for M3 and 204,800 for every listed M2 variant.
M3's [published price](https://platform.minimax.io/docs/guides/pricing-paygo)
doubles above 512K input tokens, defined as 524,288 tokens by the API reference.
Priority admission uses `service_tier: "priority"` and costs 1.5 times the
applicable standard tier. M3 has no published cache-write fee; M2.7 retains its
own documented fee. The M3.1 preview is currently restricted to Token Plan and
MiniMax Code, so it is not added to AgenC's standard PAYG picker.

Groq defaults to `openai/gpt-oss-120b`. Its reviewed public catalog also
contains `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (preview), and
`minimaxai/minimax-m2.7` (enterprise preview). The GPT OSS models accept
`low`, `medium`, and `high` effort; Qwen additionally accepts `none` and
supports images. Parallel tools are advertised only for Qwen and MiniMax.
The shared Llama models retired on August 16, 2026 and are no longer offered
in the fallback picker. Enterprise customers can still enter a custom ID;
enterprise prices remain unknown. Sources: [models](https://console.groq.com/docs/models),
[tools](https://console.groq.com/docs/tool-use/overview), and
[deprecations](https://console.groq.com/docs/deprecations).

GitHub's catalog includes the [documented Copilot CLI IDs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, and `claude-opus-5.5`, and
removes models marked retired in the [Copilot model reference](https://docs.github.com/en/copilot/reference/ai-models/supported-models).
The separate GitHub Models service retired on July 30, 2026. Copilot model
access depends on the account and plan; no account-specific discovery was
available during this review. The four added IDs use [Copilot-specific published prices](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing),
including long-context tiers, without borrowing direct-provider fast or search rates.

Bedrock's catalog additionally contains active model cards that explicitly
advertise Converse and client-side function tools. The exact IDs and source
URLs are kept in `runtime/src/llm/registry/bedrock-converse-models.ts`.
Cards showing only rounded K/M limits do not establish exact catalog limits.
Regional prices and account availability remain unknown. The current adapter
supports text input only, including for models whose AWS card also advertises
vision. Existing Nova defaults and Claude-specific wire behavior are retained.

Cerebras uses `CEREBRAS_API_KEY` with the OpenAI-compatible
`https://api.cerebras.ai/v1/chat/completions` endpoint. The optional
`CEREBRAS_BASE_URL` override supports a private/dedicated deployment without
restricting its model name to the public catalog. The public chat catalog is listed below. `gemma-4-31b` was
[removed from shared inference on September 3, 2026](https://inference-docs.cerebras.ai/support/deprecation).
Its dedicated-deployment metadata remains available for explicit model IDs,
while the shared fallback picker omits it. Qwen's catalog preserves the
conservative free-tier context/output contract; paid plans support larger limits.

The public chat catalog is:

| Model | Context | Max output | Input / output per 1M tokens | Image input | Parallel tools | Reasoning effort (default) |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `gpt-oss-120b` | 131,072 | 40,960 | $0.35 / $0.75 | no | no | `low`, `medium`, `high` (`medium`) |
| `qwen-3.8-27b` | 65,536 | 32,768 | $0.99 / $1.49 | yes | yes | `none`, `low`, `medium`, `high` (`high`) |

Both shared models expose function tools and JSON-schema structured output, but
Cerebras rejects combining those two modes in one request; AgenC blocks that
combination before dispatch. AgenC sends
`max_completion_tokens`, keeps Cerebras' `reasoning` response field out of
visible assistant text, and replays that opaque field only to the same
provider/model during a tool loop. Tool-result images are relayed as a user
image only for the two vision models; `gpt-oss-120b` and unknown dedicated
models strip them. Direct image history must use base64 PNG or JPEG data URIs
on `user` messages; remote URLs, WebP, and GIF are rejected before dispatch.
Requests are limited to ten images and a 10 MiB total HTTP request payload.
Unsupported or excess
tool-result media is dropped while its textual result remains available to the
model. The adapter targets API v2, whose strict tool sequence
requires every assistant tool call to be followed immediately by its matching
tool result. Explicit `service_tier` values remain available to callers of
configured dedicated endpoints, but the shared model catalog advertises no
selectable speed tiers because `flex` is private preview and `priority` is
dedicated-only. Structured schemas outside Cerebras' strict subset (including
array-size constraints such as `maxItems`) automatically use `strict: false`
on the wire without erasing the original application constraint. These
capabilities were verified against the public Cerebras model catalog and
inference documentation on 2026-09-04. The listed shared-API rates use the
official model/pricing pages from that date; dedicated endpoint rates remain
deployment-specific. Sources: [public model catalog](https://inference-docs.cerebras.ai/api-reference/models/public-models),
[Qwen 3.8 27B](https://inference-docs.cerebras.ai/models/qwen-3.8-27b),
[Chat Completions](https://inference-docs.cerebras.ai/api-reference/chat-completions),
[reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning),
[image inputs](https://inference-docs.cerebras.ai/capabilities/image-inputs),
[structured outputs](https://inference-docs.cerebras.ai/capabilities/structured-outputs),
and [service tiers](https://inference-docs.cerebras.ai/capabilities/service-tiers).

Z.AI Pay-As-You-Go uses `ZAI_API_KEY` with the OpenAI-compatible
`https://api.z.ai/api/paas/v4/chat/completions` endpoint. The separate
`zai-coding-plan` provider uses `ZAI_CODING_PLAN_API_KEY` with
`https://api.z.ai/api/coding/paas/v4/chat/completions`. `ZAI_BASE_URL` and
`ZAI_CODING_PLAN_BASE_URL` override only their matching route. Credentials and
endpoints never cross between the two billing modes. Both curated chat
catalogs are intentionally fixed rather than derived from `/models`:

| Model | Context | Max output | Input / cached input / output per 1M tokens | Image input | Reasoning effort (default) |
| --- | ---: | ---: | ---: | --- | --- |
| `glm-5.3` | 1,000,000 | 131,072 | $1.40 / $0.26 / $4.40 | no | `low`, `high`, `max` (`max`) |
| `glm-5.3-flash` | 1,000,000 | 131,072 | $0.15 / $0.03 / $0.50 | yes | `low`, `high`, `max` (`max`) |

Both models are documented for Pay-As-You-Go and Coding Plan and use
always-enabled thinking. Coding Plan access is subscription-based, so AgenC
does not apply Pay-As-You-Go token prices to its cost accounting. AgenC sends
the provider's nested `thinking` object with `clear_thinking=true` for ordinary
turns. It switches that field to `false` only for a complete, immediately
adjacent tool/result continuation from the exact same provider and model, and
then replays every reasoning block in that intact multi-round chain in its
original order. Compacted, incomplete, or older reasoning is cleared as a
unit and remains outside the visible answer. Z.AI receives the
full normal AgenC tool catalog up to its documented
128-function limit. If a request would exceed that limit, AgenC fails before
HTTP with an actionable error instead of silently dropping tools.
`tool_choice` is normalized to `auto`, parallel-tool and undocumented
stream-usage controls are omitted, streamed tool arguments use `tool_stream`,
and `max_tokens` is the output field. Tool-call arguments may arrive as either
a JSON string or an object; both forms are normalized before dispatch. JSON
structured output uses Z.AI's `json_object` response format, includes the
requested schema as a system constraint, and validates the result locally with
full JSON Schema semantics. Structured output remains available through
function-tool loops: intermediate `tool_calls` turns skip final-output parsing,
then the terminal `stop` answer is schema-validated. The Z.AI-specific
`sensitive`, `network_error`, and
`model_context_window_exceeded` finish reasons map to AgenC's content-filter,
error, and context-overflow states. Code `1113` is surfaced as a non-retryable
billing/endpoint configuration error rather than a transient rate limit.
Streamed tool calls require an explicit `finish_reason=tool_calls`; malformed
or conflicting terminal frames fail closed. Only `glm-5.3-flash` admits image history; tool-result
images are relayed as a user image for Flash and stripped for the text-only
model. Flash validates inline input as JPEG/PNG under 5 MiB and no larger than
6000x6000; unsupported tool-result images are omitted without losing their
text result.

`ZAI_API_KEY` also enables the provider-independent `ImagineImage` tool. A
Z.AI Pay-As-You-Go session prefers its native synchronous
`/images/generations` route over unrelated media credentials; another
reasoning provider can use it only as an explicitly configured, independent
media backend. The default image model is `glm-image`; the official
`cogview-4-250304` model is also accepted. The tool sends one image per
request and reserves the official $0.015 / $0.01 per-image cost respectively.
It validates the documented `hd` / `standard` quality and size choices,
downloads the returned temporary URL through a 20 MiB limit, and revalidates
every HTTPS redirect against the Z.AI image-host allowlist. Image models are
rejected by the chat provider before network dispatch. Coding Plan credentials
never authorize this general image route: a `zai-coding-plan` session needs a
separate `ZAI_API_KEY` (or another independent media backend) to expose
`ImagineImage`. Sources:
[GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3),
[GLM-5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash),
[Chat Completions](https://docs.z.ai/api-reference/llm/chat-completion),
[Generate Image](https://docs.z.ai/api-reference/image/generate-image), and
[pricing](https://docs.z.ai/guides/overview/pricing).

Kimi uses `MOONSHOT_API_KEY` only with Moonshot's fixed global
`https://api.moonshot.ai/v1` authority. The native `kimi` slug has no base-URL
environment override and never borrows another provider's key; regional or
custom OpenAI-compatible deployments belong under `openai-compatible`. Its
curated global catalog is:

| Model | Context | Default / maximum output | Cached input / input / output per 1M tokens | Reasoning effort (default) |
| --- | ---: | ---: | ---: | --- |
| `kimi-k3` | 1,048,576 | 131,072 / 1,048,576 | $0.30 / $3.00 / $15.00 | `low`, `high`, `max` (`max`) |
| `kimi-k3.1-pro` | 1,048,576 | 131,072 harness default / 1,048,576 context ceiling | $0.20 / $2.00 / $10.00 | `low`, `high`, `max` (`max`) |
| `kimi-k3.1-pro-highspeed` | 1,048,576 | 131,072 harness default / 1,048,576 context ceiling | $0.20 / $4.00 / $20.00 | `low`, `high`, `max` (`max`) |
| `kimi-k2.7-code` | 262,144 | 32,768 harness default / not published | $0.19 / $0.95 / $4.00 | provider-controlled |
| `kimi-k2.7-code-highspeed` | 262,144 | 32,768 harness default / not published | $0.38 / $1.90 / $8.00 | provider-controlled |
| `kimi-k2.6` | 262,144 | 32,768 harness default / not published | $0.16 / $0.95 / $4.00 | provider-controlled |

The authenticated global `/v1/models` catalog returned these six IDs on
2026-10-23. The official pricing table now lists both K3.1 variants, and AgenC
accounts for their input, output, cache hits and write tiers. K3 remains the
native default. OpenRouter has a separate catalog and endpoint policy; its
prices and ZDR eligibility are not inferred from the native Moonshot catalog.

All six models receive the normal AgenC function-tool catalog and vision
history. Requests above Moonshot's 128-tool limit fail locally rather than
silently clipping tools. K3 accepts `required`; K2.7 and K2.6 normalize that
unsupported mode to `auto`. Named function choices are incompatible with
thinking and are normalized for all six. Parallel-tool and fixed sampling
controls are omitted, and every model uses
`max_completion_tokens`.
The K2.x 64,000-token configurable ceiling is an AgenC safety guard, not a
published Moonshot model maximum.

K3, K3.1 Pro, and K2.7 always think; AgenC omits the optional `thinking` request field for
these models. K2.6 receives `thinking: { type: "enabled", keep: "all" }`. AgenC keeps
`reasoning_content` outside visible assistant text and replays every historical
block only to the exact same Kimi provider/model when the history is intact.
Authenticated compaction markers describe an already-authoritative projected
history and do not permanently disable replay. A boundary dropped during wire
normalization or orphan-tool repair still invalidates the whole replay set;
benign adjacent user-context merging does not. Kimi streams
fail closed on malformed JSON, missing/conflicting terminal reasons, or a
partial tool call not finalized with `finish_reason=tool_calls`.


Moonshot automatically caches repeated prefixes with a five-minute TTL. AgenC
keeps the stable system head before session-specific context and sends a stable
session `prompt_cache_key` on native Kimi. K3-family clients can select the
one-hour tier with `AGENC_KIMI_CACHE_TTL=1h`; `5m` is also accepted. Programmatic
callers can override this with `LLMChatOptions.promptCacheTtl`. K2 omits the
unsupported TTL control. No explicit cache objects or IDs are created.

Hits renew the original TTL without a new write charge. The first write locks
that TTL until expiration, even if a later request asks for a different one.
AgenC reads cached and written token subsets from usage, including streams, and
uses Moonshot's numeric write-tier headers to account for the actual TTL.
Five-minute writes cost the ordinary input rate; one-hour writes cost twice
that rate. Writes are not double-counted. See
[context caching](https://platform.kimi.ai/docs/guide/context-caching) and
[pricing](https://platform.kimi.ai/docs/pricing/chat).

An HTTP 429 with Moonshot's `exceeded_current_quota_error` and insufficient-balance
evidence stops as a billing refusal; ordinary throttling remains retryable.
Stop sequences are validated locally: at most five strings, each at most 32
UTF-8 bytes, as specified by the [Chat API](https://platform.kimi.ai/docs/api/chat).

Native Kimi retains the red retention badge. Moonshot's default policy retains
input while the account is active. Enterprise ZDR requires server-side approval;
no request flag enables it. OpenRouter uses its own endpoint eligibility and
`provider.zdr=true`. See the [privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy)
and [ZDR policy](https://platform.kimi.ai/docs/guide/zero-data-retention).

Multiple tool calls in a response are accepted and paired with their results;
the optional `parallel_tool_calls` control stays omitted for routing
compatibility. Response-local IDs are made unique by the shared wire logic
from #3220. Light uses Edit/Write for this family on both routes, including
the OpenRouter latest alias. OpenRouter reasoning is replayed using its own
`reasoning_details` or `reasoning` contract.

Vision input must be inline base64 or an already-uploaded `ms://` reference;
public HTTP image URLs and SVG are rejected before network dispatch. Supported
formats are JPG, PNG, WebP, GIF, BMP, HEIC, and HEIF, and the final request is
bounded to 100 MB. JSON Schema response format follows the family contract. Combining it with tools is enabled only for `kimi-k2.7-code`, whose
complete tool-call/result/final-JSON loop has been verified; the others
reject the combined request after live probes skipped tools or returned fenced
JSON. For those models, complete tool work first, then request the final schema
with `tools: []`. This split sequence passed for all six models. Kimi supplies no
native image-generation route, so `ImagineImage` continues to use a separately
authorized media backend. Sources: [model overview](https://platform.kimi.ai/docs/api/models-overview.md),
[thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models.md),
[vision models](https://platform.kimi.ai/docs/guide/use-kimi-vision-model.md),
[Chat Completions](https://platform.kimi.ai/docs/api/chat.md), and
[pricing](https://platform.kimi.ai/docs/pricing/chat).

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
`openai-compatible`, `groq`, `deepseek`, `meta`, `qwen`,
`qwen-token-plan`, and `cerebras`. Hosted providers
are probed only when `providers.<slug>.base_url` or that provider's endpoint
env is set.

Z.AI and Z.AI Coding Plan are deliberately not live-metadata providers: their curated GLM catalogs
supplies context and output limits even with a custom base URL. Provider health
checks still authenticate with `GET {base}/models`; a rejected or expired key
therefore does not appear usable, but that response never overrides the
curated limits.

Kimi likewise uses its curated native catalog for the limits documented above;
`GET /models` remains a credential-health check rather than model-metadata
authority.

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
| Local turn denied `context_window_exceeded` or the server refuses a short prompt | The live TUI shows the reason code and suggests `/compact`; it does not show the accounting values. Run `/context` for an estimate split into the base request, client tool catalog, and compact threshold. Confirm the model is pulled, the endpoint env matches the session host, and `/api/show` or `/v1/models` reports a positive integer window. If diagnostics resolve to 128000 and neither configuration nor selected-model metadata declares it, the OpenAI-compatible fallback may have been used. A configured output reserve can consume a large share of a small window, so inspect `providers.<slug>.max_output_tokens` too. The daemon TUI uses a less complete estimate; see [tui-workbench.md](tui-workbench.md#context-usage-context). |
| Streamed answer vanished; `AdmissionStepConflictError` / empty `lastAgentMessage` | Admission compares model ids case-insensitively and ignores path segments before the final slash. If the conflict remains, inspect the requested and reported execution identities and the other persisted step data. |
| `OLLAMA_BASE_URL` sessions still look at localhost for the window | Metadata used to ignore the env and probe the built-in default. Current code uses the same ingress alias as the provider factory. |
| Picker shows 128k, session later uses 32k | Picker is `resolveSync`. The admitted window comes from the async live probe at session start. |
| llama.cpp refuses just past 4096 on a 32k GGUF | Window is `meta.n_ctx` (what `-c` loaded), not `n_ctx_train`. |
| Hard USD cap holds every Ollama/LM Studio success as unpriced | Those three local slugs must resolve to the `localZeroCost` rows. A prefixed model id that was not stripped used to miss both the window and the free cost entry. |
| Compatible server 404s `/api/show` | Expected for non-Ollama runtimes. The probe is best-effort; a working `/v1/models` window is enough. |
| Empty LM Studio/openai-compatible or Gemini answer that is not `context_window_exceeded` | Check for a wire 400 (llama.cpp grammar, an unsupported Gemini schema feature, or an outdated custom Gemini proxy), `Gemini cannot preserve schema at <path>` for structured-output `oneOf` / `$ref` siblings, or the **8192** grammar-constrained-provider output ceiling. See [provider-tool-compat.md](../provider-tool-compat.md). |
| A later ChatGPT subscription request fails with `Unsupported parameter: previous_response_id` | Subscription requests are `store: false`. The continuation optimizer never attaches `previous_response_id` from an unstored response. The prompt-cache key is kept; the incremental delta is skipped. |
| ChatGPT / Responses refuses to continue after an interrupted tool turn | An unmatched `function_call` in history is closed with a synthetic `function_call_output` marked `interrupted`. The session stays usable; the model must not wait on that call id. |
| ChatGPT subscription 400s on `max_output_tokens` | Uncapped calls no longer require a provider-enforced output ceiling. Hard token or USD caps still demand a real ceiling and authoritative usage. |
| Turn ends with `Output recovery is exhausted` / `max_output_tokens_exhausted` | The turn used its three counted retries. Escalation does not count. Escalation to `min(64000, model upper limit)` runs only for a capped default with no explicit budget (`max_output_tokens`, `AGENC_MAX_OUTPUT_TOKENS` or `providers.<provider>.max_output_tokens`). Reasoning-only replies retry with a next-step instruction, not "continue from where you left off". On native DeepSeek, the call after a reasoning-only cap is sent with thinking disabled. If it returns a tool call or a final answer, `reasoningOnlyRecoveryCount` resets to 0, so only unproductive reasoning-only retries count. Empty DeepSeek tool-call reasoning is kept and sent back, so the next thinking-on call is accepted. On `lmstudio` and `openai-compatible`, a stop at the 8192 wire ceiling enters this same recovery, and escalation cannot raise it. Distinct from `context_window_exceeded`. See [max-output-tokens recovery](daemon.md#max-output-tokens-recovery). |

See [provider-aware token accounting](../design/provider-aware-token-accounting.md)
for how the resolved window is enforced. Grammar-safe schemas, the local
tool catalog, Qwen3 `/no_think`, and Gemini's function-declaration
and structured-output JSON Schema fields are
documented on that compatibility page.

## Responses history and continuation

OpenAI-compatible Responses backends treat an unmatched `function_call`
as unresolved session state. `closeDanglingFunctionCalls`
(`runtime/src/llm/wire/responses-openai.ts`) inserts a synthetic
`function_call_output` immediately after every unmatched call so history
always pairs. The output text is an interrupted marker, not a fake
success.

A `function_call` in history goes back with the item id (`fc_...`) the
provider issued for it, or with no `id` when this adapter has not seen
the call (for example after a restart). The id is never derived from the
call id: the OpenAI backend accepts such an id but serves the request on a
much slower decode path. Issued ids are kept in a bounded in-memory map
owned by each adapter and keyed by provider and call id
(`runtime/src/llm/wire/responses-function-call-ids.ts`).

The `openai` provider enables encrypted reasoning replay by default for
Responses reasoning calls, on both the platform API and ChatGPT sign-in.
It keeps each encrypted reasoning item with its assistant message and sends it
on later stateless requests to the same provider and model, right before the
function calls it led to, or before its text on a turn without tools. Stored
requests, non-reasoning models, reasoning effort `none`, and other providers
using this adapter keep their existing behavior. Switching provider or model
does not replay mismatched reasoning state.

An unset `reasoning_summary` requests `auto` while replay is enabled, except for
`gpt-6-luna` on the platform API: summaries stay off by default while encrypted
reasoning still replays. ChatGPT sign-in and other models keep their existing
automatic-summary default. Explicit summary choices are preserved, including
`auto` to request summaries on Luna; `none` disables summaries while encrypted
reasoning still replays. Set `AGENC_OPENAI_REASONING_REPLAY=0` to disable
retention and replay, or use `false`, `no` or `off`; see [env.md](env.md).
The switch is captured with each session, including ChatGPT sign-in sessions.
Replayed input counts against the task token budget and can increase usage.

`previous_response_id` can only reference a **stored** response. When
the request snapshot has `store: false` (ChatGPT subscription is always
stateless), the continuation optimizer keeps `prompt_cache_key` and
skips the incremental delta. Chaining an unstored id used to reject
every later request of a subscription conversation once tools or
history made it an extension.

### OpenAI prompt cache layout

A Responses request on the platform API puts the static head of the system
prompt in `instructions` and the session tail (workspace, memory directories,
permission section) in the first input item, ahead of the conversation. Each
request of a session therefore repeats the previous request byte for byte and
adds only new history, so GPT-5.6 and later, which write the cache up to the
last user message or tool output, read all of it back. When the tail changes
(another permission mode, reloaded project instructions), that request is
written to the cache again. The ChatGPT subscription backend rejects system
input items and keeps the tail in `instructions`.

GPT-5.6 and later use `prompt_cache_key` only to separate cache scopes: a
request reads nothing that a request with another key wrote. On the platform
API those models get one key per AgenC home: `agenc-` and 32 hex characters
of a random id generated once and kept in `<AgenC home>/prompt-cache-scope`
(mode 0600; regenerated only when missing or malformed). A new session then
reads the instructions, tools and tail that the previous session of the same
home wrote within the cache lifetime (at least 30 minutes), and separate homes
keep separate scopes. The id is not sent anywhere else. Older OpenAI models,
the ChatGPT subscription backend and every other provider keep the
conversation id as the key.

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
- standalone HTTP-client stream idle timeout: **unset** (0). During a session
  sampling attempt, the watchdog observes raw HTTP bytes before SSE parsing,
  including keepalive comments and partial frames. `stream_watchdog_timeout_ms`
  defaults to `1200000` (twenty minutes without bytes, then retryable
  `stream_idle` through the reconnect ladder). Set it or
  `AGENC_STREAM_IDLE_TIMEOUT_MS` to `0` to allow unbounded byte silence.
  Independently, `stream_quiet_warning_ms` / `AGENC_STREAM_QUIET_WARNING_MS`
  defaults to `600000`: ten minutes without a model delta emits a soft warning
  on the TUI status, without aborting. Zero disables that warning.

Model-provider streaming uses HTTP/SSE. The daemon, realtime connector, MCP,
and gateway have separate WebSocket transports; they are not provider
capabilities and are not described by the LLM provider registry.

Its retry behavior is:

- **429 is not retried** (`retry429: false`). 5xx and transport (network/timeout)
  are. Caller abort is not. One extra TLS-cert retry on attempt 0 only.
- A stream that ends before its terminal event (`response.completed` or
  `response.failed`) surfaces as `LLMStreamTruncatedError`, which the turn's
  reconnect ladder retries like `stream_idle`; the transport saw a clean end,
  so only the typed error identifies it.
- A transport fault that cuts a stream after text but before any tool call
  (undici's bare `terminated`, `ECONNRESET`, a 5xx mid-stream) is re-thrown
  instead of surfacing a partial response, so the same reconnect ladder
  samples again; nothing executed, and the text already streamed is discarded
  with the failed attempt. Once a tool call has streamed, the partial
  response is kept: the executor may have dispatched it. The Anthropic
  adapter applies the same rule.
- xAI answers "Response is too large to store" when a response exceeds its
  server-side storage limit. Stored responses are only the speed default
  (`AGENC_XAI_STORE`), so the grok provider sends the same request once more
  with `store: false` (warning `xai_store_too_large`) instead of failing the
  turn; a request that was already unstored is not retried. The refusal is
  latched for the session: every later request is unstored with full history
  (an unstored response cannot be continued). Under an admitted single wire
  attempt, where the adapter must not retry in band, it throws
  `LLMRequestRebuiltError`, which the turn's reconnect ladder treats as
  transient, so the next admitted attempt carries the unstored plan.
- **Retry-After > 300s** aborts the retry.
- Session backoff base is **200 ms**.
- After budget admission, model calls set `singleWireAttempt: true`: **no HTTP
  retry** on that lease. A retry needs a new reservation.

Request deadlines and caller cancellation stay active through JSON, text,
and non-2xx body consumption. A body-read failure after a successful HTTP
status does not trigger a transport retry. An aborted or timed-out error body
is not retried either.
Body failures cancel the reader without waiting for a stalled cancellation
callback. Completed reads release the reader, timers and abort listeners.
Successful streams keep their separate streaming lifecycle and idle watchdog.

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

### Think tags and provider reasoning fields

Reasoning models disagree about where chain-of-thought goes.

| Source | What AgenC does |
| --- | --- |
| Streaming `delta.reasoning_content` | Emits hidden thinking events and stays out of visible assistant text. |
| Non-streaming `message.reasoning_content` | Becomes visible assistant content only when `message.content` is absent, null, or otherwise not text/content blocks. A string `content`, including an empty string, takes precedence. |
| Cerebras `delta.reasoning` / `message.reasoning` | Emits/stores hidden thinking separately from `content`; opaque state is replayed as `reasoning` only to the exact same Cerebras model. |
| Z.AI `delta.reasoning_content` / `message.reasoning_content` | Emits/stores hidden thinking separately from `content`; all blocks are replayed in order only for a complete, immediately adjacent multi-round tool chain on the exact same Z.AI model. Other turns clear the whole stale chain. |
| Kimi `delta.reasoning_content` / `message.reasoning_content` | Emits/stores hidden thinking separately from `content`; intact historical blocks are replayed in order only to the exact same native Kimi model, and any compaction/boundary repair clears the complete replay set. |
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
| `reasoning_effort` | OpenAI reasoning-family slugs (`gpt-5`, `o1`, `o3`, `o4`, `codex`, `chatgpt-5`). Grok 4.3 / 4.5 / 4.6, `grok-4-20-multi-agent` / `grok-4.20-multi-agent`, and `grok-build-latest`. Meta Muse Spark models for `minimal`, `low`, `medium`, `high`, and `xhigh`, plus `max` on standard-tier `muse-spark-1.3` (Muse Wonder uses the Responses wire). Z.AI GLM-5.3 models and native Kimi K3 for `low`, `high`, and `max` only. Cerebras `gpt-oss-120b` for `low`, `medium`, `high`; Cerebras `qwen-3.8-27b` and `gemma-4-31b` for `none`, `low`, `medium`, `high`. NVIDIA NIM families below, and only values in that family's enum. Everyone else: stripped. `/effort` on a local model is a no-op on the wire. |
| `tool_choice` | Meta and Z.AI accept only `auto`. `required` and named choices are normalized to `auto`; `none` omits both the tools and choice fields. Native Kimi K3 additionally accepts `required`; Kimi K2.7/K2.6 normalize it to `auto`, and all native Kimi models normalize named choices because they are incompatible with thinking. Requests above the Z.AI or Kimi 128-function limit fail locally rather than dropping tools. Cerebras omits tool-choice/parallel controls whenever no tool definitions are attached, as required by API v2. Other compatible providers keep the requested value. |
| `stop` | Meta rejects stop sequences, so its adapter strips them. Z.AI receives only the first sequence from a caller list. Other compatible providers keep caller-supplied sequences. |
| `service_tier` | `openai` and `azure-openai`; explicit Cerebras pass-through remains for configured dedicated endpoints, while its shared catalog advertises no selectable tier |
| `stream_options.include_usage` | Default **on**. Z.AI omits this undocumented control. `STREAM_USAGE_INCOMPATIBLE_PROVIDERS` is otherwise empty, and no operator or per-instance override is wired. |

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
  `DEFAULT_MAX_OUTPUT_TOKENS` (**32_000**); Meta, QwenCloud, Cerebras, and Kimi also
  use `max_completion_tokens`, while Z.AI explicitly uses `max_tokens`. This ceiling applies only to the two
  grammar-constrained slugs.
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

- Tool / provider compatibility (object root, grammar-safe schemas, Gemini native JSON Schema, local catalog): [`../provider-tool-compat.md`](../provider-tool-compat.md)
- Token admission invariant: [`../design/provider-aware-token-accounting.md`](../design/provider-aware-token-accounting.md)
- OpenRouter setup: [`../managed-openrouter.md`](../managed-openrouter.md)
- Onboarding: `agenc onboard`

## Fast mode and service tiers

`service_tier = "priority"` (config, profile, or the desktop Speed row) is the
single "Fast" dial. What it does depends on the provider:

| Provider | Wire | Models | Price | Notes |
| --- | --- | --- | --- | --- |
| OpenAI | `service_tier: "priority"` on chat completions and Responses (OpenAI also accepts `"fast"`, its new name for the same tier) | GPT-6.1 Sol/Terra, GPT-6 Astra/Sol/Luna, GPT-5.6 Sol/Terra/Luna, GPT-5.5, 5.4, 5.4 Mini, 5.3 Codex, 5.2, 5, plus the GPT-4.1/4o/o3/o4-mini rows on the pricing page | 2x standard on GPT-5.6 and later; see the pricing page per model | The response reports the served tier; requests over the fast-mode rate limit fall back per OpenAI's rules. |
| Anthropic | `speed: "fast"` plus the `anthropic-beta: fast-mode-2026-02-01` header | Claude Opus 5.5, Claude Opus 5, Claude Opus 4.8 only | 2x standard: $8 input / $40 output per MTok on Opus 5.5, $10 / $50 on Opus 5 and 4.8 | Research preview: the organization needs access from Anthropic; without it the API returns an error. `usage.speed` reports `fast` or `standard`; AgenC warns when a request asked for fast and was served standard. Switching speeds invalidates the prompt cache. Not sent to other Claude models, which reject the field. |
| xAI Grok | `service_tier: "priority"` on the Responses API, the only xAI wire AgenC uses (xAI documents the same field on Chat Completions) | Grok 4.7 and Grok 4.6 | 2x standard on every token type, cache discount first: $4 input / $1 cached input / $12 output per MTok below 200K prompt tokens | Priority processing: higher scheduling priority, not a faster model. API-key billing only: a session signed in with X (`/grok-login`) never sends it, because xAI does not document priority for the sign-in grant; set `GROK_AUTH_MODE=api-key` to use Fast while signed in. The response `service_tier` reports `priority` or `default`, and only `priority` bills the higher rates. This is not the Grok 4.7 Fast model, which xAI serves only in Cursor and Grok Build. |
| Cerebras, Azure OpenAI | `service_tier` passthrough | per provider | per provider | Documented `service_tier` support; other chat-completions providers have the field stripped. |

`flex` is OpenAI's lower-priority tier and is only sent to providers that
document `service_tier`.

OpenAI cost follows the tier the response reports it served (`priority` or
`fast` is Fast, `default` a downgraded Fast request), the long-context rates
when one request's input passes 272K tokens, and cache writes (1.25x input on
GPT-5.6 and later). Under a hard USD cap a Fast request is reserved at Fast
rates, a reservation that could pass 272K input is priced at the long-context
rates, and a call without Fast sends `service_tier: "default"` so a
project-level Fast default cannot apply. A Fast request on a model or context
length with no published Fast price (Pro and nano models, GPT-5.5 and 5.4
above 272K) is refused under a hard USD cap with
`unpriced_service_tier_under_hard_cap`.

xAI cost also follows the tier the response reports: `priority` bills every
token rate at 2x, and `default` (the request ran at the default tier) bills
standard. Server-side tool calls such as web search keep their own rate.
AgenC's Grok prices do not model xAI's long-context rates for prompts of 200K
tokens or more, on either tier. Under a hard USD cap a priority request is
reserved at the priority rates. xAI documents an omitted `service_tier` as
its default tier, so a call without Fast sends none.

## Zero data retention

Zero data retention (ZDR) is on by default wherever a provider's API lets a
request ask for it. Only OpenRouter has such a control: every request with
your own OpenRouter key carries `provider.zdr = true`, so OpenRouter routes
only to endpoints with a zero-data-retention policy (OR-ed with the account
setting on OpenRouter's side) and refuses a model that has none instead of
serving it elsewhere. To allow endpoints that may keep data:

```toml
[providers.openrouter]
zero_data_retention = false
```

The managed AgenC route sends no routing block: its gateway pins its own
(`zdr: true`, `data_collection: "deny"`). Subagents, reviewers and the
WebSearch tool's OpenRouter search carry the same choice as the session.
OpenRouter's ZDR covers the model endpoint, not the web plugin's search
engine.

`/model` and `/providers` read OpenRouter's public list of ZDR endpoints
(`GET https://openrouter.ai/api/v1/endpoints/zdr`, no key) while ZDR is on.
A model with no ZDR endpoint stays listed, shows `no ZDR`, and says how to
use it anyway; Enter refuses it, and so does `/model openrouter:<id>` once the
list has been read. Router and alias
ids (`openrouter/auto`, `~vendor/model-latest`) are not checked, and nothing is
marked while the list cannot be read. If OpenRouter still refuses a model
(HTTP 404, "No endpoints found matching your data policy"), the turn ends with
that explanation, no retry, and its admission reservation released at zero.

Measured 2026-10-22 on OpenRouter with the request body AgenC sends (three
calls of 33K to 49K prompt tokens per model, ZDR on and off): Claude Sonnet
5.5 moved from Claude Platform on AWS to Google Vertex at the same price;
DeepSeek V4.1 Flash and GLM-5.3 stayed on the same ZDR endpoints (Relace,
InferenceNet) with the same cost and a 100% cache share on later calls. ZDR
cost nothing measurable in cache share, price or first-token time.

Elsewhere retention is a provider policy or an account, project or team
setting, so the config field is rejected under every other provider table.
Read on 2026-10-22 from each provider's documentation:

| Provider | What happens to API prompts and responses | ZDR | Status line |
| --- | --- | --- | --- |
| OpenRouter | Depends on the endpoint; OpenRouter keeps prompts only if the account turned on prompt logging | Per request (`provider.zdr`), on by default | Green; red when off or the model has no ZDR endpoint ([zdr](https://openrouter.ai/docs/guides/features/zdr), [routing](https://openrouter.ai/docs/guides/routing/provider-selection)) |
| Ollama Cloud | Not stored or logged | Policy | Green ([faq](https://docs.ollama.com/faq)) |
| Cerebras | Not retained | Policy | Green ([privacy](https://cerebras.ai/privacy-policy)) |
| abliteration.ai | Processed in memory, never stored | Policy | Green ([data handling](https://abliteration.ai/data-handling)) |
| AgenC (managed) | Routed only to ZDR endpoints by the gateway | Built in | Green |
| Venice AI | Private models keep nothing; anonymized models run on third-party hosts | Per model | Green for private models, red for anonymized ([privacy](https://docs.venice.ai/overview/privacy)) |
| Ollama, LM Studio | Stays on this computer | Local | Green on a loopback address, dim `ZDR?` elsewhere |
| OpenAI-compatible | Depends on the server, which may be a proxy to a cloud API | Unknown | Dim `ZDR?` |
| xAI Grok | Kept 30 days for abuse auditing | Team setting in the xAI Console | Red ([security](https://docs.x.ai/developers/faq/security)) |
| OpenAI | Abuse logs up to 30 days | Approved organization or project; AgenC sends `store: false` | Red ([your data](https://developers.openai.com/api/docs/guides/your-data)) |
| Anthropic | Up to 30 days, flagged content longer | Organization agreement | Red ([retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)) |
| Groq | Not kept by default, but may be logged up to 30 days for troubleshooting or abuse | Console Data Controls | Red ([your data](https://console.groq.com/docs/your-data)) |
| Mistral | 30 days for abuse monitoring | On request | Red ([zdr](https://docs.mistral.ai/admin/monitor-comply/zero-data-retention)) |
| Meta | Kept as needed for the service | Per organization; AgenC sends `store: false` | Red ([zdr](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention)) |
| QwenCloud Pay-As-You-Go | Up to 30 days | Enterprise workspaces | Red ([retention](https://www.alibabacloud.com/help/en/model-studio/data-retention-policy)) |
| QwenCloud Token Plan | Up to 30 days | Not covered by the ZDR program | Red ([faq](https://www.alibabacloud.com/help/en/model-studio/token-plan-faq)) |
| Kimi (Moonshot) | Kept while the account is active | Enterprise, on request | Red ([zdr](https://platform.kimi.ai/docs/guide/zero-data-retention)) |
| Amazon Bedrock | May be kept for abuse detection | Account `data_retention_mode: none` | Red ([retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)) |
| GitHub Copilot | Upstream models under ZDR; individual plans may train on interactions | Plan setting | Red ([hosting](https://docs.github.com/en/copilot/reference/ai-models/model-hosting)) |
| Gemini API | Logged for abuse monitoring; the free tier trains on prompts | Only on Vertex AI; AgenC sends `store: false` | Red ([zdr](https://ai.google.dev/gemini-api/docs/zdr)) |
| Z.AI, Z.AI Coding Plan | No-storage promise covers business customers; cache retention unannounced | None for individuals | Red ([privacy](https://docs.z.ai/legal-agreement/privacy-policy), [faq](https://docs.z.ai/help/faq)) |
| DeepSeek | Kept while the account exists | None | Red ([privacy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)) |
| MiniMax | Kept as long as necessary | None | Red ([privacy](https://platform.minimax.io/protocol/privacy-policy)) |
| NVIDIA NIM | Trial terms let NVIDIA keep and use prompts | None | Red ([trial terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)) |

The status line shows `ZDR` after the usage figures: green when the provider
and model keep nothing (the request-level control is on, the provider's policy
keeps nothing, or Ollama or LM Studio runs on this computer), red when data may be kept
(including providers whose ZDR is an account setting AgenC cannot see), and a
dim `ZDR?` when the requests go to an address whose policy AgenC cannot know:
an OpenAI-compatible server (even on this computer, since it may forward to a
cloud API), a local provider pointed at another machine, or a provider that
would otherwise be green pointed at a custom base URL. `/status` explains the
current state in one line. The table lives in
`runtime/src/llm/registry/provider-retention.ts`.

xAI's Responses `store` stays on by default: xAI keeps every request for 30
days whether or not it is stored, so `store: false` would not change
retention, and it was the dominant cause of slow Grok turns (see the Grok
adapter). `AGENC_XAI_STORE=0` turns it off.

## DeepSeek

Select `deepseek` and provide `DEEPSEEK_API_KEY`. The default model is
`deepseek-flash`; since 2026-10-17 DeepSeek serves DeepSeek-V4.1-Flash-1017
under that id, so no setting changes. It has a 1M-token context, image input,
Low/High/Max effort (High by default) and up to 384K output tokens; AgenC asks
for 64K per call by default. The retired names `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` still reach the same model. `deepseek-v4-pro`
serves DeepSeek-V4-Pro-0813.

Cost estimates use DeepSeek's peak rates: Flash $0.30 per million input tokens,
$1.20 per million output tokens and $0.006 per million cached input tokens.
DeepSeek charges half outside 01:00 to 04:00 and 06:00 to 10:00 UTC on
weekdays, so real bills can be lower than the estimate.

On OpenRouter the new model has its own id, `deepseek/deepseek-v4.1-flash-1017`;
`deepseek/deepseek-v4.1-flash` stays on the September build.

### The same model through a gateway

A DeepSeek or GPT model reached through OpenRouter, Ollama Cloud or Venice by its
id (`deepseek/deepseek-v4.1-flash-1017`, `deepseek-v4.1-flash:1017`,
`deepseek-v4-1-flash-1017`; `openai/gpt-6-luna`, `openai-gpt-6-luna`) gets the
behavior AgenC tunes for that model on its own API, where the gateway has an
equivalent field:

- DeepSeek: Light's task limits and batch Edit, the shared-prefix prompt layout,
  64k output tokens a call (the route's limit stays the ceiling), High effort
  when none is set (unless the route offers None), reasoning replayed on later
  requests, and no `parallel_tool_calls` field.
- GPT: Light's apply_patch, the lean head in standard mode, parallel tool
  calls, the personality line, and the encrypted reasoning
  (`reasoning_details`) replayed unchanged.
- OpenRouter: a DeepSeek model's requests carry a `prompt_cache_key` that
  names the model and the leading system message. Once a host returns a cache
  hit for that key, OpenRouter keeps later requests with it, from any session,
  on that host, as DeepSeek's own API shares one cache across sessions. A GPT
  model carries the session's own key, as on OpenAI's own API. No `session_id`
  is sent: with one, OpenRouter keeps a session on whichever host served its
  first request, whether that host caches well or not. Reasoning is read from
  `reasoning`. Costs are the charge OpenRouter reports. Which host serves the
  first request is still OpenRouter's choice: by default it load-balances by
  price among the hosts the account allows, and account privacy settings can
  exclude the model author's own endpoint.

The managed AgenC route and custom OpenAI-compatible endpoints keep their own
contracts.

In a `deepseek` session on DeepSeek's own API host, the WebSearch tool searches
through DeepSeek's Search API with the session's key, for both models, at
$0.75 per 1,000 successful searches; see
[Direct DeepSeek](../providers/deepseek-direct.md#web-search) for the setting
and the fallback.

Sources: https://api-docs.deepseek.com/quick_start/pricing/,
https://api-docs.deepseek.com/news/news261017 and
https://api-docs.deepseek.com/guides/search

## Ollama Cloud

Select `ollama-cloud` and provide `OLLAMA_API_KEY` for direct hosted inference at
`https://ollama.com/v1`. The existing `ollama` provider remains a local daemon
connection; `OLLAMA_BASE_URL` never reroutes the Cloud key. No local Ollama
installation is required.

The checked-in Cloud metadata comes from Ollama's `/api/tags` and `/api/show`
on 2026-10-20, rechecked on 2026-10-21. Runtime discovery refreshes IDs from
`/api/tags` and capabilities from `/api/show`. Unknown additions can use text/tools and native context
metadata, but do not inherit unverified image or effort settings from another
provider. Cloud model IDs retain their tags (for example `gpt-oss:120b`).

DeepSeek models default to High, as on DeepSeek's own API, and V4.1 Flash
supports image input. Reasoning controls are model specific; binary thinking
models expose None/High, GPT OSS uses Low/Medium/High, and non-thinking models
have no effort control. DeepSeek models reserve 64k output tokens a call with
DeepSeek's own 393,216 ceiling (Cloud refuses more); for other models the 16k
default and 32k recovery budget are AgenC output budgets, not advertised Cloud
limits. Cloud quota and model availability depend on the Ollama account.

An Ollama Cloud session uses its own key for `web_fetch` through Ollama's
`/api/web_fetch` API. Successful fetches cost $0.001 each (balance-verified
2026-10-21). URL permission checks and private-address rejection still apply.
A provider failure falls back to guarded direct fetching and is named in the
result. Ollama returns page text, title and links; it does not report the
origin HTTP status or the final redirected URL.

Sources: https://docs.ollama.com/cloud and
https://docs.ollama.com/api/openai-compatibility.

Claude Haiku 5.5 is selectable as `claude-haiku-5-5` on Anthropic, with 1M
context, 128K maximum output, adaptive thinking and medium default effort.
It supports low, medium, high, xhigh and max. Fast mode and Priority Tier are
not supported. Prices depend on total prompt length: $0.10/$0.50 per million
input/output tokens through 100,000 prompt tokens, and $0.50/$2.50 above that.
Haiku 4.5 remains selectable; no provider default changes.

Haiku 5.5 support in this release is limited to the direct Anthropic API.
Bedrock routing and registration are deferred to a follow-up; its provider
implementation remains unchanged. OpenRouter, Google Cloud and Foundry
registration are also outside this release. See the
[Anthropic model reference](anthropic-models.md) for cache prices, thinking,
tokenizer and migration details.


## Venice AI

Select `venice` with `agenc --provider venice` or `/provider venice`.
Use `VENICE_API_KEY` or save a key in the `/providers` screen. Venice has its
own BYOK credential record. It never reads `OPENAI_COMPATIBLE_API_KEY` or
`OPENAI_API_KEY`. `agenc providers` reports missing or present credentials.

Venice uses streaming OpenAI-compatible Chat Completions at
`https://api.venice.ai/api/v1`. Every request sets
`venice_parameters.include_venice_system_prompt = false`,
`enable_web_search = "off"`, `enable_web_scraping = false`,
`enable_web_citations = false`, and `enable_x_search = false`.
AgenC supplies the system prompt and tools. Reasoning arrives separately in
`reasoning_content` and stays out of the visible answer; a GPT model's
encrypted reasoning arrives in `reasoning_details` and goes back unchanged on
the next request. Every request carries a `prompt_cache_key`, which Venice uses
to route to a server holding the cached prefix: for a DeepSeek model it names
the model and the leading system message (sessions share the prefix, as on
DeepSeek's own API), for other models it is the session's own key.

Authenticated `GET /models` discovery offers online text models with
`model_spec.capabilities.supportsFunctionCalling = true`. It uses
`availableContextTokens` and `maxCompletionTokens` for limits, and maps
reasoning, supported effort levels, vision, and USD pricing per million
tokens. Core stores rates per thousand tokens.

Sessions in the same process reuse a successful list for ten minutes, scoped
to the endpoint, credential and transport. Expired lists refresh in the
background; failed or malformed refreshes keep the last known limits and
retry later. They do not reset a known context window to the conservative
fallback. The TUI loads live effort data when a gateway model is selected,
so its status line does not depend on opening `/effort` first.


Each model's price comes from that list: `input`, `output`, `cache_input`, and
the `extended` rates above `context_token_threshold` input tokens. Budget
admission reserves at it. A completed call costs what Venice reports with the
reply (`cost`, USD plus DIEM credit, which Venice prices 1:1), and the cost
sidecar and the status line show that charge. Chat Completions reports no cache
writes, so the `cache_write` price is not used for estimates. A Venice model ID
never takes another provider's price for the same name. When the list gives a model no price, admission reserves the
conservative ceiling and the status line says `price unknown`.

The `/providers` and `/model` screens read this list with the key the session
uses: `VENICE_API_KEY`, a key just entered in the screen, or the saved key.
They read it again after a key is saved or replaced. When the list cannot be
read, they show a small bundled catalog and say so. Any ID from the live list
can be selected, in the screens, with `/model venice:<id>`, or with
`--model venice:<id>`. An ID that Venice does not list is refused before the
first request.

The `function_calling_default` trait selects the discovered provider default.
The offline fallback is `zai-org-glm-5-2`. Explicit model selections and
`providers.venice.default_model` stay pinned. To pin a selection:

```toml
model_provider = "venice"
model = "zai-org-glm-5-2"
```

Venice documents `model_spec.privacy = "private"` as zero data retention
infrastructure. Core sets the model's `zeroDataRetention` fact only for that
value. `anonymized` hides the caller's identity but leaves retention unknown.
This is model metadata, not an extra request routing preference.

HTTP 401 maps to authentication failure. HTTP 429 maps to rate limiting.
Venice sends `x-ratelimit-reset-requests` and `x-ratelimit-reset-tokens` as
Unix timestamps in milliseconds and no `Retry-After` header. The adapter waits
for the reset of the window that is used up (`x-ratelimit-remaining-* = 0`),
or for the later reset when neither is, and respects a standard `Retry-After`
header when Venice sends one. Seconds-precision timestamps and plain delays
are read too.

Sources: [Chat Completions](https://docs.venice.ai/api-reference/endpoint/chat/completions),
[models](https://docs.venice.ai/api-reference/endpoint/models/list),
[pricing](https://docs.venice.ai/overview/pricing),
[reasoning](https://docs.venice.ai/guides/features/reasoning-models),
[privacy](https://docs.venice.ai/overview/privacy),
[errors](https://docs.venice.ai/api-reference/error-codes), and
[rate limits](https://docs.venice.ai/api-reference/rate-limiting).


## abliteration.ai

Select `abliteration` with `agenc --provider abliteration` or
`/provider abliteration`. Set `ABLIT_KEY`, the name abliteration.ai documents,
or `ABLITERATION_API_KEY`, or save a key in the `/providers` screen. When both
variables are set, `ABLIT_KEY` wins. Keys look like `ak_...`. abliteration.ai
has its own BYOK credential record and never reads another provider's key.
`ABLITERATION_BASE_URL` replaces the default endpoint,
`https://api.abliteration.ai/v1`. `agenc providers` and first-run setup list
the provider with its key names.

AgenC uses streaming OpenAI-compatible Chat Completions with its own system
prompt and tools. The Responses and Anthropic Messages surfaces are not used.

| Model | Context | Max output | Input | Reasoning modes in `/effort` | AgenC default | Price per 1M tokens (input, cached input, output) |
| --- | --- | --- | --- | --- | --- | --- |
| `abliterated-model-large-v2` (default) | 1,000,000 | 999,990 | text | low, high, max | high | $3.00, $0.30, $5.00 |
| `abliterated-model` | 262,144 | 262,134 | text, image | off, minimal, low, medium, high, xhigh, max | none sent (native depth) | $1.00, $0.10, $3.00 |
| `abliterated-model-large` | 1,000,000 | 999,990 | text | high, max | high | $3.00, $0.30, $5.00 |
| `abliterated-model-large-flash` | 1,048,576 | 262,144 | text, image | off, low, high, max | high | $1.00, $0.10, $2.00 |

All four models reason, stream and call tools, including parallel calls.
AgenC reserves 65,536 output tokens a call for the existing models and 64,000
for Large Flash through its DeepSeek family behavior. Reasoning and the answer
share `max_tokens`. The documented maximum stays available to an explicit
`max_output_tokens` and to max-output recovery.

Large Flash is based on DeepSeek-V4.1-Flash-1017. In Light, it uses DeepSeek's
batch Edit and task limits. Requests keep abliteration's session cache header
and `prompt_cache_key`. Both `/model` and `/providers` list the model.

The ZDR badge uses abliteration's existing provider policy for all four models.
The provider states that it retains no prompt, completion or image content and
does not use that content for training. Operational and billing metadata are
retained. See [data handling](https://abliteration.ai/data-handling).

### Reasoning effort

Chat Completions takes `reasoning_effort` with any of `none`, `minimal`,
`low`, `medium`, `high`, `xhigh` and `max` on every model, and runs it at one
of the modes the model has:

| Requested | `abliterated-model` | `abliterated-model-large-v2` | `abliterated-model-large` | `abliterated-model-large-flash` |
| --- | --- | --- | --- | --- |
| `none` | reasoning off | low, trace hidden | reasoning off | reasoning off |
| `minimal` | minimal | low | high | low |
| `low` | low | low | high | low |
| `medium` | medium | high | high | high |
| `high` | high | high | high | high |
| `xhigh` | xhigh | max | max | high |
| `max` | max | max | max | max |
| nothing sent | native depth | max | high | high |

`/effort` lists only the modes a model runs, and AgenC sends only those. A
saved level the model does not list runs at the model's AgenC default; `xhigh`
and `max` stand in for each other. `/effort off` is offered on
`abliterated-model` and `abliterated-model-large-flash`. Large v2 cannot turn
reasoning off.

The provider runs Large v2 at max when a request names no level. AgenC sends
high instead. Reasoning tokens bill as output at $5 per million, and every
tool step of an agent turn pays them again. They also delay the first visible
token. High is the middle of the three modes. Choose max with `/effort max`
for the hardest tasks.

The reasoning trace is shown as thinking and never as the answer. The live
API sends it as `reasoning`; the docs name it `reasoning_content`, and AgenC
reads either. It is not sent back on later requests.

### Prompt caching

Caching is automatic. Each request carries the session's `prompt_cache_key`,
a stable opaque value per session, in the body and again in the
`x-abliteration-session-id` header, so related requests reach a server that
holds the cached prefix. With both present, abliteration.ai routes by the
header. Streamed requests set `stream_options.include_usage`,
and the final chunk reports `usage.prompt_tokens_details.cached_tokens`. Cache
reads bill at 10% of the input rate, with no cache-write premium. The session
cost and the status line cache share use these counts. Cache hits are best
effort: in a live session on 2026-10-22, a later Large v2 request read 1,344
of its 1,452 prompt tokens from cache, while the request right after the
session's first one missed. The cache belongs to the project and model, so a
new session can read a prefix an earlier one wrote.

### Images

`abliterated-model` and `abliterated-model-large-flash` take images.
Large and Large v2 answer 400 to image content, so AgenC refuses an image
before sending it to them. An image a tool returns, such as a screenshot or
an image file read, reaches a vision model as a user image after the tool results.

### Model list

With a key, AgenC reads `GET /v1/models` before a session's first request and
reuses the list for ten minutes. It keeps the models that are available to the
key's project, not locked, ready, produce text and list `tools`. Their limits,
image input and prices replace the bundled rows. A model the list leaves out
is refused before the request, with a message that names it. The bundled rows
answer when the list cannot be read. The list publishes no effort levels, so a
model only the live list has runs without an effort control.

### Errors

- 401 is an authentication failure. 402, insufficient credits, is a billing
  error.
- 429 is rate limiting, and `Retry-After` is honored. The Free tier allows 4
  concurrent requests and 60 a minute per key.
- 403 `policy_violation` means a project policy blocked the request, or the
  same code ended a streamed reply. The turn ends with a message that says so
  and names the request ID. It is not retried, since the same input is blocked
  again.
- 503 `policy_evaluation_unavailable` means a blocking policy could not be
  evaluated in time. It is retried like other server errors.

Web search, structured outputs, `policy_ids` and `GET /v1/credits` are not
used.

Sources: [models](https://docs.abliteration.ai/models),
[pricing](https://docs.abliteration.ai/pricing),
[thinking and reasoning effort](https://docs.abliteration.ai/capabilities/thinking),
[prompt caching](https://docs.abliteration.ai/capabilities/prompt-caching),
[tool calling](https://docs.abliteration.ai/capabilities/tool-calling/openai-chat-completions),
[images](https://docs.abliteration.ai/capabilities/images),
[errors](https://docs.abliteration.ai/api/errors), and
[rate limits](https://docs.abliteration.ai/api/rate-limits).
