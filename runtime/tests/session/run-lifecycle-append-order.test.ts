import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function eventItem(event: Event): RolloutItem {
  return { type: "event_msg", payload: event };
}

function journalLine(event: Event): string {
  return serializeRolloutItem(eventItem(event));
}
