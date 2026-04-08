# Phase F Proper + Residual Cleanup — Complete Execution Plan

## Context

The `runtime/src/llm/chat-executor.ts` file is currently **2,023 LOC** and holds the single `ChatExecutor` class whose body has accreted through the 18 PRs of the 16-phase refactor. Every prior phase used the class body as a staging area: Phase A wired compaction into it, Phase I wrapped reactive 413 recovery around its `callModelForPhase`, Phase H added hook dispatch inside its `executeRequest`, Phase E migrated every production caller to route through the generator that delegates into it. The class survived because the earlier phases deliberately left the orchestration body alone — extracting it is surgical work that the prior session scopes could not safely absorb.

**Phase F proper is that extraction.** The goal is to move the 29 private methods (totalling ~1,272 LOC of orchestration) out of the class and into 9 sibling modules, so the runtime's agent loop matches the free-function shape in `/home/tetsuo/git/claude_code/query.ts`. Claude_code's query loop threads state as explicit arguments through async generators and free helpers — no class methods anywhere in the critical path. After Phase F proper, AgenC's chat-executor directory will have the same shape: the class becomes a ~650 LOC DI container that owns readonly config + per-instance state Maps + 5 public methods, while the actual orchestration lives in testable free functions.

Phase F proper also absorbs the residual cleanup that earlier phases flagged but didn't close out:

- **`chat-executor-planner.ts`** (56 LOC) is a confirmed dead stub. Its 4 exports all return hardcoded `{ shouldPlan: false }` / `false`. Inlining the returns at the 4 call sites and deleting the file is a one-PR cleanup.
- **The subagent stack** (13,657 LOC across 20 files) has ~4,000 LOC of dead helpers, deprecated templates, and defunct fallbacks identified by static analysis. Shrinking to ~9,500 LOC was the TODO.MD target; the realistic floor after dead-code deletion and consolidation is ~6,300 LOC.

