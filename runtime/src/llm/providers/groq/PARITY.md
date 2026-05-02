# Groq Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/utils/model/openaiContextWindows.ts`
- `src/services/api/openaiShim.ts`

This directory owns the AgenC Groq provider:
- `index.ts` specializes the shared OpenAI-compatible provider for Groq,
  setting the Groq API base URL, `GROQ_API_KEY` label, bearer authentication,
  chat-completions transport, and the built-in Groq Llama/Mixtral model catalog.
- `provider.test.ts` covers Groq bearer auth, chat-completions routing, default
  Llama routing, and request-scoped Llama/Mixtral model selection.

Shared request/response conversion and model routing live in:
- `runtime/src/llm/providers/openai/adapter.ts`
- `runtime/src/llm/wire/chat-completions.ts`
- `runtime/src/config/resolve-provider.ts`
- `runtime/src/llm/openai-compatible-token-limits.ts`
