# Qwen current chat catalog, 2026-09-29

The live Singapore PAYG models endpoint and official Alibaba documentation identify 55 additional chat/tool deployments. The Beijing-only direct Kimi route is hidden from the default Singapore picker and requires a configured Beijing workspace endpoint and separately activated regional key. This produces 66 visible Qwen PAYG picker entries. The 55 additions are registered only on Qwen PAYG. The Token Plan's five-model allowlist is unchanged. Catalog formats remain stable for model selection consumers and Desktop generation.

Sources: [function calling families](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling), [Chat Completions parameters](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), [thinking modes](https://www.alibabacloud.com/help/en/model-studio/deep-thinking), [GLM route](https://www.alibabacloud.com/help/en/model-studio/glm), [Kimi route](https://www.alibabacloud.com/help/en/model-studio/kimi-api), [Omni route](https://www.alibabacloud.com/help/en/model-studio/qwen-omni), and [Singapore pricing and decimal tier units](https://www.alibabacloud.com/help/en/model-studio/model-pricing).

The per-model links below supply exact numeric context/output limits, modalities and Singapore text rates. Prime and direct vendor routes publish only shorthand or unavailable numeric limits, so those fields remain absent. A missing rate uses Core's existing conservative unpriced admission. No rate from a model's native provider is borrowed for Alibaba hosting. Variable thinking-mode, time-of-day and modality-dependent prices stay unpriced when the cost sidecar cannot determine the billing dimension. Explicit-cache rates are not substituted for implicit-cache rates.

Some older Singapore cards label function calling Unsupported, while Alibaba's current function-calling guide explicitly includes their families. The owner's existing qwen3-coder-plus passed real Core chat and tool calls on Linux on this audit, contradicting the same card label. Family tool support follows the functional guide; each new deployment receives its own live attempt and failures remain evidence, not invented successes.

The runtime buffers required SSE for older open-source thinking models and Omni behind chat(), preserving tool arguments, reasoning provenance and authoritative usage. Older Qwen routes use max_tokens for the answer and a bounded thinking_budget when reasoning is enabled. Hosted GLM/Kimi/DeepSeek use the documented total-output max_completion_tokens. GLM's tool_stream and preserved-thinking fields use Alibaba's top-level spellings. Thinking-only deployments never receive enable_thinking:false from forced tool selection. The two direct vendor routes are held from paid checks until a total-output bound for those exact routes is verified.

Existing qwen3.7-plus and qwen3.7-flash output limits are corrected from 65536 to 131072. Qwen3.8 27B and 2.4T gain the documented low/medium/xhigh effort controls. Eight already-listed models gain verified Singapore prices, including multi-tier Coder prices. The June 8 Qwen3.7 Max snapshot is included because it adds vision to the canonical text-only Max route; true dated equivalents remain unlisted duplicates. Five further snapshots are kept because official documentation establishes a distinct contract or newer deployment: DeepSeek V4 Pro 0813 and Flash 0731 add low effort, Qwen3.8 Max 0902 upgrades vision, Qwen3.5 Plus April 20 supersedes the canonical February 15 snapshot, and Qwen3 Coder Plus September 23 supersedes the canonical July 22 snapshot.

| Added model | Context tokens | Output tokens | Image input | Thinking | Singapore USD/M input/output by increasing tier | Source |
| --- | ---: | ---: | --- | --- | --- | --- |
| `glm-5.3-prime` | Unpublished | Unpublished | No | always | >0: 2.8/8.8 | [Official](https://modelstudio.console.alibabacloud.com/ap-southeast-1/model/market/detail/glm-5.3-prime?serviceSite=international) |
| `glm-5.3` | 1048576 | 131072 | No | always | >0: 1.4/4.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/glm-5-3) |
| `deepseek-v4.1-flash` | 1000000 | 393216 | Yes | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-1-flash) |
| `kimi-k3` | 1048576 | 1048576 | Yes | always | >0: 3.0/15.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/kimi-k3) |
| `glm-5.2-fast-preview` | 1048576 | 131072 | No | hybrid | >0: 2.8/8.8 | [Official](https://www.alibabacloud.com/help/en/model-studio/glm-5-2-fast) |
| `kimi-k2.7-code` | 262144 | 16384 | Yes | always | >0: 0.95/4.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/kimi-k2-7-code) |
| `glm-5.2` | 1048576 | 131072 | No | hybrid | >0: 1.4/4.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/glm-5-2) |
| `glm-5.1` | 202745 | 131072 | No | hybrid | >0: 1.4/4.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/glm-5-1) |
| `deepseek-v4-flash` | 1000000 | 393216 | No | hybrid | >0: 0.2/0.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-flash) |
| `deepseek-v4-pro` | 1000000 | 393216 | No | hybrid | >0: 2.4/4.8 | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-pro) |
| `qwen3.6-27b` | 262144 | 65536 | Yes | hybrid | >0: 0.6/3.6 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-27b) |
| `qwen3.6-max-preview` | 262144 | 65536 | No | hybrid | >0: 1.3/7.8; >128000: 2.0/12.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-max) |
| `qwen3.6-35b-a3b` | 262144 | 65536 | Yes | hybrid | >0: 0.375/2.25 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-35b-a3b) |
| `qwen3.5-omni-plus` | 262144 | 65536 | Yes | none | >0: 1.4/8.3 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-omni-plus) |
| `qwen3.5-omni-flash` | 262144 | 65536 | Yes | none | >0: 0.4/2.2 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-omni-flash) |
| `deepseek-v3.2` | 131072 | 65536 | No | hybrid | >0: 0.57/1.71 | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v3-3) |
| `qwen3.5-flash` | 1000000 | 65536 | Yes | hybrid | >0: 0.1/0.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-flash) |
| `qwen3.5-122b-a10b` | 262144 | 65536 | Yes | hybrid | >0: 0.4/3.2 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-122b-a10b) |
| `qwen3.5-35b-a3b` | 262144 | 65536 | Yes | hybrid | >0: 0.25/2.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-35b-a3b) |
| `qwen3.5-27b` | 262144 | 65536 | Yes | hybrid | >0: 0.3/2.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-27b) |
| `qwen3.5-397b-a17b` | 262144 | 65536 | Yes | hybrid | >0: 0.6/3.6 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-397b-a17b) |
| `qwen3.5-plus` | 1000000 | 65536 | Yes | hybrid | >0: 0.4/2.4; >256000: 0.5/3.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-plus) |
| `qwen-flash` | 1000000 | 32768 | No | hybrid | >0: 0.05/0.4; >256000: 0.25/2.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-flash) |
| `qwen3-vl-flash` | 262144 | 32768 | Yes | hybrid | >0: 0.05/0.4; >32000: 0.075/0.6; >128000: 0.12/0.96 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-flash) |
| `qwen3-omni-flash` | 65536 | 16384 | Yes | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-omni-flash) |
| `qwen-coder-plus` | 131072 | 8192 | No | none | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-coder-plus) |
| `qwen3-8b` | 131072 | 8192 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-8b) |
| `qwen3-30b-a3b` | 131072 | 8192 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-30b-a3b) |
| `qwen3-235b-a22b` | 131072 | 16384 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-235b-a22b) |
| `qwen3-coder-480b-a35b-instruct` | 262144 | 65536 | No | none | >0: 1.5/7.5; >32000: 2.7/13.5; >128000: 4.5/22.5 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-480b-a35b-instruct) |
| `qwen3-235b-a22b-instruct-2507` | 131072 | 32768 | No | none | >0: 0.23/0.92 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-235b-a22b-instruct-2507) |
| `qwen3-235b-a22b-thinking-2507` | 131072 | 32768 | No | always | >0: 0.23/2.3 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-235b-a22b-thinking-2507) |
| `qwen3-coder-flash` | 1000000 | 65536 | No | none | >0: 0.3/1.5; >32000: 0.5/2.5; >128000: 0.8/4.0; >256000: 1.6/9.6 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-flash) |
| `qwen3-max` | 262144 | 32768 | No | hybrid | >0: 1.2/6.0; >32000: 2.4/12.0; >128000: 3.0/15.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/model-qwen3-max) |
| `qwen3-vl-plus` | 262144 | 32768 | Yes | hybrid | >0: 0.2/1.6; >32000: 0.3/2.4; >128000: 0.6/4.8 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-plus) |
| `qwen3-vl-235b-a22b-instruct` | 131072 | 32768 | Yes | none | >0: 0.4/1.6 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-235b-a22b-instruct) |
| `qwen3-vl-235b-a22b-thinking` | 131072 | 32768 | Yes | always | >0: 0.4/4.0 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-235b-a22b-thinking) |
| `qwen3-30b-a3b-thinking-2507` | 81920 | 32768 | No | always | >0: 0.2/2.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-30b-a3b-thinking-2507) |
| `qwen3-30b-a3b-instruct-2507` | 131072 | 32768 | No | none | >0: 0.2/0.8 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-30b-a3b-instruct-2507) |
| `qwen3-14b` | 131072 | 8192 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-14b) |
| `qwen3-32b` | 131072 | 8192 | No | hybrid | >0: 0.16/0.64 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-32b) |
| `qwen3-next-80b-a3b-thinking` | 131072 | 32768 | No | always | >0: 0.15/1.2 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-next-80b-a3b-thinking) |
| `qwen3-next-80b-a3b-instruct` | 131072 | 32768 | No | none | >0: 0.15/1.2 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-next-80b-a3b-instruct) |
| `qwen-max` | 32768 | 8192 | No | none | >0: 1.6/6.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-max) |
| `qwen-plus` | 1000000 | 32768 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |
| `qwen-turbo` | 131072 | 16384 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-turbo) |
| `ZHIPU/GLM-5.3` | Unpublished | Unpublished | No verified image contract | always | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |
| `kimi/kimi-k3` (hidden, Beijing only) | Unpublished | Unpublished | Public HTTP(S) URLs only | always | Unpriced | [Official](https://help.aliyun.com/en/model-studio/kimi-api-by-moonshot-ai) |
| `qwen3.7-max-preview` | 1000000 | 131072 | No | always | >0: 2.5/7.5 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |
| `qwen3.7-max-2026-06-08` | 1000000 | 131072 | Yes | hybrid | >0: 2.5/7.5 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |

| `deepseek-v4-pro-0813` | 1000000 | 393216 | No | hybrid | Unpriced (time dependent) | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-pro) |
| `deepseek-v4-flash-0731` | 1000000 | 393216 | No | hybrid | Unpriced (time dependent) | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-flash) |
| `qwen3.8-max-0902` | 1000000 | 131072 | Yes | hybrid | >0: 2/6 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max) |
| `qwen3.5-plus-2026-04-20` | 1000000 | 65536 | Yes | hybrid | >0: 0.4/2.4; >256000: 0.5/3 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-plus) |
| `qwen3-coder-plus-2025-09-23` | 1000000 | 65536 | No | none | >0: 1/5; >32000: 1.8/9; >128000: 3/15; >256000: 6/60 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-plus) |

