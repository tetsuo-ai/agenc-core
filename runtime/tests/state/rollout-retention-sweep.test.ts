import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "../session/event-log.js";
import { serializeRolloutItem } from "../session/rollout-item.js";
import { backfillProjectRollouts } from "./backfill.js";
import { pruneRolloutSessions } from "./pruning.js";
import { AgenCSessionSnapshotPolicy } from "./snapshot-policy.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;

const NOW = "2026-06-04T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-retention-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-retention-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
});

afterEach(() => {
  driver.close();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Write a single-message rollout JSONL for `sessionId` into its session dir,
 * stamp its mtime `ageDays` in the past, and index it into the SQLite mirror.
 * Returns the rollout file path so callers can assert on it.
 */
function seedSession(sessionId: string, ageDays: number): string {
  const sessionDir = join(driver.projectDir, "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = join(
    sessionDir,
    `rollout-2026-01-01T00-00-00-000Z-${sessionId}.jsonl`,
  );
  writeFileSync(
    rolloutPath,
    serializeRolloutItem({
      type: "session_meta",
      payload: {
        sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
        originator: "test",
        agencVersion: "0.2.0",
        rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
        model: "grok-4",
        modelProvider: "xai",
      },
    }) +
      serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "hello" },
      }),
  );
  // Index the file into thread_rollout_items / backfill_files / rollout_receipts.
  backfillProjectRollouts({ projectDir: driver.projectDir, driver });
  // Stamp mtime in the past so the age gate is exercised deterministically.
  const when = new Date(NOW_MS - ageDays * DAY_MS);
  utimesSync(rolloutPath, when, when);
  return rolloutPath;
}

function mirrorRowCount(): number {
  return (
    driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items",
      )
      .get()?.count ?? -1
  );
}

function mirrorRowCountForSource(sourcePath: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items WHERE source_path = ?",
      )
      .get(sourcePath)?.count ?? -1
  );
}

