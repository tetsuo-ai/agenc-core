# TODO: Align AgenC Runtime With Claude Code Shape

**Goal.** A reliable, working AgenC daemon whose agent loop is shaped like
`claude_code/query.ts` — a single flat tool loop — with AgenC's real
product value (channels, background runs, Concordia bridge, skills
marketplace, watch TUI, protocol integration) preserved as layers around
that core.

**Source of this plan.** Parallel audit of both
`/home/tetsuo/git/claude_code` (170,084 LOC) and
`/home/tetsuo/git/AgenC/agenc-core/runtime` (259,048 LOC) by 50
focused subagents. Every file/line/LOC figure below comes from those
reports.

**Scope.** This supersedes the prior `TODO.MD` (which targeted the
deleted planner subsystem). Phases 2a–2e already merged (~36,000 LOC
deleted from the planner). This document is the plan for everything
that remains.

---

## 0. Architectural Gap at a Glance

**Scope discipline.** The earlier draft of this plan had Cut 8 (memory
graph trim + filesystem memdir) and Cut 6 sub-items for `print`/`repl`
modes. Both were dropped because they don't fix any of the 8 original
error classes — memory graph is over-engineered but inert, and
print/repl are claude_code feature parity, not stale-daemon symptoms.
The plan stays focused on **what makes the daemon work**.

| Concern            | claude_code (works)              | AgenC runtime (today)               | Delta          |
|--------------------|----------------------------------|-------------------------------------|----------------|
| Total LOC          | 170,084                          | 259,048                             | +88,964        |
| Core agent loop    | `query.ts` (1,729)               | `chat-executor.ts` (2,257) + `-tool-loop.ts` (1,000) + `-tool-utils.ts` (1,156) + `-recovery.ts` (2,182) + `-text.ts` (1,734) + `-types.ts` (1,194) + `-planner.ts` (972) + `-fallback.ts` (388) + `-artifact-task.ts` (387) + `-provider-retry.ts` (244) + `-budget-extension.ts` (356) + `turn-execution-contract.ts` (801) | ~12,670 vs. 1,729 |
| Tool orchestration | `toolOrchestration.ts` (188) + `toolExecution.ts` (1,745) | `chat-executor-tool-loop.ts` (1,000) + `tool-handler-factory.ts` (3,272) + `tool-routing.ts` (1,898) | ~6,170 vs. 1,933 |
| Process model      | Per-invocation (CLI, print, REPL, SDK) + pooled `bridge/` for CCR | Single long-lived `daemon.ts` (6,576) with WebSocket channels | fundamentally different |
| Sub-agent          | `AgentTool/` — nested `query()` call, ~1,000 LOC total | `subagent-orchestrator.ts` (2,518) + 9 support files | ~10,000 vs. 1,000 |
| Permissions        | `Tool.checkPermissions()` + rule patterns + `canUseTool` hook, one glob matcher | `policy/engine.ts` (~1,036) + `tool-policy.ts` + `mcp-governance.ts` + `approvals.ts` (1,355); three separate glob matchers | ~3,000 vs. ~500 |
| Compaction         | `snipCompactIfNeeded` + `microcompact` + `autoCompact` + `reactiveCompact` + `contextCollapse`, layered | `prompt-budget.ts` (839) + ad-hoc `compactHistory()` | missing reactive/collapse |
| State              | Flat `Message[]`, JSONL append, `tombstone`, `normalizeMessagesForAPI` pure fn | Entangled in gateway/daemon with planner-era fields | needs extraction |

**Headline:** the runtime is **~90,000 LOC of cruft** on top of what a
Claude-Code-shaped runtime actually needs. ~60% of the agent loop is
pre-deletion-era scar tissue, 15% is Doom/execute_with_agent/stale-harness
special cases, and 25% is legitimate extensions (channels, background
runs, protocol tools, Concordia bridge) that should stay.

