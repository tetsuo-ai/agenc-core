import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgenCSessionSnapshotPolicy } from "../../src/state/snapshot-policy.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

// Regression guard for the unbounded in-memory #sessions leak:
// `flushPeriodic()` emits exactly one snapshot record per session retained in
// the in-memory map, so its length is a faithful probe of map size. Before the
// fix there was no eviction path at all (no forgetSession, no LRU cap), so the
// map grew one entry per distinct sessionId forever and flushPeriodic
// re-snapshotted every session ever seen.

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-snapshot-eviction-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-snapshot-eviction-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function touch(policy: AgenCSessionSnapshotPolicy, sessionId: string): void {
  // Any public entry point funnels through #session and creates an in-memory
  // SessionSnapshotState; recordSessionEvent is the production hot path.
  policy.recordSessionEvent(sessionId, {
    method: "event.message_chunk",
    params: {
      agentId: sessionId,
      delta: "x",
      messageId: `${sessionId}-m`,
      streamId: `${sessionId}-s`,
      eventId: `${sessionId}-e`,
    },
  });
}

describe("AgenCSessionSnapshotPolicy in-memory session eviction", () => {
  it("forgetSession removes the session from the in-memory map", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver, { agencHome: home });

    touch(policy, "session-a");
    touch(policy, "session-b");
    touch(policy, "session-c");

    expect(periodicSessionIds(policy)).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);

    policy.forgetSession("session-b");

    // The forgotten session must no longer be re-snapshotted by flushPeriodic.
    // If forgetSession is reverted to a no-op (or removed), it stays retained.
    expect(periodicSessionIds(policy)).toEqual(["session-a", "session-c"]);
  });

  it("caps the in-memory map and evicts least-recently-touched sessions", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: home,
      maxTrackedSessions: 3,
    });

    // Touch four distinct sessions. Without the LRU cap the map would hold all
    // four (and flushPeriodic would re-snapshot all four) — the unbounded leak.
    touch(policy, "old-1");
    touch(policy, "old-2");
    touch(policy, "old-3");
    touch(policy, "new-4");

    const retained = periodicSessionIds(policy);

    // Cap is honored: never more than maxTrackedSessions retained.
    expect(retained.length).toBe(3);
    // The least-recently-touched session ("old-1") was evicted; the most recent
    // ("new-4") is kept. Reverting the cap/eviction retains all four and fails.
    expect(retained).not.toContain("old-1");
    expect(retained).toContain("new-4");
  });

  it("keeps recently re-touched sessions when evicting under the cap", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: home,
      maxTrackedSessions: 2,
    });

    touch(policy, "s1");
    touch(policy, "s2");
    // Re-touch s1 so it becomes more recent than s2.
    touch(policy, "s1");
    // Adding s3 must evict the now-least-recent s2, not s1.
    touch(policy, "s3");

    const retained = periodicSessionIds(policy);
    expect(retained.length).toBe(2);
    expect(retained).toContain("s1");
    expect(retained).toContain("s3");
    expect(retained).not.toContain("s2");
  });
});

function periodicSessionIds(policy: AgenCSessionSnapshotPolicy): string[] {
  return policy
    .flushPeriodic()
    .map((record) => record.sessionId)
    .sort();
}
