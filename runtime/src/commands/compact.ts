/**
 * `/compact [instructions]` — runtime-owned manual compaction entrypoint.
 *
 * The slash-command surface is now just an adapter over the session-owned
 * compaction path. Policy, runtime context assembly, history replacement,
 * and replay-affecting rollout/event writes all live under `session/`.
 */

import type { Session } from "../session/session.js";
import {
  runSessionManualCompact,
  type SessionManualCompactOutcome,
} from "../session/manual-compact.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export type CompactOutcome = SessionManualCompactOutcome;

export async function runCompact(
  session: Session,
  instructionsRaw: string,
): Promise<CompactOutcome> {
  return runSessionManualCompact(session, instructionsRaw);
}

export function formatCompactOutcome(outcome: CompactOutcome): string {
  switch (outcome.kind) {
    case "blocked":
      return `Cannot compact right now: ${outcome.reason}.`;
    case "ran":
      return outcome.text;
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
