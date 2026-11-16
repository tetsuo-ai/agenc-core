/**
 * User-role items in the model's history are not all things the user typed.
 * The runtime wraps a prompt queued mid-turn in a `<system-reminder>` with
 * instructions for the model, and injects its own user-role messages
 * (completion gate, hook context, continuation nudges). When a transcript is
 * rebuilt from that history (after a rewind, a partial compact or a
 * compaction rollback) those items must not appear as if the user wrote
 * them.
 *
 * Returns the text to show for a user-role history item: the user's own
 * words when the item wraps them, and "" when the item is runtime text only.
 *
 * Pure module, shared by the daemon transcript snapshot and the TUI rows.
 */

const QUEUED_HUMAN = /^<system-reminder>\nThe user sent a new message while you were working:\n([\s\S]*?)\n\nIMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.\n<\/system-reminder>/u;

const RUNTIME_ONLY_PREFIXES = [
  "Continue generating directly from where you left off.",
  "The previous response exhausted its output budget on reasoning",
];

export function userFacingHistoryText(text: string): string {
  let remaining = text;
  const parts: string[] = [];
  // A turn can carry several queued prompts, each in its own wrapper.
  for (let match = QUEUED_HUMAN.exec(remaining.trimStart()); match !== null;
    match = QUEUED_HUMAN.exec(remaining.trimStart())) {
    parts.push(match[1]!);
    remaining = remaining.trimStart().slice(match[0].length);
  }
  const rest = remaining
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "")
    .replace(/<completion_gate>[\s\S]*?<\/completion_gate>/gu, "")
    .trim();
  if (rest.length > 0 && !RUNTIME_ONLY_PREFIXES.some((prefix) => rest.startsWith(prefix))) {
    parts.push(rest);
  }
  return parts.join("\n\n").trim();
}

/** True when `text` contains runtime-written wrappers this module removes. */
export function hasRuntimeHistoryWrapper(text: string): boolean {
  return text.includes("<system-reminder>") || text.includes("<completion_gate>") ||
    RUNTIME_ONLY_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix));
}
