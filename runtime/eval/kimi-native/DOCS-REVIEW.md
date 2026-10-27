# Official Kimi API review

Reviewed on 2026-10-23 before the follow-up implementation. Sources were the
platform's complete `llms-full.txt` documentation bundle, its OpenAPI schema,
and rendered pricing and limit tables. The Markdown export omits those tables,
so the HTML table definitions were checked separately. The source index below
records every page in the bundle. No provider key was used to retrieve docs.

| Documented feature | AgenC native Kimi / K3.1 status and changes |
| --- | --- |
| Quickstart, authentication, global base URL | Supported with isolated Moonshot credential authority and the native global endpoint. |
| Models and context limits | All six discovered models are registered. K3 family: 1,048,576 tokens; K2 family: 262,144. Retired models are excluded from the native catalog. |
| Chat messages, roles, full history | Supported. Full tool history and intact same-provider reasoning replay are retained. No server conversation state is assumed. |
| Output limit | Uses `max_completion_tokens`; normal defaults are 131,072 for K3 and 32,768 for K2. Evaluation explicitly caps output at 4,096 to reserve spend. |
| Sampling and `n` | Fixed sampling controls are omitted. Single completion only, matching current models' `n=1` contract. |
| Stop strings | Added local validation: at most five strings, each at most 32 UTF-8 bytes. |
| Thinking and reasoning effort | K3 uses top-level low/high/max effort. K2.7 always thinks; K2.6 uses enabled thinking with keep=all. Historical reasoning is not trimmed from intact tool loops. |
| Streaming | Supported, including reasoning fragments, indexed tool argument fragments, final usage with empty choices, and `[DONE]` validation. Truncated streams are failures. |
| Function tools | Supported with encoded names, full schemas, parallel results and locally unique IDs when Moonshot restarts IDs. Incomplete tool calls are not executed. |
| Tool choice | K3 supports auto/none/required; named choice is normalized because thinking rejects it. K2 retains the verified auto-only contract. |
| Dynamically loaded tools | AgenC supplies the current complete tool catalog at request level. Native `role=system, tools=[...]` snapshots are not exposed. This is an optional loading protocol, not needed for ordinary tool calls. |
| Official Formula tools | Standard function-tool results can carry Formula output. AgenC does not fetch Formula definitions or execute fibers automatically; it uses its own tools and MCP. |
| Search, Search Pro, Fetch | Standalone Moonshot REST endpoints are not implemented as AgenC tools. Legacy `$web_search` is not enabled; its documentation announces retirement on October 20. |
| Text / JSON object / JSON schema | Supported through the existing structured-output interface and schema validation. Combined schema-plus-tools remains enabled only for the live-verified K2.7 Code contract. Other combinations fail locally: current live probes show skipped tools or Markdown-wrapped final JSON. |
| Image input | Native base64 and `ms://` references, documented MIME types, no public image URLs or SVG, 100 MB request limit. All six models receive live vision tasks. |
| Video input | Not exposed by the shared AgenC message/attachment interface. No claim of native video support in the catalog. |
| Files and document extraction | AgenC reads local files with tools. Moonshot upload/list/content/delete APIs are not implemented by this chat provider. No automatic remote uploads. |
| Partial mode | Not exposed. Normal truncated-response handling preserves incomplete output without executing partial tools. |
| Log probabilities, prediction, safety identifier | Optional raw API controls are not exposed by AgenC's shared agent interface. |
| Responses and Anthropic Messages APIs | Reviewed for parameter and usage differences. Native `kimi` uses Chat Completions exclusively; no claims of alternative-wire support. |
| Batch API | Not exposed by the interactive agent provider; batch also lacks ZDR. |
| Automatic context caching | Supported by Moonshot without markers. Existing stable-prefix layout retained; added the stable session routing key. No explicit cache objects or IDs exist in the documented contract. |
| TTL selection and renewal | Added request `promptCacheTtl` and client `AGENC_KIMI_CACHE_TTL` (5m/1h) for K3. Default remains implicit 5m. Hits renew the original TTL; no manual refresh or deletion API. |
| Minimum cache size | Block-based; the guide gives no numeric minimum. AgenC does not invent a threshold or pad prompts to force writes. |
| Cache usage and billing | Reads and writes are subsets of total input. Added actual TTL header parsing for JSON and SSE, one-hour rates and guarded sweep pricing. No double counting of writes or reasoning. |
| Rate limits and account tiers | Existing rate-limit handling and separate terminal insufficient-funds handling retained. Sweep runs sequentially with output reservations, observed balance and usage-cost reconciliation. Limits are per account across models. |
| Errors | Authentication, quota, rate-limit, payload and malformed-stream failures are surfaced. Quota is not retried as a transient rate limit. |
| Balance, pricing, billing | Authenticated balance ledger, all six native rate cards and cache-write TTL rates verified. OpenRouter pricing remains separate. |
| Privacy and ZDR | Default native badge remains retained. Enterprise ZDR requires server-side approval; no request flag enables it. Added policy citations and tests in the WIP, retained after review. OpenRouter uses live endpoint eligibility plus `provider.zdr`. |
| Console and client integration guides | Reviewed. Account setup, organization controls, Playground, MoonPalace, Kimi Code and third-party client installation do not require agent-provider code changes. |

