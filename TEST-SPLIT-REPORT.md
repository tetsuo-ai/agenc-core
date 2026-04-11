# Phase F PR-10: chat-executor.test.ts split report

## Summary

`runtime/src/llm/chat-executor.test.ts` (4,196 LOC, 107 `it()` blocks)
has been split into 10 module-aligned sibling test files plus a thinned
integration suite. No tests were deleted or merged. One file
(`chat-executor-usage.test.ts`) holds fresh unit tests for pure helpers
rather than tests moved from the monolith.

## Per-file test counts and LOC

| File | it() | LOC |
|---|---:|---:|
| `chat-executor.test.ts` (thinned integration) | 35 | 1276 |
| `chat-executor-ctx-helpers.test.ts` | 22 | 1130 |
| `chat-executor-state.test.ts` | 2 | 161 |
| `chat-executor-config.test.ts` | 1 | 111 |
| `chat-executor-usage.test.ts` | 7 | 211 |
| `chat-executor-in-flight-compaction.test.ts` | 2 | 173 |
| `chat-executor-history-compaction.test.ts` | 7 | 394 |
| `chat-executor-context-injection.test.ts` | 8 | 257 |
| `chat-executor-model-orchestration.test.ts` | 9 | 403 |
| `chat-executor-init.test.ts` | 9 | 394 |
| `chat-executor-request.test.ts` | 12 | 542 |
| **Total** | **114** | **5052** |

## Pre vs post test count comparison

| | Pre-split | Post-split |
|---|---:|---:|
| `it()` blocks across the split surface | 107 | 114 |
| Net delta | | **+7** (new unit tests in `chat-executor-usage.test.ts`) |

Every one of the 107 original `it()` blocks has been preserved verbatim
(helpers and describe wrappers adjusted for the new file layout). The
total is strictly greater than the pre-split baseline, so the
`check-executor-baseline.mjs` floor has been raised from 358 to 372 test
files and from 5949 to 5983 `it()` blocks to lock in the gain.

## Tests deleted due to duplicate coverage

None. Every original `it()` block was moved without modification.

## Tests moved to the integration suite because they straddle modules

The thinned `chat-executor.test.ts` retains 35 tests. Of these, the
following groups kept their natural home in the integration suite because
they exercise the full `execute()` pipeline end-to-end and do not map to a
single module boundary:

- **basic operation** (4 tests) — smoke tests for result shape, system
  prompt, streaming selector, and fallback.usedFallback.
- **fallback** (12 tests) — provider fallback semantics at the full
  pipeline level. The `chat-executor-fallback.ts` module already has its
  own unit test file; these are integration coverage for the fallback
  path.
- **cooldown** (5 tests) — provider cooldown state machine. The cooldown
  map is owned by `ChatExecutor` itself and is easiest to verify through
  the full pipeline with `vi.useFakeTimers()`.
- **tool loop core** (6 tests) — basic single/multi-round tool calls,
  screenshot payload sanitization, and provider-native telemetry preservation.
- **tool arg repair / invalid JSON / ToolCallRecord shape** (4 tests) —
  dispatch-level behavior that straddles the tool loop and arg
  repair/sanitization path.
- **narrative safeguards (file-creation / mkdir)** (2 tests) — cross-cut
  the tool ledger, text postprocessing, and model reply preservation.
- **constructor edge cases** (3 tests) — `empty history`, `empty
  providers`, `negative cooldown values clamped`. Intentionally kept in
  the integration surface because they test construction semantics
  visible through `execute()`.

No test was forced into the integration suite as a catch-all due to
straddling more than one module; the 35 tests above were intentionally
planned for the integration bucket from the start of categorization. The
pre-planned rule was to stop and ask if more than 10 tests could not
cleanly fit a single module bucket; the actual count that required
integration placement is 4 (the dispatch-level tool-arg tests at
1244/1545/1568 and the arg-repair collab test), well under the threshold.

