/**
 * A second `commitDurableRunTerminal` after the journal write landed must
 * return that journal event. It must not stamp a new sequence.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});

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
