// Cherry-picked TimestampedHistoryEntry + getTimestampedHistory shim
// for the wholesale-ported HistorySearchDialog.
//
// openclaude src/history.ts (~464 LOC) reads jsonl logs from
// ~/.claude/projects/<slug>/<session>.jsonl, dedupes user prompts,
// and yields them with timestamps. AgenC has its own session/rollout
// store at runtime/src/session/ — its history is queried differently.
//
// This shim provides the openclaude API surface (an async generator
// of TimestampedHistoryEntry) as a no-op so the dialog compiles. Wire
// to AgenC's session history when this dialog becomes production.

import type { HistoryEntry } from "./utils/config.js";

export type TimestampedHistoryEntry = {
  display: string;
  timestamp: number;
  resolve: () => Promise<HistoryEntry>;
};

// eslint-disable-next-line require-yield
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  // Empty by default. AgenC consumers wire this to the session store
  // by replacing the body here, not by editing the openclaude-side
  // wholesale-ported dialog.
  return;
}

// eslint-disable-next-line require-yield
export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  // Empty by default. Same wiring story as getTimestampedHistory.
  return;
}
