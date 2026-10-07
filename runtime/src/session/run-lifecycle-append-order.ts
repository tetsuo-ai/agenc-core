import type { Event, EventMsg } from "./event-log.js";
import { parseRolloutLine, type RolloutItem } from "./rollout-item.js";
import { stableStringify } from "../utils/stableStringify.js";

/** Where an item the append-order scan saw is held. */
export type RunLifecycleSource = "journal" | "degraded" | "pending";

/**
 * Active epoch for one run, derived only from `run_terminal` / `run_reopened`.
 * Epoch 1 is open until a same-epoch terminal is seen. A reopen advances the
 * cursor only when it names that terminal epoch and the next one.
 * `sealedBy` is the first terminal seen for the active epoch.
 */
interface RunLifecycleCursor {
  activeEpoch: number;
  terminal: boolean;
  sealedBy?: { readonly event: Event; readonly source: RunLifecycleSource };
}

/**
 * `append`: write the event. `retry`: the event is the terminal that already
 * seals its epoch; write nothing and report that terminal's state.
 */
export type RunLifecycleAppendDecision =
  | { readonly kind: "append" }
  | { readonly kind: "retry"; readonly sealedIn: RunLifecycleSource };

const APPEND: RunLifecycleAppendDecision = { kind: "append" };

/**
 * Refuse a canonical lifecycle append the journal contract cannot replay.
 *
 * `run_reopened` is accepted only after the terminal it supersedes is already
 * in this file. A later `run_terminal` for that superseded epoch is refused.
 * Those are the only orders that would put a clearing reopen outside a tail
 * window that still contains the terminal (`reopenTerminalEpoch` appends the
 * reopen, via this check, after the terminal line is already durable).
 *
 * An epoch has one terminal. Once a terminal for the active epoch is in the
 * file, queued in the degraded buffer, or in the unflushed batch, a different
 * `run_terminal` for that epoch is refused. The same terminal again is a
 * retry: identical `eventId`, `id`, `seq` and payload (the store's form of
 * `run-durability` `recordTerminalResult`, which treats the same `eventId`
 * and the same content, including the sequence, as idempotent). The caller
 * writes nothing for a retry.
 *
 * Items are scanned in the order they reach disk: file bytes, then the
 * degraded queue, then the unflushed batch. The prior-byte scan matches the
 * startup tail reader: a trailing segment with no newline is not a record,
 * and a complete line that mentions a lifecycle type but does not parse
 * refuses the append.
 */
export function assertRunLifecycleAppendOrder(
  priorBytes: Buffer,
  pending: readonly RolloutItem[],
  event: Event,
  degraded: readonly RolloutItem[] = [],
): RunLifecycleAppendDecision {
  const message = event.msg;
  if (message.type !== "run_terminal" && message.type !== "run_reopened") {
    return APPEND;
  }
  const incoming = lifecycleFact(message);
  if (incoming === undefined) {
    throw new Error(
      `refusing to append ${message.type}: lifecycle binding is invalid`,
    );
  }
  const cursor = cursorFromPrior(
    priorBytes,
    degraded,
    pending,
    incoming.runId,
    message.type,
  );
  switch (incoming.kind) {
    case "terminal": {
      if (incoming.epoch !== cursor.activeEpoch) {
        throw new Error(
          `refusing to append run_terminal for ${incoming.runId}: epoch ${incoming.epoch} is not active epoch ${cursor.activeEpoch}`,
        );
      }
      const sealed = cursor.sealedBy;
      if (sealed === undefined) return APPEND;
      if (terminalIdentity(sealed.event) === terminalIdentity(event)) {
        return { kind: "retry", sealedIn: sealed.source };
      }
      throw new Error(
        `refusing to append run_terminal for ${incoming.runId}: epoch ${incoming.epoch} is already sealed by a different terminal (${describeTerminal(sealed.event)}, ${sealed.source})`,
      );
    }
    case "reopened":
      if (
        !cursor.terminal ||
        incoming.previousEpoch !== cursor.activeEpoch ||
        incoming.epoch !== cursor.activeEpoch + 1
      ) {
        throw new Error(
          `refusing to append run_reopened for ${incoming.runId}: it does not follow terminal epoch ${cursor.activeEpoch}`,
        );
      }
      return APPEND;
    default: {
      const unreachable: never = incoming;
      throw new Error(
        `refusing to append unexpected lifecycle fact ${String(unreachable)}`,
      );
    }
  }
}

