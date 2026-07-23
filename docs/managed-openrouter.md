# Managed OpenRouter models

AgenC can route model traffic through hosted OpenRouter credentials so you do
not need a local provider API key. The CLI signs in through the remote auth
backend, asks `id.agenc.ag` for a short-lived managed credential, and sends
requests to the AgenC LiteLLM/OpenRouter gateway.

Related: [onboarding](onboarding.md) · [quickstart](quickstart.md) ·
[install](install.md).

## Defaults (0.9.0)

| Setting | Value |
|---|---|
| `auth.backend` | `remote` (default) |
| `auth.managedKeys.enabled` | **`true`** (default) |
| Default paid managed model | `openrouter` / `x-ai/grok-4.5` |
| Free-tier managed routes | OpenRouter `:free` models (see below) |
| **Managed OpenRouter default max output** | **`2_048`** (`MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS` in `session.ts` / `bootstrap.ts`) |
| Generic openai-compatible catalog default | `32_000` (`DEFAULT_MAX_OUTPUT_TOKENS`) — **not** the managed path |
| Generic upper limit | `64_000` |
| Generic capped default flag | `8_000` when `capped_default_max_output_tokens` is set |

Managed chat **does** apply a **2048** default/ceiling when no explicit
`max_output_tokens` / `AGENC_MAX_OUTPUT_TOKENS` is set. That hard-cap is
separate from the generic 32k/64k openai-compatible metadata defaults used
for non-managed routes.

**BYOK always wins.** If `OPENROUTER_API_KEY` or a provider-config API key is
present, those credentials are used instead of the subscription-managed route.

Disable managed vending in config when you want pure BYOK:

```toml
[auth.managedKeys]
enabled = false
```

## Runtime flow

1. `agenc login` (or `/login`) stores the remote auth token under
   `AGENC_HOME` (`auth.json` / session state).
2. With `auth.managedKeys.enabled` (default true), entitled sessions can
   request a short-lived managed OpenRouter credential from the auth backend.
3. Free-tier accounts may use the **hosted free OpenRouter routes** only
   (models listed in `runtime/src/llm/registry/openrouter-free-models.ts`).
   Paid tiers (`pro` / `team` / `enterprise`) see the full hosted OpenRouter
   list, defaulting to `x-ai/grok-4.5`.
4. `/provider` prioritizes OpenRouter for managed sessions; `/model` opens on
   the hosted list for that tier.
5. `/usage` reads hosted allowance, spend, remaining included usage, and reset
   time from the auth backend.
6. The backend vends a LiteLLM key for the session. The local CLI keeps it in
   provider memory only — it is **not** written as a durable provider API key.
7. Requests go to the managed gateway with the model normalized as
   `openrouter/<provider>/<model>`.

## Free hosted models

Free subscription accounts can use managed OpenRouter models whose IDs end in
`:free` (plus the `openrouter/free` router). Examples from the current registry
include routes such as:

- `cohere/north-mini-code:free`
- `google/gemma-4-31b-it:free`
- `openai/gpt-oss-20b:free` / `openai/gpt-oss-120b:free`
- `qwen/qwen3-coder:free`
- `meta-llama/llama-3.3-70b-instruct:free`
- `openrouter/free` (hidden from some picker UIs; still a free route)

These free pools are rate-limited and change over time — treat the live
`/model` list after login as authoritative. Free routes are intended for
evaluation and light use, not as a substitute for a paid tier or BYOK when you
need capacity guarantees.

Paid managed catalog (non-exhaustive) includes `x-ai/grok-4.5` (paid default),
`x-ai/grok-4.3`, `x-ai/grok-build-0.1`, and common OpenRouter IDs for
OpenAI/Anthropic/Google/DeepSeek/Qwen/Mistral/Meta/etc. Full list:
`runtime/src/commands/subscription-managed-models.ts`.

## TUI behavior

After a successful `/login`:

- If the session was still on the default `grok` provider, login can switch to
  managed `openrouter / x-ai/grok-4.5` (paid) or the tier's first free model
  (free) and point you at `/model` for the rest of the hosted list.
- If you intentionally configured another provider, login keeps that provider
  and notes that `/provider openrouter` is available.
- `/provider` and `/model` prioritize hosted OpenRouter for managed sessions
  while still showing BYOK and local routes when configured.

## Output tokens

| Source | Effect |
|---|---|
| Explicit `max_output_tokens` / `AGENC_MAX_OUTPUT_TOKENS` | Wins (still bounded by model upper limit) |
| Managed OpenRouter with no explicit max | **Default and ceiling `2_048`** |
| Non-managed openai-compatible metadata | **32_000** default, **64_000** upper; optional **8_000** capped default |

Raise managed output size with an explicit max when the 2048 default is too
small for the task (and the hosted allowance can reserve it).

## Budget and error messages

OpenRouter can reject managed requests when the workspace/key is out of
credits, the monthly key budget is too low, or the request reserves more
output than remaining allowance. The CLI must not show raw upstream JSON,
OpenRouter key URLs, or provider account identifiers. Users see a short
message: try a smaller response/model, or top up the hosted allowance.

When debugging production, check in order:

1. User session is active on the backend; tier matches expected free/paid set.
2. `auth.managedKeys.enabled` is true (default) unless intentionally off.
3. No BYOK OpenRouter key is shadowing the managed route if you expected
   hosted billing.
4. `/v1/auth/llm-credential` returns a managed OpenRouter credential.
5. `/v1/auth/llm-usage` can read spend for `/usage`.
6. LiteLLM allowlist includes the selected `openrouter/...` model.
7. OpenRouter workspace has credits / free-pool capacity.
8. Request `max_tokens` matches intent: managed default is **2048** unless
   you set an explicit max; generic 32k/8k paths are for non-managed routes.


## Grok server tools and Imagine on OpenRouter (honesty matrix)

Managed OpenRouter `x-ai/grok-*` routes **do not** receive AgenC's direct xAI
server-tool payloads (`web_search`, `x_search`, `code_interpreter`, collections
`file_search`, remote `mcp`) or Imagine REST. Those surfaces require provider
slug **`grok`** with a direct `api.x.ai` base URL and BYOK (`XAI_API_KEY` /
aliases) or `/grok-login` for chat.

| Capability | Direct `grok` + api.x.ai | OpenRouter `x-ai/grok-*` |
| --- | --- | --- |
| Chat / coding tools | Yes | Yes (gateway-dependent) |
| LIVE WebSearch → native `web_search` | Yes | No (client fallback only) |
| LIVE XSearch → native `x_search` | Yes when `[llm.xai].x_search` | No |
| Native `code_interpreter` | Yes when `[llm.xai].code_execution` | No |
| ImagineImage REST | Yes with BYOK | No |
| Gateway meme / x_search / TTS | Yes with BYOK aliases | N/A |

See `grok-todo.md` and `[llm.xai]` in config for the direct-xAI capability profile.