The direct Beijing Kimi route supports only max effort, immutable sampling, auto/none/required tool choice, and complete reasoning history for tool continuations. Core preserves its thinking history and rejects inline images before HTTP. Numeric limits and prices require the regional console and remain unknown. The Qwen3 Max safe default is 32768 output tokens for thinking; its documented non-thinking ceiling is retained as 65536.

Excluded current inventory categories: embedding/rerank, image/video generation, ASR/TTS/translation, realtime WebSocket-only routes and OCR require other API surfaces. Character models, QwQ/QVQ, Qwen2, older Qwen-VL and Omni Turbo have no verified tool contract in the current function-calling guide. qwen-plus-latest and dated equivalents are deployment aliases; qwen3-max-preview is an older Snapshot Versions row whose card says tools Unsupported in every region. No existing Qwen curated ID was absent from the owner's endpoint. Legacy does not mean retired: Qwen3/3.5/3.6 remain selectable when the endpoint and official documentation still support them.

Validation: the initial expanded focused suite passed 844 tests and typecheck. Linux testing identified one provider-parity fixture whose unqualified DeepSeek model became ambiguous after Alibaba hosting was added. The fixture now qualifies the native provider; the parity and new route tests pass 285 tests locally. The orchestrator records final Linux results versus main and per-model live outcomes in the PR evidence.