/** Identity of a terminal for the retry test: eventId, id, seq and message. */
function terminalIdentity(event: Event): string {
  return stableStringify({
    eventId: event.eventId,
    id: event.id,
    seq: event.seq,
    msg: event.msg,
  });
}

function describeTerminal(event: Event): string {
  return `eventId ${event.eventId ?? "(none)"}, seq ${event.seq ?? "(none)"}`;
}

type LifecycleFact =
  | {
      readonly kind: "terminal";
      readonly runId: string;
      readonly epoch: number;
    }
  | {
      readonly kind: "reopened";
      readonly runId: string;
      readonly epoch: number;
      readonly previousEpoch: number;
    };

function cursorFromPrior(
  priorBytes: Buffer,
  degraded: readonly RolloutItem[],
  pending: readonly RolloutItem[],
  runId: string,
  appendedType: "run_terminal" | "run_reopened",
): RunLifecycleCursor {
  const cursor: RunLifecycleCursor = { activeEpoch: 1, terminal: false };
  const text = priorBytes.toString("utf8");
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x0a) continue;
    const line = text.slice(lineStart, index);
    lineStart = index + 1;
    noteCompleteLifecycleLine(cursor, line, runId, appendedType);
  }
  for (const item of degraded) {
    noteLifecycleFact(cursor, item, runId, "degraded");
  }
  for (const item of pending) noteLifecycleFact(cursor, item, runId, "pending");
  return cursor;
}

function noteCompleteLifecycleLine(
  cursor: RunLifecycleCursor,
  line: string,
  runId: string,
  appendedType: "run_terminal" | "run_reopened",
): void {
  if (
    !line.includes('"run_terminal"') &&
    !line.includes('"run_reopened"')
  ) {
    return;
  }
  let parsed: RolloutItem | null;
  try {
    parsed = parseRolloutLine(line);
  } catch {
    throw new Error(
      `refusing to append ${appendedType}: unreadable lifecycle line`,
    );
  }
  if (parsed !== null) noteLifecycleFact(cursor, parsed, runId, "journal");
}

function noteLifecycleFact(
  cursor: RunLifecycleCursor,
  item: RolloutItem,
  runId: string,
  source: RunLifecycleSource,
): void {
  if (item.type !== "event_msg") return;
  const fact = lifecycleFact(item.payload.msg);
  if (fact === undefined || fact.runId !== runId) return;
  switch (fact.kind) {
    case "terminal":
      if (fact.epoch === cursor.activeEpoch && !cursor.terminal) {
        cursor.terminal = true;
        cursor.sealedBy = { event: item.payload, source };
      }
      return;
    case "reopened":
      if (
        cursor.terminal &&
        fact.previousEpoch === cursor.activeEpoch &&
        fact.epoch === cursor.activeEpoch + 1
      ) {
        cursor.activeEpoch = fact.epoch;
        cursor.terminal = false;
        cursor.sealedBy = undefined;
      }
      return;
    default: {
      const unreachable: never = fact;
      throw new Error(
        `unexpected lifecycle fact ${String(unreachable)}`,
      );
    }
  }
}

function lifecycleFact(message: EventMsg): LifecycleFact | undefined {
  if (message.type !== "run_terminal" && message.type !== "run_reopened") {
    return undefined;
  }
  const payload: unknown = message.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as {
    readonly runId?: unknown;
    readonly epoch?: unknown;
    readonly previousEpoch?: unknown;
  };
  const runId = runIdOf(record.runId);
  const epoch = positiveEpoch(record.epoch);
  if (runId === undefined || epoch === undefined) return undefined;
  if (message.type === "run_terminal") {
    return { kind: "terminal", runId, epoch };
  }
  const previousEpoch = positiveEpoch(record.previousEpoch);
  if (previousEpoch === undefined) return undefined;
  return { kind: "reopened", runId, epoch, previousEpoch };
}

function positiveEpoch(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function runIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
