# Service Utilities Parity

Upstream reference: OC source checkout at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/notifier.ts`
- `src/services/preventSleep.ts`
- `src/services/tokenEstimation.ts`

This directory owns the AgenC port of the small service utility bundle:
- `notifier.ts` dispatches terminal notifications, runs caller-provided notification hooks, and emits caller-provided analytics metadata.
- `preventSleep.ts` keeps macOS awake during long-running work using reference-counted `caffeinate` processes and AgenC cleanup registration.
- `tokenEstimation.ts` adds provider API token counting on top of AgenC's deterministic local token-estimation helpers.
  Bedrock counting attempts an optional runtime import of `@aws-sdk/client-bedrock-runtime`; callers that ship without that optional SDK must inject a Bedrock client/module loader, and the service returns `null` when neither path is available.
