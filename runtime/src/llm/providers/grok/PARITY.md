# Grok Provider Parity

Reference source: `runtime/src/llm/grok/` in this repository at commit
`559904c8df2fa48d6bf2dd55290a7c1afd36554d`.

Primary source anchors:
- `runtime/src/llm/providers/grok/adapter.ts`
- `runtime/src/llm/providers/grok/adapter-utils.ts`
- `runtime/src/llm/providers/grok/auth-refresh.ts`
- `runtime/src/llm/providers/grok/incremental.ts`
- `runtime/src/llm/providers/grok/types.ts`

This directory owns the canonical Grok provider implementation:
- `adapter.ts` is the xAI Responses API provider adapter.
- `adapter-utils.ts` owns trace, stateful continuation, and tool-selection helpers.
- `auth-refresh.ts` owns bounded 401 refresh retry behavior.
- `incremental.ts` owns `previous_response_id` tracking and cleanup hooks.
- `types.ts` owns provider-specific configuration types.

ZC-14 removes the old `runtime/src/llm/grok/adapter.ts` compatibility
entrypoint and duplicate old-namespace adapter tests. The canonical adapter
and adapter-utils tests live beside the provider implementation in this
directory.
