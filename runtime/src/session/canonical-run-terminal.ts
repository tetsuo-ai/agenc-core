import type { RunTerminalResult } from "../contracts/run-contracts.js";
import type { Event } from "./event-log.js";
import { parseRolloutLine, type RolloutItem } from "./rollout-item.js";

/**
 * The `run_terminal` already stored for one run epoch, in the shape a
 * SQLite projection has to copy. `lastSequence` is the event's own
 * sequence, the replay upper bound.
 */
export interface CanonicalRunTerminal {
  readonly eventId: string;
  readonly id: string;
  readonly sequence: number;
  readonly result: RunTerminalResult;
}

/** Last complete `run_terminal` for `runId` at `epoch`, if one is present. */
export function canonicalRunTerminalFromItems(
  items: readonly RolloutItem[],
  runId: string,
  epoch: number,
): CanonicalRunTerminal | undefined {
  let found: CanonicalRunTerminal | undefined;
  for (const item of items) {
    const terminal = terminalFromItem(item, runId, epoch);
    if (terminal !== undefined) found = terminal;
  }
  return found;
}

/**
 * Same scan as the append-order check: only a newline-terminated line counts.
 * A trailing fragment that has not been committed as a line is ignored.
 */
export function canonicalRunTerminalFromText(
  text: string,
  runId: string,
  epoch: number,
): CanonicalRunTerminal | undefined {
  const items: RolloutItem[] = [];
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    const line = text.slice(lineStart, index);
    lineStart = index + 1;
    if (line.trim().length === 0) continue;
    try {
      const parsed = parseRolloutLine(line);
      if (parsed !== null) items.push(parsed);
    } catch {
      // An unreadable line is not a terminal we can project.
    }
  }
  return canonicalRunTerminalFromItems(items, runId, epoch);
}

function terminalFromItem(
  item: RolloutItem,
  runId: string,
  epoch: number,
): CanonicalRunTerminal | undefined {
  if (item.type !== "event_msg") return undefined;
  const event: Event = item.payload;
  if (event.msg.type !== "run_terminal") return undefined;
  const payload = event.msg.payload;
  if (payload.runId !== runId || payload.epoch !== epoch) return undefined;
  const sequence = event.seq;
  if (!Number.isSafeInteger(sequence) || sequence === undefined || sequence <= 0) {
    return undefined;
  }
  const eventId =
    typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : `legacy-event:${sequence}:${event.id}`;
  return {
    eventId,
    id: event.id,
    sequence,
    result: {
      runId: payload.runId,
      status: payload.status,
      exitCode: payload.exitCode,
      stopReason: payload.stopReason,
      finalMessage: payload.finalMessage,
      usage: payload.usage,
      lastSequence: sequence,
      finishedAt: payload.finishedAt,
    },
  };
}
