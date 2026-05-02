# Gemini Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/utils/providerProfile.ts`
- `src/utils/providerValidation.ts`
- `src/services/api/openaiShim.ts`

This directory owns the AgenC Gemini provider:
- `index.ts` specializes the shared OpenAI-compatible provider for Gemini,
  normalizing Gemini base URLs, using `GEMINI_API_KEY`, selecting
  bearer authentication, disabling Responses API routing, and
  targeting the Gemini OpenAI-compatible `/openai/chat/completions` route.
- `provider.test.ts` covers Gemini request shaping, API-key headers, base URL
  normalization, tool-call request/response parity, streaming tool-call
  accumulation, malformed streamed tool calls, and omitted `store` fields.

Shared request/response conversion lives in:
- `runtime/src/llm/providers/openai/adapter.ts`
- `runtime/src/llm/wire/chat-completions.ts`

Provider documentation evidence:
- Google AI Gemini OpenAI compatibility documentation covers bearer auth for
  Gemini OpenAI-compatible REST calls, function-calling `tools`, streaming, and
  `stream_options.include_usage` on chat-completions streams.
