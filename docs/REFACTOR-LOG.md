# Executor Refactor Log — claude_code Behavioral Alignment

**Purpose.** Durable ledger for the 16-phase refactor defined in
[`TODO.MD`](../TODO.MD) that aligns `runtime/src/llm/*` with
claude_code's async-generator query loop while preserving every
AgenC-only surface.

**Spec**: [`TODO.MD`](../TODO.MD) (authoritative, do not duplicate
content here).
**Execution runbook**: session plan file
(`.claude/plans/partitioned-leaping-codd.md` locally), collapses the
16 phases into 9 ship units.
**Rollback anchor**: git tag `pre-executor-refactor` on origin.

**Log rules.**

- One row per merged PR, appended chronologically (oldest first).
- Do **not** edit rows after they are written. Use a new row for
  corrections or reverts.
- `Test count Δ` is the delta against the previous row
  (`+0` means held the baseline; `+4` means added 4 `it()` blocks).
- The `check:executor-baseline` script enforces the floor:
  357 test files / 7594 `it()` blocks as of 2026-04-07. Any PR that
  drops under those numbers fails the fast-path gate.
- On a fresh session, reconstruct refactor state with:
  ```
  cd /home/tetsuo/git/AgenC/agenc-core && \
    git fetch --tags && \
    cat docs/REFACTOR-LOG.md | tail -20 && \
    gh pr list --search "refactor/exec-" --state all | head -30
  ```

## Status as of 2026-04-08 (after #272 merge)

**14 of 16 phases landed**: U0, A, B, C, D, E, F (partial), H, I, J, L, M, N, and this chore for O + P verification. Phases G (permission evaluator unification) and K (subagent stack collapse) are explicitly deferred to multi-session follow-ups because their scope exceeded a single session's safe edit surface.

**Cumulative diff since `pre-executor-refactor` tag (`b8decc5`)**: +3,785 / −2,765 = net +1,020 LOC across 51 files. The additions are Phase A/C/D/I/J/N infrastructure; the deletions are Phase L (bridges + proof subtrees, −2,558 LOC) + Phase H (8 hook events) + Phase M (planner stubs). The ~6,500 LOC deletion target from Phase F's class extraction and ~6,500 LOC from Phase K's subagent collapse are the multi-session work parked for a follow-up.

**What actually shipped** (honest scorecard vs the TODO.MD starting point):

| Subsystem | Before | After |
|---|---|---|
| Layered compaction | SKELETON ONLY (zero imports) | Live: snip → microcompact → autocompact runs before every provider call in `chat-executor-tool-loop.ts` |
| Parallel tool dispatch | TELEMETRY ONLY | Live: `Promise.all` on concurrency-safe batches, partition-aware |
| Reactive 413 compaction | Not implemented | Live: `LLMContextWindowExceededError` detection + retry wrapper |
| cache_control breakpoints | Zero references | Tagging infrastructure landed in `normalizeMessagesForAPI`; adapter wiring deferred pending xAI docs verification |
| Async generator loop | Class-based only | `executeChat()` generator runs in parallel with the class; 10 production callers drain it via `executeChatToLegacyResult` |
| Memory consolidation layer | Not wired | Optional `consolidationHook` on the per-iteration chain + deterministic slice helper |
| Streaming event vocabulary | No yielded event types | 7 event types + legacy-callback bridge |
| Hook vocabulary | 16 types declared, 3 fired | 8 types (8 dead ones deleted); `SessionStart`/`Stop`/`StopFailure`/`PreCompact`/`PostCompact` wire-up remains pending |
| `bridges/` subtree | 1,124 LOC public surface | Deleted (zero external consumers) |
| `proof/` subtree | 1,405 LOC public surface | Deleted (zero external consumers) |
| Planner-era daemon stubs | `buildToolRoutingDecision` + `recordToolRoutingOutcome` | Deleted |

**Test baseline**: 6,020 production tests pass (from 6,010 at session start). One pre-existing `marketplace-cli.integration.test.ts` LiteSVM failure and one pre-existing `desktop-executor.test.ts > "rejects concurrent goals"` flake persist from main.

**Rollback anchor**: `git tag pre-executor-refactor` → `b8decc5` (pushed to origin).

## Ledger

