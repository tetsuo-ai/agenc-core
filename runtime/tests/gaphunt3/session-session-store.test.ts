import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "src/session/session-store";
import { serializeRolloutItem, type RolloutItem } from "src/session/rollout-item";

/**
 * gaphunt3 #19 — SessionStore.close() must perform a final best-effort
 * drain of the degraded ring buffer before stopping its retry timer.
 *
 * Scenario the finding describes: a filesystem failure (I-12 ENOSPC/…)
 * pushed durable rollout items into the DegradedStore ring buffer via
 * the requeue=true path (bytes never reached disk). The disk then
 * recovers, but the session is closed BEFORE the 30s degraded retry
 * tick fires. Without a final drain those buffered durable events are
 * silently lost. With the fix, close() drains them and writes them to
 * the rollout file.
 */
describe("gaphunt3 #19 — SessionStore.close drains degraded buffer", () => {
  let home = "";
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-gaphunt3-19-"));
    origHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = home;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = origHome;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function openStore(sessionId: string): SessionStore {
    const store = new SessionStore({
      cwd: "/home/test-gaphunt3-19",
      sessionId,
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: "/home/test-gaphunt3-19",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    return store;
  }

  test("close() flushes buffered durable events to disk when the disk recovered", () => {
    const store = openStore("sess-degraded-drain");

    // Simulate the post-ENOSPC state: the writeSync (requeue=true) path
    // entered degraded mode and parked durable events in the ring buffer
    // because the bytes never reached the file. (We seed the buffer via
    // the internal seam to model exactly that state without depending on
    // a real disk failure.)
    const buffered: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "buffered-1",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
      },
      {
        type: "event_msg",
        payload: {
          id: "buffered-2",
          seq: 2,
          msg: { type: "turn_complete", payload: { turnId: "t2" } },
        },
      },
    ];

    const degraded = (
      store as unknown as {
        degraded: {
          enterDegraded(reason: string): void;
          append(item: RolloutItem): void;
          readonly size: number;
        };
      }
    ).degraded;
    degraded.enterDegraded("ENOSPC during append");
    for (const item of buffered) degraded.append(item);
    expect(store.isDegraded).toBe(true);
    expect(degraded.size).toBe(buffered.length);

    // The disk is healthy again (no fsync/write impl override), and we
    // close BEFORE the 30s degraded retry tick would fire. The fix must
    // drain the buffer and persist the events.
    store.close();

    const onDisk = readFileSync(store.rolloutPath, "utf8");
    // Both buffered durable events must now be present on disk. Before
    // the fix close() only stops the retry timer, dropping the buffer,
    // so these ids never appear.
    expect(onDisk).toContain('"id":"buffered-1"');
    expect(onDisk).toContain('"id":"buffered-2"');

    // And the drained items must parse as the exact rollout rows.
    const lines = onDisk.trim().split("\n");
    const ids = lines
      .map((l) => JSON.parse(l) as { payload?: { id?: string } })
      .map((r) => r.payload?.id);
    expect(ids).toContain("buffered-1");
    expect(ids).toContain("buffered-2");
  });

  test("close() drained rows match the serialized degraded items byte-for-byte", () => {
    const store = openStore("sess-degraded-drain-bytes");

    const item: RolloutItem = {
      type: "event_msg",
      payload: {
        id: "buffered-only",
        seq: 1,
        msg: { type: "turn_complete", payload: { turnId: "only" } },
      },
    };
    const expectedLine = serializeRolloutItem(item).trim();

    const degraded = (
      store as unknown as {
        degraded: {
          enterDegraded(reason: string): void;
          append(item: RolloutItem): void;
        };
      }
    ).degraded;
    degraded.enterDegraded("ENOSPC during append");
    degraded.append(item);

    store.close();

    const lines = readFileSync(store.rolloutPath, "utf8").trim().split("\n");
    expect(lines).toContain(expectedLine);
  });
});