Optional service APIs and product surfaces marked as not exposed remain outside
this chat-provider integration. They are not presented as implemented features.
The live report records the narrower evidence actually obtained, not a claim
that every possible model behavior is correct.

## Cache contract and prices

The [caching guide](https://platform.kimi.ai/docs/guide/context-caching) specifies
organization-isolated prefix matching, immutable first-write TTL, free renewal
on a hit, and expiry after inactivity. Stable instructions precede changing
questions, tool results and task state. Request-level routing keys are not cache
IDs. Explicit `prompt_cache_breakpoint` markers are rejected by the
[Chat API](https://platform.kimi.ai/docs/api/chat).

| Model | Input | Output | Hit | 5m write | 1h write |
| --- | ---: | ---: | ---: | ---: | ---: |
| kimi-k3.1-pro | 2.00 | 10.00 | 0.20 | 2.00 | 4.00 |
| kimi-k3.1-pro-highspeed | 4.00 | 20.00 | 0.20 | 4.00 | 8.00 |
| kimi-k3 | 3.00 | 15.00 | 0.30 | 3.00 | 6.00 |
| kimi-k2.7-code | 0.95 | 4.00 | 0.19 | Not separately reported | Not supported |
| kimi-k2.7-code-highspeed | 1.90 | 8.00 | 0.38 | Not separately reported | Not supported |
| kimi-k2.6 | 0.95 | 4.00 | 0.16 | Not separately reported | Not supported |

USD per million tokens, excluding tax. Source:
[official pricing](https://platform.kimi.ai/docs/pricing/chat).
`input = uncached + cached + writes`. One-hour writes replace the ordinary
input charge for that subset; they are not charged on top of full-price input.
The numeric `Msh-Usage-Cache-Write-Tokens-5m` and `...-1h` response headers identify
the actual write tier, even when a request asks for a different TTL.

## Privacy conclusion

The [privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy) says
input is retained while the account is active. The general terms permit use to
improve services; enterprise arrangements can differ. The
[ZDR policy](https://platform.kimi.ai/docs/guide/zero-data-retention) offers
enterprise ZDR on request, deletes prompts and outputs after responding except
where law requires otherwise, and says enterprise data is not used for training.
Batch jobs, directly uploaded images/videos, operational records and third-party
services are excluded. ZDR changes server policy, not API parameters or billing.
AgenC cannot verify that a native API key has enterprise ZDR enabled.

OpenRouter's [ZDR endpoint list](https://openrouter.ai/api/v1/endpoints/zdr) is a
separate routing contract. Native model privacy must not be copied to that route,
and OpenRouter eligibility must not be copied back to native Moonshot.

## Source manifest

Complete bundle: 78 pages.

- [llms-full.txt](https://platform.kimi.ai/docs/llms-full.txt), SHA-256 `93b52b75ea9da6515e54ff0b52ca7a626ace84998b51ea3da48b484b079bef90`.
- [openapi.json](https://platform.kimi.ai/docs/openapi.json), SHA-256 `f6c78afc0c20eb8d222859e3bae823a1c32bb4f8876059aa61df062c264a7fdf`.

- [agreement/modeluse](https://platform.kimi.ai/docs/agreement/modeluse).
- [agreement/userprivacy](https://platform.kimi.ai/docs/agreement/userprivacy).
- [api/balance](https://platform.kimi.ai/docs/api/balance).
- [api/batch-cancel](https://platform.kimi.ai/docs/api/batch-cancel).
- [api/batch-create](https://platform.kimi.ai/docs/api/batch-create).
- [api/batch-list](https://platform.kimi.ai/docs/api/batch-list).
- [api/batch-retrieve](https://platform.kimi.ai/docs/api/batch-retrieve).
- [api/chat](https://platform.kimi.ai/docs/api/chat).
- [api/errors](https://platform.kimi.ai/docs/api/errors).
- [api/estimate](https://platform.kimi.ai/docs/api/estimate).
- [api/files-content](https://platform.kimi.ai/docs/api/files-content).
- [api/files-delete](https://platform.kimi.ai/docs/api/files-delete).
- [api/files-list](https://platform.kimi.ai/docs/api/files-list).
- [api/files-retrieve](https://platform.kimi.ai/docs/api/files-retrieve).
- [api/files-upload](https://platform.kimi.ai/docs/api/files-upload).
- [api/join-the-community](https://platform.kimi.ai/docs/api/join-the-community).
- [api/list-models](https://platform.kimi.ai/docs/api/list-models).
- [api/messages](https://platform.kimi.ai/docs/api/messages).
- [api/models-overview](https://platform.kimi.ai/docs/api/models-overview).
- [api/overview](https://platform.kimi.ai/docs/api/overview).
- [api/responses](https://platform.kimi.ai/docs/api/responses).
- [api/signatures-verify](https://platform.kimi.ai/docs/api/signatures-verify).
- [api/tools-fetch](https://platform.kimi.ai/docs/api/tools-fetch).
- [api/tools-search](https://platform.kimi.ai/docs/api/tools-search).
- [api/tools-search-pro](https://platform.kimi.ai/docs/api/tools-search-pro).
- [get-your-api-key](https://platform.kimi.ai/docs/get-your-api-key).
- [guide/account-and-payments](https://platform.kimi.ai/docs/guide/account-and-payments).
- [guide/account-security-and-sign-in](https://platform.kimi.ai/docs/guide/account-security-and-sign-in).
- [guide/ai-readable-docs](https://platform.kimi.ai/docs/guide/ai-readable-docs).
- [guide/ask-questions-about-pdf-content](https://platform.kimi.ai/docs/guide/ask-questions-about-pdf-content).
- [guide/auto-reconnect](https://platform.kimi.ai/docs/guide/auto-reconnect).
- [guide/benchmark-best-practice](https://platform.kimi.ai/docs/guide/benchmark-best-practice).
- [guide/best-practices-for-web-search](https://platform.kimi.ai/docs/guide/best-practices-for-web-search).
- [guide/claude-code-kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi).
- [guide/codex-kimi](https://platform.kimi.ai/docs/guide/codex-kimi).
- [guide/configure-the-modelscope-mcp-server](https://platform.kimi.ai/docs/guide/configure-the-modelscope-mcp-server).
- [guide/context-caching](https://platform.kimi.ai/docs/guide/context-caching).
- [guide/engage-in-multi-turn-conversations-using-kimi-api](https://platform.kimi.ai/docs/guide/engage-in-multi-turn-conversations-using-kimi-api).
- [guide/kimi-code-cli](https://platform.kimi.ai/docs/guide/kimi-code-cli).
- [guide/kimi-k2-6-quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart).
- [guide/kimi-k2-7-code-quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart).
- [guide/kimi-k3-1-pro-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart).
- [guide/kimi-k3-quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart).
- [guide/kimi-k3-tool-calling-best-practice](https://platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice).
- [guide/open-code](https://platform.kimi.ai/docs/guide/open-code).
- [guide/org-best-practice](https://platform.kimi.ai/docs/guide/org-best-practice).
- [guide/product-plans](https://platform.kimi.ai/docs/guide/product-plans).
- [guide/prompt-best-practice](https://platform.kimi.ai/docs/guide/prompt-best-practice).
- [guide/response_format](https://platform.kimi.ai/docs/guide/response_format).
- [guide/tool-call-repeat](https://platform.kimi.ai/docs/guide/tool-call-repeat).
- [guide/troubleshooting](https://platform.kimi.ai/docs/guide/troubleshooting).
- [guide/use-batch-api](https://platform.kimi.ai/docs/guide/use-batch-api).
- [guide/use-batch-inference](https://platform.kimi.ai/docs/guide/use-batch-inference).
- [guide/use-dynamic-tool-loading](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading).
- [guide/use-json-mode-feature-of-kimi-api](https://platform.kimi.ai/docs/guide/use-json-mode-feature-of-kimi-api).
- [guide/use-kimi-api-for-file-based-qa](https://platform.kimi.ai/docs/guide/use-kimi-api-for-file-based-qa).
- [guide/use-kimi-api-to-complete-tool-calls](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls).
- [guide/use-kimi-in-hermes-agent](https://platform.kimi.ai/docs/guide/use-kimi-in-hermes-agent).
- [guide/use-kimi-in-openclaw](https://platform.kimi.ai/docs/guide/use-kimi-in-openclaw).
- [guide/use-kimi-k3-to-setup-agent](https://platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent).
- [guide/use-kimi-vision-model](https://platform.kimi.ai/docs/guide/use-kimi-vision-model).
- [guide/use-moonpalace](https://platform.kimi.ai/docs/guide/use-moonpalace).
- [guide/use-official-tools](https://platform.kimi.ai/docs/guide/use-official-tools).
- [guide/use-partial-mode-feature-of-kimi-api](https://platform.kimi.ai/docs/guide/use-partial-mode-feature-of-kimi-api).
- [guide/use-playground-to-debug-the-model](https://platform.kimi.ai/docs/guide/use-playground-to-debug-the-model).
- [guide/use-reasoning-effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort).
- [guide/use-thinking-models](https://platform.kimi.ai/docs/guide/use-thinking-models).
- [guide/use-tool-choice](https://platform.kimi.ai/docs/guide/use-tool-choice).
- [guide/use-web-search](https://platform.kimi.ai/docs/guide/use-web-search).
- [guide/utilize-the-streaming-output-feature-of-kimi-api](https://platform.kimi.ai/docs/guide/utilize-the-streaming-output-feature-of-kimi-api).
- [guide/zero-data-retention](https://platform.kimi.ai/docs/guide/zero-data-retention).
- [introduction](https://platform.kimi.ai/docs/introduction).
- [models](https://platform.kimi.ai/docs/models).
- [platform-changelog](https://platform.kimi.ai/docs/platform-changelog).
- [pricing/batch](https://platform.kimi.ai/docs/pricing/batch).
- [pricing/chat](https://platform.kimi.ai/docs/pricing/chat).
- [pricing/limits](https://platform.kimi.ai/docs/pricing/limits).
- [pricing/websearch](https://platform.kimi.ai/docs/pricing/websearch).
