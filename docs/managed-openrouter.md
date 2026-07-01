# Managed OpenRouter Models

Paid AgenC accounts can use hosted model access without setting provider API
keys locally. The CLI signs in through the remote auth backend, asks
`id.agenc.ag` for a short-lived managed credential, and sends model traffic to
the AgenC LiteLLM/OpenRouter gateway.

## Runtime Flow

1. `agenc login` stores the remote auth token in `AGENC_HOME/auth.json`.
2. The TUI or CLI reads the subscription tier from the auth backend.
3. With `AGENC_AUTH_MANAGED_KEYS_ENABLED=true`, paid users can select managed
   OpenRouter models from `/provider` or `/model`.
4. `/usage` asks the auth backend for the user's hosted model allowance,
   current spend, remaining included usage, and reset timestamp.
5. The backend vends a LiteLLM key for the session. The local CLI keeps it in
   provider memory only; it is not written as a provider API key.
6. The provider sends requests to the managed gateway with the model normalized
   as `openrouter/<provider>/<model>`.

BYOK still wins. If a user has `OPENROUTER_API_KEY` or provider config API keys,
those credentials are used instead of the subscription-managed route.

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
