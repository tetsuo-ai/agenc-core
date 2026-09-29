# Qwen current chat catalog, 2026-09-29

The live Singapore PAYG models endpoint and official Alibaba documentation identify 50 additional current chat/tool deployments. They are registered only on Qwen PAYG. The Token Plan's five-model allowlist is unchanged. Catalog formats remain stable for model selection consumers and Desktop generation.

Sources: [function calling families](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling), [Chat Completions parameters](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), [thinking modes](https://www.alibabacloud.com/help/en/model-studio/deep-thinking), [GLM route](https://www.alibabacloud.com/help/en/model-studio/glm), [Kimi route](https://www.alibabacloud.com/help/en/model-studio/kimi-api), [Omni route](https://www.alibabacloud.com/help/en/model-studio/qwen-omni), and [Singapore pricing and decimal tier units](https://www.alibabacloud.com/help/en/model-studio/model-pricing).

The per-model links below supply exact numeric context/output limits, modalities and Singapore text rates. Prime and direct vendor routes publish only shorthand or unavailable numeric limits, so those fields remain absent. A missing rate uses Core's existing conservative unpriced admission. No rate from a model's native provider is borrowed for Alibaba hosting. Variable thinking-mode, time-of-day and modality-dependent prices stay unpriced when the cost sidecar cannot determine the billing dimension. Explicit-cache rates are not substituted for implicit-cache rates.

Some older Singapore cards label function calling Unsupported, while Alibaba's current function-calling guide explicitly includes their families. The owner's existing qwen3-coder-plus passed real Core chat and tool calls on Linux on this audit, contradicting the same card label. Family tool support follows the functional guide; each new deployment receives its own live attempt and failures remain evidence, not invented successes.

The runtime buffers required SSE for older open-source thinking models and Omni behind chat(), preserving tool arguments, reasoning provenance and authoritative usage. Older Qwen routes use max_tokens for the answer and a bounded thinking_budget when reasoning is enabled. Hosted GLM/Kimi/DeepSeek use the documented total-output max_completion_tokens. GLM's tool_stream and preserved-thinking fields use Alibaba's top-level spellings. Thinking-only deployments never receive enable_thinking:false from forced tool selection. The two direct vendor routes are held from paid checks until a total-output bound for those exact routes is verified.

Existing qwen3.7-plus and qwen3.7-flash output limits are corrected from 65536 to 131072. Qwen3.8 27B and 2.4T gain the documented low/medium/xhigh effort controls. Eight already-listed models gain verified Singapore prices, including multi-tier Coder prices. The June 8 Qwen3.7 Max snapshot is included because it adds vision to the canonical text-only Max route; true dated equivalents remain unlisted duplicates.

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
| `qwen3-32b` | 131072 | 8192 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-32b) |
| `qwen3-next-80b-a3b-thinking` | 131072 | 32768 | No | always | >0: 0.15/1.2 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-next-80b-a3b-thinking) |
| `qwen3-next-80b-a3b-instruct` | 131072 | 32768 | No | none | >0: 0.15/1.2 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-next-80b-a3b-instruct) |
| `qwen-max` | 32768 | 8192 | No | none | >0: 1.6/6.4 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-max) |
| `qwen-plus` | 1000000 | 32768 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) |
| `qwen-turbo` | 131072 | 16384 | No | hybrid | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-turbo) |
| `ZHIPU/GLM-5.3` | Unpublished | Unpublished | No verified image contract | always | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |
| `kimi/kimi-k3` | Unpublished | Unpublished | No verified image contract | always | Unpriced | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |
| `qwen3.7-max-preview` | 1000000 | 131072 | No | always | >0: 2.5/7.5 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |
| `qwen3.7-max-2026-06-08` | 1000000 | 131072 | Yes | hybrid | >0: 2.5/7.5 | [Official](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max) |

Excluded current inventory categories: embedding/rerank, image/video generation, ASR/TTS/translation, realtime WebSocket-only routes and OCR require other API surfaces. Character models, QwQ/QVQ, Qwen2, older Qwen-VL and Omni Turbo have no verified tool contract in the current function-calling guide. qwen-plus-latest and dated equivalents are deployment aliases; qwen3-max-preview is an older Snapshot Versions row whose card says tools Unsupported in every region. No existing Qwen curated ID was absent from the owner's endpoint. Legacy does not mean retired: Qwen3/3.5/3.6 remain selectable when the endpoint and official documentation still support them.

Validation: focused registry, wire, Qwen provider, reasoning and cost suite passed 828 tests before the additional six focused route/stream/pricing tests, which also passed. Final typecheck, Linux suite versus main baseline and all live outcomes are recorded by the task orchestrator in the PR evidence after the pushed branch is tested.
