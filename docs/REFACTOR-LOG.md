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

## Ledger

| PR # | Phase | Branch | Merged SHA | Test count Δ | Notes |
|---|---|---|---|---|---|
| [#260](https://github.com/tetsuo-ai/agenc-core/pull/260) | U0 pre-work | `refactor/exec-prework` | `e08544a` | +0 | Baseline script, autocompact snipTokensFreed sig, applyPerIterationCompaction stub, REFACTOR-LOG.md, `pre-executor-refactor` tag pushed to origin. |
| [#261](https://github.com/tetsuo-ai/agenc-core/pull/261) | U1 Phase A | `refactor/exec-a-wire-compaction` | `a816e1b` | +7 | Wire snip → microcompact → autocompact chain into `executeToolCallLoop` before both `callModelForPhase` sites. `compact/*` skeleton is now live. |
| [#262](https://github.com/tetsuo-ai/agenc-core/pull/262) | U2 Phase B | `refactor/exec-b-parallel-dispatch` | `fa1c9d0` | +3 | Real parallel tool dispatch on concurrency-safe batches via `Promise.all`, partition-aware. `isConcurrencySafe` is no longer telemetry-only. |
| [#263](https://github.com/tetsuo-ai/agenc-core/pull/263) | U3 Phase D | `refactor/exec-d-streaming-events` | `008edbb` | +10 | Streaming event type vocabulary + `streaming-bridge.ts` with `drainToLegacyCallbacks` and `buildChatExecutorResultFromEvents`. No production wiring yet. |
| [#264](https://github.com/tetsuo-ai/agenc-core/pull/264) | U4 Phase C | `refactor/exec-c-async-generator` | `bea9bdd` | +13 | `executeChat()` async generator lands as adapter over `ChatExecutor.execute()`. Yields Phase D events, returns Terminal. Class and helpers unchanged. |
