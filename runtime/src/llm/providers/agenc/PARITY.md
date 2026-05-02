# AgenC Provider Stub Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow donor source root path -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerProfiles.ts`
- `src/components/ProviderManager.tsx`

This directory owns the AgenC-hosted provider scaffold:
- `index.ts` exposes the `LLMProvider` interface for the hosted `agenc`
  route while delegating concrete provider choice to `AuthBackend`.
- `provider.test.ts` covers inference, managed key vending, delegate caching,
  streaming, execution profiles, health fallback, and recursive route rejection.

Full hosted model routing is owned by A-04. LP-19 establishes the provider
directory, exported interface shape, and provider-factory entry point.
