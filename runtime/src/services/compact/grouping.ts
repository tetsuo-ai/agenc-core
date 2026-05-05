/**
 * Message grouping helpers for compact retries.
 *
 * Source snapshot: `src/services/compact/grouping.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { RuntimeMessage } from "./types.js";

export function groupMessagesAtAssistantBoundaries(
  messages: readonly RuntimeMessage[],
): RuntimeMessage[][] {
  const groups: RuntimeMessage[][] = [];
  let current: RuntimeMessage[] = [];
  for (const message of messages) {
    if (messageRole(message) === "assistant" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function messageRole(message: RuntimeMessage): string | undefined {
  return message.message?.role ?? message.role ?? message.originalRole;
}
