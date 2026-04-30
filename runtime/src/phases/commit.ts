/**
 * Phase 6 — Commit.
 *
 * Mirrors agenc `query.ts:1192-1465` (iteration tail) + 1643-1836
 * (terminal commit). Responsibilities per TODO.MD T5-B line 974:
 *
 *   1. **Append history** — ensure all iteration outputs (assistant
 *      message, tool results, attachments) are in `state.messages`.
 *      Await any pending tool-use summary promise so the UI sees the
 *      final text before the next iteration, without re-inserting
 *      renderer-only summaries into model-visible history.
 *
 *   2. **Compaction boundary** — if this iteration ran auto-compact
 *      successfully (tracking.compacted && turnCounter === 0), emit a
 *      `context_compacted` event so the rollout sidecar (T6) can stamp
 *      the boundary marker.
 *
 *   3. **Stop gate** — when the turn is about to terminate naturally
 *      (no tool calls, no transition), invoke stop hooks. Blocking
 *      hooks set `transition: stop_hook_blocking`; the counter was
 *      already bumped inside `evaluateStopHooks()` (I-17:
 *      MAX_STOP_HOOK_BLOCKS=3). Non-blocking hooks fall through to
 *      terminal.
 *
 *   4. Bump `turnCount`; clear per-iteration fields that survive into
 *      the next iteration via continue-site re-entry.
 *
 * The full stop-hook implementation lives behind `evaluateStopHooks`
 * in `stop-hooks.ts` (T8 replaces the stub with the real hook runner).
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { evaluateStopHooks } from "./stop-hooks.js";

/**
 * I-17: hard cap on how many consecutive stop-hook blocking cycles
 * we tolerate before force-terminating with error. Matches AgenC
 * `MAX_STOP_HOOK_BLOCKS = 3` (query.ts:163).
 */
export const MAX_STOP_HOOK_BLOCKS = 3;

function toolUseSummaryText(summary: unknown): string | null {
  if (summary === null || summary === undefined || typeof summary !== "object") {
    return null;
  }
  const record = summary as Record<string, unknown>;
  const text =
    typeof record.summary === "string"
      ? record.summary.trim()
      : typeof record.content === "string"
        ? record.content.trim()
        : "";
  if (text.length === 0) return null;
  return text;
}

export async function commit(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  // ── 1. Append history — await any pending tool-use summary promise
  //      so the UI sees the final summary before the next iteration.
  if (state.pendingToolUseSummary) {
    try {
      const summary = await state.pendingToolUseSummary;
      const summaryText = toolUseSummaryText(summary);
      if (summaryText) {
        // Tool-use summaries are UI affordances only. Re-inserting them
        // into `state.messages` makes the next model turn treat renderer
        // commentary as conversation history, which diverges from the
        // retained compact/replay contract.
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "agent_message",
            payload: {
              message: summaryText,
            },
          },
        });
      }
    } catch {
      /* summary failures non-fatal; executor emits stream_error */
    } finally {
      state.pendingToolUseSummary = undefined;
    }
  }

  // Drop the streaming tool executor reference so the next iteration
  // constructs a fresh one (matches AgenC query.ts:572).
  state.streamingToolExecutor = null;

  // ── 2. Compaction boundary — if this iteration's tracking state
  //      records a successful compact (compacted=true, turnCounter=0
  //      was reset by the AgenC compact adapter), emit a typed boundary
  //      marker so the rollout sidecar (T6) can stamp it.
  const tracking = state.autoCompactTracking;
  if (tracking && tracking.compacted && tracking.turnCounter === 0) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "context_compacted",
        payload: {
          summary: `auto-compact boundary (turnId=${tracking.turnId})`,
        },
      },
    });
    // T6 I-24b: re-append session metadata so --resume readers that
    // scan the last 16KB of the rollout still find the session
    // header even after many compacts have pushed it out of range.
    // Port of agenc sessionStorage.ts::reAppendSessionMetadata.
    session.rolloutStore?.store.reAppendSessionMetadata();
    // Mark the boundary as consumed so subsequent iterations don't
    // re-emit until the next successful compact mutates the turnId.
    state.autoCompactTracking = {
      ...tracking,
      // advance turnCounter so the marker only fires once per boundary
      turnCounter: 1,
    };
  }

  // ── 3. Stop gate — only evaluate when the turn is about to
  //      terminate naturally (no tool calls pending, no recovery
  //      transition already set). Recovery transitions (reactive
  //      compact, max-tokens recovery, etc.) route around the stop
  //      gate; stop hooks only matter at the terminal boundary.
  const turnIsTerminating =
    state.toolUseBlocks.length === 0 &&
    state.transition === undefined &&
    !state.needsFollowUp;

  if (turnIsTerminating) {
    const result = await evaluateStopHooks(state, ctx, session, signal);
    if (result.blocking) {
      if (state.stopHookBlockingCount >= MAX_STOP_HOOK_BLOCKS) {
        // I-17: stop-hook recursion cap tripped. Surface as an error
        // event + force-terminate with the blocking reason.
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "error",
            payload: {
              cause: "stop_hook_loop",
              message: `stop hooks blocked ${state.stopHookBlockingCount} times in a row — forcing terminal (${result.reason ?? "no_reason"})`,
            },
          },
        });
        state.stopHookActive = false;
        // Do NOT set transition: the cap being hit means we exit, not
        // re-enter. run-turn sees no transition + no tool calls →
        // terminal.
      } else {
        // Inject the hook's suggested message (if any) and set the
        // transition so run-turn re-enters PrepareContext.
        if (result.injectedMessage) {
          state.messages.push({
            role: "user",
            content: result.injectedMessage,
          });
        }
        state.transition = { reason: "stop_hook_blocking" };
        state.stopHookActive = true;
      }
    } else {
      state.stopHookActive = false;
      state.stopHookBlockingCount = 0;
    }
  }

  // ── 4. Bump turnCount + clear one-shot overrides. recoveryReentry
  //      and stop-hook-blocking counters are preserved here — they
  //      only reset on a successful non-recovering iteration.
  state.turnCount += 1;
  state.maxOutputTokensOverride = undefined;
  return state;
}
