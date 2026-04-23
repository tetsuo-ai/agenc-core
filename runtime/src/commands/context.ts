/**
 * `/context` — report context-window usage.
 *
 * Uses the session's `BudgetTracker` (I-22) for token math plus the
 * history length from `SessionState` for message count. Last compaction
 * timestamp is read from `session.eventLog` if the compaction event was
 * recorded (falls back to "never").
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

export interface ContextSnapshot {
  readonly tokensUsed: number | null;
  readonly tokensLimit: number | null;
  readonly messageCount: number;
  readonly lastCompactionMs: number | null;
}

/**
 * Collect the context snapshot. Returns null fields when the
 * corresponding subsystem is not wired.
 */
export function collectContextSnapshot(session: Session): ContextSnapshot {
  const bt = session.budgetTracker;
  const tokensUsed = bt ? bt.emitted : null;
  let tokensLimit: number | null = null;
  if (bt) {
    // remaining is the surviving budget; total = used + remaining when
    // remaining is finite; null when unbounded.
    const r = bt.remaining;
    if (r !== null && Number.isFinite(r)) {
      tokensLimit = bt.emitted + r;
    }
  }

  // Best-effort read of history length via the lock's unsafePeek.
  const rawState = session.state.unsafePeek() as { history?: unknown[] };
  const messageCount = rawState?.history?.length ?? 0;

  // Pull last compaction timestamp from the event log if tracked.
  const eventLog = session.eventLog as unknown as {
    lastCompactionMs?: number | null;
  };
  const lastCompactionMs = typeof eventLog.lastCompactionMs === "number"
    ? eventLog.lastCompactionMs
    : null;

  return { tokensUsed, tokensLimit, messageCount, lastCompactionMs };
}

export function formatContext(snap: ContextSnapshot): string {
  const lines: string[] = [];
  if (snap.tokensUsed === null) {
    lines.push("Tokens used     : n/a (budget disabled)");
  } else {
    const limit = snap.tokensLimit === null ? "unlimited" : String(snap.tokensLimit);
    lines.push(`Tokens used     : ${snap.tokensUsed} / ${limit}`);
  }
  lines.push(`Message count   : ${snap.messageCount}`);
  lines.push(
    `Last compaction : ${
      snap.lastCompactionMs === null
        ? "never"
        : new Date(snap.lastCompactionMs).toISOString()
    }`,
  );
  return lines.join("\n");
}

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context window usage (tokens, messages, last compaction)",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const snap = collectContextSnapshot(ctx.session);
      return { kind: "text", text: formatContext(snap) };
    }),
};

export default contextCommand;