## Snapshot inventory decisions

Every dated chat deployment in the live endpoint is classified below. Historical snapshots remain callable via explicit model configuration; omission from the default picker does not assert retirement.

| Endpoint ID | Canonical family | Decision | Source |
| --- | --- | --- | --- |
| `qwen3.8-max-0902` | `qwen3.8-max` | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max) |
| `deepseek-v4-pro-0813` | `deepseek-v4-pro` | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-pro) |
| `deepseek-v4-flash-0731` | `deepseek-v4-flash` | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-flash) |
| `qwen3.7-flash-2026-07-15` | `qwen3.7-flash` | Same published Core chat/tool limits and capabilities as canonical; no separate contract found. Kept as an audited snapshot rather than a duplicate picker entry; equivalence of weights is not asserted. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-flash) |
| `qwen3.7-max-2026-06-08` | `qwen3.7-max` | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |
| `qwen3.7-plus-2026-05-26` | `qwen3.7-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-plus) |
| `qwen3.7-max-2026-05-17` | `qwen3.7-max` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |
| `qwen3.7-max-2026-05-20` | `qwen3.7-max` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |
| `qwen3.5-plus-2026-04-20` | `qwen3.5-plus` | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-plus) |
| `qwen3.6-flash-2026-04-16` | `qwen3.6-flash` | Same published Core chat/tool limits and capabilities as canonical; no separate contract found. Kept as an audited snapshot rather than a duplicate picker entry; equivalence of weights is not asserted. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-flash) |
| `qwen3.5-omni-plus-2026-03-15` | `qwen3.5-omni-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-omni-plus) |
| `qwen3.5-omni-flash-2026-03-15` | `qwen3.5-omni-flash` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-omni-flash) |
| `qwen3.6-plus-2026-04-02` | `qwen3.6-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-plus) |
| `qwen3.5-flash-2026-02-23` | `qwen3.5-flash` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-flash) |
| `qwen3.5-plus-2026-02-15` | `qwen3.5-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-plus) |
| `qwen3-vl-flash-2026-01-22` | `qwen3-vl-flash` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-flash) |
| `qwen3-max-2026-01-23` | `qwen3-max` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/model-qwen3-max) |
| `qwen3-vl-plus-2025-12-19` | `qwen3-vl-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-plus) |
| `qwen3-omni-flash-2025-12-01` | `qwen3-omni-flash` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-omni-flash) |
| `qwen-plus-2025-12-01` | `qwen-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |
| `qwen3-vl-flash-2025-10-15` | `qwen3-vl-flash` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-flash) |
| `qwen3-omni-flash-2025-09-15` | `qwen3-omni-flash` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-omni-flash) |
| `qwen-plus-2025-01-25` | `qwen-plus` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |
| `qwq-plus-2025-03-05` | Own architecture | No verified tool contract in current function-calling guide; not a chat/tool picker candidate. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling) |
| `qwen-plus-2025-04-28` | `qwen-plus` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |
| `qwen3-235b-a22b-instruct-2507` | Own architecture | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-235b-a22b-instruct-2507) |
| `qwen-plus-2025-07-14` | `qwen-plus` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |
| `qwen3-coder-plus-2025-07-22` | `qwen3-coder-plus` | Officially functionally equivalent to the listed canonical model. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-plus) |
| `qwen3-235b-a22b-thinking-2507` | Own architecture | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-235b-a22b-thinking-2507) |
| `qwen3-max-2025-09-23` | `qwen3-max` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/model-qwen3-max) |
| `qwen3-30b-a3b-thinking-2507` | Own architecture | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-30b-a3b-thinking-2507) |
| `qwen3-30b-a3b-instruct-2507` | Own architecture | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-30b-a3b-instruct-2507) |
| `qwen3-coder-plus-2025-09-23` | `qwen3-coder-plus` | Added: distinct current deployment or architecture with verified metadata. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-plus) |
| `qwen3-vl-plus-2025-09-23` | `qwen3-vl-plus` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-plus) |
| `qwen-plus-2025-09-11` | `qwen-plus` | Older Snapshot Versions deployment than the documented canonical replacement. Kept as a historical inventory row, not declared retired or an exact alias. | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |

Hard token or USD budgets reject reasoning deployments whose `max_tokens` caps
only the answer, before dispatch. An independent `thinking_budget` is not the
single total-output ceiling reserved by Core. Uncapped sessions remain usable;
verified total-output routes and non-thinking routes retain hard-budget support.
