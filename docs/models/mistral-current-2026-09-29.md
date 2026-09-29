# Current documented Mistral routes, 2026-09-29

The account's authenticated models response omitted three models that Mistral officially lists as current hosted chat/tool routes. This follow-up adds them. Account inventory and platform availability are separate evidence: selection does not promise that this account can call a model.

The [official Vibe configuration guide](https://docs.mistral.ai/vibe/code/cli/configuration) explicitly lists all three under models available through Mistral's API, La Plateforme. Their model cards link Chat Completions and Function Calling. They are not self-host-only downloads or retired API routes.

| Picker ID | Status | Verified aliases | Image input | Published context / output labels | Standard USD/M input / output / cached input |
| --- | --- | --- | --- | --- | --- |
| `mistral-large-latest` | GA | `mistral-large-2512` | Yes | 256k / no independent output maximum | 0.50 / 1.50 / 0.05 |
| `zai-glm-5-3` | Public Preview, hosted by Mistral | `zai-glm-5`, `zai-glm-latest` | No | 1M / 128k | 1.40 / 4.40 / 0.14 |
| `zai-glm-5-2` | Public Preview, hosted by Mistral | None documented | No | 1M / 128k | 1.40 / 4.40 / 0.14 |

Sources: [Large 3 card](https://docs.mistral.ai/models/mistral-large-3-25-12), [hosted GLM 5.3 card](https://docs.mistral.ai/models/zai-glm-5-3), [hosted GLM 5.2 card](https://docs.mistral.ai/models/zai-glm-5-2), [standard pricing](https://docs.mistral.ai/inference/pricing), and [Large 3 vision guide](https://docs.mistral.ai/studio/conversations/vision). The GLM 5.3 card's rendered model-name group includes its two aliases.

The reviewed pages and embedded model-card data publish only rounded context/output labels, with no exact deployment integers. The rich catalog therefore leaves all three exact context and output fields unset. The older bare Large alias's guessed context/output values are removed from the legacy lookup table so they cannot silently become known metadata. Core's existing conservative fallback remains usable and is labeled as fallback metadata. Exact native ZAI, open-weight or other-host limits are not transferred to Mistral hosting.

All three cards support function tools and structured output. The [function calling guide](https://docs.mistral.ai/studio/conversations/function-calling) and [hosted Chat Completions schema](https://docs.mistral.ai/api/endpoint/chat) document ordinary tools, parallel calls, `auto`/`none`/`any`/`required` tool choice, JSON Schema output and `max_tokens`. The existing Mistral adapter already implements these fields, parses standard and nested thinking content, and replays same-provider/model thinking in Mistral's content format. No native ZAI `thinking`, `clear_thinking` or `tool_stream` parameter is sent to this host.

The [reasoning guide](https://docs.mistral.ai/studio/conversations/reasoning) establishes explicit effort controls for Small 4 and Medium 3.5, but does not establish an enum for these three routes. The new rows expose no guessed effort dial. General GLM reasoning capability and host defaults remain provider-owned.

The prices are Mistral's published standard text-token rates, including its own cache rates. They do not reuse native ZAI or OpenRouter prices. Existing cost admission and catalog formats are unchanged. Media-specific pricing, regional premiums, batch and priority tiers are outside these standard rates.

Validation includes all three ordinary chat/tool paths through Core's real factory with mocked HTTP, exact provider identity, alias isolation, image/tool capabilities, unknown-limit projection and fallback labeling, scoped prices, and omitted unsupported native ZAI controls. The orchestrator records the Linux suite and tiny real API outcomes separately, including any account refusal. No success is inferred from documentation or a unit test.
