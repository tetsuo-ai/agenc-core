/**
 * User-role items in the model's history are not all things the user typed.
 * The runtime wraps a prompt queued mid-turn in a `<system-reminder>` with
 * instructions for the model, and injects its own user-role messages
 * (completion gate, hook context, continuation nudges). When a transcript is
 * rebuilt from that history (after a rewind, a partial compact or a
 * compaction rollback, or for a client that reads history) those items must
 * not appear as if the user wrote them.
 *
 * `userFacingHistoryText` returns the text to show for a user-role history
 * item: the user's own words when the item wraps them, and "" when the item
 * is runtime text only. Callers that must keep one row per history item
 * (rewind ordinals count them) show {@link RUNTIME_NOTE_PLACEHOLDER} for "".
 *
 * Only wrappers at the start or the end of the item are removed. A tag the
 * user typed inside a prompt is their text and stays.
 *
 * Pure module, shared by the daemon transcripts and the TUI rows.
 */

/** Shown in place of a history item that holds runtime text only. */
export const RUNTIME_NOTE_PLACEHOLDER = "Runtime note for the model (hidden)";

const QUEUED_HUMAN = /^<system-reminder>\nThe user sent a new message while you were working:\n([\s\S]*?)\n\nIMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.\n<\/system-reminder>/u;
const LEADING_BLOCK = /^<(system-reminder|completion_gate)>(?:(?!<\1>)[\s\S])*?<\/\1>/u;

const RUNTIME_ONLY_PREFIXES = [
  "Continue generating directly from where you left off.",
  "The previous response exhausted its output budget on reasoning",
];

function withoutTrailingBlocks(text: string): string {
  let rest = text.trimEnd();
  for (;;) {
    const tag = rest.endsWith("</system-reminder>")
      ? "system-reminder"
      : rest.endsWith("</completion_gate>") ? "completion_gate" : null;
    if (tag === null) return rest;
    const open = rest.lastIndexOf(`<${tag}>`);
    if (open < 0) return rest;
    rest = rest.slice(0, open).trimEnd();
  }
}

export function userFacingHistoryText(text: string): string {
  let remaining = text.trimStart();
  const parts: string[] = [];
  for (;;) {
    // A turn can carry several queued prompts, each in its own wrapper.
    const queued = QUEUED_HUMAN.exec(remaining);
    if (queued !== null) {
      parts.push(queued[1]!);
      remaining = remaining.slice(queued[0].length).trimStart();
      continue;
    }
    const block = LEADING_BLOCK.exec(remaining);
    if (block === null) break;
    remaining = remaining.slice(block[0].length).trimStart();
  }
  const rest = withoutTrailingBlocks(remaining).trim();
  if (rest.length > 0 && !RUNTIME_ONLY_PREFIXES.some((prefix) => rest.startsWith(prefix))) {
    parts.push(rest);
  }
  return parts.join("\n\n").trim();
}

/** True when `text` may contain runtime-written wrappers this module removes. */
export function hasRuntimeHistoryWrapper(text: string): boolean {
  const lead = text.trimStart();
  return lead.startsWith("<system-reminder>") || lead.startsWith("<completion_gate>") ||
    text.trimEnd().endsWith("</system-reminder>") || text.trimEnd().endsWith("</completion_gate>") ||
    RUNTIME_ONLY_PREFIXES.some((prefix) => lead.startsWith(prefix));
}
