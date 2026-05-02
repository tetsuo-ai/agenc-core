# Grok Provider Parity

Reference source: `runtime/src/llm/grok/` in this repository at commit
`559904c8df2fa48d6bf2dd55290a7c1afd36554d`.

Primary source anchors:
- `runtime/src/llm/grok/adapter.ts`
- `runtime/src/llm/grok/adapter-utils.ts`
- `runtime/src/llm/grok/auth-refresh.ts`
- `runtime/src/llm/grok/incremental.ts`
- `runtime/src/llm/grok/types.ts`

This directory owns the canonical Grok provider implementation:
- `adapter.ts` is the xAI Responses API provider adapter.
- `adapter-utils.ts` owns trace, stateful continuation, and tool-selection helpers.
- `auth-refresh.ts` owns bounded 401 refresh retry behavior.
- `incremental.ts` owns `previous_response_id` tracking and cleanup hooks.
- `types.ts` owns provider-specific configuration types.

The historical `runtime/src/llm/grok/` files are compatibility exports only.
