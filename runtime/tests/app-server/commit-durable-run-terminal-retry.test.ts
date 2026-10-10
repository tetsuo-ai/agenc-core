/**
 * A second `commitDurableRunTerminal` after the journal write landed must
 * return that journal event. It must not stamp a new sequence.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commitDurableRunTerminal } from "../../src/app-server/background-agent-runner/turn-lifecycle.js";
import type { RunTerminalResult } from "../../src/contracts/run-contracts.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";

describe("commitDurableRunTerminal retry", () => {
  let root: string;
  let store: RolloutStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the journal terminal instead of minting another event", () => {
    root = mkdtempSync(join(tmpdir(), "agenc-durable-terminal-retry-"));
    const cwd = join(root, "repo");
    mkdirSync(cwd);
    const runId = "durable-terminal-retry";
    store = new RolloutStore({
      cwd,
      agencHome: join(root, "home"),
      sessionId: runId,
      agencVersion: "0.2.0",
      sessionTempRoot: join(root, "tmp"),
    });
    store.open({
      cwd,
      sessionId: runId,
      timestamp: "2026-08-19T00:00:00.000Z",
      originator: "terminal-retry",
      agencVersion: "0.2.0",
      model: "test-model",
      modelProvider: "test-provider",
    });
    const eventLog = new EventLog();
    const rollout = store;
    const active = {
      startedAt: "2026-08-19T00:00:00.000Z",
      runEpoch: 1,
      bootstrap: {
        rolloutStore: rollout,
        session: {
          eventLog,
          emit(input: Event): Event {
            const stamped = eventLog.stamp(input);
            const committed = rollout.append(stamped, { durable: true });
            if (!committed) {
              throw new Error(
                `durable event ${stamped.msg.type} was not fsync-committed`,
              );
            }
            return stamped;
          },
        },
      },
    };

    const first = terminalResult("2026-08-19T00:00:01.000Z", "original");
    const snapshot = commitDurableRunTerminal(active as never, runId, first);
    const before = readFileSync(rollout.rolloutPath);
    active.terminal = undefined;

    const retry = commitDurableRunTerminal(
      active as never,
      runId,
      terminalResult("2026-08-19T00:00:02.000Z", "retried"),
    );
    expect(readFileSync(rollout.rolloutPath)).toEqual(before);
    expect(retry.eventId).toBe(snapshot.eventId);
    expect(retry.epoch).toBe(snapshot.epoch);
    expect(retry.result).toEqual(snapshot.result);
    expect(retry.result.finishedAt).toBe("2026-08-19T00:00:01.000Z");
    expect(retry.result.finalMessage).toBe("original");
    expect(retry.result.lastSequence).toBe(snapshot.result.lastSequence);
    const line = before
      .toString("utf8")
      .split("\n")
      .find((entry) => entry.includes('"type":"run_terminal"'));
    const event = JSON.parse(line!).payload as Event;
    expect(event.eventId).toBe(retry.eventId);
    expect(event.id).toBe(retry.eventId);
    expect(event.seq).toBe(retry.result.lastSequence);
    expect(event.msg.type === "run_terminal" && event.msg.payload.finishedAt).toBe(
      retry.result.finishedAt,
    );
  });

  it("does not stamp a second terminal while the first is queued after ENOSPC", () => {
    root = mkdtempSync(join(tmpdir(), "agenc-durable-terminal-queued-"));
    const cwd = join(root, "repo");
    mkdirSync(cwd);
    const runId = "durable-terminal-queued";
    store = new RolloutStore({
      cwd,
      agencHome: join(root, "home"),
      sessionId: runId,
      agencVersion: "0.2.0",
      sessionTempRoot: join(root, "tmp"),
    });
    store.open({
      cwd,
      sessionId: runId,
      timestamp: "2026-08-19T00:00:00.000Z",
      originator: "terminal-retry",
      agencVersion: "0.2.0",
      model: "test-model",
      modelProvider: "test-provider",
    });
    const eventLog = new EventLog();
    const rollout = store;
    let failTerminal = true;
    rollout.store.setWriteImplForTest((fd, buffer, offset, length) => {
      const text = Buffer.from(buffer).toString("utf8");
      if (failTerminal && text.includes('"type":"run_terminal"')) {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      }
      return writeSync(fd, buffer, offset, length);
    });
    const active = {
      startedAt: "2026-08-19T00:00:00.000Z",
      runEpoch: 1,
      bootstrap: {
        rolloutStore: rollout,
        session: {
          eventLog,
          emit(input: Event): Event {
            const stamped = eventLog.stamp(input);
            const committed = rollout.append(stamped, { durable: true });
            if (!committed) {
              throw new Error(
                `durable event ${stamped.msg.type} was not fsync-committed`,
              );
            }
            return stamped;
          },
        },
      },
    };
    const result = terminalResult("2026-08-19T00:00:01.000Z", "original");
    expect(() =>
      commitDurableRunTerminal(active as never, runId, result),
    ).toThrow(/was not fsync-committed/);
    const seqAfterQueue = eventLog.lastSeq;
    const before = readFileSync(rollout.rolloutPath);
    expect(countQueuedTerminals(before)).toBe(0);
    expect(() =>
      commitDurableRunTerminal(
        active as never,
        runId,
        terminalResult("2026-08-19T00:00:02.000Z", "retried"),
      ),
    ).toThrow(/was not fsync-committed/);
    expect(eventLog.lastSeq).toBe(seqAfterQueue);
    expect(readFileSync(rollout.rolloutPath)).toEqual(before);

    failTerminal = false;
    rollout.store.setWriteImplForTest(writeSync);
    rollout.close();
    store = undefined;
    const drained = readFileSync(rollout.rolloutPath);
    const lines = drained
      .toString("utf8")
      .split("\n")
      .filter((line) => line.includes('"type":"run_terminal"'));
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!).payload as Event;
    expect(event.msg.type === "run_terminal" && event.msg.payload.finalMessage).toBe(
      "original",
    );
    expect(event.msg.type === "run_terminal" && event.msg.payload.finishedAt).toBe(
      "2026-08-19T00:00:01.000Z",
    );
    expect(event.seq).toBe(seqAfterQueue);
  });
});

function countQueuedTerminals(bytes: Buffer): number {
  return bytes.toString("utf8").split('"type":"run_terminal"').length - 1;
}

function terminalResult(finishedAt: string, finalMessage: string): RunTerminalResult {
  return {
    runId: "durable-terminal-retry",
    status: "failed",
    exitCode: 1,
    stopReason: "session_shutdown",
    finalMessage,
    usage: null,
    lastSequence: null,
    finishedAt,
  };
}
