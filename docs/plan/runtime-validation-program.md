# Runtime Validation Program

This document converts the named validation gates and benchmark fixtures
from [runtime-replacement.md](./runtime-replacement.md) into
the current `agenc-core/runtime` file map.

It is intentionally literal:

- if a gate already has live tests, this doc points at them
- if a gate only has source seams and no direct suite yet, this doc says so
- if a benchmark harness is not runnable yet, this doc records the reserved
  location without pretending it is green

## Compatibility Gates

| Gate | Current runtime surfaces | Current validation files | Status |
| --- | --- | --- | --- |
| `cli-compat-suite` | `runtime/src/bin/agenc.ts`, `runtime/src/bin/slash.ts`, `runtime/src/commands/dispatcher.ts` | `runtime/src/bin/agenc.test.ts`, `runtime/src/bin/agenc.cli-branch.test.ts`, `runtime/src/bin/slash.test.ts`, `runtime/src/commands/dispatcher.test.ts` | Active |
| `bridge-session-suite` | `runtime/src/bridge/createSession.ts`, `runtime/src/bridge/sessionIdCompat.ts` | `runtime/src/bridge/createSession.test.ts` | Active for the current bridge-session compatibility contract; `runtime/src/bridge/bridgeApi.ts` remains an upstream stub surface |
| `sdk-session-suite` | `runtime/src/entrypoints/agentSdkTypes.ts` | `runtime/src/entrypoints/agentSdkTypes.test.ts` | Active for current compatibility stub contract |
| `mcp-attach-suite` | `runtime/src/session/mcp-startup.ts`, `runtime/src/session/observer-wiring.ts`, `runtime/src/mcp-client/manager.ts`, `runtime/src/mcp-client/tool-bridge.ts`, `runtime/src/mcp-client/resource-bridge.ts`, `runtime/src/mcp-client/prompt-bridge.ts` | `runtime/src/session/mcp-startup.test.ts`, `runtime/src/session/observer-wiring.test.ts`, `runtime/src/mcp-client/manager.test.ts`, `runtime/src/mcp-client/tool-bridge.test.ts`, `runtime/src/mcp-client/resource-bridge.test.ts`, `runtime/src/mcp-client/prompt-bridge.test.ts` | Active |
| `sidecar-consumer-suite` | `runtime/src/session/sidecar.ts`, `runtime/src/session/error-log.ts`, `runtime/src/session/cost.ts` | `runtime/src/session/sidecar.test.ts`, `runtime/src/session/error-log.test.ts`, `runtime/src/session/cost.test.ts`, `runtime/src/session/cost-persistence.test.ts`, `runtime/src/bin/agenc.test.ts` | Active |
| `tty-vs-headless-suite` | `runtime/src/bin/agenc.ts`, `runtime/src/permissions/evaluator.ts`, `runtime/src/permissions/denial-tracking.ts` | `runtime/src/bin/agenc.cli-branch.test.ts`, `runtime/src/permissions/evaluator.test.ts`, `runtime/src/permissions/denial-tracking.test.ts` | Active |
| `event-schema-consumer-suite` | `runtime/src/session/event-log.ts`, `runtime/src/session/event-log-reducer.ts`, `runtime/src/session/session-store.ts`, `runtime/src/session/rollout-reconstruction.ts` | `runtime/src/session/event-log.test.ts`, `runtime/src/session/event-log-reducer.test.ts`, `runtime/src/session/session-store.test.ts`, `runtime/src/session/rollout-reconstruction.test.ts` | Active |

## Benchmark Fixtures

The migration plan names four benchmark fixtures up front:

- `runtime-large-session-replay`
- `runtime-large-history-compact`
- `runtime-tool-event-burst-1000`
- `runtime-approval-concurrency`

Current mapping:

| Fixture | Current source seam(s) | Current runner location | Status |
| --- | --- | --- | --- |
| `runtime-large-session-replay` | `runtime/src/session/session-store.ts`, `runtime/src/session/rollout-reconstruction.ts` | `runtime/tests/benchmark-runner.integration.test.ts` + `runtime/benchmarks/v1/runtime-replacement/manifest.json` | Runnable local capture lane; baseline file lives at `runtime/benchmarks/artifacts/runtime-replacement/runtime-large-session-replay.baseline.json` |
| `runtime-large-history-compact` | `runtime/src/llm/compact/session-memory-compact.ts`, `runtime/src/llm/compact/compact.ts` | `runtime/tests/benchmark-runner.integration.test.ts` + `runtime/benchmarks/v1/runtime-replacement/manifest.json` | Runnable local capture lane for the deterministic compact-selection/rewrite seam; baseline file lives at `runtime/benchmarks/artifacts/runtime-replacement/runtime-large-history-compact.baseline.json` |
| `runtime-tool-event-burst-1000` | `runtime/src/session/event-log.ts`, `runtime/src/session/observer-wiring.ts`, `runtime/src/mcp-client/tool-bridge.ts` | `runtime/tests/benchmark-runner.integration.test.ts` + `runtime/benchmarks/v1/runtime-replacement/manifest.json` | Runnable local capture lane; baseline file lives at `runtime/benchmarks/artifacts/runtime-replacement/runtime-tool-event-burst-1000.baseline.json` |
| `runtime-approval-concurrency` | `runtime/src/permissions/evaluator.ts`, `runtime/src/permissions/denial-tracking.ts` | `runtime/tests/benchmark-runner.integration.test.ts` + `runtime/benchmarks/v1/runtime-replacement/manifest.json` | Runnable local capture lane; baseline file lives at `runtime/benchmarks/artifacts/runtime-replacement/runtime-approval-concurrency.baseline.json` |

## Reserved Runner Notes

- `runtime/vitest.config.ts` already reserves
  `tests/benchmark-runner.integration.test.ts` from the default `vitest run`
  surface unless `AGENC_RUNTIME_BENCHMARKS=1` is set.
- The benchmark contract now lives in
  `runtime/benchmarks/v1/runtime-replacement/manifest.json`.
- Baselines are repo-relative JSON artifacts under
  `runtime/benchmarks/artifacts/runtime-replacement/`.
- Capture uses `AGENC_RUNTIME_BENCHMARK_CAPTURE=1`; verify uses
  `AGENC_RUNTIME_BENCHMARK_VERIFY=1`.
