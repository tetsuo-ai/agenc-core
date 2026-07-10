# Managed OpenRouter models

AgenC can route model traffic through hosted OpenRouter credentials so you do
not need a local provider API key. The CLI signs in through the remote auth
backend, asks `id.agenc.ag` for a short-lived managed credential, and sends
requests to the AgenC LiteLLM/OpenRouter gateway.

Related: [onboarding](onboarding.md) · [quickstart](quickstart.md) ·
[install](install.md).

## Defaults (0.3.0)

| Setting | Value |
|---|---|
| `auth.backend` | `remote` (default) |
| `auth.managedKeys.enabled` | **`true`** (default) |
| Default paid managed model | `openrouter` / `x-ai/grok-4.3` |
| Free-tier managed routes | OpenRouter `:free` models (see below) |
| Default max output tokens | **`32_000`** (`DEFAULT_MAX_OUTPUT_TOKENS`) |
| Upper limit | **`64_000`** |
| Capped default (when `capped_default_max_output_tokens` is set) | **`8_000`** (`CAPPED_DEFAULT_MAX_OUTPUT_TOKENS`) |

There is **no product default of 2048 output tokens** for managed chat.
Catalog/metadata defaults use the 32k/64k path above; operators can opt into
the 8k capped default or set an explicit cap with `max_output_tokens` /
`AGENC_MAX_OUTPUT_TOKENS`.

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
   list, defaulting to `x-ai/grok-4.3`.
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

Paid managed catalog (non-exhaustive) includes `x-ai/grok-4.3`,
`x-ai/grok-build-0.1`, and common OpenRouter IDs for OpenAI/Anthropic/Google/
DeepSeek/Qwen/Mistral/Meta/etc. Full list:
`runtime/src/commands/subscription-managed-models.ts`.

## TUI behavior

After a successful `/login`:

- If the session was still on the default `grok` provider, login can switch to
  managed `openrouter / x-ai/grok-4.3` (paid) or the tier's first free model
  (free) and point you at `/model` for the rest of the hosted list.
- If you intentionally configured another provider, login keeps that provider
  and notes that `/provider openrouter` is available.
- `/provider` and `/model` prioritize hosted OpenRouter for managed sessions
  while still showing BYOK and local routes when configured.

## Output tokens

| Source | Effect |
|---|---|
| Explicit `max_output_tokens` / `AGENC_MAX_OUTPUT_TOKENS` | Wins (bounded by model upper limit) |
| `capped_default_max_output_tokens = true` | Default **8_000** |
| Metadata / compatible default | **32_000** default, **64_000** upper limit |

Managed chat does **not** force a 2048-token ceiling. Prefer an explicit
operator cap when you need smaller reserved budgets for allowance headroom.

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
8. Request `max_tokens` matches the intended default (32k / 8k capped /
   explicit), not an outdated hard-coded 2048 assumption.
