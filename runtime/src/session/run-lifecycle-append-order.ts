import type { Event, EventMsg } from "./event-log.js";
import { parseRolloutLine, type RolloutItem } from "./rollout-item.js";

/**
 * Active epoch for one run, derived only from `run_terminal` / `run_reopened`.
 * Epoch 1 is open until a same-epoch terminal is seen. A reopen advances the
 * cursor only when it names that terminal epoch and the next one.
 */
interface RunLifecycleCursor {
  activeEpoch: number;
  terminal: boolean;
}

/**
 * Refuse a canonical lifecycle append the journal contract cannot replay.
 *
 * `run_reopened` is accepted only after the terminal it supersedes is already
 * in this file. A later `run_terminal` for that superseded epoch is refused.
 * Those are the only orders that would put a clearing reopen outside a tail
 * window that still contains the terminal (`reopenTerminalEpoch` appends the
 * reopen, via this check, after the terminal line is already durable).
 */
export function assertRunLifecycleAppendOrder(
  priorBytes: Buffer,
  pending: readonly RolloutItem[],
  event: Event,
): void {
  const message = event.msg;
  if (message.type !== "run_terminal" && message.type !== "run_reopened") {
    return;
  }
  const incoming = lifecycleFact(message);
  if (incoming === undefined) {
    throw new Error(
      `refusing to append ${message.type}: lifecycle binding is invalid`,
    );
  }
  const cursor = cursorFromPrior(priorBytes, pending, incoming.runId);
  switch (incoming.kind) {
    case "terminal":
      if (incoming.epoch !== cursor.activeEpoch) {
        throw new Error(
          `refusing to append run_terminal for ${incoming.runId}: epoch ${incoming.epoch} is not active epoch ${cursor.activeEpoch}`,
        );
      }
      return;
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
      return;
    default: {
      const unreachable: never = incoming;
      throw new Error(
        `refusing to append unexpected lifecycle fact ${String(unreachable)}`,
      );
    }
  }
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
  pending: readonly RolloutItem[],
  runId: string,
): RunLifecycleCursor {
  const cursor: RunLifecycleCursor = { activeEpoch: 1, terminal: false };
  const text = priorBytes.toString("utf8");
  let lineStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.charCodeAt(index) !== 0x0a) continue;
    const line = text.slice(lineStart, index);
    lineStart = index + 1;
    if (
      !line.includes('"run_terminal"') &&
      !line.includes('"run_reopened"')
    ) {
      continue;
    }
    let parsed: RolloutItem | null;
    try {
      parsed = parseRolloutLine(line);
    } catch {
      continue;
    }
    if (parsed !== null) noteLifecycleFact(cursor, parsed, runId);
  }
  for (const item of pending) noteLifecycleFact(cursor, item, runId);
  return cursor;
}

function noteLifecycleFact(
  cursor: RunLifecycleCursor,
  item: RolloutItem,
  runId: string,
): void {
  if (item.type !== "event_msg") return;
  const fact = lifecycleFact(item.payload.msg);
  if (fact === undefined || fact.runId !== runId) return;
  switch (fact.kind) {
    case "terminal":
      if (fact.epoch === cursor.activeEpoch) cursor.terminal = true;
      return;
    case "reopened":
      if (
        cursor.terminal &&
        fact.previousEpoch === cursor.activeEpoch &&
        fact.epoch === cursor.activeEpoch + 1
      ) {
        cursor.activeEpoch = fact.epoch;
        cursor.terminal = false;
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
