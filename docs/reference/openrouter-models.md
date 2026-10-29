# OpenRouter model catalog

`/model` and `/providers` read a cached OpenRouter catalog and refresh it in
background from `/api/v1/models`. The catalog includes every advertised model,
including models without function tools. A model without tools can be selected,
but AgenC shows a note that agent tools will not work with it.

The cache lasts one hour and lives under the captured AgenC home's `cache`
directory. It is partitioned by credential digest and contains no API key.
Requests use the user's OpenRouter key when available; the public endpoint also
works without one. Model requests, including free models, require the user's
own OpenRouter key.

Menus remain usable while the catalog refreshes. If the request fails or returns
an invalid catalog, AgenC uses the bundled 300-model snapshot and shows a short
notice. Offline selection accepts a well-formed `vendor/model` ID with an
unverified-model notice. When a live catalog is available, a new selection must
appear in it. Saved explicit selections remain pinned.

The preferred default is `x-ai/grok-4.5`. If it is absent from the available live
catalog, AgenC uses a listed model instead. Model rows show tools, vision,
thinking and free-model tags, context limits and token prices. The separate ZDR
endpoint lookup marks models without a ZDR route when ZDR is enabled.

Published context and output limits apply to runtime planning. Missing limits
and unadvertised reasoning controls remain unset. OpenRouter reasoning efforts
use its nested `reasoning: { effort }` envelope. Explicit NIM and local compatible
provider selections retain their vendor/model identity when OpenRouter lists
the same ID.

Catalog token prices are estimates. Budget admission and accounting use the
published token and cache rates, including context tiers and UTC price schedules.
An unpriced model uses conservative unknown-cost admission. A provider-reported
charge takes precedence for settlement and usage totals. For a BYOK response,
Core includes the reported upstream inference cost. Free routes are zero only
when the catalog lists no other charges or price overrides.

`runtime/scripts/generate-openrouter-catalog.mjs` regenerates the bundled
snapshot and its authority projections from a saved models response or the
public endpoint. It retains every advertised model and does not read credentials.
The current bundled snapshot remains the offline fallback.

Provider references:

- [Live model catalog](https://openrouter.ai/api/v1/models)
- [Model API fields](https://openrouter.ai/docs/guides/overview/models)
- [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Request parameters](https://openrouter.ai/docs/api/reference/parameters)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)
