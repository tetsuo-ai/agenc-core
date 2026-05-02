# Provider Discovery Parity

Upstream reference: donor TypeScript repository at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/providerDiscovery.ts`
- `src/utils/providerAutoDetect.ts`
- `src/utils/providerProfile.ts`

This directory owns AgenC provider readiness discovery:
- `provider-discovery.ts` detects usable providers from BYOK credentials,
  local model-server probes, and hosted subscription-backed key vending.
- `index.ts` exposes the discovery API used by `agenc providers`.

Shape differences:
- AgenC reports readiness directly from runtime config and `AuthBackend`
  instead of writing profile environment files.
- Provider IDs and default models come from the AgenC provider registry.
