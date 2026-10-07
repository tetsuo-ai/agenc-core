/**
 * A producer may adopt a same-epoch terminal from a bounded suffix.
 * Absence is decided only when that suffix reaches byte 0, or when it
 * contains the run_reopened that opened the epoch. A shorter suffix that
 * contains neither is not absence, so the window grows.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RECOVERY_CANONICAL_LINE_BYTES } from "../../src/state/recovery-contract.js";
import { validateCanonicalJournalText } from "../../src/state/recovery-journal-contract.js";
import {
  canonicalRunTerminalFromGrowingTail,
  INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES,
  type CommittedSuffix,
} from "./canonical-run-terminal.js";
import { EventLog, type Event } from "./event-log.js";
import { serializeRolloutItem, type RolloutItem } from "./rollout-item.js";
import { RolloutStore } from "./rollout-store.js";
import { Session } from "./session.js";

const SUFFIX_CAP_BYTES = MAX_RECOVERY_CANONICAL_LINE_BYTES * 2;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    expect(found).toMatchObject({
      status: "found",
      terminal: {
        eventId: "run-terminal:tail-near-end:1",
        sequence: 4,
        result: { finalMessage: "done" },
      },
    });
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
    expect(found).toMatchObject({
      status: "found",
      terminal: {
        eventId: "run-terminal:tail-second-window:1",
        sequence: 9,
      },
    });
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
    expect(found).toEqual({ status: "absent" });
    expect(windows).toEqual([INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES]);
    expect(starts).toEqual([file.length - INITIAL_COMMITTED_RUN_TERMINAL_TAIL_BYTES]);
    const suffix = file.subarray(starts[0]!);
    expect(suffix.includes(buriedEpoch1)).toBe(false);
    expect(suffix.includes(reopen)).toBe(true);
  });

  it("reports undecided, not absence, when the capped suffix cannot see the terminal", () => {
    const cap = SUFFIX_CAP_BYTES;
    const windows: number[] = [];
    const lookup = canonicalRunTerminalFromGrowingTail(
      cap + 32,
      (window) => {
        windows.push(window);
        return {
          bytes: Buffer.from("padding\n"),
          start: 32,
          size: cap + 32,
        };
      },
      "buried-cap",
      1,
    );
    expect(windows.at(-1)).toBe(cap);
    expect(lookup).toEqual({ status: "undecided" });
  });

  it("does not burn a sequence or journal bytes when the committed terminal sits past the suffix cap", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-buried-terminal-"));
    roots.push(cwd);
    const sessionId = "buried-suffix-terminal";
    const store = openBuriedStore(cwd, sessionId);
    try {
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      // Three lines keep each record under the canonical line ceiling while
      // pushing the terminal strictly outside the 8 MiB suffix.
      const pad = "p".repeat(3_000_000);
      for (const seq of [2, 3, 4] as const) {
        expect(
          store.append(paddingEvent(sessionId, seq, pad), { durable: true }),
        ).toBe(true);
      }
      const before = readFileSync(store.rolloutPath);
      const terminalAt = before.indexOf('"type":"run_terminal"');
      expect(terminalAt).toBeGreaterThanOrEqual(0);
      expect(before.length - terminalAt).toBeGreaterThan(SUFFIX_CAP_BYTES);

      const eventLog = new EventLog();
      eventLog.seedCanonicalHistory(
        store
          .readAll()
          .flatMap((item) => (item.type === "event_msg" ? [item.payload] : [])),
      );
      expect(eventLog.lastSeq).toBe(4);
      const session = sessionOver(store, eventLog);

      expect(() =>
        session.emit(
          {
            id: randomUUID(),
            msg: {
              type: "run_terminal",
              payload: {
                runId: sessionId,
                epoch: 1,
                status: "failed",
                exitCode: 1,
                stopReason: "turn_failed",
                finalMessage: "a second outcome",
                usage: null,
                lastSequenceBeforeTerminal: 4,
                finishedAt: "2026-08-19T00:00:03.000Z",
              },
            },
          },
          { durable: true },
        ),
      ).toThrow(/already sealed/);
      expect(readFileSync(store.rolloutPath)).toEqual(before);

      const later = session.emit(
        {
          id: randomUUID(),
          msg: {
            type: "error",
            payload: {
              cause: "after_refused_terminal",
              message: "contiguous successor",
            },
          },
        },
        { durable: true },
      );
      expect(later.seq).toBe(5);
      expect(eventLog.lastSeq).toBe(5);
      expect(() =>
        validateCanonicalJournalText(readFileSync(store.rolloutPath, "utf8"), {
          expectedRunId: sessionId,
        }),
      ).not.toThrow();
      expect(store.committedRunTerminal(sessionId, 1)).toMatchObject({
        eventId: `run-terminal:${sessionId}:1`,
        sequence: 1,
        result: { finalMessage: "done", lastSequence: 1 },
      });
    } finally {
      store.close();
    }
  }, 60_000);
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

function openBuriedStore(cwd: string, sessionId: string): RolloutStore {
  const store = new RolloutStore({
    agencHome: cwd,
    cwd,
    sessionId,
    agencVersion: "0.2.0",
    sessionTempRoot: join(cwd, "rollout-temp"),
  });
  store.open({
    sessionId,
    timestamp: "2026-08-19T00:00:00.000Z",
    cwd,
    originator: "buried-terminal-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function sessionOver(store: RolloutStore, eventLog: EventLog): Session {
  return Object.assign(Object.create(Session.prototype), {
    eventLog,
    rolloutStore: store,
    canonicalJournalSealed: false,
    txEvent: { send: () => true },
    isRolloutPersistenceSuspended: () => false,
  }) as Session;
}

function paddingEvent(runId: string, seq: number, pad: string): Event {
  return {
    eventId: `event:${seq}`,
    id: `pad-${runId}-${seq}`,
    seq,
    msg: {
      type: "warning",
      payload: { cause: "suffix-pad", message: `${runId}:${seq}:${pad}` },
    },
  };
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
