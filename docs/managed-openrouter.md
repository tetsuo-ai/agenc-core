# OpenRouter account models retired

AgenC accounts no longer provide models, provider keys, proxy access, or model credits. Configure your own OpenRouter key with `/providers` or `OPENROUTER_API_KEY`. Free OpenRouter models use that key just like paid models.

The free-model list in `runtime/src/llm/registry/openrouter-free-models.ts` is unchanged, including its first entry, `cohere/north-mini-code:free`. The direct OpenRouter provider default remains `x-ai/grok-4.5`.

Old `[auth.managed_keys]` and `[auth.managedKeys]` sections load successfully, are ignored, and produce one notice per configuration load. `AGENC_AUTH_MANAGED_KEYS_ENABLED` no longer enables any feature.

AgenC sign-in remains available for account identity, marketplace access, remote pairing, and desktop sync. Provider sign-ins such as ChatGPT and X / xAI remain separate and use the user's own provider account.
