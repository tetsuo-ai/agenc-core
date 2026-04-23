/**
 * `/compact [instructions]` — manually trigger conversation compaction.
 *
 * Mid-stream guard (mirrors I-13): if a turn is currently in flight we
 * REFUSE the request with an error result. Unlike `/model` and
 * `/provider`, we do NOT abort the turn — compacting mid-stream would
 * corrupt state (the in-flight response is still being appended to
 * history and the compact pipeline reads the fully-committed history).
 * The user must wait for the current turn to settle and re-issue
 * `/compact`.
 *
 * When no turn is active the command delegates to
 * `runSessionManualCompact` from the session manual-compact module,
 * which drives the full compaction pipeline.
 *
 * Optional `instructions` argument (free-form text) is accepted and
 * forwarded to the compact pipeline.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import { runSessionManualCompact } from "../session/manual-compact.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * Outcome of an attempted compaction. `ran` means the compact pipeline
 * executed successfully; `blocked` means the mid-stream guard refused;
 * `error` means compaction was attempted but failed.
 */
export type CompactOutcome =
  | { readonly kind: "ran"; readonly instructions: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "error"; readonly cause: string };

/**
 * Drive the compaction flow. Returns a structured outcome so tests can
 * assert on the decision without parsing the text message.
 */
export async function runCompact(
  session: Session,
  instructionsRaw: string,
): Promise<CompactOutcome> {
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

  const result = await runSessionManualCompact(session, instructionsRaw);
  switch (result.kind) {
    case "ran":
      return { kind: "ran", instructions: result.instructions };
    case "blocked":
      // Belt-and-suspenders: runSessionManualCompact has its own mid-stream
      // guard; surface it as blocked if it fires.
      return { kind: "blocked", reason: result.reason };
    case "error":
      return { kind: "error", cause: result.cause };
  }
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
      return `Compaction failed: ${outcome.cause}.`;
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
      if (outcome.kind === "blocked") {
        return {
          kind: "error",
          message: formatCompactOutcome(outcome),
        };
      }
      return { kind: "compact", text: formatCompactOutcome(outcome) };
    }),
};

export default compactCommand;
