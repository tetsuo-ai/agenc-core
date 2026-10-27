/**
 * Phase 4 — Continuation Nudge.
 *
 * Continuation-nudge decision block. Fires when:
 *   - the stream produced an assistant message
 *   - AND the turn has not hit maxTurns
 *   - AND continuationNudgeCount < MAX_CONTINUATION_NUDGES (=3)
 *   - AND the final prose paragraph announces unfinished execution
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

import { Lexer } from "marked";
import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

const MAX_CONTINUATION_NUDGES = 3;

export const CONTINUATION_NUDGE_TEXT =
  "Continue with the task. Use the appropriate tools to proceed.";

const CONTINUATION_SIGNALS: RegExp[] = [
  /^so now (i|let me|we) (need to|have to|should|must|will) (do|create|write|edit|update|fix|implement|add|run|check|make|build|set up)\b/,
  /^now i('ll| will) (do|create|write|edit|update|fix|implement|add|run|check|make|build|set up|go|proceed)\b/,
  /^let me (go ahead and |now )?(do|create|write|edit|update|fix|implement|add|run|check|make|build|set up|proceed)\b/,
  /^time to (do|create|write|edit|update|fix|implement|add|run|check|make|build|get started|begin)\b/,
  /^(continuing|proceeding|executing|starting|moving on to)\b.{0,120}\b(do|create|write|edit|update|fix|implement|add|run|check|make|build|test|verify|wire|parse|dispatch|execute)\b/,
  /^(source|eval|tests?|edits?|tool calls?|verification)\b.{0,80}\b(incoming|queued|sequential)\b/,
];

const SHORT_TEXT_SIGNALS: RegExp[] = [
  /^(i('ll| will| need to| have to| must) (now )?(do|create|write|edit|update|fix|implement|add|run|check|make|build|set up))\b/,
  /^next,?\s+(i('ll| will)|let me|i need to) (do|create|write|edit|update|fix|implement|add|run|check|make|build)\b/,
];

const COMPLETION_MARKERS =
  /\b(done|finished|completed|complete|summary|that's all|that is all|all set|hope this helps|let me know if)\b/;

const CONSENT_MARKERS =
  /\b(?:if|when|once|after|until|unless) you(?:['’]d| would)? (?:want|like|approve|agree|confirm|prefer|allow|authorize|permit|give)\b|\b(?:your|user) (?:approval|permission|confirmation|consent|go[- ]ahead)\b|\b(?:would|do) you (?:like|want)\b|\b(?:may|shall|should|can|could) i\b|\blet me know\b/;

function matchesContinuationSignal(text: string): boolean {
  const lowered = text.toLowerCase().replaceAll("’", "'");
  if (COMPLETION_MARKERS.test(lowered) || CONSENT_MARKERS.test(lowered)) return false;

  // Only an unfinished execution announcement at the end can justify another
  // turn. Examples in a capabilities answer, code, lists and quotations do not
  // establish work to continue, and a closing question waits for the user.
  const ending = Lexer.lex(lowered).filter((token) => token.type !== "space").at(-1);
  if (ending?.type !== "paragraph" || typeof ending.text !== "string") return false;
  const prose = ending.text
    .replace(/`+[^`]*`+|"[^"]*"|“[^”]*”/g, "")
    .replace(/[*_]/g, "")
    .trim();
  if (/[?？]$/.test(prose)) return false;
  return prose.split(/[.!?]\s+|\n+/).some((sentence) => {
    const announcement = sentence.trim();
    return CONTINUATION_SIGNALS.some((re) => re.test(announcement)) ||
      (prose.length < 80 && SHORT_TEXT_SIGNALS.some((re) => re.test(announcement)));
  });
}

export function injectNudgeMessage(state: TurnState): void {
  const nudge: LLMMessage = {
    role: "user",
    content: CONTINUATION_NUDGE_TEXT,
    // gaphunt3 #34: the continuation nudge is a synthetic, heuristic-driven
    // turn — keep it ephemeral/in-context only so a false-positive match never
    // pollutes the durable rollout/transcript that --resume replays.
    runtimeOnly: { excludeFromDurableHistory: true },
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
  state.maxOutputTokensRecoveryCount = 0;
  state.reasoningOnlyRecoveryCount = undefined;
  state.reasoningCapPolicy = undefined;
  state.hasAttemptedReactiveCompact = false;
  state.maxOutputTokensOverride = undefined;
  state.pendingToolUseSummary = undefined;
  state.stopHookActive = undefined;
  state.transition = { reason: "continuation_nudge" };
  return state;
}
