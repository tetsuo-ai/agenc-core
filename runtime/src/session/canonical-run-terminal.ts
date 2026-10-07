import type { RunTerminalResult } from "../contracts/run-contracts.js";
import { MAX_RECOVERY_CANONICAL_LINE_BYTES } from "../state/recovery-contract.js";
import type { Event } from "./event-log.js";
import { parseRolloutLine, type RolloutItem } from "./rollout-item.js";

/**
 * First suffix, same bound as the startup journal tail. Grows while the
 * epoch's terminal is still outside the window.
 */
export const INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES = 64 * 1024;

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

/** A suffix of a committed rollout. `start` is its byte offset in the file. */
export interface CommittedSuffix {
  readonly bytes: Buffer;
  readonly start: number;
  readonly size: number;
}

/**
 * Last complete `run_terminal` for this epoch in a growing file suffix.
 *
 * The window starts at 64 KiB and doubles until it decides, or until it
 * reaches two maximum records. A same-epoch terminal in the suffix is that
 * epoch's only terminal. Absence is decided when the suffix starts at byte
 * 0, or when it contains the `run_reopened` that opened this epoch and no
 * same-epoch terminal follows: a committed reopen has its terminal at a
 * lower offset, in an earlier write or earlier in the same ordered fsync,
 * and this epoch's terminal is appended after that reopen. A capped suffix
 * that contains neither is not absence. Callers that still need the buried
 * line read the whole file.
 */
export function canonicalRunTerminalFromGrowingTail(
  size: number,
  readSuffix: (window: number) => CommittedSuffix | undefined,
  runId: string,
  epoch: number,
): CanonicalRunTerminal | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined;
  const limit = Math.min(size, MAX_RECOVERY_CANONICAL_LINE_BYTES * 2);
  let window = Math.min(size, INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES);
  for (;;) {
    const suffix = readSuffix(window);
    if (suffix === undefined) return undefined;
    const decision = decideCommittedRunTerminal(suffix, runId, epoch);
    if (decision.decided) return decision.terminal;
    if (window >= limit) return undefined;
    const next = Math.min(limit, window * 2);
    if (next <= window) return undefined;
    window = next;
  }
}

function decideCommittedRunTerminal(
  suffix: CommittedSuffix,
  runId: string,
  epoch: number,
):
  | { readonly decided: true; readonly terminal: CanonicalRunTerminal | undefined }
  | { readonly decided: false } {
  const lines = completeSuffixLines(suffix.bytes, suffix.start === 0);
  if (lines === undefined) return { decided: false };
  let terminal: CanonicalRunTerminal | undefined;
  let openedEpoch = false;
  for (const line of lines) {
    let parsed: RolloutItem | null;
    try {
      parsed = parseRolloutLine(line);
    } catch {
      continue;
    }
    if (parsed === null) continue;
    if (opensEpoch(parsed, runId, epoch)) openedEpoch = true;
    const found = terminalFromItem(parsed, runId, epoch);
    if (found !== undefined) terminal = found;
  }
  if (terminal !== undefined) return { decided: true, terminal };
  if (suffix.start === 0 || openedEpoch) {
    return { decided: true, terminal: undefined };
  }
  return { decided: false };
}

function opensEpoch(item: RolloutItem, runId: string, epoch: number): boolean {
  if (epoch <= 1 || item.type !== "event_msg") return false;
  if (item.payload.msg.type !== "run_reopened") return false;
  const payload = item.payload.msg.payload;
  return (
    payload.runId === runId &&
    payload.epoch === epoch &&
    payload.previousEpoch === epoch - 1
  );
}

function completeSuffixLines(
  chunk: Buffer,
  atStart: boolean,
): readonly string[] | undefined {
  let from = 0;
  if (!atStart) {
    const boundary = chunk.indexOf(0x0a);
    if (boundary < 0) return undefined;
    from = boundary + 1;
  }
  let end = chunk.length;
  if (end > from && chunk[end - 1] !== 0x0a) {
    const boundary = chunk.lastIndexOf(0x0a);
    if (boundary < from) return atStart ? [] : undefined;
    end = boundary + 1;
  }
  const lines: string[] = [];
  let lineStart = from;
  for (let index = from; index < end; index += 1) {
    if (chunk[index] !== 0x0a) continue;
    const lineEnd =
      index > lineStart && chunk[index - 1] === 0x0d ? index - 1 : index;
    if (lineEnd - lineStart > MAX_RECOVERY_CANONICAL_LINE_BYTES) {
      lineStart = index + 1;
      continue;
    }
    if (lineEnd > lineStart) {
      lines.push(chunk.subarray(lineStart, lineEnd).toString("utf8"));
    }
    lineStart = index + 1;
  }
  return lines;
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
