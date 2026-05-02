# OpenRouter Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/components/ProviderManager.tsx`
- `src/services/api/openaiShim.ts`

This directory owns the AgenC OpenRouter provider:
- `index.ts` specializes the shared OpenAI-compatible provider for OpenRouter,
  setting the OpenRouter API base URL, `OPENROUTER_API_KEY` label, bearer
  authentication, chat-completions transport, provider-routing metadata
  headers, and the built-in OpenRouter seed model catalog.
- `provider.test.ts` covers OpenRouter bearer auth, chat-completions routing,
  provider-routing headers, request-scoped multi-model selection, and explicit
  routing-header overrides.

Shared request/response conversion and model routing live in:
- `runtime/src/llm/providers/openai/adapter.ts`
- `runtime/src/llm/wire/chat-completions.ts`
- `runtime/src/config/resolve-provider.ts`
- `runtime/src/llm/model-metadata.ts`
