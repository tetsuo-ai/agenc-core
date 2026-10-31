# QwenCloud Token Plan chat catalog, 2026-10-31

The Models API of a Singapore Token Plan key (`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models`)
listed 20 ids on 2026-10-31. Thirteen are chat models; seven are image, audio and video models that use other API
surfaces (`qwen-image-3.0-pro`, `wan2.7-image`, `wan2.7-image-pro`, `wan3.0-video`, `qwen-audio-3.0-tts-plus`,
`qwen-audio-3.0-realtime-plus`, `qwen-audio-3.0-asr-flash`).

| Chat id | Core on `qwen-token-plan` | Contract |
| --- | --- | --- |
| `qwen3.8-max`, `qwen3.8-flash` | Listed (before) | Qwen3.8: low, medium, xhigh effort (default xhigh); images |
| `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash` | Listed (before) | Hybrid thinking with `preserve_thinking` |
| `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`, `glm-5.3`, `glm-5.2` | Listed (new) | The Pay-As-You-Go deployment of the same id ([Qwen current chat catalog](qwen-current-2026-09-29.md)) |
| `deepseek-v4.1-flash-1017` | Listed (new) | The `deepseek-v4.1-flash` contract (dated deployment of that model) |
| `auto` | Not listed | A server-side router with no published limits or controls |

Every chat id answered a parallel two-tool call (both calls in one response) and the tool-result round trip on the
Token Plan endpoint on 2026-10-31.

Caching: Qwen3.8 and Qwen3.7 cache implicitly. Qwen3.6 has no implicit cache and caches only with explicit
`cache_control` markers ([context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)). In live
agent-loop probes `qwen3.6-flash` cached none of its input without markers and 81% with a marker on the system prompt
and on the newest message, so Core sends those two markers for it. On `qwen3.8-max` explicit markers raised the cached
share from 80.5% to 85.3% at the price of cache-creation tokens and did not change time to first byte, so the
implicit cache stays in use there.

Errors ([Token Plan FAQ](https://www.alibabacloud.com/help/en/model-studio/token-plan-faq)): an exhausted plan quota
is HTTP 429 `insufficient_quota` ("Your token-plan quota has been exhausted.") and lasts until the monthly reset, a
quota pack or a plan change, so Core stops the turn with that explanation instead of retrying. HTTP 429 "Requests rate
limit exceeded" is throttling and is retried. A streamed request receives an error as one SSE data frame.
