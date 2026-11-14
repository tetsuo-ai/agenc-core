# DeepSeek App tools, 2026-11-13

Verified against the [launch announcement](https://api-docs.deepseek.com/news/news261113/),
[chatbot guide](https://api-docs.deepseek.com/guides/build_a_chatbot), and the linked official guides on 2026-11-13.
These are server tools on `deepseek-flash` (V4.1-Flash-1017), available through Chat Completions,
Responses and Messages. They are separate from the standalone Search and Fetch APIs already used by Core.

| Capability | Published contract |
| --- | --- |
| [Web Search](https://api-docs.deepseek.com/guides/web_tools#web-search) | Declare `deepseek_web_search` with thinking disabled. The service searches the web or images and returns citations. |
| [Deep Thinking Search](https://api-docs.deepseek.com/guides/web_tools#search-while-thinking) | The same declaration with thinking enabled permits repeated search, open-page and find-in-page steps, up to about 20 tool calls. |
| [URL Reading](https://api-docs.deepseek.com/guides/web_tools#read-links) | `deepseek_read_url` considers the first 10 distinct URLs in the last user message. With thinking and web search enabled, deep search handles links instead of a separate read-link stage. |
| [File Parsing](https://api-docs.deepseek.com/guides/document_parsing) | Upload first, then reference `file_id`. `text_recognition` extracts text; `rich_layout_recognition` also crops figures. Limits: 100 MiB, 1,000 pages, 20 document references and 8 MiB of text per chat request. Plain text, spreadsheets and ebooks use `user_data` without parsing fees. |
| [Model Content Safety](https://api-docs.deepseek.com/guides/safety) | `safety_check: {level: "high"}` reviews inputs and outputs; `low` is the default. The docs require high for public services and describe the service provider's own moderation obligations. Chat Completions signals refusals with `content_filter`, possibly after text streamed. Safety tokens are included in billed output. |

[Web Tools](https://api-docs.deepseek.com/guides/web_tools#chat-completions-api) documents the native Core wire:
`message.server_tool_calls` is an ordered array of steps, each with its own `reasoning_content` and `calls`.
Calls contain `action`, `kind`, `status`, sources/page/error and, for successful URL reading, an opaque `signature`.
`message.reasoning_content` is only the final step's thinking. Citations are `annotations[].url_citation`;
their offsets count Unicode code points, not UTF-16 units. The answer itself contains no citation markers.
Streams send progress in `choices[].server_tool_event`, beside `delta`. The final delta carries complete
`server_tool_calls` and `annotations`; progress events do not carry the signed page.

Replay the full history and returned blocks unchanged, including unknown fields, `kind` and `signature`.
Search results, opened search pages and previous-round thinking are not restored to subsequent context.
Only the answer text remains, plus URL-reading pages restored from valid signatures. Dropping a signature
silently loses that page; history containing server blocks can be sent even when tools are no longer declared.
Continuing a partial assistant response that used web tools is unsupported; resend the original request.

Declaring either tool makes Chat Completions ignore `temperature`, `top_p`, `frequency_penalty`,
`presence_penalty`, `stop`, `seed`, `n`, `preserve_thinking` and `parallel_tool_calls`.
`max_tokens` still applies, but **per inference step**, not to the whole request.
`web_search_options`, non-text `response_format`, `logprobs` and `top_logprobs` are rejected.
`tool_choice: "none"` disables all tools, `required` behaves as `auto`, and neither server tool can be forced by name.
These restrictions also apply when high safety review or title generation activates the App service.

[Pricing](https://api-docs.deepseek.com/quick_start/pricing#web-tools-pricing): each billed text search,
image search or page fetch costs $0.00075, in addition to tokens. A successful search bills each query;
empty/failed searches do not bill. Reopening cached pages and find-in-page are free. Use the final
`usage.server_tool_use.tool_search`, `tool_fetch`, and `tool_image_search` counts. The Messages-format
`web_search_requests` and `web_fetch_requests` count displayed result blocks, including errors, and are
**not** billing counters. Final token usage sums all inference steps, not just the final answer.
File parsing/OCR costs $0.225 per 1,000 successfully parsed pages, once at upload; referenced content also
incurs input tokens on each chat request.

Flash token prices per million are $0.006 cache hits, $0.30 misses and $1.20 output at peak, half at off-peak.
Peak is weekdays 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays; all other hours are
off-peak. Tool fees have no published off-peak discount. Core's existing native token estimates use peak rates.

## Core opt-in

Set top-level `web_search = "on"` (or session `AGENC_WEB_SEARCH=on`) and
`[providers.deepseek] app_tools = true` (or session `AGENC_DEEPSEEK_APP_TOOLS=on`).
The setting defaults off and applies only to native `deepseek` Flash sessions, including full and lean requests.
The App tools replace the two local web definitions; coding functions remain available. Existing standalone
`providers.deepseek.web_search` and `web_fetch` settings keep their original meanings.
Both web tools must be available in the session's tool catalog. Explicit ask/deny rules or domain-qualified
web rules keep the local web path, since the server cannot apply those rules. App tools retain thinking
on coding turns; the thinking-off recovery switch is not applied to this mode. Hard token or dollar caps
reject App mode through admission because the API has no request-wide output ceiling. An uncapped session
records all billed inference steps and tool units. App usage is excluded from prompt-size calibration.

The transcript shows search/read steps, Unicode-aware citation markers and linked sources. Exact wire
content, annotations and server calls are retained in the existing provider/model-bound durable replay
carrier; display formatting never changes that replay. Valid page ciphertext survives secret redaction;
if redaction changes ordinary replay text, the existing durable-history policy drops the replay as a unit.

## Live observations

Recorder-backed probes and exact receipts are in the dsweb13 job folder. No credentials enter the probe clients.
On 2026-11-13, a mixed request with both server tools plus `exec_command` and `FileRead` returned HTTP 400
with thinking disabled: client tools are supported together with App features only in thinking mode.
The same request with thinking enabled returned a valid `FileRead` function call. This restriction was not
stated in the Web Tools guide's client-tool discussion at retrieval time.

A thinking search billed one search. Its next request replayed the complete assistant message and reported
2,048 cached tokens out of 3,255 prompt tokens. Repeating that request with `preserve_thinking: false`
reported the same prompt and cache counts as `true`. Prefix caching therefore survives this search in the
observed case; the service's documented context reconstruction does not promise full-prefix reuse.
A streamed URL read returned a signed call, and its follow-up answered from that page without another fetch.


A second streamed thinking search, with both local functions still declared, returned server progress and
terminal blocks. The search → `FileRead` → tool-result continuation also completed. A 500-marker addition
to the previous final reasoning left the next prompt at 3,255 tokens, the same as unmodified replay:
that thinking was not inserted into next-round context. One unconstrained probe chose a local shell call
instead of search; the probe did not execute it. Tool declarations permit server search but do not force it.

The 12 requests ran from 20:56 to 21:07 UTC, all off-peak. Eleven succeeded; the non-thinking mixed-tools
probe returned the expected 400. Total metered token and tool cost was **$0.006132036** (three tool units,
$0.00225 in fees, plus $0.003882036 tokens). Recorder cap: $0.95. The recorder's final credential exposure
scan was clean. These are observed cases, not a cache-hit guarantee across models, gateways or future releases.
