# LLM API Core Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source path -->

Primary source anchors:
- `src/services/api/client.ts`
- `src/services/api/withRetry.ts`
- `src/services/api/errors.ts`
- `src/services/api/fetchWithProxyRetry.ts`
- `src/services/api/providerConfig.ts`
- API streaming source file stream-idle watchdog sections

This directory owns the TypeScript port of API-core primitives:
- `errors.ts` exposes UI-neutral error classification and mapping.
- `retry.ts` exposes retry/backoff helpers, Retry-After handling, 529 detection, and context-overflow parsing.
- `fallback-ladder.ts` exposes the repeated-overload fallback trigger and provider/model target normalization.
- `http.ts` exposes the HTTP request wrapper and stale-connection fetch retry.