**Already deleted** (PRs #178–#193, Phase 1 + 2a–2e): planner execution
pipeline, verifier lane source files, contract-flow/contract-guidance,
`chat-executor-doom.ts`, 57 dead exports from `chat-executor-planner.ts`.

**This plan finishes the job and aligns the rest.**

---

## Table of Contents

- [Cut 1 — Finish the planner tail](#cut-1)
- [Cut 2 — Gut llm/ to claude_code shape](#cut-2)
- [Cut 3 — Delete legacy lanes](#cut-3)
- [Cut 4 — Gut gateway/](#cut-4)
- [Cut 5 — Add claude_code-shaped capabilities that are missing](#cut-5)
- [Cut 6 — Close the stale-daemon feedback loop](#cut-6)
- [Cut 7 — Policy / approvals consolidation](#cut-7)
- [Cut 9 — Ship it](#cut-9)
- [Appendix A — Complete deletion manifest](#appendix-a)
- [Appendix B — claude_code learnings library](#appendix-b)
- [Appendix C — Risk register](#appendix-c)
- [Appendix D — PR sequence and branch names](#appendix-d)

---

## <a id="cut-1"></a>Cut 1 — Finish the planner tail

**Goal.** Delete every remaining file that exists only to serve the
removed planner pipeline. After this cut, no file under `runtime/src/`
should mention "planner", "workflow verification contract",
"completion contract", "plan-only execution", or
"turn execution contract".

**Target: ~8,500 LOC deleted.**

### 1.1 Delete planner-coupled files under `runtime/src/workflow/`

All verdicts come from the `rt_workflow` audit. Every DELETE is confirmed
reachable only from other DELETEs or from eval harnesses being removed.

| File | Lines | Verdict | Why |
|---|---|---|---|
| `workflow/verification-contract.ts` | 830 | **DELETE** | Planner-era contract validation. Only called by `delegation-validation.ts` and eval suites. |
| `workflow/cleanup-mode.ts` | 181 | **DELETE** | Literal issue codes for `PLANNER_VERIFIER_*` — zero non-test references. |
| `workflow/verification-obligations.ts` | 297 | **DELETE** | Derives obligations from planner contracts. All callers planner-coupled. |
| `workflow/verification-results.ts` | 128 | **DELETE** | Planner verification channel diagnostic types. |
| `workflow/workspace-inspection-evidence.ts` | 289 | **DELETE** | Evidence grading for planner acceptance criteria. |
| `workflow/request-completion.ts` | 50 | **DELETE** | Milestone tracking contract (planner artifact). |
| `workflow/subagent-orchestration-requirements.ts` | 383 | **DELETE** | Parses user messages for planner multi-agent cues. |
| `workflow/execution-kernel-policy.ts` | 243 | **DELETE** | DAG dependency satisfaction for planner graphs. |
| `workflow/completion-contract.ts` | 19 | **MERGE** | Fold into `execution-envelope.ts`. |
| `workflow/completion-state.ts` | 120 | **PRUNE** | Keep simple `resolvePipelineCompletionState()`; delete planner-aware complex resolver. Target ~60. |
| `workflow/execution-intent.ts` | 127 | **PRUNE** | Keep `canonicalizeExecutionStepKind()`; delete planner step inferences. Target ~60. |
| `workflow/execution-kernel.ts` | 330 | **PRUNE** | Keep deterministic pipeline entry; delete planner-delegate path. Target ~200. |
| `workflow/pipeline.ts` | 737 | **KEEP** | Core deterministic multi-step executor. Used by autonomous desktop-executor and background runs. |
| `workflow/execution-envelope.ts` | 442 | **KEEP** | Artifact relations + effect class. |
| `workflow/artifact-contract.ts` | 65 | **KEEP** | Read/write sandboxing types. |
| `workflow/path-normalization.ts` | 306 | **KEEP** | Core utility. |

**workflow/ delta: delete ~2,800, prune ~400 to ~320, keep ~1,550.**

### 1.2 Delete residual llm/ files left from the planner rip-out

| File | Lines | Verdict | Why |
|---|---|---|---|
| `llm/chat-executor-planner.ts` | 972 | **INLINE + DELETE** | 13 surviving utilities (12 + `safeStepStringArray` already extracted). Move into new `llm/request-analysis.ts` (~400 lines) and delete the file. |
| `llm/turn-execution-contract.ts` | 801 | **DELETE** | Delegation/orchestration/artifact inference. Only consumer is dead planner routing. |
| `llm/turn-execution-contract-types.ts` | 53 | **DELETE** | Types for above. |
| `llm/chat-executor-artifact-task.ts` | 387 | **DELETE** | Planner-era artifact-task pipeline. |
| `llm/chat-executor-doom.ts` | 287 | **DELETED** (this session) | Done. |
| `llm/chat-executor-doom.test.ts` | 199 | **DELETED** (this session) | Done. |
| `llm/chat-executor-provider-retry.ts` | 244 | **DELETE + INLINE** | Merge retry-before-fallback into `grok/adapter.ts`. |
| `llm/chat-executor-budget-extension.ts` | 356 | **DELETE** | Dynamic round-budget extension. Claude Code uses fixed `maxTurns` + recovery message. Drop the `evaluateToolRoundBudgetExtension` callback. |
| `llm/run-budget.ts` | 552 | **DELETE** | Planner/verifier/child run class ledger. No users after Cuts 2+3. |
| `llm/model-routing-policy.ts` | 349 | **DELETE + SIMPLIFY** | Claude Code's routing is 3 rules in one function. Replace with a 30-line helper. |
| `llm/delegation-decision.ts` | 619 | **DELETE** | `assessDelegationDecision()` only called from eval. Live delegation uses `assessDelegationAdmission()`. |
| `llm/delegation-learning.ts` | 564 | **PRUNE → ~200** | Keep trajectory sink + `computeDelegationFinalReward` + `deriveDelegationContextClusterId` (used by subagent orchestrator). Delete `DelegationBanditPolicyTuner` (never wired) + `computeUsefulDelegationProxy` (dead). Rename to `delegation-trajectory.ts`. |

**llm/ tail delta: delete ~4,900, shrink ~564 → ~200.**

### 1.3 Delete the `simpleAgentLoop` flag

- `chat-executor-types.ts` — remove from `ChatExecutorConfig`
- `chat-executor.ts` — remove flag check (only path now)
- `gateway/chat-executor-factory.ts` — remove `?? true`
- `gateway/types.ts` — remove from gateway LLM config
- `gateway/config-watcher.ts` — remove validation line

### 1.4 Acceptance for Cut 1

- `tsc --noEmit -p runtime/tsconfig.json` clean
- `npm run test` ≥ 6,830 tests passing (allow ±5 for deletions)
- `rg -l 'PlannerVerificationContract|ImplementationCompletionContract|TurnExecutionContract|WorkflowVerificationContract' runtime/src` returns nothing
- `rg -l 'chat-executor-doom|chat-executor-artifact-task|turn-execution-contract|run-budget|model-routing-policy|delegation-decision' runtime/src` returns nothing

### 1.5 PRs in Cut 1

1. **PR#1** `refactor(runtime): delete workflow/ planner-coupled files (phase 2f)` — ~2,800 LOC
2. **PR#2** `refactor(runtime): delete llm/ planner tail (turn-execution-contract, artifact-task, run-budget, delegation-decision)` — ~3,100 LOC
3. **PR#3** `refactor(runtime): inline surviving planner.ts utilities into request-analysis.ts`
4. **PR#4** `refactor(runtime): delete budget-extension + provider-retry, inline into adapter` — ~600 LOC
5. **PR#5** `refactor(runtime): delete model-routing-policy.ts, replace with 30-line helper` — ~300 LOC
6. **PR#6** `refactor(runtime): rename delegation-learning.ts → delegation-trajectory.ts, delete bandit tuner` — ~360 LOC
7. **PR#7** `refactor(runtime): remove simpleAgentLoop flag (Phase 3)` — ~50 LOC

---

## <a id="cut-2"></a>Cut 2 — Gut llm/ to claude_code shape

**Goal.** Collapse `chat-executor.ts` + its 11 support files into a
`query()`-shaped flat loop. After this cut, `runtime/src/llm/` should be
~12,000 LOC (down from ~33,000).

**Target: ~15,000 LOC deleted/merged across the executor chain.**

### 2.1 `chat-executor-recovery.ts` — 2,182 → ~300

Per `rt_recovery` audit:

**Load-bearing (keep, ~295 LOC):**
- `preflightStaleCopiedCmakeHarnessInvocation` (85) — real, solves stale-build-dir on delegated workspaces. Move to `chat-executor-tool-loop.ts` as inline preflight.
- Round-level CMake recovery hints in `inferRoundRecoveryHint` (~100)
- `buildSemanticToolCallKey` + `normalizeSemanticValue` (~30) — used by circuit breaker, stuck detection, dedup
- `summarizeStateful` + `hasActionableStatefulFallback` (~50)
- Minimum per-call hints (npm missing script, package exports, shell builtin, watch-mode) (~30)

**Delete (~1,800 LOC):**
- `execute_with_agent` validation (13 variants, lines 1441–1576) — ~135 LOC — planner-era delegation scope gates
- Doom-specific hints (lines 1329–1363, 1307–1321) — ~35 LOC
- Compiler diagnostics parsing (lines 887–968, 1729–1768) — ~120 LOC — model can read its own error output
- `computeQualityProxy` + `buildDelegationTrajectoryEntry` + `buildPlannerSummary` — ~100 LOC (move trajectory to `delegation-trajectory.ts`)
- Exhaustive npm workspace + exports edge cases — ~140 LOC
- Long-tail per-tool hint detectors — ~400+ LOC
- `buildWorkflowRecoveryStateLines` — ~60 LOC
- `sanitizeRawToolResultText` regex helpers — ~40 LOC

### 2.2 `chat-executor-text.ts` — 1,734 → ~300

Per `rt_text` audit:

**Keep (~300 LOC):**
- `truncateText`, `normalizeHistory`, `extractMessageText`, `extractLLMMessageText`
- `sanitizeJsonForPrompt`, `prepareToolResultForPrompt`, `buildPromptToolContent`
- Estimation helpers: `estimateContentChars`, `estimateMessageChars`, `estimatePromptShape`, `estimateToolCallsChars`
- `appendUserMessage` (multimodal)
- `generateFallbackContent`, `summarizeToolCalls` (simple variants)

**Delete (~1,400 LOC):**
- `reconcileExactResponseContract` (~60)
- `reconcileStructuredToolOutcome` (~100)
- `reconcileTerminalFailureContent` (~80)
- `reconcileTerminalCompletionStateContent` (~120)
- `reconcileDirectShellObservationContent` (~80)
- `reconcileVerifiedFileWorkflowContent` (~200)
- `looksLikeExecutionPlan`, `isPlanOnlyExecutionResponse`, `isExecutionDeferralResponse` (~40)
- `toStatefulReconciliationMessage`, `normalizeHistoryForStatefulReconciliation` (~60)
- `buildToolExecutionGroundingMessage` (~80)
- `collapseRunawayRepetition`, `isBase64Like`, `sanitizeRawToolResultText` (~100)
- Planner-era content-shaping helpers (~500+)

### 2.3 `chat-executor-tool-utils.ts` — 1,156 → ~300

Per `rt_toolloop` audit:

**Keep:**
- Argument parsing: `parseToolCallArguments`, `normalizeToolCallArguments`, `normalizeFilesystemToolCallArguments` (~200)
- `checkToolCallPermission` (~50)
- `executeToolWithRetry` (~40)
- Failure detection: `didToolCallFail`, `extractToolFailureText`, `isLikelyToolTransportFailure` (~50)
- Semantic dedup helpers (~50)

**Delete:**
- `repairToolCallArgumentsFromMessageText` (~60) — regex-based repair for `social.requestCollaboration` only; scar tissue
- `enrichToolResultMetadata` (~40) — planner-era metadata enrichment
- `trackToolCallFailureState` — merge with circuit breaker (~50 saved)
- `summarizeToolRoundProgress`, `ToolRoundProgressSummary` (~80) — only used by deleted budget extension
- `buildToolLoopRecoveryMessages`, `buildRoutingExpansionMessage` (~60) — simplify
- Slim `checkToolLoopStuckDetection` to ~80 (currently ~150)

### 2.4 `chat-executor-types.ts` — 1,194 → ~400

Per `rt_types` audit. Delete:
- All `Planner*` types (12 items listed in audit)
- `WorkflowContract`, `WorkflowStepContract`, `WorkflowContractClass`
- `ChatPlannerSummary`, `MutablePlannerSummaryState`, `ChatPlannerDecision*`
- 9 planner-only trace variants in `ChatExecutionTraceEventType`
- 25 dead fields from `ExecutionContext` (enumerated in audit under "Bloat Vector"): `plannerHandled`, `plannerImplementationFallbackBlocked`, `plannerWorkflowTaskClassification`, `plannerVerificationContract`, `plannerCompletionContract`, `plannerFailedStep`, `plannerTerminalFallback`, `plannerSummaryState`, `plannedSubagentSteps`, `plannedDeterministicSteps`, `plannedSynthesisSteps`, `plannedDependencyDepth`, `plannedFanout`, `trajectoryContextClusterId`, `selectedBanditArm`, `tunedDelegationThreshold`, `requiredToolEvidenceCorrectionAttempts`, `completedRequestMilestoneIds`, `economicsState`, `delegationBudgetSnapshot`, etc.

### 2.5 `chat-executor.ts` — 2,257 → ~1,500

Per `rt_executor` audit. Collapse into a `query()`-shaped loop. Delete:
- `resolvePlannerFallbackBarrier()` (44)
- `resolveWorkflowVerificationContext()` (18) — returns `{}` unconditionally
- Shrink `synchronizeCompletionState()` to 5-line no-op stub for API stability
- Planner decision scoring in `initializeExecutionContext()` (~50)
- Phase `"planner_synthesis"` / `"planner"` branches in `callModelForPhase()` (~30)
- Unused `plannerSummary` state building + bandit tuning post-turn (~80)
- Multi-phase dispatch via `resolveRunClassForPhase()` (~30)

Simplify:
- Collapse `phase` from 5 values to 2 (`"initial"`, `"tool_followup"`)
- Inline `executeToolCallLoop()` wrapper
- Fold `buildToolLoopCallbacks()` into caller
- Replace class with `export async function* executeChat(params)` matching `query()` shape

### 2.6 `chat-executor-tool-loop.ts` — 1,000 → ~700

Per `rt_toolloop` audit. Delete:
- Dialogue-only tool suppression branch (planner-era)
- `preflightStaleCopiedCmakeHarnessInvocation` call site (moved inline in Cut 2.1)
- `contractGuidance.runtimeInstruction` injection (contract-guidance deleted Phase 2c)
- `maybePushRuntimeInstruction` callback usage (Doom-era)
- `finalizeDelegatedTurnAfterToolBudgetExhaustion` (already deleted)
- Routing expansion via `buildRoutingExpansionMessage`
- Simplify semantic keys machinery — keep only for circuit breaker

### 2.7 `llm/types.ts` — 907 → ~400

Per `rt_llmtypes` audit. Keep only:
- `LLMMessage`, `LLMContentPart`, `LLMToolCall`, `LLMTool`, `LLMResponse`, `LLMUsage`, `LLMStreamChunk`, `MessageRole`
- `LLMChatOptions`, `LLMChatToolRoutingOptions`, `LLMToolChoice`, `LLMReasoningEffort`
- `LLMProvider`, `LLMProviderConfig`, `LLMProviderCapabilities`
- Tool validation types + functions

Delete:
- All `LLMStateful*` — stateful continuation is a Grok adapter detail, move to `grok/types.ts`
- All `LLMCompaction*` — move to the new compaction module in Cut 5
- All `LLMProviderNativeServerTool*`
- All xAI-specific config types (`LLMXaiCapabilitySurface`, `LLMWebSearchConfig`, `LLMXSearchConfig`, `LLMRemoteMcpConfig`, `LLMRemoteMcpServerConfig`, `LLMCollectionsSearchConfig`) → move to `grok/types.ts`
- `LLMStoredResponse*`, `LLMEncryptedReasoningDiagnostics`
- Planner phase variants in `LLMProviderTraceEvent`

### 2.8 `llm/prompt-budget.ts` — 839 → REPLACED in Cut 5

Do not trim. The whole budgeting model is replaced by claude_code-style
`tokenCountWithEstimation` + layered compaction (Cut 5). When Cut 5
lands, delete `prompt-budget.ts` and its callers.

### 2.9 `llm/tool-failure-circuit-breaker.ts` — 169, KEEP

Real bug prevention, different granularity from stuck detection.

### 2.10 `llm/chat-executor-fallback.ts` — 388 → 120

Keep the provider-fallback wrapper. Delete:
- Per-provider skip-reason buffer diagnostics
- `computeProviderCooldownMs` → simplify to "transient = short cooldown + jitter, permanent = long cooldown"
- Policy-gate failure wrapping (policy enforced in tool-handler, not here)

### 2.11 Acceptance for Cut 2

- `chat-executor*.ts` sum drops from ~12,670 to ~4,200 LOC
- Signature change: `export async function* executeChat(params): AsyncGenerator<ExecEvent>`
- 6,830 tests passing minus tests for intentionally removed features
- Real Grok + Ollama end-to-end turn works via new loop

### 2.12 PRs in Cut 2

1. **PR#8** `refactor(runtime): shrink chat-executor-recovery.ts from 2,182 → 300`
2. **PR#9** `refactor(runtime): shrink chat-executor-text.ts from 1,734 → 300`
3. **PR#10** `refactor(runtime): shrink chat-executor-tool-utils.ts from 1,156 → 300`
4. **PR#11** `refactor(runtime): prune chat-executor-types.ts from 1,194 → 400`
5. **PR#12** `refactor(runtime): shrink llm/types.ts from 907 → 400, move Grok types`
6. **PR#13** `refactor(runtime): shrink chat-executor-tool-loop.ts from 1,000 → 700`
7. **PR#14** `refactor(runtime): collapse chat-executor.ts to query.ts-shaped generator`
8. **PR#15** `refactor(runtime): simplify chat-executor-fallback.ts from 388 → 120`

---

## <a id="cut-3"></a>Cut 3 — Delete legacy lanes

**Target: ~16,000 LOC deleted.**

### 3.1 Delete the autonomous verifier lane

Per `rt_autonomous`. The verifier lane is only wired through
`autonomous/agent.ts` (AutonomousAgent — the pre-Grok Solana task
executor, separate from desktop goals).

Delete:
- `runtime/src/autonomous/verifier.ts`
- `runtime/src/autonomous/verification-budget.ts` (~400)
- `runtime/src/autonomous/verifier-scheduler.ts` (~80)
- `runtime/src/autonomous/escalation-graph.ts` (~65)
- `runtime/src/autonomous/candidate-generator.ts`
- `runtime/src/autonomous/arbitration.ts`
- `runtime/src/autonomous/inconsistency-detector.ts`
- `runtime/src/autonomous/risk-scoring.ts` — move `scoreTaskRisk()` to `task-discovery-action.ts` as local helper
- `runtime/src/autonomous/agent.ts` (AutonomousAgent)
- All associated tests

**Keep the real autonomous lane:**
- `autonomous/goal-manager.ts` — durable goal lifecycle
- `autonomous/goal-store.ts` — persisted goal history
- `autonomous/desktop-executor.ts` — see-think-act-verify via ChatExecutor
- `autonomous/strategic-memory.ts` — durable task/goal history
- `autonomous/desktop-awareness.ts` + `autonomous/awareness-goal-bridge.ts`
- `autonomous/goal-executor-action.ts` — heartbeat goal execution
- `autonomous/proactive-comms-action.ts`

**autonomous/ delta:** ~5,200 → ~2,000 LOC.

### 3.2 Delete the task/ speculation ecosystem

Per `rt_task`. Speculation is only used by deleted `autonomous/agent.ts`.
Live caller is `gateway/runtime.ts` → `TaskExecutor` + SQLite stores.

Delete:
- `task/speculative-executor.ts`
- `task/speculative-scheduler.ts`
- `task/proof-pipeline.ts`
- `task/proof-deferral.ts`
- `task/rollback-controller.ts`
- `task/commitment-ledger.ts`
- `task/dependency-graph.ts`
- `task/speculation-metrics.ts`
- `task/speculation-adapter.ts`
- All matching tests

**Keep:**
- `task/executor.ts` (TaskExecutor)
- `task/types.ts`, `task/operations.ts`, `task/discovery.ts`, `task/pda.ts`
- `task/checkpoint.ts` + `task/sqlite-checkpoint-store.ts`
- `task/dlq.ts` + `task/sqlite-dlq.ts`
- `task/filters.ts`, `task/priority-queue.ts`, `task/metrics.ts`

**task/ delta:** ~9,160 → ~1,200 LOC.

### 3.3 Acceptance for Cut 3

- `tsc --noEmit` clean
- Goal manager tests passing
- Background runs still start/resume/stop via TaskExecutor + sqlite stores
- No references to `SpeculativeExecutor`, `ProofPipeline`, `RollbackController`, `VerifierExecutor`, `AutonomousAgent`

### 3.4 PRs in Cut 3

1. **PR#16** `refactor(runtime): delete autonomous verifier lane`
2. **PR#17** `refactor(runtime): delete autonomous/agent.ts — keep desktop/goal/awareness lanes`
3. **PR#18** `refactor(runtime): delete task/ speculation ecosystem`

---

## <a id="cut-4"></a>Cut 4 — Gut gateway/

**Target: ~35,000 LOC deleted/simplified (71k → ~36k).**

### 4.1 Excise Doom autoplay from daemon.ts

Per `rt_daemon`. Delete:
- Three Doom stub functions in daemon.ts (lines 298–328, added this session as placeholders)
- Imports of `blockUntilDoomStopTool`, `isDoomStopRequest`, `DoomStopRequest`
- `DEFAULT_DOOM_FIT_RESOLUTION` + `chooseDoomResolutionForDisplay()` (lines 398–408)
- `buildDoomAutoplayBackgroundContract()`, `extractDoomRecoveryObjective()`, `buildDoomAutoplaySupervisionObjective()` (lines 378–490)
- ~200 LOC of Doom autoplay logic in WebChat turn (lines 5623–5944)
- `executeWebChatDoomStopTurn()` method
- `runtime/src/gateway/doom-stop-guard.ts` + test
- `DOOM_TOOL_PREFIX` in `tool-routing.ts`
- Doom references in `tool-routing.test.ts`, `run-domains.ts/test`, `background-run-supervisor.test.ts`, `tool-handler-factory.test.ts`, `chat-executor.test.ts`, `chat-executor-recovery.test.ts`, `chat-executor-routing-state.test.ts`, `chat-executor-tool-utils.test.ts`

**Total Doom deletion across the tree: ~500 LOC.**

### 4.2 Delete tool-routing.ts (1,898) entirely

Per `rt_toolhandler`. Per-phase "routed tool names" was planner-era.
Claude Code exposes a single static tool list per query.

Delete:
- `runtime/src/gateway/tool-routing.ts`
- `runtime/src/gateway/tool-routing.test.ts`
- `ToolRouter` instantiation in daemon.ts
- `buildToolRoutingDecision()` plumbing
- `ToolRoutingDecision` plumbing in `daemon-text-channel-turn.ts`, `daemon-webchat-turn.ts`, `background-run-supervisor.ts`
- `recordToolRoutingOutcome()`, `maybeAugmentToolRoutingDecisionWithNativeTools()`

Replace with: `resolveAllowedTools(sessionId): readonly string[]` — ~30 LOC.

### 4.3 Simplify tool-handler-factory.ts (3,272 → ~1,000)

Per `rt_toolhandler`:

**Keep (~800):** normalization, tool:before hook dispatcher, approval gating, handler selection + execution + timing, result formatting + WebSocket send, onToolStart/onToolEnd callbacks

**Delete (~2,200):**
- Verification metadata extraction (lines 675–733, 3208–3216) — ~60
- Effect ledger + compensation (lines 2783–2860, 3045–3205) — ~200
- Policy engine delegation gating (lines 2595–2623) — ~30 (moves to approvals)
- Subagent lifecycle verification events (lines 3237–3252) — ~20
- MCP-specific native tool augmentation
- Overgrown test fixtures

### 4.4 Collapse subagent orchestrator stack (~10,000 → ~1,200)

Per `rt_subagent`. Current sprawl: 10 files.

**Delete entirely:**
- `gateway/delegation-economics.ts`
- `gateway/subagent-dependency-summarization.ts`
- `gateway/subagent-workspace-probes.ts`

**Shrink:**
- `gateway/subagent-orchestrator.ts` 2,518 → ~400
- `gateway/subagent-prompt-builder.ts` 1,207 → ~300
- `gateway/subagent-context-curation.ts` → keep sensitive-data redaction + history/memory filtering; remove workspace artifact scanning
- `gateway/delegation-admission.ts` → keep hard rejections only (fanout/depth/shared-writer)
- `gateway/sub-agent.ts` → keep as ~500 LOC isolation primitive
- `gateway/subagent-infrastructure.ts` → keep, already minimal

Result: 5 files, ~1,200 LOC. Matches `claude_code/tools/AgentTool/` shape.

### 4.5 Simplify daemon.ts (6,576 → ~3,500)

Per `rt_daemon`. Beyond 4.1 Doom:
- Delete planner fallback barrier checks in WebChat turn path — ~80
- Delete `configureDelegationRuntimeServices` + `clearDelegationRuntimeServices` bandit wiring — ~85
- Delete `createPlannerPipelineExecutor()` — ~55
- Delete per-phase tool routing wiring — ~60
- Delete `hotSwapLLMProvider` planner paths — ~40
- Delete `maybeApplyPlannerFrameworkOverrides` — ~30
- Shrink sub-agent infrastructure methods post-Cut 4.4 — ~300
- Split WebChat turn path: trim planner-era branches — ~200
- Trim telemetry wiring — ~50

Target: ≤ 3,500 LOC.

### 4.6 Shrink background-run-supervisor.ts (4,468 → ~2,300)

Per `rt_bgrun`. Keep core actor → verifier → reschedule loop, carry-forward
state compression, managed-process lifecycle, wake signals, dispatch
queue, budget enforcement, checkpoint/resume.

Delete:
- All Doom test fixtures + game-specific heuristics (`allowsHeuristicProcessExitCompletion`) — ~300
- Autonomy rollout quality gating (move to eval consumer) — ~200
- Duplicated approval flow — ~100
- Sub-agent lineage tracking (move to `durable-subrun-orchestrator.ts`) — ~250
- Provider compaction repair (move to Grok adapter) — ~150
- Fault injection points (already in eval) — ~50

### 4.7 Shrink background-run-store.ts (3,472 → ~2,000)

Keep persist/load/checkpoint/event stream/wake queue/dispatch queue/dead
letters. Delete per-run quality artifact embedding, trajectory record
embedding, legacy schema migrations beyond latest 2.

### 4.8 Other gateway cuts

- `gateway/approvals.ts` → see Cut 7
- `gateway/config-watcher.ts` (3,065) → delete planner-related config validation (~150)
- `gateway/run-domains.ts` (1,532) → delete Doom refs, simplify run class enumeration (~200)
- `gateway/daemon-feature-wiring.ts` → delete verifier-lane + autonomy-agent wiring, keep desktop/goal/awareness/social
- `gateway/daemon-command-registry.ts` (2,331) → audit for planner-era commands

### 4.9 Acceptance for Cut 4

- `gateway/` ≤ 36,000 LOC
- WebChat end-to-end turn works
- Background runs start/resume/stop
- Sub-agent delegation works via simplified orchestrator
- `rg doom runtime/src` returns nothing
- No references to `tool-routing.ts` exports

### 4.10 PRs in Cut 4

1. **PR#19** `refactor(gateway): excise Doom autoplay subsystem`
2. **PR#20** `refactor(gateway): delete tool-routing.ts`
3. **PR#21** `refactor(gateway): shrink tool-handler-factory.ts`
4. **PR#22** `refactor(gateway): collapse subagent stack to 5 files`
5. **PR#23** `refactor(gateway): simplify daemon.ts to ~3,500 LOC`
6. **PR#24** `refactor(gateway): shrink background-run-supervisor.ts`
7. **PR#25** `refactor(gateway): shrink background-run-store.ts + run-domains.ts`
8. **PR#26** `refactor(gateway): prune daemon-feature-wiring and command-registry`

---

## <a id="cut-5"></a>Cut 5 — Add claude_code-shaped capabilities that are missing

**Goal.** Add the real features from claude_code we don't have.

### 5.1 Add layered compaction (snip → microcompact → autocompact → reactiveCompact)

Per `cc_compact`. Replaces `prompt-budget.ts` (839) + ad-hoc
`compactHistory()`.

New files:
- `runtime/src/llm/compact/snip.ts` (~150) — time-based old-message removal
- `runtime/src/llm/compact/microcompact.ts` (~200) — content-clear of cached tool results
- `runtime/src/llm/compact/autocompact.ts` (~300) — proactive summarization
- `runtime/src/llm/compact/reactive-compact.ts` (~200) — 413/prompt-too-long fallback
- `runtime/src/llm/compact/index.ts` (~100) — ordering

Key shapes:
- `tokenCountWithEstimation(messages, lastResponseUsage)` — canonical token counter
- `AutoCompactTrackingState { compacted, turnCounter, turnId, consecutiveFailures? }`
- `buildPostCompactMessages({ boundary, summary, kept, attachments })`
- `CompactBoundaryMessage` — system subtype `compact_boundary`, filtered by `normalizeMessagesForAPI`
- `ESCALATED_MAX_TOKENS = 64000`
- Suffix-preserving reactive compact on 413

Integration:
```
for each iteration:
  apply snip (yield boundary)
  apply microcompact (defer boundary for cached path)
  apply autocompact (if tokens >= threshold)
  call model
  on withheld prompt-too-long: apply reactiveCompact, retry
```

Delete `llm/prompt-budget.ts` when this lands.

**New LOC: ~950.**

### 5.2 Add hook system

Per `cc_hooks`. Hook types:
- `SessionStart`, `UserPromptSubmit`
- `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
- `PermissionRequest`, `PermissionDenied`
- `Stop`, `StopFailure`
- `PreCompact`, `PostCompact`
- `SubagentStart`, `SubagentStop`
- `Notification`, `FileChanged`, `ConfigChange`

Config: `~/.agenc/hooks.json` with matcher patterns.

New files:
- `runtime/src/llm/hooks/types.ts` (~200)
- `runtime/src/llm/hooks/registry.ts` (~300)
- `runtime/src/llm/hooks/dispatcher.ts` (~400)
- `runtime/src/llm/hooks/executors.ts` (~300)
- `runtime/src/llm/hooks/matcher.ts` (~100)

Integration: hooks fire inside `executeChat()` at each documented point.

**New LOC: ~1,300.**

### 5.3 Add per-tool result budget + disk persistence

Per `cc_toolresult`. Today we truncate at ~12KB in memory. claude_code
persists large results to disk and replaces with a 2KB preview.

New file: `runtime/src/llm/tool-result-budget.ts` (~400 LOC)
- `applyToolResultBudget(messages, state, writeToTranscript, skipTools)`
- `ContentReplacementState { seenIds, replacements }`
- `persistToolResult(toolUseId, content)` → `~/.agenc/workspace/tool-results/{sessionId}/{toolUseId}.{txt|json}`
- `reconstructContentReplacementState(records)` — on resume

Add `maxResultSizeChars: number` to `Tool` interface (default 50_000,
`Infinity` for self-bounded tools).

**New LOC: ~500.**

### 5.4 Add queryTracking (chainId + depth)

Per `cc_subagents`. Add to `ExecutionContext`:
```ts
queryTracking: { chainId: string; depth: number }
```
Sub-agent inherits chainId; increments depth. Replaces scattered depth
fields. **New LOC: ~50.**

### 5.5 Add concurrency-safe tool batching

Per `cc_tool_exec`. Today we dispatch serially.

Add `isConcurrencySafe?(args): boolean` to `Tool` interface. Default
false. Override to true for: `system.readFile`, `system.listDir`,
`system.httpGet`, `glob`, `grep`, `agenc.getTask`, `agenc.listTasks`.

New file: `runtime/src/llm/tool-orchestration.ts` (~200 LOC) with
`partitionToolCalls`, `runToolsConcurrently`, `runToolsSerially`,
`runTools` (matches `services/tools/toolOrchestration.ts`).

Integration: replace serial loop in `chat-executor-tool-loop.ts` with
`runTools()`. Keep circuit breaker + stuck detection between rounds.

**New LOC: ~250.**

### 5.6 Add AgentDefinition-based subagent

Per `cc_subagents`. Declarative agent definitions:

New directory: `runtime/src/gateway/agent-definitions/` with
`explore.md`, `plan.md`, `review.md`, `implement.md`. Each has
frontmatter:
```yaml
name: explore
description: Fast read-only codebase exploration
tools: [system.readFile, system.listDir, glob, grep]
model: inherit
maxTurns: 10
```

New loader: `runtime/src/gateway/agent-loader.ts` (~400 LOC). Scans
built-in dir + user `~/.agenc/agents/` + project `.agenc/agents/`.

Subagent orchestrator uses this instead of economics scoring. Spawns
nested `executeChat()` call with scoped tools.

**New LOC: ~600.**

### 5.7 Add canUseTool hook

Per `cc_permissions`. See Cut 7 for backend consolidation.

```ts
type CanUseToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolUseContext,
) => Promise<PermissionResult>

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "ask"; message: string; suggestions?: RuleSuggestion[] }
  | { behavior: "deny"; message: string }
```

Invoked inside `runTools` before each tool. Default impl consults rules,
tool `checkPermissions`, then hooks. **New LOC: ~400.**

### 5.8 Add normalizeMessagesForAPI + Message shape

Per `cc_state`. Extract clean shape:
- `Message = UserMessage | AssistantMessage | SystemMessage | TombstoneMessage | ProgressMessage | AttachmentMessage | ToolUseSummaryMessage`
- `normalizeMessagesForAPI(messages)` — pure function that:
  1. Reorders attachments
  2. Merges consecutive user messages
  3. Merges adjacent assistant messages by id
  4. Strips virtual messages
  5. Ensures tool_use ↔ tool_result pairing
  6. Strips signature blocks on credential change
  7. Enforces non-empty assistant content

New file: `runtime/src/llm/messages.ts` (~400 LOC).

Existing `chat-executor-text.ts::normalizeHistory` becomes a thin caller.
**Net: +200.**

### 5.9 Add tombstone message support

Per `cc_state` + `cc_query_loop`. When streaming fallback leaves orphaned
thinking blocks, yield `TombstoneMessage` to mark prior message for UI
removal. Not persisted. **New LOC: ~80.**

### 5.10 Add cache_control breakpoints

Per `cc_api`. Today we don't explicitly set xAI `cache_control` on
content blocks.

Add to `grok/adapter.ts`:
- Split system prompt into static prefix (cached) + dynamic suffix
- Attach `cache_control: { type: "ephemeral" }` on the last block of
  static prefix + last message content block
- Session-stable latched state prevents mid-session cache busts

**New LOC: ~150.**

### 5.11 Acceptance for Cut 5

- Layered compaction works end-to-end on a long webchat session
- Hooks fire at every documented point (covered by new tests)
- Per-tool result budget persists to disk with preview visible to model
- `canUseTool` unified path ready for Cut 7 backend merge
- Concurrency-safe tools run in parallel

### 5.12 PRs in Cut 5

1. **PR#27** `feat(runtime): layered compaction, delete prompt-budget.ts`
2. **PR#28** `feat(runtime): unified hook system`
3. **PR#29** `feat(runtime): per-tool result budget + disk persistence`
4. **PR#30** `feat(runtime): queryTracking for subagent nesting`
5. **PR#31** `feat(runtime): concurrency-safe tool batching`
6. **PR#32** `feat(runtime): AgentDefinition-based subagent loader`
7. **PR#33** `feat(runtime): canUseTool hook shape`
8. **PR#34** `refactor(runtime): Message flat-array + normalizeMessagesForAPI`
9. **PR#35** `feat(runtime): tombstone messages`
10. **PR#36** `feat(runtime): cache_control breakpoints on Grok adapter`

---

## <a id="cut-6"></a>Cut 6 — Close the stale-daemon feedback loop

**Goal.** The original 2-month silent failure window happened because
(a) `agenc-runtime restart` swapped in pre-published tarballs instead of
local source, (b) there was no way to verify which build was actually
running, and (c) errors accumulated in `daemon.errors.log` with no
visible signal. This cut fixes those three things and nothing else.

**Out of scope:** print mode, REPL mode, claude_code feature parity for
entrypoints. Those don't fix any failing workload.

### 6.1 Add `--from-source` dev flag

```
agenc-runtime start --from-source
```

Runs `npm run build` in `runtime/`, points
`~/.agenc/runtime/current` at the local dist with an atomic symlink
swap. Documented in `agenc-core/README.md`.

This is the **single most load-bearing item in the entire plan.**
Without it, every PR in Cuts 1–5 + 7 lands in the repo but never reaches
the running daemon — same as the last two months. ~150 LOC in
`agenc-runtime` wrapper + `runtime-manager.js`.

### 6.2 Add daemon startup banner

```
[agenc-runtime] starting
  commit: a1b2c3d
  build:  2026-04-07T12:34:56Z
  path:   ~/.agenc/runtime/current/node_modules/@tetsuo-ai/runtime/dist/bin/daemon.js
  config: ~/.agenc/config.json
```

Read commit + build time from `runtime/dist/VERSION` (written by the
build script). Logged as the first line of `~/.agenc/daemon.log` and
included in `agenc-runtime status` output.

Verification primitive for Cut 9: lets you confirm the running daemon
contains the commit you just built. ~30 LOC in `bin/daemon.ts` + a
build-script line that writes `dist/VERSION`.

### 6.3 Wire `daemon.errors.log` into watch TUI

1-hour rolling error-rate indicator in the watch TUI footer. Red badge
when non-zero, count visible. Closes the "did my fix actually land"
feedback loop that was missing from the original Stage 3 of the
stale-daemon plan.

~100 LOC in `watch/agenc-watch-surface-summary.mjs` + data source in
`watch/agenc-watch-log-tail.mjs`.

### 6.4 Acceptance for Cut 6

- `agenc-runtime start --from-source` rebuilds and starts the daemon
  from local `runtime/dist`
- The startup banner shows the current local commit hash (verify with
  `git rev-parse HEAD`)
- Watch TUI footer shows a non-zero error count when an error is
  injected, and 0 when the log is clean
- `agenc-runtime status` includes the build commit + time

### 6.5 PRs in Cut 6

1. **PR#37** `feat(runtime): --from-source dev flag for local-source daemon`
2. **PR#38** `feat(runtime): daemon startup banner with commit hash + build time`
3. **PR#39** `feat(watch): rolling error-rate indicator in TUI footer`

---

## <a id="cut-7"></a>Cut 7 — Policy / approvals consolidation

**Goal.** Collapse three permission engines into one `canUseTool` pipeline.

Per `rt_policy`. Current state:
- `policy/engine.ts` (~1,036) — runtime safety evaluator
- `gateway/tool-policy.ts` — granular conditional gating
- `policy/mcp-governance.ts` (~290) — MCP supply-chain validation
- `gateway/approvals.ts` (1,355) — user-facing async approval gate

**Three separate `globMatch` implementations with different semantics.**

Target: ~1,600 LOC total (down from ~3,000).

### 7.1 Unify glob matching

New file: `runtime/src/policy/glob.ts` (~40 LOC). Single canonical
`matchToolPattern` + `matchArgPattern`. Delete the 3 duplicates.

### 7.2 Create ToolPermissionEvaluator

New file: `runtime/src/policy/tool-permission-evaluator.ts` (~500 LOC).

Single pipeline:
1. Hard deny rules → deny
2. Hard allow rules → allow (if conditions met)
3. Tool's `checkPermissions()` method
4. `canUseTool` hook
5. Rate limits + budgets (via Cut 7.3)
6. If approval required → `{ behavior: "ask" }`
7. Default → allow

### 7.3 Extract budget state service

New file: `runtime/src/policy/budget-state.ts` (~200 LOC). Owns all
sliding-window budget state. Pure state mutation, no decision logic.

### 7.4 Simplify approvals.ts (1,355 → 600)

Keep: async request/response, timeout + escalation, per-session
elevation, parent delegation.

Delete: embedded glob matcher (use unified), effect ledger +
compensation, simulate/evaluate duplication, tool-handler-factory
coupling (move to `PreToolUse` hook via Cut 5.2).

### 7.5 Simplify policy/engine.ts (1,036 → 300)

Keep budget state + circuit breaker as raw state management. Move
decision logic to `ToolPermissionEvaluator`.

### 7.6 Simplify mcp-governance.ts (290 → 200)

Keep supply-chain validation at server registration. Delete parallel
approval-rule generation.

### 7.7 Acceptance for Cut 7

- Single `canUseTool(name, args, ctx)` entry point
- No duplicate glob matchers
- Policy config schema unified
- All existing policy tests pass
- Approval flow works end-to-end

### 7.8 PRs in Cut 7

1. **PR#42** `refactor(policy): unify glob matching`
2. **PR#43** `refactor(policy): extract BudgetStateService`
3. **PR#44** `refactor(policy): create ToolPermissionEvaluator`
4. **PR#45** `refactor(policy): simplify approvals.ts`
5. **PR#46** `refactor(policy): simplify policy/engine.ts`

---

## <a id="cut-9"></a>Cut 9 — Ship it

**This is the critical step that has been skipped for 2 months.** No
matter how clean the code is, the user is not helped until the running
daemon contains it.

### 9.1 Build runtime from source

```
cd /home/tetsuo/git/AgenC/agenc-core
npm run build
```

### 9.2 Repack the public runtime artifact

```
npm run build:public-runtime-artifacts
```

Regenerates `artifacts/public-runtime/agenc-runtime-0.1.0-linux-x64.tar.gz`
and manifest.

### 9.3 Verify manifest + checksum

```
jq . artifacts/public-runtime/manifest.json
sha256sum artifacts/public-runtime/agenc-runtime-0.1.0-linux-x64.tar.gz
```

### 9.4 Stop stale daemon

```
agenc-runtime stop
```

Confirm PID is gone and `~/.agenc/daemon.pid` is cleaned.

### 9.5 Install new tarball

```
agenc-runtime install --from artifacts/public-runtime/agenc-runtime-0.1.0-linux-x64.tar.gz
```

Or: `agenc-runtime start --from-source` (from Cut 6.3) bypasses the
tarball step.

### 9.6 Start the new daemon

```
agenc-runtime start
```

Confirm banner (Cut 6.4) shows current local commit hash.

### 9.7 Rotate error log

```
mv ~/.agenc/daemon.errors.log ~/.agenc/daemon.errors.log.pre-refactor
```

### 9.8 Validate against real workloads

Reproduce the workflows that were failing:

1. **Web chat session** — multi-turn messages, confirm no
   `state_reconciliation_mismatch`, no empty structured payloads, no
   `planner_verifier` timeouts.
2. **Concordia simulation** — confirm no `.trim()` crashes, no bridge
   HTTP errors.
3. **Sub-agent delegation** — invoke `execute_with_agent`, confirm
   simplified orchestrator spawns and returns cleanly.
4. **MetaPlanner heartbeat path** — idle daemon, confirm no
   `MemoryBackendError: Backend is closed`.
5. **WebSocket stress** — 30+ connections, no frame error floods.
6. **Background run** — long-running autonomous goal with
   checkpoint/resume across daemon restart.

### 9.9 Watch error rate for 30 minutes

```
tail -F ~/.agenc/daemon.errors.log
```

Watch TUI error-rate indicator (Cut 6.5) should stay at 0.

### 9.10 Diff the error catalog

Every error class from the original 8-item catalog should be resolved or
have a specific follow-up:

1. `agenc_planner_plan returned an empty structured payload`
2. `state_reconciliation_mismatch: local history does not match previous_response_id anchor`
3. `xAI structured outputs with tools require a Grok 4 model`
4. `chat-executor error: All providers are in cooldown`
5. `grok request timed out after 59998ms`
6. `MemoryBackendError: sqlite error: Backend is closed`
7. `RangeError: Invalid WebSocket frame`
8. `[concordia] Bridge HTTP error: Cannot read properties of undefined (reading 'trim')`

All 8 should be ≤ 0 occurrences in 30 minutes.

### 9.11 Acceptance for Cut 9

- Rebuilt tarball signed and verified
- Daemon running current local commit
- 30-minute soak test: 0 of original 8 error classes
- All 6 real workloads exercise cleanly
- `~/.agenc/daemon.errors.log` empty or only new documented classes

### 9.12 PRs in Cut 9

Ops, not code. Produces:
- `.claude/notes/refactor-soak-test-report.md`
- Signed tarball in `artifacts/`

---

## <a id="appendix-a"></a>Appendix A — Complete deletion manifest

### A.1 Files to delete outright

```
# Cut 1.1 — workflow planner coupling
runtime/src/workflow/verification-contract.ts
runtime/src/workflow/cleanup-mode.ts
runtime/src/workflow/verification-obligations.ts
runtime/src/workflow/verification-results.ts
runtime/src/workflow/workspace-inspection-evidence.ts
runtime/src/workflow/request-completion.ts
runtime/src/workflow/subagent-orchestration-requirements.ts
runtime/src/workflow/execution-kernel-policy.ts
runtime/src/workflow/completion-contract.ts

# Cut 1.2 — llm tail
runtime/src/llm/chat-executor-planner.ts
runtime/src/llm/turn-execution-contract.ts
runtime/src/llm/turn-execution-contract-types.ts
runtime/src/llm/chat-executor-artifact-task.ts
runtime/src/llm/chat-executor-provider-retry.ts
runtime/src/llm/chat-executor-budget-extension.ts
runtime/src/llm/run-budget.ts
runtime/src/llm/model-routing-policy.ts
runtime/src/llm/delegation-decision.ts

# Cut 3.1 — autonomous verifier lane
runtime/src/autonomous/verifier.ts
runtime/src/autonomous/verification-budget.ts
runtime/src/autonomous/verifier-scheduler.ts
runtime/src/autonomous/escalation-graph.ts
runtime/src/autonomous/candidate-generator.ts
runtime/src/autonomous/arbitration.ts
runtime/src/autonomous/inconsistency-detector.ts
runtime/src/autonomous/risk-scoring.ts
runtime/src/autonomous/agent.ts

# Cut 3.2 — task speculation
runtime/src/task/speculative-executor.ts
runtime/src/task/speculative-scheduler.ts
runtime/src/task/proof-pipeline.ts
runtime/src/task/proof-deferral.ts
runtime/src/task/rollback-controller.ts
runtime/src/task/commitment-ledger.ts
runtime/src/task/dependency-graph.ts
runtime/src/task/speculation-metrics.ts
runtime/src/task/speculation-adapter.ts

# Cut 4.1 — Doom
runtime/src/gateway/doom-stop-guard.ts
runtime/src/gateway/doom-stop-guard.test.ts

# Cut 4.2 — tool routing
runtime/src/gateway/tool-routing.ts
runtime/src/gateway/tool-routing.test.ts

# Cut 4.4 — subagent stack
runtime/src/gateway/delegation-economics.ts
runtime/src/gateway/subagent-dependency-summarization.ts

# Cut 5.1 — prompt budget (after compaction lands)
runtime/src/llm/prompt-budget.ts
runtime/src/llm/prompt-budget.test.ts
```

Plus all `.test.ts` siblings.

### A.2 Files to shrink dramatically

```
runtime/src/llm/chat-executor-recovery.ts          2,182 → 300   (-86%)
runtime/src/llm/chat-executor-text.ts              1,734 → 300   (-83%)
runtime/src/llm/chat-executor-tool-utils.ts        1,156 → 300   (-74%)
runtime/src/llm/chat-executor-types.ts             1,194 → 400   (-66%)
runtime/src/llm/chat-executor.ts                   2,257 → 1,500 (-34%)
runtime/src/llm/chat-executor-tool-loop.ts         1,000 → 700   (-30%)
runtime/src/llm/types.ts                             907 → 400   (-56%)
runtime/src/llm/delegation-learning.ts               564 → 200   (-65%)
runtime/src/llm/chat-executor-fallback.ts            388 → 120   (-69%)
runtime/src/gateway/daemon.ts                      6,576 → 3,500 (-47%)
runtime/src/gateway/tool-handler-factory.ts        3,272 → 1,000 (-69%)
runtime/src/gateway/background-run-supervisor.ts   4,468 → 2,300 (-49%)
runtime/src/gateway/background-run-store.ts        3,472 → 2,000 (-42%)
runtime/src/gateway/subagent-orchestrator.ts       2,518 → 400   (-84%)
runtime/src/gateway/subagent-prompt-builder.ts     1,207 → 300   (-75%)
runtime/src/gateway/subagent-context-curation.ts     ~500 → 200  (-60%)
runtime/src/gateway/delegation-admission.ts          ~400 → 100  (-75%)
runtime/src/gateway/approvals.ts                   1,355 → 600   (-56%)
runtime/src/gateway/config-watcher.ts              3,065 → 2,900 (-5%)
runtime/src/gateway/run-domains.ts                 1,532 → 1,300 (-15%)
runtime/src/policy/engine.ts                       1,036 → 300   (-71%)
runtime/src/policy/mcp-governance.ts                 290 → 200   (-31%)
```

### A.3 New files to add

```
runtime/src/llm/request-analysis.ts                (~400)
runtime/src/llm/messages.ts                        (~400)
runtime/src/llm/tool-result-budget.ts              (~400)
runtime/src/llm/compact/snip.ts                    (~150)
runtime/src/llm/compact/microcompact.ts            (~200)
runtime/src/llm/compact/autocompact.ts             (~300)
runtime/src/llm/compact/reactive-compact.ts        (~200)
runtime/src/llm/compact/index.ts                   (~100)
runtime/src/llm/hooks/types.ts                     (~200)
runtime/src/llm/hooks/registry.ts                  (~300)
runtime/src/llm/hooks/dispatcher.ts                (~400)
runtime/src/llm/hooks/executors.ts                 (~300)
runtime/src/llm/hooks/matcher.ts                   (~100)
runtime/src/llm/tool-orchestration.ts              (~200)
runtime/src/policy/glob.ts                         (~40)
runtime/src/policy/tool-permission-evaluator.ts    (~500)
runtime/src/policy/budget-state.ts                 (~200)
runtime/src/gateway/agent-loader.ts                (~400)
runtime/src/gateway/agent-definitions/explore.md
runtime/src/gateway/agent-definitions/plan.md
runtime/src/gateway/agent-definitions/review.md
runtime/src/gateway/agent-definitions/implement.md
```

### A.4 LOC ledger

| Cut | Delete | Add | Net |
|---|---|---|---|
| 1 — Planner tail | -11,900 | +400 | -11,500 |
| 2 — llm/ gut | -15,500 | 0 | -15,500 |
| 3 — Legacy lanes | -13,200 | 0 | -13,200 |
| 4 — Gateway gut | -35,000 | 0 | -35,000 |
| 5 — Add capabilities | 0 | +4,680 | +4,680 |
| 6 — Stale-daemon feedback loop | 0 | +280 | +280 |
| 7 — Policy merge | -2,000 | +740 | -1,260 |
| 9 — Ship | 0 | 0 | 0 |
| **TOTAL** | **-77,600** | **+6,100** | **-71,500** |

**Final runtime LOC estimate:** 259,048 − 71,500 = **~187,500** (vs.
claude_code 170k). ~10% over claude_code accounts for real AgenC product
value.

---

## <a id="appendix-b"></a>Appendix B — claude_code learnings library

### B.1 query.ts loop shape

```
async function* queryLoop(params, consumedCommandUuids):
  state: Immutable across continues; destructured at top of each iteration
  loop:
    apply snip → yield boundary
    apply microcompact → defer boundary until post-API
    apply contextCollapse (feature-flagged)
    apply autocompact (if over threshold)
    call model via deps.callModel()
      streams tool_use blocks → StreamingToolExecutor.addTool() (parallel during stream)
      streams text deltas → yield StreamEvent
      ends with message_delta + stop_reason
    post-sampling hooks fire (fire-and-forget)
    on error:
      FallbackTriggeredError → switch model, orphan old msgs as tombstones, retry
      isPromptTooLongMessage → withhold, reactiveCompact, retry
      isWithheldMaxOutputTokens → escalate to ESCALATED_MAX_TOKENS, retry
      generic → yield SystemAPIErrorMessage, return { reason: 'model_error' }
    stop hooks fire
    tool execution (non-streaming path): runTools() partitions + runs
    attachment injection
    recurse or terminate based on maxTurns / stop_reason
```

### B.2 Tool interface (minimum required)

```ts
interface Tool<Input, Output> {
  readonly name: string
  description(input: Input, options): string
  inputSchema: Zod | JSONSchema
  checkPermissions(input: Input, context): Promise<PermissionResult>
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<{ data, contextModifier?, newMessages? }>
  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  maxResultSizeChars: number
  prompt(options): Promise<string>  // system prompt contribution
}
```

### B.3 runTools orchestration (188 LOC)

```ts
async function* runTools(toolUseMessages, assistantMessages, canUseTool, context):
  for each { isConcurrencySafe, blocks } in partitionToolCalls(toolUseMessages, context):
    if isConcurrencySafe:
      run blocks in parallel via runToolsConcurrently, max CONCURRENCY
      queue contextModifiers by toolUseID
      yield each update with currentContext
      apply queued modifiers after batch
    else:
      run each serially
      apply contextModifier per tool
      yield with updated currentContext
```

### B.4 Compaction layer order

```
per-iteration in queryLoop:
  1. snip (gap-based old message removal) → yields boundary
  2. microcompact (cached-tool-result clearing, avoids cache invalidation)
  3. contextCollapse (feature-gated)
  4. autocompact (proactive summary when tokens >= threshold)

on 413 error:
  5. reactiveCompact (peel from tail, summarize old) → retry
```

### B.5 Permission flow

```
1. Fast-path rule match (toolAllowList/toolDenyList)
2. Tool's own checkPermissions(input, context)
3. If "ask": hooks race (user / remote bridge / channel / auto-classifier)
4. First to settle via atomic claim() wins
5. Headless: bypass-permissions unavailable; auto-deny if no allowlist match
6. Denial tracking: 3 consecutive / 20 total → fallback to prompting
```

### B.6 AgentTool subagent spawn (nested query)

```ts
async function runAgent(agentDef, task, parentContext):
  scopedTools = filterToolsForAgent(agentDef, parentContext.availableTools)
  childContext = {
    ...parentContext,
    tools: scopedTools,
    queryTracking: {
      chainId: parentContext.queryTracking.chainId,
      depth: parentContext.queryTracking.depth + 1
    },
    abortController: createChildAbortController(parentContext.abortController),
    maxTurns: agentDef.maxTurns ?? 5
  }
  for await (const msg of query({ messages: [{ role: 'user', content: task }], ...childContext })):
    yield msg
```

Zero process forking. Pure async generator nesting.

### B.7 normalizeMessagesForAPI transformations (in order)

1. Reorder attachments (bubble hook results up)
2. Strip virtual/REPL-only messages
3. Merge consecutive user messages (API requires alternation)
4. Merge adjacent assistant messages by `message.id`
5. Normalize tool inputs (remove SDK-only fields)
6. Strip tool_reference blocks (when beta off)
7. Ensure non-empty assistant content
8. Filter whitespace-only messages
9. Strip signature blocks on credential change
10. Ensure tool_use ↔ tool_result pairing (synthetic errors for missing)

### B.8 System prompt structure

```
cached prefix (static):
  - intro + safety
  - system section (tools, permissions, tags)
  - doing tasks (code style, safety)
  - actions section (reversibility)
  - using tools (dedicated tools vs bash)
  - tone/style, output efficiency

SYSTEM_PROMPT_DYNAMIC_BOUNDARY

dynamic sections:
  - session-specific guidance
  - agent memory (loadMemoryPrompt)
  - language pref, output style, MCP instructions
  - scratchpad, function result clearing
  - token budget (feature-gated)

system context (appended):
  - git status, branch, commits, user
  - cache breaker

user context (prepended as first user message, isMeta: true):
  <system-reminder>
  # claudeMd ...
  # currentDate ...
  </system-reminder>
```

Tools are NOT in system prompt — they go in the API's `tools` array.

### B.9 Rate limit + retry

- `withRetry` generator: max 10 retries default, exponential backoff
  (base 500ms, cap 32s, jitter)
- Honor `Retry-After` header
- **CannotRetryError** for 401, 403 (after refresh), 400 non-overflow
- **Retry** for 429, 529, 408, 409, 5xx, credential refresh, 400 context
  overflow (reduce tokens, retry)
- **FallbackTriggeredError** after 3 consecutive 529s on primary
- Persistent retry mode for CCR: infinite 429/529, 5-min max backoff,
  heartbeat every 30s

---

## <a id="appendix-c"></a>Appendix C — Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Deleting `turn-execution-contract.ts` breaks webchat turn routing | High | Audit call sites before deletion; `rg turn-execution-contract runtime/src` before PR. |
| Subagent collapse breaks Concordia plugin's delegation | High | Concordia uses its own HTTP bridge, not runtime's subagent. Verify with `rg subagent agenc-plugin-concordia/`. |
| Background run checkpoints unreadable after schema trim | High | Keep backwards-compat migration. Version bump only if on-disk format changes. |
| Daemon.ts shrink introduces regression in Matrix/Signal channels | Medium | Channel smoke-test suite before Cut 4.5 merges. |
| New compaction diverges from existing `compactHistory()` callers | Medium | Parallel-run both for one release cycle with feature flag; then delete old. |
| Policy consolidation breaks existing `.claude/settings.json` configs | Medium | Migration script + validator; deprecation warnings for one release. |
| `--from-source` dev mode hides a publish-pipeline bug | Medium | Keep CI exercising published-tarball path separately. |
| 50+ PR sequencing unmanageable | High | Strict per-Cut ordering. Per-PR acceptance tests. PRs ≤ 3,000 LOC where possible. |
| User loses trust if any Cut breaks daemon > 1 day | Critical | Every PR on feature branch first. Soak-test in Cut 9 format before merging to main. |
| Memory backend swap (SQLite ↔ memdir) confuses users | Medium | Document clearly. SQLite for structured; memdir for human-editable. |
| Hooks block turn loop on misbehaving hook | Medium | Per-hook timeout (5s default), non-blocking semantics, circuit break on 3 consecutive failures. |

---

## <a id="appendix-d"></a>Appendix D — PR sequence and branch names

**Cut 1 — Planner tail (7 PRs):**
- `refactor/cut-1-1-workflow-planner-files`
- `refactor/cut-1-2a-llm-tail-turn-execution-contract`
- `refactor/cut-1-2b-llm-tail-artifact-task-run-budget`
- `refactor/cut-1-3-inline-planner-utils-request-analysis`
- `refactor/cut-1-4-budget-extension-provider-retry`
- `refactor/cut-1-5-model-routing-policy`
- `refactor/cut-1-6-delegation-trajectory-rename`
- `refactor/cut-1-7-remove-simple-agent-loop-flag`

**Cut 2 — llm/ gut (8 PRs):**
- `refactor/cut-2-1-shrink-recovery`
- `refactor/cut-2-2-shrink-text`
- `refactor/cut-2-3-shrink-tool-utils`
- `refactor/cut-2-4-prune-types`
- `refactor/cut-2-5-shrink-llm-types`
- `refactor/cut-2-6-shrink-tool-loop`
- `refactor/cut-2-7-collapse-chat-executor`
- `refactor/cut-2-8-simplify-fallback`

**Cut 3 — Legacy lanes (3 PRs):**
- `refactor/cut-3-1-delete-verifier-lane`
- `refactor/cut-3-2-delete-autonomous-agent`
- `refactor/cut-3-3-delete-task-speculation`

**Cut 4 — Gateway gut (8 PRs):**
- `refactor/cut-4-1-excise-doom-from-daemon`
- `refactor/cut-4-2-delete-tool-routing`
- `refactor/cut-4-3-shrink-tool-handler-factory`
- `refactor/cut-4-4-collapse-subagent-orchestrator`
- `refactor/cut-4-5-simplify-daemon`
- `refactor/cut-4-6-shrink-bgrun-supervisor`
- `refactor/cut-4-7-shrink-bgrun-store`
- `refactor/cut-4-8-prune-feature-wiring`

**Cut 5 — New capabilities (10 PRs):**
- `feat/cut-5-1-layered-compaction`
- `feat/cut-5-2-hook-system`
- `feat/cut-5-3-tool-result-budget`
- `feat/cut-5-4-query-tracking`
- `feat/cut-5-5-concurrency-safe-tool-batching`
- `feat/cut-5-6-agent-definitions`
- `feat/cut-5-7-can-use-tool-hook`
- `refactor/cut-5-8-messages-normalize`
- `feat/cut-5-9-tombstone-messages`
- `feat/cut-5-10-cache-control-breakpoints`

**Cut 6 — Stale-daemon feedback loop (3 PRs):**
- `feat/cut-6-1-from-source-dev-mode`
- `feat/cut-6-2-daemon-startup-banner`
- `feat/cut-6-3-watch-error-rate`

**Cut 7 — Policy merge (5 PRs):**
- `refactor/cut-7-1-unified-glob`
- `refactor/cut-7-2-budget-state-service`
- `refactor/cut-7-3-tool-permission-evaluator`
- `refactor/cut-7-4-simplify-approvals`
- `refactor/cut-7-5-simplify-policy-engine`

**Cut 9 — Ship (ops):**
- `chore/cut-9-rebuild-repack-restart`

**Total: 44 code PRs + 1 ops milestone.**

---

## Sequencing notes

- Cut 1 must merge before Cut 2 (llm/ gut depends on planner tail delete)
- Cut 2 must merge before Cut 4 (gateway simplification relies on
  collapsed `executeChat()` shape)
- Cut 3 can run **in parallel** with Cuts 1+2 (isolated modules)
- Cut 5 must merge before Cut 7 (policy consolidation needs `canUseTool`
  hook shape)
- Cut 5 should merge before Cut 4.3–4.4 (tool-handler-factory shrink
  relies on new hook system)
- Cut 6 can run in parallel with any other cut (touches the runtime
  manager + watch TUI, not the agent loop)
- **Cut 6 should land EARLY** — without `--from-source` and the startup
  banner, no other Cut can be validated against the running daemon
- Cut 9 must run after every code Cut is merged and soaked

**Critical path:** Cut 6 → Cut 1 → Cut 2 → Cut 5 → Cut 4 → Cut 9
**Parallel tracks:** Cut 3, Cut 7

---

## Success metrics

After Cut 9:

1. **Runtime LOC:** 259k → ~187.5k (−28%, −71.5k lines)
2. **Daemon reliability:** 0 of the original 8 error classes in 30-min soak
3. **chat-executor shape:** single `executeChat()` generator ~1,500 LOC
4. **Gateway shape:** ~36k LOC (from 71k)
5. **Test suite:** ≥ 6,000 tests passing
6. **End-to-end:** webchat, Concordia, subagent, background run, watch TUI
   all work against current-commit code
7. **Stale-daemon fixed:** `agenc-runtime start --from-source` rebuilds and
   launches daemon from local source; banner verifies the running commit
8. **Feedback loop:** watch TUI shows live error rate — future
   2-month-silent-failure windows impossible

---

## What explicitly stays

These are AgenC-specific product value and are **not** targets:

- **Channels:** webchat, telegram, discord, signal, whatsapp, matrix,
  imessage, concordia plugin
- **Background runs:** supervisor + store + managed-process lifecycle
- **Tools:** all 87 built-in tools (system.*, agenc.*, social.*, x.*)
- **Memory backends:** SQLite, Redis, in-memory + semantic retrieval +
  consolidation (trim graph, keep core)
- **Watch TUI:** real-time daemon observer (simplify, keep)
- **Skills marketplace:** skill system, Jupiter, on-chain registry,
  monetization (80/20 split)
- **Protocol integration:** Solana on-chain task/agent/skill/governance
- **Concordia simulation bridge:** plugin + Python bridge
- **Goal-driven autonomous lane:** GoalManager + DesktopExecutor +
  awareness (verifier lane goes; goal lane stays)
- **Replay + observability + events**

## What explicitly goes

- Planner subsystem (finished Phase 2 + Cut 1)
- Verifier lane (multi-candidate, arbitration, risk-scoring)
- Task speculation (proof pipeline, rollback cascade)
- Doom autoplay (chat-executor-doom.ts gone; Cut 4.1 finishes the rest)
- Per-phase tool routing (tool-routing.ts entirely)
- Delegation bandit learning (never wired)
- Policy/approvals/mcp-governance triplication (consolidated Cut 7)
- Planner-era text reconciliation (reconcile* functions)
- execute_with_agent contract validation (13 hints)
- Compiler diagnostic parsing (model can read its own errors)
- `run-budget.ts` run-class ledger
- `model-routing-policy.ts` (replace with 30-line helper)
- `turn-execution-contract.ts` (planner delegation inference)
- Memory graph's 8 unused edge types + temporal + entities
- AgentIdentity + reflection (never wired)
- Procedural memory (stored but never retrieved)
