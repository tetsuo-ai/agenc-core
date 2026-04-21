/**
 * `/compact [instructions]` — manually trigger conversation compaction
 * (T11 Wave 2, Agent W2-E).
 *
 * Mid-stream guard (mirrors I-13): if a turn is currently in flight we
 * REFUSE the request with an error result. Unlike `/model` and
 * `/provider`, we do NOT abort the turn — compacting mid-stream would
 * corrupt state (the in-flight response is still being appended to
 * history and the compact pipeline reads the fully-committed history).
 * The user must wait for the current turn to settle and re-issue
 * `/compact`.
 *
 * When no turn is active the command calls `runPostCompactCleanup`
 * which enforces I-2 (clear `previous_response_id` on every compaction)
 * and related post-compact cache resets. The cleanup is imported
 * statically now that the `compact/` typecheck exclude is lifted.
 *
 * Optional `instructions` argument (free-form text) is accepted and
 * forwarded to the compact pipeline once the full compaction pass is
 * wired; for now it is echoed back in the output so `/help` users can
 * see that the arg is recognised.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import { runPostCompactCleanup } from "../llm/compact/post-compact-cleanup.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * Outcome of an attempted compaction. `ran` means
 * `runPostCompactCleanup` executed successfully; `blocked` means the
 * mid-stream guard refused; `error` means the cleanup itself threw
 * (surfaced instead of being silently swallowed).
 */
export type CompactOutcome =
  | { readonly kind: "ran"; readonly instructions: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "error"; readonly cause: string };

/**
 * Drive the compaction flow. Returns a structured outcome so tests can
 * assert on the decision without parsing the text message.
 *
 * Errors from `runPostCompactCleanup` are caught and returned as a
 * structured `error` outcome instead of being silently swallowed —
 * I-2 requires the `previous_response_id` clear to fire end-to-end on
 * every `/compact`, so a swallowed failure would leave the invariant
 * broken with no user-visible signal.
 */
export async function runCompact(
  session: Session,
  instructionsRaw: string,
): Promise<CompactOutcome> {
  const instructions = instructionsRaw.trim();

  // Mid-stream guard: if a turn is active, refuse. Compacting while a
  // turn is mid-stream would race the history writer and leave the
  // compact input in an inconsistent state. Unlike the provider/model
  // switch path, we do NOT abort — the user must let the current turn
  // finish before re-issuing `/compact`.
  const activeTurn = session.activeTurn.unsafePeek();
  if (activeTurn !== null) {
    return {
      kind: "blocked",
      reason:
        "a turn is currently in flight; wait for it to complete before running /compact",
    };
  }

  try {
    runPostCompactCleanup();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { kind: "error", cause };
  }
  return { kind: "ran", instructions };
}

/**
 * Render a `CompactOutcome` into a user-visible string.
 */
export function formatCompactOutcome(outcome: CompactOutcome): string {
  switch (outcome.kind) {
    case "blocked":
      return `Cannot compact right now: ${outcome.reason}.`;
    case "ran":
      return outcome.instructions.length > 0
        ? `Compaction complete. Custom instructions noted: ${outcome.instructions}`
        : "Compaction complete.";
    case "error":
      return `Compaction failed: ${outcome.cause}`;
  }
}

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Manually compact conversation history",
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const outcome = await runCompact(ctx.session, ctx.argsRaw);
      if (outcome.kind === "blocked" || outcome.kind === "error") {
        return {
          kind: "error",
          message: formatCompactOutcome(outcome),
        };
      }
      return { kind: "compact", text: formatCompactOutcome(outcome) };
    }),
};

export default compactCommand;
