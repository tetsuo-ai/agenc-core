# Phase F Proper — COMPLETE

**Status as of 2026-04-07**: Phase F proper is done. The ChatExecutor class body extraction finished with PR #293 on `main`. `chat-executor.ts` shrank from **2,023 LOC → 508 LOC** (-75%, exceeding the original ~650 LOC target). All 9 orchestration modules live as free functions in sibling files. See [`docs/REFACTOR-LOG.md`](docs/REFACTOR-LOG.md) for the full per-PR ledger and end-state module map.

**Merged PR sequence** (runnable in order from the `pre-phase-f-pr1` tag):

| # | PR | Branch | Scope |
|---|---|---|---|
| PR-1 | #285 | `refactor/exec-f-pr1-ctx-state` | Cluster 1 (pure ctx helpers) + Cluster 2 (state-map accessors) |
| PR-2 | #286 | `refactor/exec-f-pr2-config-helpers` | Cluster 3 (config-read helpers) |
| PR-3 | #287 | `refactor/exec-f-pr3-usage-helpers` | Cluster 7 (usage utilities, private methods deleted outright) |
| PR-4 | #288 | `refactor/exec-f-pr4-message-mutation-and-shim-cleanup` | Cluster 4 + Cluster 5 (PR #280 shim cleanup) |
| PR-5 | #289 | `refactor/exec-f-pr5-tool-loop-callback-wiring` | Cluster 6 (callback wiring into chat-executor-tool-loop.ts) |
| PR-6 | #290 | `refactor/exec-f-pr6-compaction-fallback` | E1 + E2 + E3 (in-flight compaction, history compaction, fallback wrapper deletion) |
| PR-7 | #291 | `refactor/exec-f-pr7-injection-model-orchestration` | E4 + E5 (context injection + model orchestration) |
| **PR-8** | **#292** | **`refactor/exec-f-pr8-init-request-class-shrink`** | **KEYSTONE.** E6 + E0 + class shrink (init + executeRequest + DI-container form) |
| PR-9 | #293 | `refactor/exec-f-pr9-delete-planner-stub` | Delete `chat-executor-planner.ts` + inline dead branches |

**Final class residual** (508 LOC, `runtime/src/llm/chat-executor.ts`):

- 30 readonly fields + constructor — the DI container shape, unchanged.
- 5 public methods — `execute`, `getSessionTokenUsage`, `resetSessionTokens`, `clearAllSessionTokens`, `clearCooldowns`.
- 3 dep-struct builders — `buildHistoryCompactionDeps`, `buildCallModelForPhaseDeps`, `buildExecuteRequestDeps`.
- 2 thin delegators — `callModelForPhase` (for the tool-loop callback seam) and `executeToolCallLoop` (for the request-orchestration seam). Both are 1-call wrappers around free helpers.
- 1 static helper — `normalizeRequestTimeoutMs`, used at construction time only.

---

## Remaining optional cleanups

The following items were on the original Phase F plan but are **not required** for the class extraction to ship. They are low-risk, mechanical, and can land as independent follow-ups when there is session budget.

### PR-10 — Test split (OPTIONAL)

Split `runtime/src/llm/chat-executor.test.ts` (4,196 LOC, 107 tests) into 10 module-aligned test files + a thinned 1,500-LOC integration suite. The monolith is still green (107/107) after Phase F proper; splitting is purely an organizational cleanup.

**Why it's optional**: tests pass, baseline holds, every new sibling module is covered by integration tests that exercise its public surface via the `execute()` path. A mis-categorized test can regress coverage — better to do this in a dedicated session.

**Target file shape**:

| File | Owns |
|---|---|
| `chat-executor-ctx-helpers.test.ts` | pushMessage, setStopReason, checkRequestTimeout, emitExecutionTrace, maybePushRuntimeInstruction, replaceRuntimeRecoveryHintMessages |
| `chat-executor-state.test.ts` | buildDegradedProviderNames, getSessionCompactionState, trackTokenUsage |
| `chat-executor-config.test.ts` | resolveRunClassForPhase, resolveRoutingDecision, getContextSectionMaxChars |
| `chat-executor-usage.test.ts` | accumulateUsage, createCallUsageRecord |
| `chat-executor-in-flight-compaction.test.ts` | maybeCompactInFlightCallInput (soft/hard threshold, cooldown snapshot/restore) |
| `chat-executor-history-compaction.test.ts` | compactHistory (summary fallback, artifact merge, onCompaction hook) |
| `chat-executor-context-injection.test.ts` | injectContext (skill, memory, learning, detailed + classic) |
| `chat-executor-model-orchestration.test.ts` | callModelForPhase (routing decision, budget enforcement, fallback wiring) |
| `chat-executor-init.test.ts` | initializeExecutionContext (budget overrides, planner decision, compaction pre-check, context injection wiring) |
| `chat-executor-request.test.ts` | executeRequest (SessionStart/Stop/StopFailure hooks, terminal state, result assembly) |
| `chat-executor.test.ts` (thinned) | top-level execute() integration tests that exercise the full pipeline |

