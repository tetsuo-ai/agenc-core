# Native model catalog refresh, 2026-09-29

This update keeps the existing catalog schema. `mistral-models.ts` supplies exact deployment aliases, metadata and prices; the existing registry and pricing consumers derive their rows from it. Qwen and Z.AI keep their existing catalog factories. All additions below were present in the corresponding account's live models response on the audit date.

## Added selectable models

Prices below are USD per million text tokens: uncached input / output / cached input. Cached input means the provider's automatic prompt cache. Qwen prices are Singapore international PAYG rates, matching the built-in endpoint. Audio, video, search and regional surcharges are outside these text rates.

| Provider | Model | Context | Output ceiling | Input / output / cached | Image input | Reasoning control |
| --- | --- | ---: | ---: | --- | --- | --- |
| Mistral | `mistral-small-latest` | 262144 | unpublished | 0.15 / 0.60 / 0.015 | yes | none, high |
| Mistral | `codestral-latest` | 256000 | unpublished | 0.30 / 0.90 / 0.03 | no | no documented selector |
| Mistral | `ministral-14b-latest` | 262144 | unpublished | 0.20 / 0.20 / 0.02 | yes | no documented selector |
| Mistral | `ministral-8b-latest` | 262144 | unpublished | 0.15 / 0.15 / 0.015 | yes | no documented selector |
| Mistral | `ministral-3b-latest` | 131072 | unpublished | 0.10 / 0.10 / 0.01 | yes | no documented selector |
| Mistral | `voxtral-small-latest` | 32768 | unpublished | 0.10 / 0.40 / unpublished | no | no documented selector |
| Mistral | `labs-leanstral-1-5` | 262144 | 128k shorthand, exact integer unpublished | free | yes | reasoning available, no documented selector |
| Z.AI | `glm-5.3-flashx` | 1000000 | 131072 | 0.37 / 1.25 / 0.075 | yes | low, high, max |
| Qwen | `qwen3.8-27b` | 1000000 | 131072 | 0.50 / 3.00 / 0.10 | yes | hybrid thinking, no documented effort selector |
| Qwen | `qwen3.8-2.4t-a95b` | 1000000 | 131072 | 2.00 / 6.00 / 0.25 | no | thinking always enabled |
| Qwen | `qwen3.8-omni-flash` | 1000000 | 131072 | 0.15 / 0.47 / 0.016 | yes | none, minimal, low, medium, high, xhigh, max |

Every added model supports function tools. Mistral aliases resolve to one canonical picker row, preserving saved alias selection. Missing Mistral output ceilings stay unspecified instead of treating the shared context as an independent output allowance. Leanstral's card publishes only 128k shorthand, so its exact output ceiling is also omitted. Leanstral uses the existing conservative admission policy for a zero-priced remote model.

Mistral's existing Medium 3.5 row now exposes its verified 262144-token context, vision, tool and structured-output capabilities, and none/high reasoning control. The shared Chat Completions adapter parses Mistral thinking blocks in ordinary and streaming responses and replays their text in the provider's nested content format only for matching provider/model history.

Z.AI FlashX is PAYG-only in the official guide, so the Coding Plan allowlist stays unchanged. It inherits the Flash thinking-only, image, JSON-object and tool-streaming contract. New Qwen models are PAYG-only because the current Token Plan list does not include them. Qwen 2.4T cannot disable thinking, so forced tool selections normalize to automatic selection. Omni also uses automatic selection instead of the older `enable_thinking=false` forced-tool workaround; its documented thinking switch is `reasoning_effort`.

Native DeepSeek's live output ceiling is 393216, replacing 384000. Its 64000-token default remains a runtime budget. Provider-neutral fallback output metadata also reflects 393216. Managed AgenC route limits remain separate.

## Scope and evidence conflicts

The Mistral models endpoint returns 46 IDs, of which 27 chat/tool IDs form the eight canonical groups now listed. The rest use embedding, OCR, moderation or audio-specific APIs. The endpoint's Codestral context is 256000 while its static card says 128k; Ministral 3B serves 131072 while its card says 256k. The catalog follows exact deployment metadata. Large 3 and hosted GLM 5.3/5.2 appear in official Mistral docs but were absent from this account's models response; this update does not advertise account access to them. Former Magistral names are deprecated in the reasoning guide and are returned as current Small/Medium aliases by the endpoint, so they are not duplicate picker rows.

Qwen's endpoint also lists older snapshots, media/embedding endpoints and third-party deployments. This change covers the new canonical native Qwen 3.8 deployments; it does not label other endpoint IDs retired. Z.AI likewise still lists older GLM generations; absence from the curated picker is not a retirement claim.

## Official sources

- [Mistral models endpoint](https://docs.mistral.ai/api/endpoint/models): aliases, exact context, chat/tools, vision and reasoning support.
- [Mistral pricing](https://docs.mistral.ai/inference/pricing), [Voxtral Small](https://docs.mistral.ai/models/voxtral-small-25-07), [Leanstral 1.5](https://docs.mistral.ai/models/leanstral-1-5): text rates and the documented Leanstral output limit.
- [Mistral reasoning](https://docs.mistral.ai/studio/conversations/reasoning) and [known limitations](https://docs.mistral.ai/resources/known-limitations): effort controls, thinking replay and tool behavior.
- [Z.AI Flash and FlashX](https://docs.z.ai/guides/vlm/glm-5.3-flash) and [pricing](https://docs.z.ai/guides/overview/pricing): models, limits, vision, thinking-only behavior, PAYG availability and text rates.
- [Qwen 3.8 27B](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-27b) and [Qwen 3.8 2.4T A95B](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-2-4t-a95b): limits, tools, modalities and Singapore rates.
- [Qwen 3.8 Omni Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash), [Omni guide](https://www.alibabacloud.com/help/en/model-studio/qwen-omni), [deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking), [model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing): Omni limits, tool support, effort controls, thinking contracts and Singapore rates.
- [DeepSeek models endpoint](https://api-docs.deepseek.com/api/list-models/): exact native output ceiling.
