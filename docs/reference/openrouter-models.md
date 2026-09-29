# OpenRouter model catalog

The 2026-09-29 snapshot uses OpenRouter's authenticated `/api/v1/models`
response. The same metadata is publicly available without authentication.
It adds current text-output models that advertise `tools`, with their exact
provider IDs, context and output limits, input modalities, reasoning levels
and prices. Batch variants, routing aliases beginning with `~`, and models
without function tools remain outside this agent picker.

The existing `x-ai/grok-4.5` default and leading model order stay unchanged.
Free models absent from the live response no longer appear in the BYOK
picker. The separate managed account free-model policy is unchanged.

`runtime/scripts/generate-openrouter-catalog.mjs` generates the reviewed
snapshot in `runtime/src/llm/registry/openrouter-models.ts`. It accepts a saved
models response or fetches the public endpoint. It does not read credentials.
The registry and cost tables consume that snapshot without changing their
public interfaces. Desktop can generate its matching rows from the Core
registry.

Missing output limits and unadvertised reasoning controls remain unset.
Prices belong to OpenRouter's advertised primary provider, so they need not
equal the original model vendor's direct tariff. A single documented context
price threshold is represented exactly. Request charges, multiple price
thresholds, and time-dependent price overrides retain Core's conservative
unknown-cost admission behavior. Provider-reported final charges remain the
authority for actual spend.

Sources:

- [Live model catalog](https://openrouter.ai/api/v1/models)
- [Model API fields and filtering](https://openrouter.ai/docs/guides/overview/models)
- [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Request parameters](https://openrouter.ai/docs/api/reference/parameters)

Reviewed reasoning efforts use OpenRouter’s nested `reasoning: { effort }` envelope. Unlisted efforts stay omitted, and managed gateway request contracts remain separate. Source: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens. Explicit NIM and local compatible provider selections retain their vendor/model identity when OpenRouter adds the same model ID.
