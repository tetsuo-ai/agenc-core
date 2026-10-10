/**
 * Close's drain is what makes a queued terminal projectable. A failed
 * fsync must not leave a complete line for SQLite to adopt, and a drain
 * must wait for an in-flight flush before it decides the buffer is empty.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionStore } from "./session-store.js";
import type { RolloutItem } from "./rollout-item.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("close drain commitment", () => {
  test("a failed fsync does not leave a projectable terminal and does not stick shutdown", () => {
    const store = openStore("close-fsync-rollback");
    const item = terminalItem("close-fsync-rollback");
    const degraded = degradedOf(store);
    degraded.enterDegraded("ENOSPC during append");
    degraded.append(item);
    const before = readFileSync(store.rolloutPath);
    store.setFsyncImplForTest(() => {
      throw Object.assign(new Error("fsync failed"), { code: "EIO" });
    });

    expect(() => store.close()).toThrow(/not fsync-committed/);

    const after = readFileSync(store.rolloutPath);
    expect(after).toEqual(before);
    expect(after.toString("utf8")).not.toContain("run-terminal:close-fsync-rollback:1");
    const diagnostics = store.drainBufferedDiagnostics();
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.cause === "fsync_failed" &&
          diagnostic.message.includes("not committed"),
      ),
    ).toBe(true);
    expect(() => store.close()).not.toThrow();
  });

  test("close waits for an in-flight flush before writing the requeued terminal", async () => {
    const store = openStore("close-inflight-requeue");
    const item = terminalItem("close-inflight-requeue");
    const degraded = degradedOf(store);
    degraded.enterDegraded("ENOSPC during append");
    degraded.append(item);

    let releaseFlush!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    degraded.flushFn = async () => {
      await gate;
      return false;
    };

    const flushing = degraded.tryFlush();
    const closed = store.close();
    expect(closed).toBeInstanceOf(Promise);

    let closeSettled = false;
    void Promise.resolve(closed).finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(readFileSync(store.rolloutPath, "utf8")).not.toContain(
      "run-terminal:close-inflight-requeue:1",
    );

    releaseFlush();
    await flushing;
    await closed;
    expect(closeSettled).toBe(true);

    const onDisk = readFileSync(store.rolloutPath, "utf8");
    expect(onDisk.split('"type":"run_terminal"').length - 1).toBe(1);
  });

  test("close does not write a second copy of a terminal an in-flight flush already committed", async () => {
    const store = openStore("close-inflight-committed");
    const item = terminalItem("close-inflight-committed");
    const degraded = degradedOf(store);
    degraded.enterDegraded("ENOSPC during append");
    degraded.append(item);

    let releaseFlush!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const original = degraded.flushFn;
    degraded.flushFn = async (events) => {
      await gate;
      return original(events);
    };

    const flushing = degraded.tryFlush();
    const closed = store.close();
    expect(closed).toBeInstanceOf(Promise);
    releaseFlush();
    await flushing;
    await closed;

    const onDisk = readFileSync(store.rolloutPath, "utf8");
    expect(onDisk.split('"type":"run_terminal"').length - 1).toBe(1);
  });
});

function openStore(sessionId: string): SessionStore {
  const home = mkdtempSync(join(tmpdir(), "agenc-close-drain-"));
  roots.push(home);
  const store = new SessionStore({
    cwd: home,
    sessionId,
    agencVersion: "0.2.0",
    agencHome: home,
  });
  store.open({
    sessionId,
    timestamp: "2026-08-19T00:00:00.000Z",
    cwd: home,
    originator: "close-drain-test",
    agencVersion: "0.2.0",
  });
  return store;
}

function degradedOf(store: SessionStore): {
  enterDegraded(reason: string): void;
  append(item: RolloutItem): void;
  tryFlush(): Promise<boolean>;
  flushFn: (events: readonly RolloutItem[]) => Promise<boolean>;
} {
  return (
    store as unknown as {
      degraded: {
        enterDegraded(reason: string): void;
        append(item: RolloutItem): void;
        tryFlush(): Promise<boolean>;
        flushFn: (events: readonly RolloutItem[]) => Promise<boolean>;
      };
    }
  ).degraded;
}

function terminalItem(runId: string): RolloutItem {
  const eventId = `run-terminal:${runId}:1`;
  return {
    type: "event_msg",
    payload: {
      eventId,
      id: eventId,
      seq: 1,
      msg: {
        type: "run_terminal",
        payload: {
          runId,
          epoch: 1,
          status: "completed",
          exitCode: 0,
          stopReason: "turn_completed",
          finalMessage: "done",
          usage: null,
          lastSequenceBeforeTerminal: null,
          finishedAt: "2026-08-19T00:00:00.000Z",
        },
      },
    },
  };
}
