# Direct DeepSeek in AgenC

The native `deepseek` provider supports `deepseek-v4-flash` and
`deepseek-v4-pro`. Their registered reasoning levels are `low`, `high`, and
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
must finish streaming before execution. Images remain unsupported on these
two text model entries.

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

Desktop can send the internal `session.applyConfig` request with an exclusive
`reasoningEffort` field before a turn. It validates the selected model's
native levels, rejects a running turn, records the durable runtime setting,
and changes neither permission policy nor disk configuration. It cannot be
combined with `profile` or `reload`. Desktop must wait for acknowledgement
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
