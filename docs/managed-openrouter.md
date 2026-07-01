# Managed OpenRouter Models

Paid AgenC accounts can use hosted model access without setting provider API
keys locally. The CLI signs in through the remote auth backend, asks
`id.agenc.ag` for a short-lived managed credential, and sends model traffic to
the AgenC LiteLLM/OpenRouter gateway.

## Runtime Flow

1. `agenc login` stores the remote auth token in `AGENC_HOME/auth.json`.
2. The TUI or CLI reads the subscription tier from the auth backend.
3. With `AGENC_AUTH_MANAGED_KEYS_ENABLED=true`, paid users get the hosted
   OpenRouter route selected automatically when the active provider is the old
   default `grok` route.
4. `/provider` opens with OpenRouter first and marked as subscription-managed.
   `/model` opens on the hosted OpenRouter model list first, even if the
   previous session provider was `grok`.
5. `/usage` asks the auth backend for the user's hosted model allowance,
   current spend, remaining included usage, and reset timestamp.
6. The backend vends a LiteLLM key for the session. The local CLI keeps it in
   provider memory only; it is not written as a provider API key.
7. The provider sends requests to the managed gateway with the model normalized
   as `openrouter/<provider>/<model>`.

BYOK still wins. If a user has `OPENROUTER_API_KEY` or provider config API keys,
those credentials are used instead of the subscription-managed route.

## TUI Behavior

After a successful paid `/login`, the TUI should feel ready without extra
provider setup:

- If the session was still on the default `grok` provider, login switches it to
  `openrouter / x-ai/grok-4.3` and tells the user to run `/model` for other
  hosted models.
- If the user intentionally configured another provider, login keeps that
  provider and tells the user that `/provider openrouter` is available.
- `/provider` prioritizes the hosted OpenRouter route for paid accounts, then
  shows BYOK and local routes.
- `/model` prioritizes hosted OpenRouter models for paid accounts, while still
  leaving BYOK/local provider rows visible when they are configured.

## Output Cap

Managed OpenRouter routes default to `2048` output tokens unless the user's
provider config explicitly sets `max_output_tokens`. This cap is applied both at
startup and after `/model` or `/provider` switches so catalog metadata such as
`128000` does not become the reserved `max_tokens` value on the provider call.

## Budget Errors

OpenRouter can reject managed requests when the workspace/key is out of credits,
the monthly key budget is too low, or the request reserves too many output
tokens for the remaining allowance. The CLI must not show raw upstream JSON,
OpenRouter key URLs, or provider account identifiers. Users should see a short
message telling them to use a smaller response/model or that the hosted
OpenRouter allowance needs to be topped up.

When debugging production, check these layers in order:

1. User subscription is active on the backend.
2. `/v1/auth/llm-credential` returns a managed OpenRouter credential.
3. `/v1/auth/llm-usage` can read the user's LiteLLM key spend for `/usage`.
4. LiteLLM key allowlist includes the selected `openrouter/...` model.
5. OpenRouter workspace has credits and the key monthly limit is high enough.
6. The CLI request uses the managed `2048` default unless the user configured a
   smaller or larger explicit cap.
