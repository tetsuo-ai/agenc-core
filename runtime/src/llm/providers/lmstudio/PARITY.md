# LM Studio Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/utils/providerDiscovery.ts`
- `src/utils/providerAutoDetect.ts`
- `src/services/api/openaiShim.ts`

This directory owns the AgenC LM Studio provider:
- `index.ts` specializes the shared OpenAI-compatible provider for LM Studio,
  setting the local default base URL, optional `LMSTUDIO_API_KEY` bearer
  authentication, chat-completions transport, and stream health sidecar.
- `health.ts` wraps shared local-provider stream health polling with the LM
  Studio provider label.
- `provider.test.ts` covers no-auth local operation, optional bearer auth,
  request-scoped local model selection, chat-completions streaming, and local
  health-sidecar abort behavior.

Shared local endpoint discovery, model metadata, and request/response conversion
live in:
- `runtime/src/llm/providers/shared/local-health.ts`
- `runtime/src/llm/providers/openai/adapter.ts`
- `runtime/src/llm/wire/chat-completions.ts`
- `runtime/src/llm/provider.ts`
- `runtime/src/llm/model-metadata.ts`