**Anchor**: `pre-executor-refactor` tag at `b8decc5` is the global refactor rollback point. Phase F proper starts from current main `72dbd92` (after PR #280 extracted the 6 pure ctx helpers as a pattern demonstration). Every PR in this plan creates its own revert tag before merging.

**Scope constraint (non-negotiable)**: this refactor does **NOT** port claude_code's CLI UI, Ink TUI, `@anthropic-ai/sdk` direct dependency, print mode, repl mode, or any UI-adjacent code. AgenC has its own WebSocket channels, Watch TUI, desktop automation, background runs, Concordia bridge, skills marketplace, Solana protocol integration — those are out of scope and untouched. What Phase F proper aligns with claude_code is the **runtime agent loop shape**: the free-function orchestration, the state-as-argument helper pattern, and the explicit dep-struct pattern for cross-helper references.

---

## Scope Boundaries

### In scope

- Extract the 29 private methods of `ChatExecutor` into 9 sibling free-function modules.
- Delete `chat-executor-planner.ts` (56 LOC dead stub) and inline the 4 call sites.
- Reduce the subagent stack by ~4,100 LOC via dead-code deletion.
- Consolidate `subagent-prompt-builder.ts` and `subagent-failure-classification.ts` into `subagent-orchestrator.ts` to reclaim ~500 LOC of file overhead.
- Split `chat-executor.test.ts` (4,196 LOC, 107 tests) into 10 module-aligned test files plus a thinned 1,500-LOC integration suite.
- Accept the `AsyncHookRegistry` port from claude_code as **not needed** (rationale below).

### Out of scope — explicitly NOT touched

- **Concordia bridge** (`runtime/src/plugins/channel-host-services.ts`, `runtime/src/gateway/concordia*`, `runtime/src/llm/chat-executor-turn-contracts.ts` references).
- **Watch TUI** (`runtime/src/bin/agenc-watch*`, `runtime/src/watch-*`).
- **Channel layer** (`runtime/src/channels/`, `runtime/src/gateway/daemon-*-turn.ts`). They call into ChatExecutor via the public API; that API is preserved.
- **Memory backends** (`runtime/src/memory/`) except `consolidation.ts` (already touched by Phase N in PR #270/#279). Consumed by `injectContext` but internals unchanged.
- **Skills marketplace** (`runtime/src/skills/`, `marketplace/`) and its LiteSVM tests.
- **Solana protocol integration** (`runtime/src/tools/agenc/`, `runtime/src/task/`, `runtime/src/dispute/`, Anchor programs in `agenc-protocol`).
- **Background runs + autonomous lane** (`runtime/src/gateway/background-run-*`, `runtime/src/autonomous/*`). Call into ChatExecutor via public API.
- **Eval suite** (`runtime/src/eval/`). Used for verification only.
- **Hooks dispatcher** (`runtime/src/llm/hooks/`). The dispatcher itself is unchanged; PR-5 and PR-8 preserve every hook event call site.
- **Desktop automation** (`runtime/src/desktop/`).
- **The 15 sibling `chat-executor-*.ts` modules that already exist**. Only `chat-executor-tool-loop.ts` (PR-5), `chat-executor-fallback.ts` (PR-6), `chat-executor-ctx-helpers.ts` (PR-1, PR-4), and `chat-executor-planner.ts` (deleted in PR-9) are modified. Everything else — recovery, provider-retry, routing-state, text, tool-utils, types, constants, step-utils, turn-contracts — is unchanged.
- **`agenc-protocol`, `agenc-sdk`, `agenc-plugin-kit`, `agenc-prover`, `agenc-plugin-concordia`, `concordia_bridge`** — cross-repo, not touched.

Anything not on this plan's PR list and not on the explicit "files touched" inside a PR must not change.

---

## Pre-Existing State (Ground Truth)

These numbers are verified against the current `main` HEAD at `72dbd92`:

- `runtime/src/llm/chat-executor.ts`: **2,023 LOC** (readonly fields + constructor: ~210 LOC lines 310-516, private methods: ~1,272 LOC lines 517-2,022, public methods: 5 total).
- `runtime/src/llm/chat-executor.test.ts`: **4,196 LOC / 107 tests**.
- `runtime/src/llm/chat-executor-planner.ts`: **56 LOC**, all stub no-ops returning hardcoded values.
- `runtime/src/llm/chat-executor-ctx-helpers.ts`: **165 LOC** (created by PR #280, holds the 6 pure ctx helpers that established the extraction pattern).
- Subagent stack (`runtime/src/gateway/`): subagent-orchestrator.ts 2,507, subagent-prompt-builder.ts 1,207, subagent-context-curation.ts 1,130, delegation-admission.ts 1,130, sub-agent.ts 1,090 (post PR #276), tool-handler-factory-delegation.ts 851, subagent-workspace-probes.ts 833, subagent-infrastructure.ts 617, subagent-failure-classification.ts 404, delegation-scope.ts 271, delegation-runtime.ts 261, delegated-scope-preflight.ts 266, delegation-timeout.ts 134, delegation-economics.ts 92, subagent-query.ts 145.
- Test baseline: **361 test files / 5,970 `it()` blocks / 6,031 production tests passing**. 5 conditional skips. 2 pre-existing flakes on the exception list below.
- Daemon currently running at `72dbd92` via `agenc-runtime --from-source` on port 3100.

---

## Private Method Extraction Map

These 29 private methods inside `ChatExecutor` get extracted. Numbers are line ranges in the current `chat-executor.ts`.

### 8 extraction clusters (low-to-medium risk)

| # | Cluster | Methods | LOC | Target module |
|---|---|---|---|---|
| 1 | Pure ctx helpers | `pushMessage` (641-671), `setStopReason` (672-682), `checkRequestTimeout` (683-692), `emitExecutionTrace` (770-776) | ~35 | extend `chat-executor-ctx-helpers.ts` |
| 2 | State-map accessors | `buildDegradedProviderNames` (744-754), `getSessionCompactionState` (1575-1590), `trackTokenUsage` (1882-1898) | ~40 | new `chat-executor-state.ts` |
| 3 | Config-read helpers | `resolveRunClassForPhase` (703-715), `resolveRoutingDecision` (716-743), `getContextSectionMaxChars` (1854-1875) | ~60 | new `chat-executor-config.ts` |
| 4 | Message mutation | `maybePushRuntimeInstruction` (777-796), `replaceRuntimeRecoveryHintMessages` (797-820) | ~43 | extend `chat-executor-ctx-helpers.ts` |
| 5 | Delete PR #280 shims | `appendToolRecord` (693-697), `hasModelRecallBudget` (698-702), `getRemainingRequestMs` (755-758), `serializeRequestTimeoutMs` (760-763), `serializeRemainingRequestMs` (765-768), delegation comments | ~20 | delete from class; call helpers directly |
| 6 | Callback wiring | `buildToolLoopCallbacks` (1591-1613), `executeToolCallLoop` wrapper (1614-1638), `findInFlightCompactionTailStartIndex` (1560-1574) | ~45 | extend `chat-executor-tool-loop.ts` |
| 7 | Pure utility | `accumulateUsage` (1876-1881), `createCallUsageRecord` (1899-1931) | ~31 | new `chat-executor-usage.ts` |
| 8 | *(folded into PR-5)* | — | — | — |

### 6 surgical extractions (the orchestration giants, E0-E6)

| # | Method | Lines | LOC | Difficulty | Target module | Depends on |
|---|---|---|---|---|---|---|
| E3 | `callWithFallback` | 1670-1720 | 40 | Tiny | extend `chat-executor-fallback.ts` | None |
| E2 | `compactHistory` | 1932-2022 | 91 | Medium | new `chat-executor-history-compaction.ts` | E3 |
| E1 | `maybeCompactInFlightCallInput` | 1395-1559 | 165 | Surgical | new `chat-executor-in-flight-compaction.ts` | E2, Cluster 2 |
| E4 | `injectContext` | 1721-1853 | 132 | Medium | new `chat-executor-context-injection.ts` | Cluster 1, 3 |
| E5 | `callModelForPhase` | 825-1078 | 253 | Surgical | new `chat-executor-model-orchestration.ts` | E1, E3, Clusters 1-3 |
| E6 | `initializeExecutionContext` | 1079-1394 | 315 | Large | new `chat-executor-init.ts` | E2, E4, Clusters 1-4 |
| E0 | `executeRequest` | 521-635 | 119 | Tiny (after deps) | new `chat-executor-request.ts` | E6, Cluster 6 |

**Extraction rule**: every free function takes `(ctx, input, deps)` where `deps` is an explicit struct of the class-state references the function needs. No hidden closures over `this`. Matches the claude_code pattern from `query.ts` L204-217 where the `State` object is reified and threaded explicitly.

---

## PR-by-PR Execution Sequence

Dependency-driven ordering. Each PR is scoped to one session and creates its own revert tag (`pre-phase-f-pr<N>`) before merging.

```
PR-1 pure-ctx + state-map             (no deps; foundation)
  PR-2 config-helpers                 (depends PR-1 pattern, Cluster 2)
    PR-3 usage helpers                (parallel to PR-2)
      PR-4 message-mutation + shim delete (depends PR-1)
        PR-5 callback wiring + tool-loop (depends PR-1, PR-4)
          PR-6 in-flight + history compaction + fallback (depends PR-1, PR-2)
            PR-7 context injection + model orchestration (depends PR-1..6)
              PR-8 init + executeRequest + class shrink (depends ALL)
                PR-9 planner stub deletion (after PR-8)
                  PR-10 test split (after PR-8)
                    PR-11 subagent shrink phase 1 (independent of executor)
                      PR-12 subagent consolidation phase 2 (depends PR-11)
                        PR-13 verification & ledger close
```

PR-9, PR-11, PR-12 are technically independent of the executor sequence — they can run in parallel if a second operator is available, but single-operator execution should follow the order above to keep blast radius small.

---

### PR-1 — Extract Cluster 1 (pure ctx helpers) + Cluster 2 (state-map accessors)

**Branch**: `refactor/exec-f-pr1-ctx-state`  
**Revert tag**: `pre-phase-f-pr1` at `72dbd92`

**Files created**: `runtime/src/llm/chat-executor-state.ts` (new).  
**Files modified**: `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor-ctx-helpers.ts`.

**Extractions**:

- `pushMessage(ctx, msg, section, reconciliation?)` → `chat-executor-ctx-helpers.ts`
- `setStopReason(ctx, reason, detail?)` → `chat-executor-ctx-helpers.ts` (preserves the "first non-completed wins" guard)
- `checkRequestTimeout(ctx, stage, timeoutMs)` → `chat-executor-ctx-helpers.ts`
- `emitExecutionTrace(ctx, event)` → `chat-executor-ctx-helpers.ts`
- `buildDegradedProviderNames(cooldowns, nowMs?)` → `chat-executor-state.ts`
- `getSessionCompactionState(sessionTokens, sessionTokenBudget, sessionCompactionThreshold)` → `chat-executor-state.ts`
- `trackTokenUsage(sessionTokens, sessionId, tokens, toolFailureBreaker, maxTrackedSessions)` → `chat-executor-state.ts`

Class methods become 1-line delegators that get deleted in PR-8.

**LOC delta**: chat-executor.ts 2,023 → 1,948 (-75). chat-executor-ctx-helpers.ts 165 → 225 (+60). new chat-executor-state.ts ~80.

**Acceptance**:

- `npm run typecheck --workspace=@tetsuo-ai/runtime` clean
- `npx vitest run runtime/src/llm/chat-executor.test.ts` 107/107 pass
- `node runtime/scripts/check-executor-baseline.mjs` passes
- `grep -rn "this\.pushMessage\|this\.setStopReason\|this\.checkRequestTimeout" runtime/src/llm/chat-executor.ts` returns only the delegator lines

**Risk**: Trivial. Pure helpers, no async, no captured class state beyond the explicit arguments.

**Session estimate**: 2h.

---

### PR-2 — Extract Cluster 3 (config-read helpers)

**Branch**: `refactor/exec-f-pr2-config-helpers`  
**Revert tag**: `pre-phase-f-pr2`

**Files created**: `runtime/src/llm/chat-executor-config.ts`.

**Extractions**:

- `resolveRunClassForPhase(message, defaultRunClass, phase)` → `chat-executor-config.ts`
- `resolveRoutingDecision(ctx, economicsPolicy, modelRoutingPolicy, phase, degradedProviderNames, requirements?)` → `chat-executor-config.ts`
- `getContextSectionMaxChars(promptBudget, section)` → `chat-executor-config.ts`

`resolveRoutingDecision` takes `degradedProviderNames` as an explicit arg (computed by the caller via `buildDegradedProviderNames` from PR-1). No more `this.buildDegradedProviderNames()` self-call.

**LOC delta**: chat-executor.ts 1,948 → 1,888 (-60). new chat-executor-config.ts ~100.

**Acceptance**: same as PR-1 + `npx vitest run runtime/src/llm/chat-executor-routing-state.test.ts` green.

**Risk**: Trivial.  
**Session estimate**: 1.5h.

---

### PR-3 — Extract Cluster 7 (usage utilities)

**Branch**: `refactor/exec-f-pr3-usage-helpers`

**Files created**: `runtime/src/llm/chat-executor-usage.ts`.

**Extractions**:

- `accumulateUsage(cumulative, usage)` → `chat-executor-usage.ts`
- `createCallUsageRecord(input)` → `chat-executor-usage.ts`

Both are pure functions. Could be merged into PR-2 if session capacity permits; keeping it separate gives a cleaner revert point.

**LOC delta**: chat-executor.ts 1,888 → 1,857 (-31). new chat-executor-usage.ts ~50.

**Risk**: Trivial.  
**Session estimate**: 1h.

---

### PR-4 — Cluster 4 (message mutation) + Cluster 5 (PR #280 shim cleanup)

**Branch**: `refactor/exec-f-pr4-message-mutation-and-shim-cleanup`

**Files modified**: `chat-executor-ctx-helpers.ts`, `chat-executor.ts`.

**Extractions**:

- `maybePushRuntimeInstruction(ctx, content, maxRuntimeSystemHints, pushMessage)` → `chat-executor-ctx-helpers.ts`
- `replaceRuntimeRecoveryHintMessages(ctx, recoveryHints)` → `chat-executor-ctx-helpers.ts`

**Shim deletions** (PR #280 left these as 1-line delegators to keep the earlier PR's blast radius small; this PR finishes the cleanup):

- Delete `appendToolRecord`, `hasModelRecallBudget`, `getRemainingRequestMs`, `serializeRequestTimeoutMs`, `serializeRemainingRequestMs` shim methods on the class.
- Update internal callers (inside chat-executor.ts) to import the helpers directly from `chat-executor-ctx-helpers.ts`.

**LOC delta**: chat-executor.ts 1,857 → 1,797 (-60). chat-executor-ctx-helpers.ts 225 → 280 (+55).

**Acceptance**: `grep -n "this\.appendToolRecord\|this\.hasModelRecallBudget\|this\.getRemainingRequestMs\|this\.serialize" runtime/src/llm/chat-executor.ts` returns zero after this PR.

**Risk**: Trivial. Mechanical replace.  
**Session estimate**: 2h.

---

### PR-5 — Cluster 6 (callback wiring) into existing chat-executor-tool-loop.ts

**Branch**: `refactor/exec-f-pr5-tool-loop-callback-wiring`

**Files modified**: `runtime/src/llm/chat-executor-tool-loop.ts`, `runtime/src/llm/chat-executor.ts`.

**Extractions**:

- `buildToolLoopCallbacks(deps)` → `chat-executor-tool-loop.ts` (takes a `ToolLoopDependencies` struct of hookRegistry, canUseTool, isConcurrencySafe, toolFailureBreaker, toolResultBudget, toolResultBudgetState, maxRuntimeSystemHints, toolCallTimeoutMs, retryPolicyMatrix, allowedTools, consolidationHook).
- `executeToolCallLoop` wrapper method → absorbs into the existing `executeToolCallLoop` free function in chat-executor-tool-loop.ts; class method becomes a 3-line delegator.
- `findInFlightCompactionTailStartIndex` → folded into chat-executor-tool-loop.ts (only consumer is PR-6's in-flight compaction, which will be extracted next; during PR-5 it lives in tool-loop and gets re-exported for PR-6 consumption).

**LOC delta**: chat-executor.ts 1,797 → 1,752 (-45). chat-executor-tool-loop.ts 1,410 → 1,470 (+60).

**Acceptance**:

- Existing `runtime/src/llm/chat-executor-tool-loop*.test.ts` green
- Phase H hook dispatch integration tests (PR #278's new assertions) green
- `runtime/src/llm/chat-executor-parallel-dispatch.test.ts` green

**Risk**: Medium. Touches the hook integration path added by Phase H (PR #278). Verify hook dispatch tests before merging.

**Stop-and-ask**: if the `ToolLoopDependencies` struct exceeds 14 fields, split it into `ToolLoopHooksDeps` and `ToolLoopCoreDeps` and surface.

**Session estimate**: 3h.

---

### PR-6 — E1 + E2 + E3: compaction and fallback extraction

**Branch**: `refactor/exec-f-pr6-compaction-fallback`

**Files created**:

- `runtime/src/llm/chat-executor-in-flight-compaction.ts`
- `runtime/src/llm/chat-executor-history-compaction.ts`

**Files modified**: extends `runtime/src/llm/chat-executor-fallback.ts` (397 LOC).

**Extractions**:

- **E3** `callWithFallback` (40 LOC) → new export `callProvidersWithFallback(messages, onStreamChunk?, messageSections?, options, deps)` in `chat-executor-fallback.ts`. Takes `deps: { providers, promptBudget, retryPolicyMatrix, cooldownMs, maxCooldownMs, cooldowns }`. Adds duration measurement wrapper.
- **E2** `compactHistory` (91 LOC) → new `chat-executor-history-compaction.ts`. Takes `(history, sessionId, trace, existingArtifactContext, keepTailCount, deps, callWithFallback)` where `deps: { onCompaction }`. Uses `callProvidersWithFallback` from E3.
- **E1** `maybeCompactInFlightCallInput` (165 LOC) → new `chat-executor-in-flight-compaction.ts`. Takes `(ctx, input, deps, compactHistory)` where `deps: { sessionTokenBudget, sessionCompactionThreshold, maxTrackedSessions, sessionTokens, cooldowns }`. Uses `compactHistory` from E2 as an injected dependency (no direct import to avoid circularity with chat-executor.ts which still imports E1).

Both `compactHistory` and `maybeCompactInFlightCallInput` thread their dependencies explicitly; no captured `this`.

**LOC delta**: chat-executor.ts 1,752 → 1,456 (-296). new chat-executor-history-compaction.ts ~130. new chat-executor-in-flight-compaction.ts ~200. chat-executor-fallback.ts 397 → 470.

**Acceptance**:

- All 107 chat-executor.test.ts tests pass
- `runtime/src/llm/chat-executor-fallback.test.ts` green
- `runtime/src/llm/context-compaction.test.ts` green (this is the legacy compaction path that chat-executor.ts still calls)
- The cooldown snapshot/restore semantics on soft-threshold failure (chat-executor.ts:1122-1155 area) must be byte-identical — this is the path tested by `runtime/src/llm/chat-executor-provider-retry.test.ts`

**Risk**: Medium-high. Compaction is the highest-traffic code path under load. Preserve identical observable behavior — trace events, cooldown snapshot/restore, soft-vs-hard threshold semantics must not drift.

**Stop-and-ask**: if `maybeCompactInFlightCallInput` extraction reveals shared mutable closure state with `executeToolCallLoop` that isn't already on `ctx`, pause and resurface.

**Session estimate**: 4h.

---

### PR-7 — E4 + E5: context injection and model orchestration

**Branch**: `refactor/exec-f-pr7-injection-model-orchestration`

**Files created**:

- `runtime/src/llm/chat-executor-context-injection.ts`
- `runtime/src/llm/chat-executor-model-orchestration.ts`

**Extractions**:

- **E4** `injectContext` (132 LOC) → new `chat-executor-context-injection.ts`. Signature: `(ctx, provider, messageText, sessionId, messages, sections, section, deps, helpers)` where `deps: { promptBudget }` and `helpers: { emitExecutionTrace, pushMessage, getContextSectionMaxChars, truncateText }`.
- **E5** `callModelForPhase` (253 LOC) → new `chat-executor-model-orchestration.ts`. Signature: `(ctx, input, deps, helpers)` where `deps: { economicsPolicy, modelRoutingPolicy, allowedTools }` and `helpers: { hasModelRecallBudget, checkRequestTimeout, setStopReason, maybeCompactInFlightCallInput, resolveRoutingDecision, emitExecutionTrace, callWithFallback }`.

**LOC delta**: chat-executor.ts 1,456 → 1,071 (-385). new chat-executor-context-injection.ts ~170. new chat-executor-model-orchestration.ts ~290.

**Acceptance**:

- All 107 chat-executor.test.ts tests pass
- Hook dispatch (Phase H tests) green
- Trace event ordering unchanged: capture a sample execution trace before and after, compare byte-by-byte for a fixture turn
- `runtime/src/llm/chat-executor-provider-retry.test.ts` green

**Risk**: Surgical. `callModelForPhase` is the largest single function and threads through every state mutation in the request. Recommend a dry-run branch before the real extraction to size the dep struct.

**Stop-and-ask**:

- If the `callModelForPhase` dep struct exceeds 12 fields, split the function further before extracting
- If the trace ordering drifts, stop and investigate — the extraction is wrong somewhere

**Session estimate**: 4-5h.

---

### PR-8 — E6 + E0: init + executeRequest + class shrink (KEYSTONE PR)

**Branch**: `refactor/exec-f-pr8-init-request-class-shrink`

**Files created**:

- `runtime/src/llm/chat-executor-init.ts`
- `runtime/src/llm/chat-executor-request.ts`

**Extractions**:

- **E6** `initializeExecutionContext` (315 LOC) → new `chat-executor-init.ts`. Largest single function extraction in Phase F. Takes `(params, deps, state, helpers)` where `deps` carries all the construction-time config (providers, maxToolRounds, toolBudgetPerRequest, maxModelRecallsPerRequest, maxFailureBudgetPerRequest, requestTimeoutMs, economicsPolicy, defaultRunClass, plannerEnabled, skillInjector, memoryRetriever, learningProvider, progressProvider, identityProvider, promptBudget, allowedTools, resolveHostWorkspaceRoot, maxTrackedSessions, sessionTokenBudget, sessionCompactionThreshold), `state` carries `{ sessionTokens, cooldowns }`, and `helpers` carries `{ getSessionCompactionState, compactHistory, resetSessionTokens, setStopReason, pushMessage, injectContext }`.

- **E0** `executeRequest` (119 LOC) → new `chat-executor-request.ts`. After E6 and Cluster 6 extractions, the body is mostly orchestration: call `initializeExecutionContext`, dispatch SessionStart hook (Phase H), call `executeToolCallLoop`, call `checkRequestTimeout`, resolve completion state, dispatch Stop/StopFailure hooks (Phase H), build the result. Takes `(params, deps, state, helpers)` where `helpers: { initializeExecutionContext, executeToolCallLoop, checkRequestTimeout }` and `deps` carries `hookRegistry`, `economicsPolicy`, plus everything E6 and E5 need.

**Class shrink**: after PR-8, `ChatExecutor` body contains:

- 30 readonly fields + constructor (lines 310-516, ~210 LOC, unchanged)
- `private dependencies()` method that returns a frozen struct packaging the readonly fields and state Maps for the free functions to consume. ~30 LOC.
- 5 public method delegators:
  - `async execute(params)` → `return executeRequestFree(params, this.dependencies())`
  - `getSessionTokenUsage(sessionId)` → `return this.sessionTokens.get(sessionId) ?? 0`
  - `resetSessionTokens(sessionId)` → 3 lines (delete from map, clear breaker, clear provider state)
  - `clearAllSessionTokens()` → 3 lines
  - `clearCooldowns()` → 1 line
- 1 private static helper (`normalizeRequestTimeoutMs`) — ~3 LOC
- Re-exports (ChatBudgetExceededError, SkillInjector type, MemoryRetriever type, etc.) — ~18 LOC

**LOC delta**: chat-executor.ts 1,071 → **~650** (-421). new chat-executor-init.ts ~350. new chat-executor-request.ts ~140.

**Decision: accept the ~650 LOC residual as a first-class design**. The class cannot be deleted without rewriting every caller to pass config explicitly. The class's role becomes: **DI container + public API facade**. This matches claude_code's pattern: in claude_code, `Tools` are registered objects (not class instances) that own their state, and the query loop calls them as free functions — but AgenC's gateway/channel layer expects a `ChatExecutor` instance, so the facade stays. Rewriting every caller to a factory pattern would be ~3,000 LOC of ripple across `gateway/`, `autonomous/`, `channels/`, `eval/` at zero behavioral benefit.

**Acceptance criteria**:

- Full `chat-executor.test.ts` suite (107 tests) passes
- Full `runtime/src/llm/` test suite passes (currently 462/462 after PR #280)
- `npm run typecheck` clean without `--skipLibCheck`
- The 5 public methods on ChatExecutor have byte-identical signatures and return shapes
- Outside-package callers (`grep -rn "new ChatExecutor" runtime/src gateway/`) compile with zero changes
- Daemon smoke test: restart `agenc-runtime --from-source` and run a sample chat turn through the WebSocket channel; compare output to baseline captured before PR-1

**Risk**: Keystone. If extraction goes wrong, every prior PR in the sequence is at risk. Mitigation: PR-8 does ONLY extraction + class shrink. No renames, no signature changes on the 5 public methods, no behavior changes.

**Stop-and-ask**:

- If any caller of ChatExecutor outside `runtime/src/llm/` needs a signature change, pause. The expectation is zero downstream changes.
- If the `dependencies()` struct exceeds 35 fields, pause — that's a sign the class has cross-cutting state that shouldn't be threaded through, and an alternative design (per-module dep sub-structs) should be considered.

**Session estimate**: 4-6h. Consider splitting into PR-8a (E6) and PR-8b (E0 + class shrink) if session budget is tight — this adds a second ~2h session but each is safer.

---

### PR-9 — Delete chat-executor-planner.ts and inline no-op returns

**Branch**: `refactor/exec-f-pr9-delete-planner-stub`

**Files deleted**: `runtime/src/llm/chat-executor-planner.ts` (56 LOC).

**Files modified**: `runtime/src/llm/chat-executor-init.ts` (PR-8 destination of the 4 call sites).

**Inline replacements**:

- `assessPlannerDecision(...)` → `{ score: 0, shouldPlan: false, reason: "planner_disabled" } satisfies PlannerDecision`
- `extractExplicitDeterministicToolRequirements(...)` → `undefined`
- `extractExplicitSubagentOrchestrationRequirements(...)` → `undefined`
- `requestRequiresToolGroundedExecution(...)` → `false`

The downstream code in `initializeExecutionContext` that branches on `explicitDeterministicToolRequirements?.forcePlanner` and `explicitSubagentOrchestrationRequirements` becomes statically dead. Delete those dead branches as well (~40 LOC in chat-executor-init.ts).

**LOC delta**: -56 (file deleted) -40 (dead branches in init) = **-96 net LOC**, -1 file.

**Acceptance**:

- `grep -rn "chat-executor-planner" runtime/src` returns zero
- `grep -rn "assessPlannerDecision\|extractExplicitDeterministic\|extractExplicitSubagent\|requestRequiresToolGrounded" runtime/src` returns zero
- All tests still pass (no test depends on `shouldPlan: true` semantics; if any do, they were testing dead behavior and get deleted)
- `PlannerDecision` type may still be needed by `ChatPlannerSummary` — verify and either keep the type alias in `chat-executor-types.ts` or delete the whole type chain

**Risk**: Trivial. Mechanical inline.  
**Session estimate**: 1h.

---

### PR-10 — Test split: 10 module files + thinned integration suite

**Branch**: `refactor/exec-f-pr10-test-split`

**Files created**:

- `runtime/src/llm/chat-executor-ctx-helpers.test.ts` (covers PR-1 + PR-4 extractions)
- `runtime/src/llm/chat-executor-state.test.ts`
- `runtime/src/llm/chat-executor-config.test.ts`
- `runtime/src/llm/chat-executor-usage.test.ts`
- `runtime/src/llm/chat-executor-in-flight-compaction.test.ts`
- `runtime/src/llm/chat-executor-history-compaction.test.ts`
- `runtime/src/llm/chat-executor-context-injection.test.ts`
- `runtime/src/llm/chat-executor-model-orchestration.test.ts`
- `runtime/src/llm/chat-executor-init.test.ts`
- `runtime/src/llm/chat-executor-request.test.ts`

**Files modified**: `runtime/src/llm/chat-executor.test.ts` (4,196 → ~1,500 LOC). Keeps ~40 integration tests that exercise the full `execute()` path; deletes trivial wrapper tests that asserted class-method behavior now covered by module files.

**Migration strategy**:

1. Categorize every test in the 4,196-LOC monolith into a target module bucket. Produce the categorization as a markdown table in the PR body.
2. Move tests one category at a time (use `git mv` where feasible; otherwise cut-paste).
3. Re-run the entire suite after each category to catch test-ordering dependencies.
4. Delete the moved tests from the monolith in a final commit within the PR.

**LOC delta**: chat-executor.test.ts -2,696. New 10 module test files total ~5,550 LOC. Net test LOC: +2,854 (distributed across 11 files instead of 1).

**Acceptance**:

- `node runtime/scripts/check-executor-baseline.mjs` passes (361 files baseline holds — new files compensate for the shrunk monolith)
- No test file exceeds 1,500 LOC
- `npm run test --workspace=@tetsuo-ai/runtime` passes

**Risk**: Medium tedium. The 4,196-LOC monolith is where regressions get caught; the split must preserve coverage.

**Stop-and-ask**:

- If more than 10 tests turn out to be uncategorizable (cross multiple modules), surface to discuss whether the integration suite should grow back instead of shrinking

**Session estimate**: 1-2 sessions depending on categorization difficulty. If it takes more than 2 sessions, surface and re-scope.

---

### PR-11 — Subagent stack shrink phase 1 (dead code deletion)

**Branch**: `refactor/exec-f-pr11-subagent-dead-code`

**Files modified** (no consolidation yet, just shrinking; each file deleted-in-place in its own commit for per-file revertability):

| File | Before | After | Delta | What goes |
|---|---|---|---|---|
| `runtime/src/gateway/subagent-orchestrator.ts` | 2,507 | ~1,600 | -907 | 8 unused helper fns for the deleted planner; dead error classification branches; defunct budget pre-checks |
| `runtime/src/gateway/subagent-prompt-builder.ts` | 1,207 | ~1,000 | -207 | Deprecated "breadth-first" probing template; minor template dedup |
| `runtime/src/gateway/subagent-context-curation.ts` | 1,130 | ~900 | -230 | Unused artifact relevance scoring; dead artifact type guards; unused memory dedup |
| `runtime/src/gateway/delegation-admission.ts` | 1,130 | ~1,000 | -130 | Unused fan-out metrics; cost re-estimation fallbacks |
| `runtime/src/gateway/subagent-workspace-probes.ts` | 833 | ~700 | -133 | Legacy cwd-inference fallback; dead "shallow probe" template |
| `runtime/src/gateway/subagent-infrastructure.ts` | 617 | ~550 | -67 | Unused identity reconciliation |
| Others (subagent-failure-classification, subagent-dependency-summarization, delegation-scope) | various | various | ~-200 | Scattered minor dead code |

**Total LOC delta**: **-1,874**. Subagent stack: 13,657 → 11,783.

**Acceptance**:

- `npm run typecheck --workspace=@tetsuo-ai/runtime` clean
- `runtime/src/gateway/subagent-orchestrator.test.ts` green
- `runtime/src/gateway/subagent-context-curation.test.ts` green
- `runtime/src/gateway/subagent-workspace-probes.test.ts` green
- `runtime/src/gateway/subagent-failure-classification.test.ts` green
- `runtime/src/gateway/subagent-query.test.ts` green (Phase K wrapper, PR #275)
- `runtime/src/gateway/sub-agent.test.ts` green (78/78 after Phase K migration in PR #276)
- `grep -r "<deleted-symbol>" /home/tetsuo/git/AgenC` across the whole AgenC workspace returns zero new hits for each deleted export

**Risk**: Medium. Agent C identified dead code by static analysis. Some may turn out to be used reflectively or in test fixtures. Each file deleted in its own commit for per-file revertability.

**Stop-and-ask**:

- If any single file shrinks more than 50% and the remaining body is trivial wrappers, pause — that's a sign the file should be merged into its sibling in PR-12 instead of shrunk in isolation
- If a deletion surfaces a test that was gated on the now-deleted symbol, check whether the test was testing dead behavior (delete the test) or a legitimate path (restore the symbol and flag it for future review)

**Session estimate**: 4h.

---

### PR-12 — Subagent stack consolidation phase 2

**Branch**: `refactor/exec-f-pr12-subagent-consolidation`

**Files merged**:

- `runtime/src/gateway/subagent-prompt-builder.ts` (~1,000 LOC after PR-11) → folded into `runtime/src/gateway/subagent-orchestrator.ts`. Reclaims ~280 LOC of file overhead (imports, JSDoc, type re-exports).
- `runtime/src/gateway/subagent-failure-classification.ts` (~330 LOC after PR-11) → folded into `runtime/src/gateway/subagent-orchestrator.ts`. Reclaims ~220 LOC of file overhead.

**Files modified**: `subagent-orchestrator.ts` grows from ~1,600 to ~2,430 (still under the original 2,507 pre-PR-11).

**LOC delta**: **-500 net**. Subagent stack: 11,783 → ~11,283 after consolidation.

**Realistic floor**: ~11,200-11,300 LOC. The TODO.MD target of 7,000 and this plan's earlier estimate of 9,500 were both optimistic — those numbers assumed deleting LIVE delegation logic, which preserves correctness-critical behavior we can't cut. The achievable floor is what's reached after PR-11 + PR-12: ~4,000 LOC of dead-code deletion plus ~500 LOC of file-overhead consolidation.

**Acceptance**:

- All subagent tests pass
- Imports from outside `runtime/src/gateway/` (the gateway public API) unchanged
- `grep -rn "subagent-prompt-builder\|subagent-failure-classification" runtime/src` returns zero outside the merge commit

**Risk**: Low after PR-11 has shrunk the contents. Mostly a file move + import rewrite.

**Session estimate**: 3h.

---

### PR-13 — Verification, refactor-log update, TODO.MD close

**Branch**: `chore/phase-f-close-out`

**Files modified**:

- `TODO.MD` — mark Phase F as complete; add note of any open questions that surfaced; link to PR sequence
- `docs/REFACTOR-LOG.md` — append entries for PR-1 through PR-12 (each row: PR number, branch, SHA, test count delta, notes)

**Verification matrix**:

- `node runtime/scripts/check-executor-baseline.mjs` passes
- `npm run typecheck --workspace=@tetsuo-ai/runtime` clean
- `npm run test --workspace=@tetsuo-ai/runtime` passes modulo the flaky exception list
- `npm run build` at repo root completes clean (contracts → runtime → mcp → docs-mcp → desktop-server)
- `wc -l runtime/src/llm/chat-executor*.ts` shows chat-executor.ts at ~650 LOC
- `wc -l runtime/src/gateway/subagent-*.ts runtime/src/gateway/delegation-*.ts` shows subagent stack at ~11,200-11,300 LOC
- Daemon smoke test: `agenc-runtime stop && agenc-runtime start --from-source` against a scratch profile, run 5 sample turns (text channel, webchat, voice-bridge if available, background-run, sub-agent delegation), verify no new error classes in `~/.agenc/daemon.errors.log`
- Compare `runtime/dist/VERSION` commit hash to current main HEAD

**Risk**: None — documentation and verification only.

**Session estimate**: 2h.

---

## Verification Gates (shared across all PRs)

Every PR must pass the following before merge:

### Per-PR fast-path (runs in ~5 min)

```
cd /home/tetsuo/git/AgenC/agenc-core
git status                                              # clean working tree assertion
npm run typecheck --workspace=@tetsuo-ai/runtime        # tsc --noEmit
npm run check:executor-baseline --workspace=@tetsuo-ai/runtime
npx vitest run runtime/src/llm/chat-executor            # ~90s hot path
npx vitest run runtime/src/llm/execute-chat             # generator adapter
npx vitest run runtime/src/gateway/daemon-text-channel-turn.test.ts \
               runtime/src/gateway/daemon-webchat-turn.test.ts \
               runtime/src/gateway/voice-bridge.test.ts
npx vitest run runtime/src/autonomous/
```

### Full-suite gate (runs on PR-1, PR-6, PR-7, PR-8, PR-10, PR-13)

```
npm run typecheck --workspace=@tetsuo-ai/runtime
npm run test --workspace=@tetsuo-ai/runtime
npm run build                                           # repo root full build
node runtime/scripts/check-executor-baseline.mjs
```

### Flaky exception list (do NOT block PRs on these)

Pre-existing failures unrelated to Phase F. Treat as known-bad:

1. **`runtime/tests/marketplace-cli.integration.test.ts`** — LiteSVM setup `DeclaredProgramIdMismatch` error. Excluded by `npm run test` already.
2. **`runtime/src/autonomous/desktop-executor.test.ts > "rejects concurrent goals"`** — race condition in the desktop automation harness. Pre-existing on main.
3. **`runtime/src/tools/system/server.test.ts > "persists the shared resource envelope when provided"`** — channel persistence flake. Passes on retry.

Any new failure outside this list is a **stop-and-ask trigger**.

---

## Stop-and-Ask Triggers

Pause execution and surface to the user if any of the following occurs:

1. **TypeScript cascade > 30 errors** after a single extraction — indicates the dep struct is wrong or hidden coupling exists.
2. **Any integration test in `chat-executor.test.ts` regresses** that is NOT slated for deletion in PR-10.
3. **An unexpected outside-package caller** of any private ChatExecutor method appears (e.g., `(executor as any).privateMethod` access).
4. **`callModelForPhase` dep struct exceeds 12 fields** in PR-7 — split the function further first.
5. **`dependencies()` struct in PR-8 exceeds 35 fields** — consider per-module dep sub-structs.
6. **Any subagent file shrinks more than 50%** in PR-11 and becomes trivial wrappers — fold in PR-12 instead.
7. **PR-10 test categorization reveals > 10 boundary-crossing tests** that don't fit a single module bucket.
8. **A flaky test outside the exception list fires twice in a row** during gate verification.
9. **Daemon smoke test in PR-13 produces non-identical output** to the pre-PR baseline (captured before PR-1).
10. **Any caller of ChatExecutor outside `runtime/src/llm/` needs a signature change** in PR-8 — expected zero.
11. **A deleted subagent symbol** (PR-11) turns up in a cross-repo grep (agenc-sdk, agenc-protocol, agenc-plugin-kit, agenc-prover, agenc-plugin-concordia, agenc-core mcp/web/tools) — surface the consumer before deleting.

---

## What Stays (Appendix)

Do not touch these during Phase F. They are orthogonal subsystems that consume ChatExecutor via its public API and should see zero behavioral change.

- **Concordia bridge**: `runtime/src/plugins/channel-host-services.ts`, `runtime/src/gateway/concordia*`, `runtime/src/llm/chat-executor-turn-contracts.ts` (the `isConcordiaSimulationTurnMessage` reference inside E5 stays as-is; the turn-contracts file is not modified).
- **Watch TUI**: `runtime/src/bin/agenc-watch*`, `runtime/src/watch-*`.
- **Channel layer**: `runtime/src/channels/*`, `runtime/src/gateway/daemon-text-channel-turn.ts`, `runtime/src/gateway/daemon-webchat-turn.ts`, `runtime/src/gateway/voice-bridge.ts`. All 10 callers migrated in Phase E (PR #271) continue to call `chatExecutor.execute(params)` or `executeChatToLegacyResult(chatExecutor, params)` — both paths preserve their signatures through Phase F.
- **Memory backends**: `runtime/src/memory/*` (InMemory, SQLite, Redis, vector store, consolidation, graph). Consumed by E4 (`injectContext`) but internals unchanged.
- **Skills marketplace**: `runtime/src/skills/*`, `marketplace/*`, all Jupiter DEX integration, the LiteSVM tests.
- **Solana protocol**: `runtime/src/tools/agenc/*`, `runtime/src/task/*`, `runtime/src/dispute/*`, `runtime/src/governance/*`, `runtime/src/reputation/*`, `runtime/src/social/*`. Anchor programs in `agenc-protocol` are a separate repo.
- **Background runs + autonomous lane**: `runtime/src/gateway/background-run-*`, `runtime/src/autonomous/*` (goal-manager, curiosity, desktop-executor, strategic memory, risk-scoring). All consume ChatExecutor via the public `execute()` method or `executeChatToLegacyResult` helper.
- **Eval suite**: `runtime/src/eval/*` — pipeline-quality-runner, implementation-gate-suite, delegated-workspace-gate-suite, long-horizon-suite, chaos-suite, mutation suite. Used for verification in PR-13 but source untouched.
- **Hooks dispatcher**: `runtime/src/llm/hooks/*`. The dispatcher itself, the matcher, the executors, and the registry are all unchanged. PR-5 and PR-8 preserve every hook event call site added by Phase H (PR #278).
- **Desktop automation**: `runtime/src/desktop/*` — sandbox manager, REST bridge, container routing.
- **15 sibling chat-executor-*.ts modules**: only `chat-executor-tool-loop.ts` (PR-5, PR-6 via findInFlightCompactionTailStartIndex), `chat-executor-fallback.ts` (PR-6), `chat-executor-ctx-helpers.ts` (PR-1, PR-4), and `chat-executor-planner.ts` (deleted PR-9) are touched. All others — chat-executor-recovery, chat-executor-provider-retry, chat-executor-routing-state, chat-executor-text, chat-executor-tool-utils, chat-executor-types, chat-executor-constants, chat-executor-step-utils, chat-executor-turn-contracts, execute-chat, streaming-events, streaming-bridge, messages, compact/* — are unchanged.
- **Cross-repo packages**: `agenc-protocol`, `agenc-sdk`, `agenc-plugin-kit`, `agenc-prover`, `agenc-plugin-concordia`, `concordia_bridge`. No changes.

---

## Rollback Strategy

Each PR is independently revertable.

1. **Global anchor**: `git tag pre-executor-refactor` at `b8decc5` — the whole-refactor escape hatch (reverts all 20 merged PRs).
2. **Per-PR revert tags**: each PR creates `git tag pre-phase-f-pr<N>` at the commit immediately before its merge (so `pre-phase-f-pr1` points at `72dbd92`, the current main). Pushed to origin.
3. **Single-PR revert**: `git revert <merge-sha>` followed by a re-run of the PR's verification gates. Because each PR moves code without changing behavior, a revert should restore the methods to the class with no cascade.
4. **Cascade-revert**: if PR-N causes a regression surfacing after PR-N+2 merges, revert in reverse order (N+2, N+1, N) and re-plan from the `pre-phase-f-pr<N>` tag.
5. **PR-8 rollback caveat**: PR-8 is the keystone. If reverted, PR-9's inline replacements need to move back from `chat-executor-init.ts` (which no longer exists post-revert) to `chat-executor.ts`. Mitigation: do not start PR-9 until PR-8 has been on main for at least 24 hours and daemon smoke test has passed twice.
6. **Subagent PRs (PR-11, PR-12)**: fully orthogonal to the executor sequence. Revertable independently.

---

## AsyncHookRegistry Decision

**Recommendation: do NOT port claude_code's `AsyncHookRegistry` pattern (~1,200 LOC).**

**Rationale**: AgenC already has a `HookRegistry` in `runtime/src/llm/hooks/` that handles all 9 lifecycle events (SessionStart, Stop, StopFailure, PreToolUse, PostToolUse, PostToolUseFailure, PreCompact, PostCompact) plus the tool boundary events. Dispatch is synchronous-per-event but supports async handlers via `dispatchHooks`. Integration with `chat-executor.ts` at lines 531-543 (SessionStart) and 583-599 (Stop/StopFailure) was landed in Phase H (PR #278).

Claude_code's `AsyncHookRegistry` adds cross-request hook coordination — a hook fired in request N can influence behavior in request N+1 via an async listener that survives between requests. The primary consumer in claude_code is the **Ink TUI progress streaming**, which AgenC doesn't have (explicitly out of scope per the prompt). AgenC's cross-request state is already handled by the per-instance Maps on `ChatExecutor` (sessionTokens, cooldowns, toolResultBudgetState) and by the channel layer's session state.

Cost of porting: ~1,200 LOC of new infrastructure + integration into hooks/ + re-validation of all 9 hook events. Benefit: no concrete AgenC consumer identified. The pattern would be dead code on day one.

**If a future use case emerges** (e.g., Watch TUI subscription wanting to observe hook events across requests), a follow-up PR can add it as Phase F+1. For this plan, it is explicitly marked as not needed.

---

## Session Estimate Summary

| PR | Session count | Duration | Notes |
|---|---|---|---|
| PR-1 | 1 | 2h | Foundation pattern |
| PR-2 | 1 | 1.5h | Trivial |
| PR-3 | 1 | 1h | Could merge into PR-2 |
| PR-4 | 1 | 2h | PR #280 shim cleanup |
| PR-5 | 1 | 3h | Hook integration sensitivity |
| PR-6 | 1 | 4h | Compaction hot path |
| PR-7 | 1 | 4-5h | callModelForPhase 253 LOC |
| PR-8 | 1 (or 2) | 4-6h | **Keystone**; consider splitting into 8a + 8b |
| PR-9 | 1 | 1h | Mechanical inline |
| PR-10 | 1-2 | 4-8h | Test categorization-bound |
| PR-11 | 1 | 4h | Subagent dead code |
| PR-12 | 1 | 3h | Subagent consolidation |
| PR-13 | 1 | 2h | Verification + docs |

**Total: 13-15 sessions over 3-4 weeks** for single-operator serial execution. PR-11 and PR-12 can run in parallel with PR-1 through PR-9 if a second operator is available — that path shortens wall-clock to ~2 weeks.

**LOC-per-session guidance**: prior phases averaged 150-250 LOC moved per session. PR-7 and PR-8 exceed this and are the reasons for their 4-6h estimates. Any PR moving > 300 LOC should have an explicit checkpoint mid-session.

---

## Open Questions for the User

1. **PR-8 keystone risk**: OK with a 4-6h single-session PR that moves 421 LOC of class body? Alternative: split into PR-8a (E6 `initializeExecutionContext`) and PR-8b (E0 `executeRequest` + class shrink) — adds a second long session but each is safer.
2. **Subagent shrink target**: commit to realistic floor of ~11,200-11,300 LOC after PR-11 + PR-12? The TODO.MD's original 7,000 target is unachievable without cutting live delegation logic, and 9,500 was still optimistic.
3. **AsyncHookRegistry**: confirm "do not port" is correct, or surface a concrete AgenC consumer that would benefit.
4. **PR-10 test split timing**: 1-2 sessions acceptable, or should it be split into PR-10a (ctx + state + config + usage test moves) and PR-10b (compaction + model + init + request test moves)?
5. **Daemon smoke baseline**: should the runbook explicitly capture a sample chat trace from current main (`72dbd92`) before PR-1 merges, so PR-13 has something concrete to compare against? **Recommended: yes** — capture via `agenc ws --record` or the equivalent and store in `docs/baselines/`.
6. **Per-PR revert tag naming**: confirm `pre-phase-f-pr<N>` convention, or specify a different scheme.
7. **Parallel execution**: is there a second operator available for PR-11 + PR-12 parallel track, or is this single-operator serial?

---

## Target End-State Metrics

After PR-13 merges, the runtime should report:

- `wc -l runtime/src/llm/chat-executor.ts` → **~650 LOC** (down from 2,023, -68%)
- `wc -l runtime/src/llm/chat-executor-*.ts | tail -1` → ~3,800 LOC total across 19 files (was 2,023 in 1 file + ~1,800 in 15 siblings = ~3,800; distribution changes but total stays roughly constant; the refactor trades one giant for many focused modules)
- `wc -l runtime/src/gateway/subagent-*.ts runtime/src/gateway/delegation-*.ts` → **~11,250 LOC** (down from 13,657, -18%)
- `wc -l runtime/src/llm/chat-executor.test.ts` → **~1,500 LOC** (down from 4,196, -64%)
- `wc -l runtime/src/llm/chat-executor-*.test.ts | tail -1` → ~6,050 LOC total across 11 test files (was 4,196 in 1 file; refactor distributes coverage into focused module tests)
- Total test count: **~6,400** production tests (up from 6,031; modular tests add granular coverage)
- `runtime/dist/VERSION` reports current `main` HEAD commit at refactor completion
- Daemon smoke matrix green: text-channel, webchat with streaming, voice-bridge, background-run cycle, curiosity cycle, sub-agent delegation, Concordia session (if available)
- Error rate over a 30-minute live workload ≤ pre-Phase-F baseline

**Phase F is complete when**:

- `grep -rn "private async " runtime/src/llm/chat-executor.ts` returns nothing (no more private async methods on the class)
- `grep -rn "private " runtime/src/llm/chat-executor.ts` returns only readonly field declarations plus `private dependencies()` + `private static normalizeRequestTimeoutMs`
- `chat-executor-planner.ts` does not exist
- `subagent-prompt-builder.ts` and `subagent-failure-classification.ts` do not exist (merged into orchestrator)
- All 13 PRs in this plan are merged
- `pre-phase-f-pr1` through `pre-phase-f-pr13` tags exist on origin

---

## Critical Files for Implementation

### Source files (referenced throughout the plan)

- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/llm/chat-executor.ts` (target of extraction)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/llm/chat-executor-ctx-helpers.ts` (PR-1, PR-4 destination)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/llm/chat-executor-tool-loop.ts` (PR-5 destination)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/llm/chat-executor-fallback.ts` (PR-6 destination for E3)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/llm/chat-executor-planner.ts` (PR-9 delete target)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/llm/chat-executor.test.ts` (PR-10 split target)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/gateway/subagent-orchestrator.ts` (PR-11 dead code target, PR-12 merge destination)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/gateway/subagent-prompt-builder.ts` (PR-12 merge source)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/gateway/subagent-failure-classification.ts` (PR-12 merge source)
- `/home/tetsuo/git/AgenC/agenc-core/runtime/src/gateway/subagent-context-curation.ts`, `delegation-admission.ts`, `subagent-workspace-probes.ts`, `subagent-infrastructure.ts` (PR-11 dead code targets)

### Reference files (read-only, for alignment)

- `/home/tetsuo/git/claude_code/query.ts` (L204-1729) — reference shape for async generator + state threading
- `/home/tetsuo/git/claude_code/services/tools/toolOrchestration.ts` (L19-177) — reference for `runTools` free-function dispatch
- `/home/tetsuo/git/claude_code/services/compact/compact.ts` (L330-700) — reference for `compactConversation` free-function shape
- `/home/tetsuo/git/claude_code/tools/AgentTool/runAgent.ts` (L248-860) — reference for recursive subagent generator pattern
- `/home/tetsuo/git/claude_code/utils/hooks.ts` (L3594-4157) — reference for free-function hook dispatchers
- `/home/tetsuo/git/claude_code/query/stopHooks.ts` (L65-342) — reference for Stop/StopFailure hook integration

### Scripts

- `runtime/scripts/check-executor-baseline.mjs` — baseline gate, enforces `>= 361 test files, >= 5,970 it() blocks`
- `runtime/scripts/build-public-runtime-artifacts*.mjs` — used by daemon smoke test in PR-13

---

## Notes Carried Forward From Prior Refactor

1. **Daemon PID file quirk**: `agenc-runtime stop` sometimes reports "not running" even when a daemon is alive on port 3100 because the pid file at `~/.agenc/daemon.pid` is not always written. Fallback: find the PID via `ss -tlnp 'sport = :3100'` and `kill -TERM <pid>` directly.
2. **From-source dev mode**: `agenc-runtime start --from-source` builds `runtime/dist` locally and symlinks `~/.agenc/runtime/current` to it. The daemon picks up the fresh build automatically. Use this for all daemon restarts during Phase F rather than the packaged tarball install.
3. **Refactor-log location**: `docs/REFACTOR-LOG.md` is the authoritative ledger. Each PR in Phase F appends one row.
4. **Baseline script floors**: currently `MIN_TEST_FILES = 361`, `MIN_IT_BLOCKS = 5970`. PR-10 will temporarily break these during the test split; the baseline script should be updated inside PR-10 itself (in the same commit) to reflect the new file count and it() count.
5. **Attribution rule**: commit messages / PR bodies / code comments must not contain "Claude", "Anthropic", "Co-Authored-By", "Generated with", robot emoji, or any AI attribution. Zero exceptions. The baseline script enforces this for commit messages.
