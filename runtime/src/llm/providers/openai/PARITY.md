# OpenAI Provider Parity

Upstream reference: `/home/tetsuo/git/codex` at commit <!-- branding-scan: allow donor source root path -->
`48791920a8b122939c4d3feb15673c0a690ca4a0`.

Primary source anchors:
- `codex-rs/codex-api/src/common.rs` <!-- branding-scan: allow donor source file path -->
- `codex-rs/codex-api/src/endpoint/responses.rs` <!-- branding-scan: allow donor source file path -->
- `codex-rs/codex-api/src/sse/responses.rs` <!-- branding-scan: allow donor source file path -->
- `codex-rs/codex-api/src/requests/responses.rs` <!-- branding-scan: allow donor source file path -->
- `codex-rs/tools/src/responses_api.rs` <!-- branding-scan: allow donor source file path -->

This directory owns the AgenC OpenAI provider:
- `adapter.ts` owns OpenAI HTTP/SSE transport, Responses API routing,
  chat-completions fallback routing, fallback ladder behavior, streaming
  tool-call accumulation, stored-response helpers, and provider error mapping.
- `auth.ts` owns API-key and OAuth bearer-header resolution plus one-shot
  OAuth refresh retry behavior.
- `types.ts` owns OpenAI-specific provider configuration.
- `adapter.test.ts` covers request shaping, streaming, OAuth refresh, Responses
  tool calls, chat-completions fallback, malformed streamed tool calls, usage,
  and compatibility-provider auth modes.

Shared request/response conversion lives in:
- `runtime/src/llm/wire/responses-openai.ts`
- `runtime/src/llm/wire/chat-completions.ts`