describe("pruneRolloutSessions", () => {
  it("deletes an old session + its mirror rows, keeps recent and active", () => {
    const oldPath = seedSession("thread-old", 60); // older than the window
    const recentPath = seedSession("thread-recent", 5); // inside the window
    const activePath = seedSession("thread-active", 90); // old but live

    const sessionsDir = join(driver.projectDir, "sessions");
    // Each seeded rollout indexes 2 items → 6 mirror rows total.
    expect(mirrorRowCount()).toBe(6);

    const report = pruneRolloutSessions(driver, {
      sessionsDir,
      retention_days: 30,
      activeSessionId: "thread-active",
      now: () => NOW,
    });

    // Only the old, non-active session is pruned.
    expect(report.prunedSessions).toBe(1);
    expect(report.prunedSessionIds).toEqual(["thread-old"]);
    expect(report.prunedRolloutFiles).toBe(1);
    expect(report.prunedMirrorRows).toBe(2);

    // Old session: file gone, dir gone, mirror rows gone.
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(sessionsDir, "thread-old"))).toBe(false);
    expect(mirrorRowCountForSource(oldPath)).toBe(0);

    // Recent and active sessions: untouched on disk and in the mirror.
    expect(existsSync(recentPath)).toBe(true);
    expect(existsSync(activePath)).toBe(true);
    expect(mirrorRowCountForSource(recentPath)).toBe(2);
    expect(mirrorRowCountForSource(activePath)).toBe(2);
    expect(mirrorRowCount()).toBe(4);
  });

  it("deletes nothing when no retention window is configured", () => {
    const oldPath = seedSession("thread-old", 365);
    const sessionsDir = join(driver.projectDir, "sessions");
    expect(mirrorRowCount()).toBe(2);

    const report = pruneRolloutSessions(driver, {
      sessionsDir,
      // retention_days intentionally unset → sweep disabled (conservative).
      now: () => NOW,
    });

    expect(report.prunedSessions).toBe(0);
    expect(report.prunedSessionIds).toEqual([]);
    expect(existsSync(oldPath)).toBe(true);
    expect(mirrorRowCount()).toBe(2);
  });

  it("treats retention_days: 0 as disabled, not 'delete everything'", () => {
    // The config validator accepts 0 (shared non-negative-days rule). A user
    // setting 0 means "off"; it must NOT resolve to cutoff=now and nuke every
    // non-active session. Guards rolloutCutoffMs's `days <= 0 → disabled`.
    const oldPath = seedSession("thread-old", 365);
    const sessionsDir = join(driver.projectDir, "sessions");
    expect(mirrorRowCount()).toBe(2);

    const report = pruneRolloutSessions(driver, {
      sessionsDir,
      retention_days: 0,
      now: () => NOW,
    });

    expect(report.prunedSessions).toBe(0);
    expect(report.prunedSessionIds).toEqual([]);
    expect(existsSync(oldPath)).toBe(true);
    expect(mirrorRowCount()).toBe(2);
  });

  it("never prunes a session whose rollout lock is held by a live process", () => {
    // Daemon shares the sessions dir with live foreground processes. An old,
    // non-active session that is still OPEN (lock held by a live pid) must not
    // be removed out from under the live writer. Guards sessionHasLiveRolloutLock.
    const lockedPath = seedSession("thread-locked", 90); // old + non-active
    // Write the rollout lock held by THIS (live) process, matching SessionLock's
    // `<rolloutPath>.lock` JSON shape.
    writeFileSync(
      `${lockedPath}.lock`,
      JSON.stringify({
        pid: process.pid,
        startNs: "0",
        acquiredAtIso: "2026-01-01T00:00:00.000Z",
      }),
    );
    const sessionsDir = join(driver.projectDir, "sessions");

    const report = pruneRolloutSessions(driver, {
      sessionsDir,
      retention_days: 30,
      now: () => NOW,
    });

    expect(report.prunedSessions).toBe(0);
    expect(report.prunedSessionIds).toEqual([]);
    expect(existsSync(lockedPath)).toBe(true);
    expect(mirrorRowCountForSource(lockedPath)).toBe(2);
  });
});

describe("AgenCSessionSnapshotPolicy rollout sweep timer", () => {
  it("prunes old sessions on the throttled periodic tick, sparing the active one", () => {
    const oldPath = seedSession("thread-old", 60);
    const activePath = seedSession("thread-active", 90);
    const sessionsDir = join(driver.projectDir, "sessions");

    let tick: (() => void) | undefined;
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => NOW,
      rolloutRetention: { retention_days: 30 },
      rolloutSessionsDir: sessionsDir,
      activeSessionId: "thread-active",
      setInterval: (callback, intervalMs) => {
        // Throttled daemon timer, not a tight loop.
        expect(intervalMs).toBe(30_000);
        tick = callback;
        return { unref: vi.fn() };
      },
      clearInterval: vi.fn(),
    });

    policy.startPeriodic();
    expect(tick).toBeDefined();
    // No sweep until the timer fires.
    expect(existsSync(oldPath)).toBe(true);

    tick?.();
    policy.stopPeriodic();

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(activePath)).toBe(true);
    expect(mirrorRowCountForSource(oldPath)).toBe(0);
    expect(mirrorRowCountForSource(activePath)).toBe(2);
  });

  it("never sweeps when no rollout retention window is configured", () => {
    const oldPath = seedSession("thread-old", 365);
    const sessionsDir = join(driver.projectDir, "sessions");

    let tick: (() => void) | undefined;
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => NOW,
      // rolloutRetention intentionally unset → disabled.
      rolloutSessionsDir: sessionsDir,
      setInterval: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
      clearInterval: vi.fn(),
    });

    policy.startPeriodic();
    tick?.();
    policy.stopPeriodic();

    expect(existsSync(oldPath)).toBe(true);
    expect(mirrorRowCount()).toBe(2);
  });
});
