# Generic OpenAI-Compatible Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/components/ProviderManager.tsx`
- `src/utils/providerDiscovery.ts`
- `src/services/api/openaiShim.ts`

This directory owns the AgenC generic OpenAI-compatible provider:
- `index.ts` specializes the shared OpenAI provider adapter for self-hosted
  OpenAI-compatible endpoints, setting optional bearer authentication,
  chat-completions transport, and local default routing.
- `provider.test.ts` covers no-auth local operation, optional bearer auth,
  custom base URLs, and request-scoped local model selection.

Shared request/response conversion and model routing live in:
- `runtime/src/llm/providers/openai/adapter.ts`
- `runtime/src/llm/wire/chat-completions.ts`
- `runtime/src/llm/provider.ts`
- `runtime/src/llm/model-metadata.ts`
