# Ollama Provider Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/utils/providerDiscovery.ts`
- `src/utils/providerAutoDetect.ts`
- `src/utils/providerRecommendation.ts`

This directory owns the AgenC Ollama provider:
- `adapter.ts` is the first-class native SDK provider for local Ollama chat,
  streaming, tool routing, context-window profile resolution, local connection
  errors, and request diagnostics.
- `types.ts` owns the Ollama-specific provider configuration surface.
- `health.ts` wraps shared local-provider stream health polling with the Ollama
  provider label.
- `index.ts` is the canonical import entrypoint for the provider.
- `provider.test.ts` covers native request construction, request-scoped local
  model selection, assistant tool-call history, native tool-call parsing,
  streaming, health checks, connection-refused errors, and local health-sidecar
  abort behavior.

Compatibility exports for the historical path live in:
- `runtime/src/llm/ollama/index.ts`

Shared provider factory, model metadata, and defaults live in:
- `runtime/src/llm/provider.ts`
- `runtime/src/config/resolve-provider.ts`
- `runtime/src/llm/_deps/config.ts`
- `runtime/src/llm/model-metadata.ts`
