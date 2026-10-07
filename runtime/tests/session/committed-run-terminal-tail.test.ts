/**
 * A producer may adopt a same-epoch terminal from a bounded suffix.
 * Absence is decided only when that suffix reaches byte 0, or when it
 * contains the run_reopened that opened the epoch. A shorter suffix that
 * contains neither is not absence, so the window grows.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalRunTerminalFromGrowingTail,
  INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES,
  type CommittedSuffix,
} from "./canonical-run-terminal.js";
import type { Event } from "./event-log.js";
import { serializeRolloutItem, type RolloutItem } from "./rollout-item.js";

describe("committed run terminal tail", () => {
  it("finds a terminal in the last 1KB of a 200KB file from the first 64KB window", () => {
    const terminal = terminalLine("tail-near-end", 1, 4);
    expect(terminal.length).toBeLessThan(1024);
    const file = Buffer.concat([
      filler(200 * 1024 - terminal.length),
      terminal,
    ]);
    expect(file.length).toBe(200 * 1024);
    const { windows, readSuffix } = suffixReader(file);
    const found = canonicalRunTerminalFromGrowingTail(
      file.length,
      readSuffix,
      "tail-near-end",
      1,
    );
    expect(windows).toEqual([INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES]);
    expect(found?.eventId).toBe("run-terminal:tail-near-end:1");
    expect(found?.sequence).toBe(4);
    expect(found?.result.finalMessage).toBe("done");
  });

  it("grows once to find a terminal about 70KB from the end and does not read the whole file", () => {
    const terminal = terminalLine("tail-second-window", 1, 9);
    const distanceFromEnd = 70 * 1024;
    const file = Buffer.concat([
      filler(200 * 1024 - distanceFromEnd - terminal.length),
      terminal,
      filler(distanceFromEnd),
    ]);
    expect(file.length).toBe(200 * 1024);
    const { windows, readSuffix, starts } = suffixReader(file);
    const found = canonicalRunTerminalFromGrowingTail(
      file.length,
      readSuffix,
      "tail-second-window",
      1,
    );
    expect(windows).toEqual([
      INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES,
      INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES * 2,
    ]);
    expect(starts.every((start) => start > 0)).toBe(true);
    expect(windows.every((window) => window < file.length)).toBe(true);
    expect(found?.eventId).toBe("run-terminal:tail-second-window:1");
    expect(found?.sequence).toBe(9);
  });

  it("decides epoch 2 is absent when the tail contains its reopen and no epoch-2 terminal", () => {
    const reopen = line(
      eventItem({
        eventId: "run-reopened:tail-epoch-open:2",
        id: "run-reopened:tail-epoch-open:2",
        seq: 8,
        msg: {
          type: "run_reopened",
          payload: {
            runId: "tail-epoch-open",
            previousEpoch: 1,
            epoch: 2,
            reason: "user_session_continue",
            reopenedAt: "2026-08-19T00:00:01.000Z",
          },
        },
      }),
    );
    const buriedEpoch1 = terminalLine("tail-epoch-open", 1, 3);
    const file = Buffer.concat([
      filler(80 * 1024),
      buriedEpoch1,
      filler(80 * 1024),
      reopen,
    ]);
    expect(file.length).toBeGreaterThan(
      INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES,
    );
    const { windows, readSuffix, starts } = suffixReader(file);
    const found = canonicalRunTerminalFromGrowingTail(
      file.length,
      readSuffix,
      "tail-epoch-open",
      2,
    );
    expect(found).toBeUndefined();
    expect(windows).toEqual([INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES]);
    expect(starts).toEqual([file.length - INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES]);
    const suffix = file.subarray(starts[0]!);
    expect(suffix.includes(buriedEpoch1)).toBe(false);
    expect(suffix.includes(reopen)).toBe(true);
  });
});

function suffixReader(file: Buffer): {
  readonly windows: number[];
  readonly starts: number[];
  readonly readSuffix: (window: number) => CommittedSuffix;
} {
  const windows: number[] = [];
  const starts: number[] = [];
  return {
    windows,
    starts,
    readSuffix(window: number): CommittedSuffix {
      windows.push(window);
      const use = Math.min(window, file.length);
      const start = file.length - use;
      starts.push(start);
      return { bytes: file.subarray(start), start, size: file.length };
    },
  };
}

function filler(byteLength: number): Buffer {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`filler length ${byteLength} is not a non-negative integer`);
  }
  const chunks: Buffer[] = [];
  let remaining = byteLength;
  const body = Buffer.alloc(63, 0x61);
  while (remaining > 0) {
    if (remaining >= 64) {
      chunks.push(body, Buffer.from("\n"));
      remaining -= 64;
      continue;
    }
    if (remaining === 1) {
      chunks.push(Buffer.from("\n"));
      remaining = 0;
      continue;
    }
    chunks.push(Buffer.alloc(remaining - 1, 0x62), Buffer.from("\n"));
    remaining = 0;
  }
  const out = Buffer.concat(chunks);
  if (out.length !== byteLength) {
    throw new Error(`filler wrote ${out.length}, expected ${byteLength}`);
  }
  return out;
}

function terminalLine(runId: string, epoch: number, seq: number): Buffer {
  return line(eventItem(terminalEvent(runId, epoch, seq)));
}

function line(item: RolloutItem): Buffer {
  return Buffer.from(serializeRolloutItem(item));
}

function eventItem(event: Event): RolloutItem {
  return { type: "event_msg", payload: event };
}

function terminalEvent(runId: string, epoch: number, seq: number): Event {
  const eventId = `run-terminal:${runId}:${epoch}`;
  return {
    eventId,
    id: eventId,
    seq,
    msg: {
      type: "run_terminal",
      payload: {
        runId,
        epoch,
        status: "completed",
        exitCode: 0,
        stopReason: "turn_completed",
        finalMessage: "done",
        usage: null,
        lastSequenceBeforeTerminal: null,
        finishedAt: "2026-08-19T00:00:00.000Z",
      },
    },
  };
}
