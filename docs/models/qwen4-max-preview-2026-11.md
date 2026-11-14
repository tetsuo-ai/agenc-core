# Qwen4 Max Preview on Token Plan, 2026-11-13

Checked Alibaba Cloud's documentation with `curl` on 2026-11-13. This is a
documentation review, not a live Models API or inference probe. No Token Plan
key was read, created or copied.

Rechecked the public model card, Chat API, thinking and structured-output guides
on 2026-11-14 for the release follow-up. No inference calls were made.

## Model and access

The [model card](https://www.alibabacloud.com/help/en/model-studio/qwen4-max-preview)
documents `qwen4-max-preview`, available **only through Token Plan**, with no
pay-as-you-go access. The
[Personal](https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview)
and [Team](https://www.alibabacloud.com/help/en/model-studio/token-plan-team-overview)
guides confirm that `qwen4.0-max-preview` is an accepted alias and the name shown
on bills. This is the same deployment, not a second model.

The preview runs from 2026-11-11 10:00 through 2026-11-25 24:00 (UTC+8). Alibaba
says it will make no changes during that period and retire the model afterward.
The closing instant is 2026-11-26 00:00 UTC+8, or 2026-11-25 16:00 UTC. Core's
retirement code accepts only UTC calendar dates. Its bundled entry therefore
uses `retiresOn: 2026-11-25`: Core hides the preview from the picker and refuses
new selections from **2026-11-25 00:00 UTC**, 16 hours before Alibaba closes it.
Both IDs follow this rule. The picker label is `Qwen4 Max Preview`.

| Property | Documented contract |
| --- | --- |
| Context | 1M tokens; Core uses 1,000,000, consistent with its other Qwen 1M rows |
| Output | At most 393,216 tokens, including thinking and the final answer |
| Input | Text, images and video; Core exposes its existing text/image chat input |
| Tools | Function Calling, web search and built-in tools |
| Structured output | Model card lists JSON Object and JSON Schema; Core keeps schema requests disabled on Token Plan |
| APIs | OpenAI Chat Completions, OpenAI Responses and Anthropic Messages |

These properties are stated on the model card. The
[vision guide](https://www.alibabacloud.com/help/en/model-studio/vision),
[Function Calling guide](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling)
and [structured output guide](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)
describe the input, tool and JSON Schema workflows. On Chat Completions, image
parts use `image_url.url` (public URL or a base64 data URL), tool definitions use
`tools[].function`, and parallel calls use `parallel_tool_calls`. The Chat API
reference lists `tool_stream` for the model's text modality; Core does not enable
that optional switch for this multimodal entry. Ordinary streamed tool calls
use Core's existing Chat Completions parser.

The structured-output guide still excludes Singapore models from JSON Schema,
despite listing Qwen4 in its supported families. Core keeps structured output
disabled for both preview IDs, as it does for other Token Plan models. Schema
requests fail locally before transport. The memory reranker also refuses this
model before admission, leaving recall on its lexical fallback. Its 1,024-token
cap and five-second deadline are not a verified fit for default xhigh thinking.

## Endpoint qualification

The [Token Plan overview](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview)
links to the Personal and Team plans and their integration guides. Both
international plan pages currently advertise **Singapore only**. The
[international integration guide](https://www.alibabacloud.com/help/en/model-studio/more-tools)
lists these bases:

- OpenAI: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
- Anthropic: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`

The [mainland integration guide](https://help.aliyun.com/zh/model-studio/more-tools)
lists the corresponding Beijing bases with host
`token-plan.cn-beijing.maas.aliyuncs.com`. Thus the two region-specific hosts are
documented, but the international guides do not establish Beijing availability
for an international subscription. Use the base and dedicated key supplied for
the actual subscription; a PAYG key or workspace endpoint is not interchangeable.
Core retains Singapore as its default and its existing base-URL override.

Core uses Chat Completions at `/compatible-mode/v1/chat/completions`. The
[Codex integration example](https://www.alibabacloud.com/help/en/model-studio/codex)
also configures the OpenAI base above with the Responses wire API. Core does not
switch API protocols for this entry. The Token Plan guides place native built-in
tools on Responses, so Core continues using its provider-neutral search tools
and does not advertise provider-native web search for this chat adapter.

## Thinking and output accounting

The model card and
[Chat Completions reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
establish the following:

- Thinking is on by default. `reasoning_effort` has canonical values `low`,
  `medium`, `xhigh`, with `xhigh` the default. They map to thinking budgets of
  4,096, 16,384 and 262,144 tokens respectively.
- The API also documents compatibility mappings: `minimal` to `low`, `high`
  and `max` to `xhigh`, and `none` to `enable_thinking=false`. The
  [thinking guide](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)
  classifies Qwen4 as hybrid, so thinking can be disabled. Core accepts `none`,
  `minimal`, `low`, `medium` and `xhigh` in saved and session choices. It sends
  `none` to disable thinking and maps `minimal` to `low` before building either
  buffered or streaming requests. The session's top-tier `max` still maps to
  `xhigh` through the existing resolver; other direct effort values stay filtered.
- `thinking_budget` is an alternative to `reasoning_effort`, not an additional
  field. Sending both is an error. The API maps budgets 0–4,096 to `low`,
  4,097–16,384 to `medium`, and 16,385–262,144 to `xhigh`. Core sends effort only
  and does not synthesize a thinking budget for this model.
- In Chat Completions, thinking is returned in `reasoning_content` (message or
  streaming delta), while the answer is in `content`. `preserve_thinking` is
  enabled by default. Replay historical reasoning in the assistant message's
  `reasoning_content`, never concatenate it with `content`. Preserved thinking
  counts as input tokens on subsequent requests.
- `max_tokens` and `max_completion_tokens` both limit the combined thinking and
  answer tokens. The
  [API compatibility notice](https://www.alibabacloud.com/help/en/model-studio/api-compatibility-upgrade-notice)
  explicitly says earlier Qwen models keep their previous behavior.

Core uses `max_completion_tokens` with a default and ceiling of 393,216. At the
documented maximum thinking budget this leaves 131,072 tokens for the answer,
instead of letting the generic 32K chat fallback expire during thinking. A
smaller explicit output cap remains authoritative and can truncate thinking or
the answer; context admission can also reduce the available reservation. The
new default does not override either constraint. Only the two exact preview IDs
on `qwen-token-plan` receive this behavior.

The existing hybrid-Qwen tool rule applies: a forced `required` or named tool
choice disables thinking with `enable_thinking=false` and omits effort. The
Function Calling guide says forced choices are rejected while thinking is on.
Auto tool choice preserves thinking and reasoning replay.

## Credits and Core cost display

Personal and Team charge **Credits**, dynamically determined by the model,
token usage, thinking mode and tools. The thinking guide accounts for reasoning
as output tokens; the API usage separates `completion_tokens_details.reasoning_tokens`
within `completion_tokens`. Do not add it again to total completion usage.
Cached input is another metered dimension (illustrated in the Team guide).

Both plan pages advertise Qwen4 preview Credits consumption as low as 20% of
the standard rate, with another 60% reduction at 22:00–08:00 UTC+8, giving 8% of
the standard rate. These are promotional relative rates, not published fixed
Credits-per-token or USD-per-token prices. Actual Credits consumption comes
from the subscription console/invoice, using the alias `qwen4.0-max-preview`.

Personal consumes its monthly quota then usage packs; Team consumes its seat
quota then shared packs. Exhaustion pauses service rather than causing PAYG
overage. Core therefore records both IDs with the existing `plan` USD cost
entry: zero additional per-call USD, **not free tokens or zero Credits**. It
retains token usage and does not invent a Credits conversion or PAYG price.

## Verification boundary

Offline tests pin the clock before retirement and cover the UTC date boundary,
picker hiding and selection refusal for both IDs. They also cover local schema
and memory-reranker rejection, configured and carried effort values, buffered
and streaming request bodies, image/tool requests, reasoning replay and usage,
output limits, token estimation, selector priors, plan cost and request snapshots.
Existing Qwen, Token Plan and DeepSeek request contracts remain unchanged.

A live check would require an active Token Plan subscription, its matching
regional base URL and dedicated key, and an authorized interactive Core
session before retirement. It should check both IDs, each canonical effort,
streaming and buffered replies, image input, parallel tools and the tool-result
round trip, preserved reasoning, a long thinking/answer budget, and console
Credits consumption under the billing alias. None was performed for this change.
