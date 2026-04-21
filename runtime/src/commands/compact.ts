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
 * (landing in T5b when the `compact/` typecheck exclude is lifted).
 * Until then the practical effect is an info message that compaction
 * is pending-wire, so the slash-command is discoverable and the
 * dispatcher does not crash on a missing implementation.
 *
 * Optional `instructions` argument (free-form text) is accepted and
 * forwarded to the compact pipeline once T5b wires it; for now it is
 * echoed back in the info message so `/help` users can see that the
 * arg is recognised.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * Outcome of an attempted compaction. `pending` means the compact
 * pipeline is not wired yet (current T11 state); `ran` means
 * `runPostCompactCleanup` executed; `blocked` means the mid-stream
 * guard refused.
 */
export type CompactOutcome =
  | { readonly kind: "pending"; readonly instructions: string }
  | { readonly kind: "ran"; readonly instructions: string }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Attempt to invoke `runPostCompactCleanup` from the compact module.
 * Returns true on success, false when the module is not yet reachable
 * from typecheck (T5b lifts the exclude).
 *
 * Kept as a dynamic import so this file stays typecheck-clean while the
 * `src/llm/compact/**` tree is excluded via tsconfig.
 */
// TODO T5b: wire real runPostCompactCleanup once compact/ is un-excluded
async function tryRunPostCompactCleanup(): Promise<boolean> {
  try {
    // Dynamic import through a variable path avoids a static dependency
    // on the typecheck-excluded `src/llm/compact/**` tree (tsconfig
    // exclude list). When T5b lifts the exclude this can become a
    // regular top-of-file import.
    const modulePath = "../llm/compact/post-compact-cleanup.js";
    const mod = (await import(modulePath)) as {
      runPostCompactCleanup?: (querySource?: unknown) => void;
    };
    if (typeof mod.runPostCompactCleanup === "function") {
      mod.runPostCompactCleanup();
      return true;
    }
    return false;
  } catch {
    // Module absent or failing to resolve — T5b wires this properly.
    return false;
  }
}

/**
 * Drive the compaction flow. Returns a structured outcome so tests can
 * assert on the decision without parsing the text message.
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

  const ran = await tryRunPostCompactCleanup();
  if (ran) {
    return { kind: "ran", instructions };
  }
  return { kind: "pending", instructions };
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
    case "pending":
      return (
        "Compaction requested, but the compact pipeline is not wired in " +
        "this build (pending T5b/T6). No changes were made." +
        (outcome.instructions.length > 0
          ? ` Instructions captured for the future pipeline: ${outcome.instructions}`
          : "")
      );
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
