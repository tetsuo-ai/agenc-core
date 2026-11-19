/**
 * The note a durable resume adds after the restored history of a turn whose
 * process died (run-turn.ts). Its lead is fixed so the OpenAI Responses wire
 * (responses-openai.ts) can send the note where it sits: in `instructions`,
 * where every developer message goes, it changed the cached prefix from its
 * first byte.
 *
 * @module
 */

export const INTERRUPTED_TURN_NOTE_LEAD = "The previous turn was interrupted by an app or daemon restart.";

export function interruptedTurnNote(completedToolResults: number): string {
  return `${INTERRUPTED_TURN_NOTE_LEAD} ${completedToolResults} completed tool result(s) from that turn are already recorded in the conversation. Continue the unfinished user request from the recorded state and pending plan. Check the workspace before further writes. Do not repeat completed work. A tool without a settled result may have executed; check its outcome before any side-effecting retry.`;
}