### PR-11 — Subagent stack dead-code deletion (OPTIONAL)

Delete ~1,874 LOC of identified dead code across 7 files in `runtime/src/gateway/`:

| File | Before | After | Delta |
|---|---|---|---|
| `subagent-orchestrator.ts` | 2,507 | ~1,600 | −907 |
| `subagent-prompt-builder.ts` | 1,207 | ~1,000 | −207 |
| `subagent-context-curation.ts` | 1,130 | ~900 | −230 |
| `delegation-admission.ts` | 1,130 | ~1,000 | −130 |
| `subagent-workspace-probes.ts` | 833 | ~700 | −133 |
| `subagent-infrastructure.ts` | 617 | ~550 | −67 |
| Others | various | various | ~-200 |

**Why it's optional**: the subagent stack is correct as-is. The dead code is unused helpers, deprecated templates, and defunct fallbacks identified by static analysis. No behavior change.

### PR-12 — Subagent stack consolidation (OPTIONAL, depends on PR-11)

After PR-11 has shrunk the contents, fold `subagent-prompt-builder.ts` (~1,000 LOC) and `subagent-failure-classification.ts` (~330 LOC) into `subagent-orchestrator.ts`. Reclaims ~500 LOC of file overhead. Subagent stack floor: ~11,250 LOC.

**Why it's optional**: same rationale as PR-11 — no behavior change. Realistic floor is ~11,200-11,300 LOC; the original TODO.MD target of ~7,000 was unachievable without cutting live delegation logic.

### AsyncHookRegistry port from claude_code — **NOT NEEDED**

Explicit decision, from PR-1 planning: do **not** port claude_code's `AsyncHookRegistry` pattern. AgenC's `HookRegistry` already handles every lifecycle event Phase F touches (SessionStart, Stop, StopFailure, PreToolUse, PostToolUse, PostToolUseFailure, PreCompact, PostCompact). Claude_code's AsyncHookRegistry is primarily an Ink TUI cross-request coordination layer, which AgenC doesn't have (Ink TUI is explicitly out of scope).

---

## Verification gates (for any future PR-10/11/12)

Every future PR must pass:

```
cd /home/tetsuo/git/AgenC/agenc-core
git status                                              # clean working tree
npm run typecheck --workspace=@tetsuo-ai/runtime        # tsc --noEmit clean
node runtime/scripts/check-executor-baseline.mjs        # 362+ files, 5976+ it() blocks
npx vitest run runtime/src/llm/                         # 464/464 LLM suite green
npx vitest run runtime/src/gateway/daemon-text-channel-turn.test.ts \
               runtime/src/gateway/daemon-webchat-turn.test.ts \
               runtime/src/gateway/voice-bridge.test.ts
```

### Flaky exception list (known-bad, do NOT block PRs on these)

1. `runtime/tests/marketplace-cli.integration.test.ts` — LiteSVM `DeclaredProgramIdMismatch`. Excluded by `npm run test` already.
2. `runtime/src/autonomous/desktop-executor.test.ts > "rejects concurrent goals"` — desktop automation harness race condition. Pre-existing on main.
3. `runtime/src/tools/system/server.test.ts > "persists the shared resource envelope when provided"` — channel persistence flake. Passes on retry.

---

## Rollback

- Global anchor: `git tag pre-executor-refactor` at `b8decc5` (whole-refactor escape hatch).
- Per-PR revert tags: `pre-phase-f-pr1` through `pre-phase-f-pr9`, all on origin.
- Each PR is independently revertable — free-function extractions don't change behavior, and the class-level delegators were deleted only after every call site moved.

**Phase F proper is complete. No further work is required to consider the 16-phase refactor done.** Any remaining entries in this file are explicitly optional polish.
