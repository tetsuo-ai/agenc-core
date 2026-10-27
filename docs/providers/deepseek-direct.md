# Direct DeepSeek in AgenC

The native `deepseek` provider supports `deepseek-flash` (DeepSeek V4.1 Flash,
the default) and `deepseek-v4-pro`. The older IDs `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` still resolve to the Flash entry. Their registered reasoning levels are `low`, `high`, and
`max`, with `high` as the default. `max` remains literal on the wire.
Managed AgenC models and OpenRouter routes keep their separate contracts.

The catalog advertises a 1,048,576-token context, a 64,000-token default
response budget, and a 384,000-token provider output ceiling. An explicit
`max_output_tokens` setting still takes precedence. When diagnosing repeated
output exhaustion, inspect user, project, and profile overrides: an old
8,192-token pilot setting can truncate reasoning or file-writing arguments.
Remove that override only when it is no longer intended; do not change the
managed promotion's spending limits.

Thinking is enabled explicitly. Native requests omit `tool_choice`,
`parallel_tool_calls`, and temperature, and replay `reasoning_content` only
for messages with matching provider and model provenance. Tool arguments
must finish streaming before execution. `deepseek-flash` accepts image
input; `deepseek-v4-pro` does not.

`AGENC_DEEPSEEK_REASONING_ONLY_REPLAY=1` is an experimental, default-off
switch for the native provider. With tools available and thinking enabled, it preserves
provider-owned assistant reasoning whose visible body is empty, including a
reasoning-only output-cap response followed by recovery and re-enabled thinking. Generic message
normalization otherwise drops that empty assistant message. Only matching
provider and model provenance permits retention; the returned text is sent
unchanged as `reasoning_content`. Thinking-off recovery omits this additional
replay because a four-call acceptance probe found that the provider did not
count its reasoning text as input in that mode. Effort, output caps,
tool validation and retry limits keep their existing behavior. Token
admission includes the retained reasoning. The extra input may exhaust task
budgets sooner, and retained partial reasoning may reinforce a mistaken plan.
This is a continuity experiment, with no measured solve-preserving benefit.
The session captures the switch at ingress; it does not read mutable process
environment during a turn.

On Node, native DeepSeek uses HTTP/1.1 through the existing dispatcher without
changing its TLS or proxy policy. The HTTP/2 fetch path can queue a POST body
behind another streaming response: a Low request was observed waiting 44 seconds
before its body was sent while a High conversation ran. The provider-scoped
transport lets separate conversations use concurrent HTTPS connections. Explicit
`fetchImpl` transports remain authoritative, and Bun keeps its native stack.
The regression test keeps one verified HTTPS response open and requires a second
POST to finish before the first is released.

The same rule applies to DeepSeek through AgenC's managed gateway, constructed
by `buildManagedGatewayProvider`, rather than the ordinary OpenRouter adapter.
Its internal model key is prefixed `openrouter/deepseek/`. Both direct and
managed construction paths are exercised against the verified HTTPS fixture.
Managed admission, idempotency, credit reservations and route policy remain
owned by the backend. This transport change does not relax those controls.

Managed DeepSeek also preserves its returned plaintext `reasoning` when runtime
reminders or a later user message follow tool results. The earlier adjacent-only
rule discarded it at those boundaries. Replay remains restricted to the same
provider and exact model; it does not copy reasoning to another route.
The managed wire tests cover streaming and complete responses at Low/High/Max,
with both runtime reminders and subsequent user requests between calls.
This follows the [OpenRouter reasoning continuity contract](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning).

Generated context following a tool result is included in that result's wire
message for managed DeepSeek. A standalone user-role reminder started a new
turn on the hosted route and the model repeatedly abandoned the actual task.
Only the runtime's `user_context` marker permits this projection; user-authored
reminder text remains a user message. The context is never promoted to system
authority. Canonical history, original tool evidence, and other providers keep
their existing representation. Tests use the actual attachment renderer for
deferred MCP discovery and check that subsequent human instructions remain
separate.

Desktop can send the internal `session.applyConfig` request with an exclusive
`reasoningEffort` field before a turn. It validates the selected model's
native levels, rejects a running turn, records the durable runtime setting,
and changes neither permission policy nor disk configuration. It cannot be
combined with `profile` or `reload`. `reasoningEffort: null` clears the
session's effort so the model runs at its default; daemons that accept it
advertise `session.applyConfig.reasoningEffortClear`. Desktop must wait for acknowledgement
and reapply the captured selection after a cold resume.

The provider contract tests cover native effort, explicit output overrides,
reasoning provenance, and streaming tool continuation. Runner and dispatcher
tests cover the idle-session update and its validation. Desktop generates
its model metadata from `runtime/src/llm/registry/deepseek-models.ts` using
`scripts/generate-deepseek-models.mjs` in the Desktop repository.

Provider references checked on 2026-09-10:

- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/

## Web search

In a `deepseek` session the WebSearch tool searches through DeepSeek's Search
API (`POST /v1/tools/search`, DeepSeek's own engine) with the session's key.
The API takes no model, so it serves `deepseek-flash` and `deepseek-v4-pro`
alike. DeepSeek's other search route, the Responses API `web_search` tool, is
ignored on `deepseek-flash`, and Chat Completions has no search tool, so AgenC
does not use them.

A search runs only when the model calls WebSearch. The request carries the
model's query and a result count, nothing else from the conversation. The
query is cut at a word boundary to DeepSeek's 128-character limit (the result
then shows the text sent as `query_sent`), and `allowed_domains` and
`blocked_domains` are sent as `site:` and `-site:` operators when they fit and
are also applied to the results. The model receives each result's title, URL,
snippet, publication date, site name and DeepSeek's summary, capped at 600
characters, under `source: "deepseek_search"`, so its answer can cite them.

Each successful search costs $0.75 per 1,000; a search with no results is free.
The charge is counted in the session cost as the WebSearch call's own price,
and the results count as ordinary input on the next model call.

`[providers.deepseek] web_search` sets it in `config.toml`, and
`AGENC_DEEPSEEK_WEB_SEARCH` in the session environment wins over it:

| Value | Behavior |
| --- | --- |
| unset (default) | On when the session uses DeepSeek's own API host (`https://api.deepseek.com`) and no `tools_config.web_search_endpoint` or `AGENC_WEB_SEARCH_ENDPOINT` is set |
| `true` / `1` | On for any DeepSeek base URL (its `/v1/tools/search` path), ahead of a configured search endpoint |
| `false` / `0` | Off; WebSearch uses the configured endpoint or DuckDuckGo |

If a search fails (an HTTP error such as 402 for insufficient balance, a
timeout or a network error) or finds nothing, WebSearch continues with its
usual chain, the configured endpoint and then DuckDuckGo, and the result
carries `deepseek_search_fallback` with the reason. The TUI shows it on the
WebSearch row, for example `8 results via DuckDuckGo (DeepSeek search: HTTP
404: Not Found)`; a row from DeepSeek reads `8 results via DeepSeek search`,
and ctrl+o lists each source's title and URL. The first failure in a session
is also recorded as a `deepseek_web_search_failed` warning event for the
daemon log and SDK clients. Other providers' sessions are unchanged.

Provider references checked on 2026-10-19:

- https://api-docs.deepseek.com/guides/search
- https://api-docs.deepseek.com/api/search
- https://api-docs.deepseek.com/guides/responses_api
- https://api-docs.deepseek.com/quick_start/pricing/