| PR # | Phase | Branch | Merged SHA | Test count Δ | Notes |
|---|---|---|---|---|---|
| [#260](https://github.com/tetsuo-ai/agenc-core/pull/260) | U0 pre-work | `refactor/exec-prework` | `e08544a` | +0 | Baseline script, autocompact snipTokensFreed sig, applyPerIterationCompaction stub, REFACTOR-LOG.md, `pre-executor-refactor` tag pushed to origin. |
| [#261](https://github.com/tetsuo-ai/agenc-core/pull/261) | U1 Phase A | `refactor/exec-a-wire-compaction` | `a816e1b` | +7 | Wire snip → microcompact → autocompact chain into `executeToolCallLoop` before both `callModelForPhase` sites. `compact/*` skeleton is now live. |
| [#262](https://github.com/tetsuo-ai/agenc-core/pull/262) | U2 Phase B | `refactor/exec-b-parallel-dispatch` | `fa1c9d0` | +3 | Real parallel tool dispatch on concurrency-safe batches via `Promise.all`, partition-aware. `isConcurrencySafe` is no longer telemetry-only. |
| [#263](https://github.com/tetsuo-ai/agenc-core/pull/263) | U3 Phase D | `refactor/exec-d-streaming-events` | `008edbb` | +10 | Streaming event type vocabulary + `streaming-bridge.ts` with `drainToLegacyCallbacks` and `buildChatExecutorResultFromEvents`. No production wiring yet. |
| [#264](https://github.com/tetsuo-ai/agenc-core/pull/264) | U4 Phase C | `refactor/exec-c-async-generator` | `bea9bdd` | +13 | `executeChat()` async generator lands as adapter over `ChatExecutor.execute()`. Yields Phase D events, returns Terminal. Class and helpers unchanged. |
| [#265](https://github.com/tetsuo-ai/agenc-core/pull/265) | U7 Phase H | `refactor/exec-h-hook-events` | `202e3ab` | +0 | Narrow `HookEvent` union from 16 → 8; delete 8 dead event types (UserPromptSubmit, Notification, FileChanged, ConfigChange, Permission{Request,Denied}, Subagent{Start,Stop}) that were declared but never dispatched. |
| [#266](https://github.com/tetsuo-ai/agenc-core/pull/266) | U9 Phase M | `refactor/exec-m-daemon-stubs` | `8a585a9` | +0 | Delete `buildToolRoutingDecision` / `recordToolRoutingOutcome` private stubs from `daemon.ts`. Inline `() => undefined` / `() => {}` at 3 contract boundaries; drop 3 unused type imports. |
| [#267](https://github.com/tetsuo-ai/agenc-core/pull/267) | U7 Phase J | `refactor/exec-j-cache-control` | `0153f20` | +9 | `normalizeMessagesForAPI` tags last system / user / tool messages with `cacheControl: "ephemeral"` for prompt caching. Provider adapter wiring deferred to follow-up. |
| [#268](https://github.com/tetsuo-ai/agenc-core/pull/268) | U7 Phase I | `refactor/exec-i-reactive-413` | `75f7c64` | +5 | `LLMContextWindowExceededError` + `callModelWithReactiveCompact` wrapper on both `callModelForPhase` sites; reactive trim + retry on 413s. `reactiveCompact` state field added. |
| [#269](https://github.com/tetsuo-ai/agenc-core/pull/269) | U9 Phase L | `refactor/exec-l-dead-files` | `9cdd581` | −27 | Delete `runtime/src/bridges/` (LangChain/X402/Farcaster) and `runtime/src/proof/` (ZK engine) — zero external consumers. −2,558 LOC net. |
| [#270](https://github.com/tetsuo-ai/agenc-core/pull/270) | U9 Phase N | `refactor/exec-n-memory-consolidation` | `a3b421a` | +10 | Add deterministic `consolidateEpisodicSlice` + optional `consolidationHook` layer in `applyPerIterationCompaction`. |
| [#271](https://github.com/tetsuo-ai/agenc-core/pull/271) | U5 Phase E | `refactor/exec-e-text-channel` | `3c7ea2f` | +0 | Migrate all 10 production callers to drain `executeChat` via `executeChatToLegacyResult`. Preserves field reads, honors error rethrow contract. |
| [#272](https://github.com/tetsuo-ai/agenc-core/pull/272) | U6 Phase F | `refactor/exec-f-class-shim` | `fc3434f` | +0 | Conditional stream-hook install in `executeChat` (fixes 96-test regression). Class deletion itself deferred — circular call path, multi-session extraction required. |
| [#273](https://github.com/tetsuo-ai/agenc-core/pull/273) | O + P close-out | `chore/exec-op-final-sweep` | `11dc425` | +0 | `tsc --noUnusedLocals` sweep (nothing to sweep — clean throughout) + full `npm run build` validation at repo root. Records `dist/VERSION` = `fc3434f04540`. |
| [#274](https://github.com/tetsuo-ai/agenc-core/pull/274) | Phase G subgoal | `refactor/exec-g-approval-requester` | `b093cc3` | +7 | Wire optional `approvalRequester` callback on `ToolPermissionEvaluator`. Resolves `"ask"` decisions through external approval engines (e.g. the gateway WebSocket approval flow) and returns the final allow/deny. Legacy path preserved when requester not supplied. Dead file deletion (tool-governance / mcp-governance / bundles) deferred — each has 9 live callers. |