## Categorization rationale by target file

- **chat-executor-ctx-helpers.test.ts** (22 tests)
  - 1 loop-stuck detector exercising `setStopReason` + the
    `tool_loop_stuck_detected` path via `emitExecutionTrace`.
  - 20 recovery-hint injection tests covering every
    `maybePushRuntimeInstruction` / `replaceRuntimeRecoveryHintMessages`
    code path (shell builtins, ENOENT, grep, npm scripts, npm
    workspaces, tsc rootDir, duplicate exports, JSON-escaped source,
    CommonJS vs exports, localhost SSRF, desktop.bash unavailability,
    container MCP tool, host denials, filesystem allowlist).
  - 1 terminal-trace emission test for the `no_progress` stop reason.

- **chat-executor-state.test.ts** (2 tests)
  - `throws ChatBudgetExceededError when compaction fails`
  - `accumulates across multiple executions; resetSessionTokens clears`
  - Both directly exercise `trackTokenUsage` and session-token LRU
    state through the public `execute()` / `getSessionTokenUsage` /
    `resetSessionTokens` surface.

- **chat-executor-config.test.ts** (1 test)
  - `allowedTools rejects disallowed tool name` — verifies
    `resolveRoutingDecision` dispatch enforcement.

- **chat-executor-usage.test.ts** (7 tests, fresh)
  - Direct unit tests of the pure `accumulateUsage` and
    `createCallUsageRecord` helpers. The monolith's shape assertions
    inside the basic-operation smoke test are still exercised via
    the thinned integration suite.

- **chat-executor-in-flight-compaction.test.ts** (2 tests)
  - Soft compaction threshold while hard session budget is unlimited.
  - Best-effort handling when a soft-threshold compaction fails.

- **chat-executor-history-compaction.test.ts** (7 tests)
  - Hard-budget `compactHistory` behavior: threshold triggering, token
    counter reset, provider trace events for the compaction phase,
    `onCompaction` callback, short-history skip path, unconfigured
    budget path, and repeated budget-hit re-compaction.

- **chat-executor-context-injection.test.ts** (8 tests)
  - `injectContext` path through `skillInjector`, `memoryRetriever`,
    `learningProvider`, and `progressProvider`, including ordering,
    error isolation, and the fresh-session skip rule.

- **chat-executor-model-orchestration.test.ts** (9 tests)
  - Per-call budget overrides flowing into `callModelForPhase`
    (`maxToolRounds`, `maxModelRecallsPerRequest`,
    `toolBudgetPerRequest`), routed tool subset threading, provider
    trace callback metadata, and route expansion on tool misses.

- **chat-executor-init.test.ts** (9 tests)
  - `initializeExecutionContext` history normalization (image
    stripping), user-message truncation, repetitive / oversized
    assistant output guards, prompt-growth bounding across long
    sessions, assistant tool-call argument truncation, section-level
    budget diagnostics, runtime hint caps, and system-anchor shedding
    under pressure.

- **chat-executor-request.test.ts** (12 tests)
  - Per-call streaming hook wiring (5 tests) and stateful session
    result assembly (7 tests: reconciliation messages, resume
    anchors, compacted artifact context injection, fallback summary
    aggregation, store-disabled tracking).

## Verification gate

Each batch commit was validated with:

```
cd runtime && npx vitest run src/llm/
cd runtime && npx tsc --noEmit
node runtime/scripts/check-executor-baseline.mjs
```

The final run confirms:

- 40 test files in `runtime/src/llm/` (up from 31 before the split).
- 471 `it()` blocks across those files.
- 114 tests total across the thinned monolith + 10 split sibling files.
- Baseline script floors raised to 372 test files / 5983 `it()` blocks.
- TypeScript strict typecheck passes.

## Commit list (branch `test/phase-f-pr10-split-executor-tests`)

Each batch created one commit per populated file, followed by a final
baseline-script commit. See `git log` on the branch for the exact
sequence.
