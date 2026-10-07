import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event } from "./event-log.js";
import { assertRunLifecycleAppendOrder } from "./run-lifecycle-append-order.js";
import { serializeRolloutItem, type RolloutItem } from "./rollout-item.js";
import { RolloutStore } from "./rollout-store.js";
import { validateCanonicalJournalText } from "../../src/state/recovery-journal-contract.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("run lifecycle append order", () => {
  it("refuses a reopen that precedes its terminal and a later terminal for that epoch", () => {
    const cwd = freshCwd();
    const sessionId = "lifecycle-order-refused";
    const store = openStore({ cwd, sessionId });
    try {
      const before = readFileSync(store.rolloutPath);
      expect(() =>
        store.append(reopenEvent(sessionId, 1), { durable: true }),
      ).toThrow(/refusing to append run_reopened/);
      expect(readFileSync(store.rolloutPath)).toEqual(before);

      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      const afterTerminal = readFileSync(store.rolloutPath, "utf8");
      expect(afterTerminal).not.toContain('"type":"run_reopened"');
      store.close();

      const resumed = openStore({
        cwd,
        sessionId,
        resume: true,
        reopenTerminalRun: true,
      });
      try {
        const text = readFileSync(resumed.rolloutPath, "utf8");
        const terminalAt = text.indexOf('"type":"run_terminal"');
        const reopenAt = text.indexOf('"type":"run_reopened"');
        expect(terminalAt).toBeGreaterThanOrEqual(0);
        expect(reopenAt).toBeGreaterThan(terminalAt);
        expect(text.indexOf('"type":"run_terminal"', reopenAt)).toBe(-1);
        const beforeStale = readFileSync(resumed.rolloutPath);
        expect(() =>
          resumed.append(terminalEvent(sessionId, 1, 4, "stale-epoch-terminal"), {
            durable: true,
          }),
        ).toThrow(/refusing to append run_terminal/);
        expect(readFileSync(resumed.rolloutPath)).toEqual(beforeStale);
        expect(
          resumed.append(terminalEvent(sessionId, 2, 4), { durable: true }),
        ).toBe(true);
      } finally {
        resumed.close();
      }
    } finally {
      store.close();
    }
  });

  it("does not append a reopen when the canonical epoch is not terminal", () => {
    const cwd = freshCwd();
    const sessionId = "lifecycle-order-open";
    const original = openStore({ cwd, sessionId });
    original.close();
    const resumed = openStore({
      cwd,
      sessionId,
      resume: true,
      reopenTerminalRun: true,
    });
    try {
      expect(resumed.runEpoch).toBe(1);
      expect(readFileSync(resumed.rolloutPath, "utf8")).not.toContain(
        '"type":"run_reopened"',
      );
    } finally {
      resumed.close();
    }
  });

  it("counts a pending terminal ahead of the reopen being appended", () => {
    const sessionId = "pending-terminal";
    const terminal = eventItem(terminalEvent(sessionId, 1, 1));
    expect(() =>
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [terminal],
        reopenEvent(sessionId, 2),
      ),
    ).not.toThrow();
    expect(() =>
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [],
        reopenEvent(sessionId, 1),
      ),
    ).toThrow(/refusing to append run_reopened/);
  });

  it("ignores a torn trailing lifecycle segment with no terminating newline", () => {
    const cwd = freshCwd();
    const sessionId = "torn-trailing-lifecycle";
    const store = openStore({ cwd, sessionId });
    try {
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      const tornReopen = journalLine(reopenEvent(sessionId, 9)).replace(
        /\n$/,
        "",
      );
      expect(tornReopen.endsWith("\n")).toBe(false);
      expect(tornReopen).toContain('"run_reopened"');
      appendFileSync(store.rolloutPath, tornReopen);
      expect(
        store.append(reopenEvent(sessionId, 2), { durable: true }),
      ).toBe(true);
      const text = readFileSync(store.rolloutPath, "utf8");
      const terminalAt = text.indexOf('"type":"run_terminal"');
      const reopenAt = text.indexOf('"type":"run_reopened"');
      expect(terminalAt).toBeGreaterThanOrEqual(0);
      expect(reopenAt).toBeGreaterThan(terminalAt);
    } finally {
      store.close();
    }
  });

  it("refuses the append when a complete lifecycle line does not parse and leaves bytes unchanged", () => {
    const cwd = freshCwd();
    const sessionId = "unreadable-lifecycle-line";
    const store = openStore({ cwd, sessionId });
    try {
      const corrupt =
        '{"type":"event_msg","payload":{"id":"bad","msg":{"type":"run_terminal","payload":}}\n';
      appendFileSync(store.rolloutPath, corrupt);
      const before = readFileSync(store.rolloutPath);
      expect(before.subarray(before.length - 1)).toEqual(Buffer.from("\n"));
      expect(() =>
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toThrow(/refusing to append run_terminal: unreadable lifecycle line/);
      expect(readFileSync(store.rolloutPath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("does not refuse a non-lifecycle line that quotes lifecycle substrings", () => {
    const cwd = freshCwd();
    const sessionId = "quoted-lifecycle-substrings";
    const store = openStore({ cwd, sessionId });
    try {
      // Escaped quotes inside message text do not form the prefilter needle.
      // A JSON string whose value is the token does, and must be ignored.
      const quotedLine =
        '{"type":"response_item","payload":{"role":"user","content":"please explain \\"run_terminal\\" and \\"run_reopened\\"","quoted":["run_terminal","run_reopened"]},"eventVersion":1}\n';
      expect(quotedLine).toContain('"run_terminal"');
      expect(quotedLine).toContain('"run_reopened"');
      expect(quotedLine).not.toContain('"type":"run_terminal"');
      appendFileSync(store.rolloutPath, quotedLine);
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      expect(readFileSync(store.rolloutPath, "utf8")).toContain(
        '"type":"run_terminal"',
      );
    } finally {
      store.close();
    }
  });

  it("refuses appendRollout of a lifecycle event", () => {
    const cwd = freshCwd();
    const sessionId = "append-rollout-lifecycle";
    const store = openStore({ cwd, sessionId });
    try {
      const before = readFileSync(store.rolloutPath);
      expect(() =>
        store.appendRollout(eventItem(terminalEvent(sessionId, 1, 1)), {
          durable: true,
        }),
      ).toThrow(
        /refusing to append run_terminal: lifecycle events cannot use appendRollout/,
      );
      expect(() =>
        store.appendRollout(eventItem(reopenEvent(sessionId, 2)), {
          durable: true,
        }),
      ).toThrow(
        /refusing to append run_reopened: lifecycle events cannot use appendRollout/,
      );
      expect(readFileSync(store.rolloutPath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("refuses a distinct second terminal for a flushed sealed epoch and leaves the bytes unchanged", () => {
    const cwd = freshCwd();
    const sessionId = "duplicate-terminal-flushed";
    const store = openStore({ cwd, sessionId });
    try {
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      const before = readFileSync(store.rolloutPath);
      const beforeHash = sha256(before);
      const distinct: readonly Event[] = [
        // Different content under the canonical eventId every producer uses.
        withFinalMessage(terminalEvent(sessionId, 1, 2), "a second outcome"),
        // Same content re-emitted under a new sequence.
        terminalEvent(sessionId, 1, 3),
        // A different eventId.
        terminalEvent(sessionId, 1, 4, "other-terminal-id"),
      ];
      for (const event of distinct) {
        expect(() => store.append(event, { durable: true })).toThrow(
          /refusing to append run_terminal for duplicate-terminal-flushed: epoch 1 is already sealed by a different terminal \(eventId run-terminal:duplicate-terminal-flushed:1, seq 1, journal\)/,
        );
      }
      const after = readFileSync(store.rolloutPath);
      expect(after).toEqual(before);
      expect(sha256(after)).toBe(beforeHash);
      expect(countTerminals(after)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("refuses a distinct terminal while the first is queued in the degraded buffer, and a retry does not queue a second copy", () => {
    const cwd = freshCwd();
    const sessionId = "duplicate-terminal-queued";
    const store = openStore({ cwd, sessionId });
    try {
      store.store.setWriteImplForTest(() => {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      });
      const first = terminalEvent(sessionId, 1, 1);
      expect(store.append(first, { durable: true })).toBe(false);
      expect(store.store.isDegraded).toBe(true);
      const before = readFileSync(store.rolloutPath);
      const beforeHash = sha256(before);
      expect(countTerminals(before)).toBe(0);

      expect(() =>
        store.append(
          withFinalMessage(terminalEvent(sessionId, 1, 2), "a second outcome"),
          { durable: true },
        ),
      ).toThrow(
        /epoch 1 is already sealed by a different terminal \(eventId run-terminal:duplicate-terminal-queued:1, seq 1, degraded\)/,
      );
      // The same terminal again is a retry. It is still queued, so it is
      // still not committed, and nothing else is queued or written.
      expect(store.append({ ...first }, { durable: true })).toBe(false);
      const after = readFileSync(store.rolloutPath);
      expect(after).toEqual(before);
      expect(sha256(after)).toBe(beforeHash);

      // The disk recovers; close drains the queue.
      store.store.setWriteImplForTest(writeSync);
    } finally {
      store.close();
    }
    const drained = readFileSync(store.rolloutPath);
    expect(countTerminals(drained)).toBe(1);
    expect(drained.toString("utf8")).toContain('"finalMessage":"done"');
    expect(drained.toString("utf8")).not.toContain("a second outcome");
  });

  it("refuses a distinct terminal while the first is in the unflushed batch or the degraded queue", () => {
    const sessionId = "duplicate-terminal-pending";
    const first = terminalEvent(sessionId, 1, 1);
    const second = withFinalMessage(
      terminalEvent(sessionId, 1, 2),
      "a second outcome",
    );
    for (const [pending, degraded, source] of [
      [[eventItem(first)], [], "pending"],
      [[], [eventItem(first)], "degraded"],
    ] as const) {
      expect(() =>
        assertRunLifecycleAppendOrder(Buffer.alloc(0), pending, second, degraded),
      ).toThrow(new RegExp(`already sealed by a different terminal .*, ${source}\\)`));
      expect(
        assertRunLifecycleAppendOrder(
          Buffer.alloc(0),
          pending,
          { ...first },
          degraded,
        ),
      ).toEqual({ kind: "retry", sealedIn: source });
    }
    // Pending is one ordered flush: the seal and its reopen are already in
    // that batch, so the next epoch's terminal is written behind them.
    expect(
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [eventItem(first), eventItem(reopenEvent(sessionId, 2))],
        terminalEvent(sessionId, 2, 3),
      ),
    ).toEqual({ kind: "append" });
    // A degraded seal is not in that batch. Queuing the reopen ahead of it
    // must not open the next epoch.
    expect(() =>
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [eventItem(reopenEvent(sessionId, 2))],
        terminalEvent(sessionId, 2, 3),
        [eventItem(first)],
      ),
    ).toThrow(
      /epoch 2 is not active until its clearing reopen is a complete line in the journal \(seal degraded, reopen pending\)/,
    );
  });

  it("accepts a same-terminal retry without writing a second copy", () => {
    const cwd = freshCwd();
    const sessionId = "same-terminal-retry";
    const store = openStore({ cwd, sessionId });
    try {
      const first = terminalEvent(sessionId, 1, 1);
      expect(store.append(first, { durable: true })).toBe(true);
      const before = readFileSync(store.rolloutPath);
      // A freshly built copy, as a retrying producer would send it.
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      const after = readFileSync(store.rolloutPath);
      expect(after).toEqual(before);
      expect(sha256(after)).toBe(sha256(before));
      expect(countTerminals(after)).toBe(1);
      // The epoch can still be reopened after the retry.
      expect(
        store.append(reopenEvent(sessionId, 2), { durable: true }),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("still dedups an unsequenced same-terminal retry by id", () => {
    const cwd = freshCwd();
    const sessionId = "unsequenced-terminal-retry";
    const store = openStore({ cwd, sessionId });
    try {
      const { seq: _seq, ...first } = terminalEvent(sessionId, 1, 1);
      expect(store.append(first, { durable: true })).toBe(true);
      const before = readFileSync(store.rolloutPath);
      expect(store.append({ ...first }, { durable: true })).toBe(true);
      expect(readFileSync(store.rolloutPath)).toEqual(before);
      expect(countTerminals(before)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("does not brick the session when a corrupt ordinary line quotes a lifecycle token", () => {
    const cwd = freshCwd();
    const sessionId = "quoted-corrupt-ordinary-line";
    const store = openStore({ cwd, sessionId });
    try {
      // Invalid JSON, and the token is only quoted text. It is not a
      // lifecycle record, so a later terminal must still append.
      const corrupt = [
        '{"type":"response_item","payload":{"content":"please explain "',
        '"run_terminal"',
        " and ",
        '"run_reopened"',
        '"}}',
      ].join("") + "\n";
      expect(corrupt.endsWith("\n")).toBe(true);
      expect(corrupt).toContain('"run_terminal"');
      expect(corrupt).toContain('"run_reopened"');
      expect(corrupt).not.toContain('"type":"run_terminal"');
      expect(corrupt).not.toContain('"type":"run_reopened"');
      expect(() => JSON.parse(corrupt.trim())).toThrow();
      appendFileSync(store.rolloutPath, corrupt);
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(true);
      expect(readFileSync(store.rolloutPath, "utf8")).toContain(
        '"type":"run_terminal"',
      );
    } finally {
      store.close();
    }
  });

  it("labels an in-flight terminal separately from the degraded ring", () => {
    const sessionId = "inflight-label";
    const terminal = terminalEvent(sessionId, 1, 1);
    expect(() =>
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [],
        reopenEvent(sessionId, 2),
        [],
        [eventItem(terminal)],
      ),
    ).toThrow(
      /refusing to append run_reopened for inflight-label: terminal epoch 1 is not yet a complete line in the journal \(inflight\)/,
    );
    expect(() =>
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [],
        reopenEvent(sessionId, 2),
        [eventItem(terminal)],
      ),
    ).toThrow(
      /refusing to append run_reopened for inflight-label: terminal epoch 1 is not yet a complete line in the journal \(degraded\)/,
    );
  });

  it("refuses a reopen while the sealing terminal is only in the degraded queue", () => {
    const sessionId = "degraded-terminal-reopen";
    const terminal = terminalEvent(sessionId, 1, 1);
    expect(() =>
      assertRunLifecycleAppendOrder(
        Buffer.alloc(0),
        [],
        reopenEvent(sessionId, 2),
        [eventItem(terminal)],
      ),
    ).toThrow(
      /refusing to append run_reopened for degraded-terminal-reopen: terminal epoch 1 is not yet a complete line in the journal \(degraded\)/,
    );
  });

  it("does not append a reopen ahead of a terminal that is only queued after ENOSPC", () => {
    const cwd = freshCwd();
    const sessionId = "enospc-reopen-after-terminal";
    const store = openStore({ cwd, sessionId });
    try {
      store.store.setWriteImplForTest(() => {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      });
      expect(
        store.append(terminalEvent(sessionId, 1, 1), { durable: true }),
      ).toBe(false);
      expect(store.store.isDegraded).toBe(true);
      expect(countTerminals(readFileSync(store.rolloutPath))).toBe(0);

      store.store.setWriteImplForTest(writeSync);
      const before = readFileSync(store.rolloutPath);
      const beforeHash = sha256(before);
      expect(() =>
        store.append(reopenEvent(sessionId, 2), { durable: true }),
      ).toThrow(
        /refusing to append run_reopened for enospc-reopen-after-terminal: terminal epoch 1 is not yet a complete line in the journal \(degraded\)/,
      );
      const after = readFileSync(store.rolloutPath);
      expect(after).toEqual(before);
      expect(sha256(after)).toBe(beforeHash);
    } finally {
      store.close();
    }
    const drained = readFileSync(store.rolloutPath);
    const drainedHash = sha256(drained);
    const drainedText = drained.toString("utf8");
    const drainedTerminalAt = drainedText.indexOf('"type":"run_terminal"');
    expect(drainedTerminalAt).toBeGreaterThanOrEqual(0);
    expect(drainedText.indexOf('"type":"run_reopened"')).toBe(-1);
    expect(drainedText.endsWith("\n")).toBe(true);
    const terminalLine = drainedText
      .split("\n")
      .find((line) => line.includes('"type":"run_terminal"'));
    expect(terminalLine).toBeDefined();
    expect(JSON.parse(terminalLine!).payload.msg.type).toBe("run_terminal");

    // The queued terminal is durable only after the store drains it. The
    // real reopen path then commits run_reopened after that line.
    const resumed = openStore({
      cwd,
      sessionId,
      resume: true,
      reopenTerminalRun: true,
    });
    try {
      const committed = readFileSync(resumed.rolloutPath);
      const text = committed.toString("utf8");
      const terminalAt = text.indexOf('"type":"run_terminal"');
      const reopenAt = text.indexOf('"type":"run_reopened"');
      expect(terminalAt).toBeGreaterThanOrEqual(0);
      expect(reopenAt).toBeGreaterThan(terminalAt);
      expect(committed.subarray(0, drained.length)).toEqual(drained);
      expect(sha256(committed.subarray(0, drained.length))).toBe(drainedHash);
      const reopenLine = text
        .split("\n")
        .find((line) => line.includes('"type":"run_reopened"'));
      expect(reopenLine).toBeDefined();
      expect(text.endsWith("\n")).toBe(true);
    } finally {
      resumed.close();
    }
  });

  it("does not append an epoch-2 terminal ahead of a queued epoch-1 terminal and reopen", () => {
    const cwd = freshCwd();
    const sessionId = "queued-epoch-chain";
    const store = openStore({ cwd, sessionId });
    try {
      const queue = degradedQueue(store);
      queue.enterDegraded("test");
      queue.append(eventItem(terminalEvent(sessionId, 1, 1)));
      queue.append(eventItem(reopenEvent(sessionId, 2)));
      const before = readFileSync(store.rolloutPath);
      const beforeHash = sha256(before);
      expect(() =>
        store.append(terminalEvent(sessionId, 2, 3), { durable: true }),
      ).toThrow(
        /refusing to append run_terminal for queued-epoch-chain: epoch 2 is not active until its clearing reopen is a complete line in the journal \(seal degraded, reopen degraded\)/,
      );
      const after = readFileSync(store.rolloutPath);
      expect(after).toEqual(before);
      expect(sha256(after)).toBe(beforeHash);
    } finally {
      store.close();
    }
    const drained = readFileSync(store.rolloutPath, "utf8");
    const terminalAt = drained.indexOf('"type":"run_terminal"');
    const reopenAt = drained.indexOf('"type":"run_reopened"');
    expect(terminalAt).toBeGreaterThanOrEqual(0);
    expect(reopenAt).toBeGreaterThan(terminalAt);
    expect(drained.indexOf('"type":"run_terminal"', reopenAt)).toBe(-1);
    expect(countTerminals(Buffer.from(drained))).toBe(1);
  });

  it("refuses a distinct terminal while the first is in the degraded in-flight slice", async () => {
    const cwd = freshCwd();
    const sessionId = "inflight-distinct-terminal";
    const store = openStore({ cwd, sessionId });
    try {
      store.store.setWriteImplForTest(() => {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      });
      const first = terminalEvent(sessionId, 1, 1);
      expect(store.append(first, { durable: true })).toBe(false);
      expect(store.store.isDegraded).toBe(true);
      const before = readFileSync(store.rolloutPath);
      const beforeHash = sha256(before);
      let refusal: unknown;
      let entered = false;
      store.store.setWriteImplForTest((fd, buffer, offset, length) => {
        if (!entered) {
          entered = true;
          expect(readFileSync(store.rolloutPath)).toEqual(before);
          try {
            store.append(
              withFinalMessage(terminalEvent(sessionId, 1, 2), "a second outcome"),
              { durable: true },
            );
          } catch (error) {
            refusal = error;
          }
          expect(readFileSync(store.rolloutPath)).toEqual(before);
        }
        return writeSync(fd, buffer, offset, length);
      });
      await degradedQueue(store).tryFlush();
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toMatch(
        /already sealed by a different terminal \(eventId run-terminal:inflight-distinct-terminal:1, seq 1, inflight\)/,
      );
      const after = readFileSync(store.rolloutPath);
      expect(sha256(before)).toBe(beforeHash);
      expect(countTerminals(after)).toBe(1);
      expect(after.toString("utf8")).toContain('"finalMessage":"done"');
      expect(after.toString("utf8")).not.toContain("a second outcome");
    } finally {
      store.store.setWriteImplForTest(writeSync);
      store.close();
    }
  });

  it("rejects a journal whose clearing reopen precedes the terminal", () => {
    const sessionId = "validator-order";
    const terminal = journalLine(terminalEvent(sessionId, 1, 1));
    const reopen = journalLine(reopenEvent(sessionId, 2));
    const reopenFirst = journalLine(reopenEvent(sessionId, 1));
    const stale = journalLine(terminalEvent(sessionId, 1, 3, "stale-terminal"));
    expect(validateCanonicalJournalText(`${terminal}${reopen}`)).toMatchObject({
      activeEpoch: 2,
      activeLifecycleState: "open",
    });
    expect(() => validateCanonicalJournalText(reopenFirst)).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
    expect(() =>
      validateCanonicalJournalText(`${terminal}${reopen}${stale}`),
    ).toThrow(
      expect.objectContaining({ reasonCode: "terminal_binding_mismatch" }),
    );
  });
});

function freshCwd(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-lifecycle-order-"));
  roots.push(root);
  return root;
}

function openStore(opts: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly resume?: boolean;
  readonly reopenTerminalRun?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    agencHome: opts.cwd,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    sessionTempRoot: join(opts.cwd, "rollout-temp"),
    ...(opts.resume === true ? { resume: true } : {}),
    ...(opts.reopenTerminalRun === true ? { reopenTerminalRun: true } : {}),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: "2026-08-19T00:00:00.000Z",
    cwd: opts.cwd,
    originator: "lifecycle-order-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function terminalEvent(
  sessionId: string,
  epoch: number,
  seq: number,
  eventId = `run-terminal:${sessionId}:${epoch}`,
): Event {
  return {
    eventId,
    id: eventId,
    seq,
    msg: {
      type: "run_terminal",
      payload: {
        runId: sessionId,
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

function reopenEvent(sessionId: string, seq: number): Event {
  return {
    eventId: `run-reopened:${sessionId}:2`,
    id: `run-reopened:${sessionId}:2`,
    seq,
    msg: {
      type: "run_reopened",
      payload: {
        runId: sessionId,
        previousEpoch: 1,
        epoch: 2,
        reason: "user_session_continue",
        reopenedAt: "2026-08-19T00:00:01.000Z",
      },
    },
  };
}

function withFinalMessage(event: Event, finalMessage: string): Event {
  if (event.msg.type !== "run_terminal") throw new Error("not a terminal");
  return {
    ...event,
    msg: { ...event.msg, payload: { ...event.msg.payload, finalMessage } },
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function countTerminals(bytes: Buffer): number {
  return bytes.toString("utf8").split('"type":"run_terminal"').length - 1;
}

function eventItem(event: Event): RolloutItem {
  return { type: "event_msg", payload: event };
}

function degradedQueue(store: RolloutStore): {
  enterDegraded(reason: string): void;
  append(item: RolloutItem): void;
  tryFlush(): Promise<boolean>;
} {
  return (
    store.store as unknown as {
      degraded: {
        enterDegraded(reason: string): void;
        append(item: RolloutItem): void;
        tryFlush(): Promise<boolean>;
      };
    }
  ).degraded;
}

function journalLine(event: Event): string {
  return serializeRolloutItem(eventItem(event));
}
