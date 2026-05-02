# Anthropic Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/api/claude.ts` <!-- branding-scan: allow donor source file path -->
- `src/services/api/openaiShim.ts`
- `src/cost-tracker.ts`
- `src/screens/REPL.tsx`

This directory owns the AgenC Anthropic Messages provider:
- `adapter.ts` owns Anthropic HTTP/SSE transport, fallback behavior, streaming
  tool-use accumulation, context-management headers, and provider error mapping.
- `types.ts` owns Anthropic-specific provider configuration.
- `adapter.test.ts` covers request shaping, streaming, tool-use, prompt cache,
  vision, AGENC.md system context, usage, and fallback behavior.
- `adapter.input-json-delta-forwarding.parity.test.ts` locks streaming
  `input_json_delta` forwarding for tool-use UI consumers.

Shared request/response conversion lives in `runtime/src/llm/wire/messages-anthropic.ts`.
