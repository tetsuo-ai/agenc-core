/**
 * Phase 4 — Continuation Nudge.
 *
 * Hand-port of openclaude `query.ts:1400-1463` (the continuation-nudge
 * decision block). Fires when:
 *   - the stream produced an assistant message
 *   - AND the turn has not hit maxTurns
 *   - AND continuationNudgeCount < MAX_CONTINUATION_NUDGES (=3)
 *   - AND the assistant text contains a continuation-signal pattern
 *     (e.g. "now I'll create...", "let me add...")
 *   - AND the text does NOT contain a completion marker
 *     (e.g. "done", "finished", "that's all")
 *
 * When all conditions are met, inject a meta user message asking the
 * model to continue, bump the counter, and set `transition` to
 * `continuation_nudge` so run-turn re-enters PrepareContext for the
 * next iteration (`PhaseTransition['continuation_nudge'] = PrepareContext`).
 *
 * If the stop-hook returned blocking from this same iteration, the
 * post-sample-recovery phase (T8) will have already set
 * `transition: stop_hook_blocking`; this phase then no-ops because
 * run-turn observed the transition and continued before reaching
 * here.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

export const MAX_CONTINUATION_NUDGES = 3;

const CONTINUATION_SIGNALS: RegExp[] = [
  /\bso now (i|let me|we) (need to|have to|should|must|will) (do|create|write|edit|update|fix|implement|add|run|check|make|build|set up)\b/,
  /\bnow i('ll| will) (do|create|write|edit|update|fix|implement|add|run|check|make|build|set up|go|proceed)\b/,
  /\blet me (go ahead and |now )?(do|create|write|edit|update|fix|implement|add|run|check|make|build|set up|proceed)\b/,
  /\btime to (do|create|write|edit|update|fix|implement|add|run|check|make|build|get started|begin)\b/,
];

const SHORT_TEXT_SIGNALS: RegExp[] = [
  /\b(i('ll| will| need to| have to| must) (now )?(do|create|write|edit|update|fix|implement|add|run|check|make|build|set up))\b/,
  /\bnext,?\s+(i('ll| will)|let me|i need to) (do|create|write|edit|update|fix|implement|add|run|check|make|build)\b/,
];

const COMPLETION_MARKERS =
  /\b(done|finished|completed|complete|summary|that's all|that is all|all set|hope this helps|let me know if)\b/;

function matchesContinuationSignal(text: string): boolean {
  const lowered = text.toLowerCase();
  if (COMPLETION_MARKERS.test(lowered)) return false;
  if (CONTINUATION_SIGNALS.some((re) => re.test(lowered))) return true;
  if (lowered.length < 80 && SHORT_TEXT_SIGNALS.some((re) => re.test(lowered))) {
    return true;
  }
  return false;
}

function injectNudgeMessage(state: TurnState): void {
  const nudge: LLMMessage = {
    role: "user",
    content: "Continue with the task. Use the appropriate tools to proceed.",
  };
  state.messages.push(nudge);
}

export async function continuationNudge(
  state: TurnState,
  ctx: TurnContext,
  _session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  // Nudge only fires when the model stopped without tool calls and
  // the text looks like it was mid-work. If tool calls are present,
  // execute-tools runs next; no nudge needed.
  if (state.toolUseBlocks.length > 0) return state;
  if (state.assistantMessages.length === 0) return state;

  const maxTurns =
    (ctx.config as unknown as { maxTurns?: number }).maxTurns ?? Number.POSITIVE_INFINITY;
  if (state.turnCount >= maxTurns) return state;
  if (state.continuationNudgeCount >= MAX_CONTINUATION_NUDGES) return state;

  const lastAssistant = state.assistantMessages.at(-1);
  if (!lastAssistant) return state;
  const text = lastAssistant.text ?? "";
  if (text.length === 0) return state;

  if (!matchesContinuationSignal(text)) return state;

  injectNudgeMessage(state);
  state.continuationNudgeCount += 1;
  state.transition = { reason: "continuation_nudge" };
  return state;
}
