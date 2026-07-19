import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCanonicalRunReplay } from "../../src/app-server/run-journal-replay.js";
import { ROLLOUT_SCHEMA_VERSION } from "../session/event-log.js";
import { serializeRolloutItem } from "../session/rollout-item.js";
import { RolloutStore } from "../session/rollout-store.js";
import { SessionLock, SessionLockedError } from "../session/session-store.js";
import { backfillProjectRollouts } from "./backfill.js";
import { pruneRolloutSessions } from "./pruning.js";
import { StateRunDurabilityRepository } from "./run-durability.js";
import { AgenCSessionSnapshotPolicy } from "./snapshot-policy.js";
import { recoverCanonicalRunJournalForRun } from "./startup-run-journal-recovery.js";
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

  it("retires a bound journal before removing its projection and rollout", () => {
    const runId = "thread-bound-old";
    const oldPath = seedSession(runId, 60);
    const runs = new StateRunDurabilityRepository(driver);
    runs.ensureInitialEpoch({ runId, openedAt: "2026-01-01T00:00:00.000Z" });
    runs.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: oldPath,
      firstAvailableSequence: 1,
      lastSequence: 2,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    driver.prepareState(
      `INSERT INTO agent_runs (
         id, objective, status, started_at, last_active_at, current_session_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "retention test",
      "completed",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      runId,
    );

    const report = pruneRolloutSessions(driver, {
      sessionsDir: join(driver.projectDir, "sessions"),
      retention_days: 30,
      now: () => NOW,
    });

    expect(report).toMatchObject({
      prunedSessions: 1,
      prunedRolloutFiles: 1,
      prunedMirrorRows: 2,
      prunedSessionIds: [runId],
    });
    expect(existsSync(oldPath)).toBe(false);
    expect(mirrorRowCountForSource(oldPath)).toBe(0);
    expect(runs.getJournalBinding(oldPath)).toMatchObject({
      active: false,
      lastSequence: 2,
      retiredThroughSequence: 2,
      gapReason: "retention",
      gapObservedAt: NOW,
    });
    expect(runs.getJournalBinding(oldPath)?.firstAvailableSequence).toBeUndefined();

    // Missing historical sources are valid after explicit retirement. Startup
    // recovery must not mistake this inactive binding for a lost active journal.
    expect(() => recoverCanonicalRunJournalForRun(driver, runId)).not.toThrow();
  });

  it("derives a missing retirement tail from canonical JSONL before deletion", () => {
    const runId = "thread-bound-without-projection";
    const oldPath = seedSession(runId, 60);
    appendFileSync(
      oldPath,
      serializeRolloutItem({
        type: "event_msg",
        payload: {
          eventId: "canonical-retained-event",
          id: "reusable-correlation",
          seq: 1,
          msg: {
            type: "user_message",
            payload: { message: "must become an explicit retention gap" },
          },
        },
      }),
    );
    const when = new Date(NOW_MS - 60 * DAY_MS);
    utimesSync(oldPath, when, when);

    const runs = new StateRunDurabilityRepository(driver);
    runs.ensureInitialEpoch({ runId, openedAt: "2026-01-01T00:00:00.000Z" });
    runs.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: oldPath,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    // Model the normal live-writer path: the binding exists, but no replay or
    // listing has populated bounds/the rebuildable SQLite mirror yet.
    driver
      .prepareState("DELETE FROM thread_rollout_items WHERE source_path = ?")
      .run(oldPath);

    expect(
      pruneRolloutSessions(driver, {
        sessionsDir: join(driver.projectDir, "sessions"),
        retention_days: 30,
        now: () => NOW,
      }),
    ).toMatchObject({ prunedSessions: 1, prunedMirrorRows: 0 });
    expect(runs.getJournalBinding(oldPath)).toMatchObject({
      active: false,
      lastSequence: 1,
      retiredThroughSequence: 1,
      gapReason: "retention",
    });
    expect(
      buildCanonicalRunReplay(
        driver.state,
        {
          projectDir: driver.projectDir,
          stateDbPath: driver.stateDbPath,
          logsDbPath: driver.logsDbPath,
        },
        runId,
        0,
        100,
      ),
    ).toMatchObject({
      events: [],
      nextAfterSequence: 0,
      lastAvailableSequence: 1,
      gap: {
        kind: "event_gap",
        afterSequence: 0,
        firstAvailableSequence: 2,
        reason: "retention",
      },
    });
  });

  it("never re-indexes an explicitly retired source that still exists", () => {
    const runId = "thread-retired-present";
    const sourcePath = seedSession(runId, 60);
    const runs = new StateRunDurabilityRepository(driver);
    runs.ensureInitialEpoch({ runId, openedAt: "2026-01-01T00:00:00.000Z" });
    runs.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath,
      firstAvailableSequence: 1,
      lastSequence: 2,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    driver.prepareState(
      `INSERT INTO agent_runs (
         id, objective, status, started_at, last_active_at, current_session_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "retired source recovery test",
      "completed",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      runId,
    );
    runs.retireJournalSource({
      sourcePath,
      reason: "retention",
      observedAt: NOW,
    });
    driver
      .prepareState("DELETE FROM thread_rollout_items WHERE source_path = ?")
      .run(sourcePath);

    expect(existsSync(sourcePath)).toBe(true);
    expect(recoverCanonicalRunJournalForRun(driver, runId)).toMatchObject({
      filesScanned: 0,
      eventsProjected: 0,
    });
    expect(mirrorRowCountForSource(sourcePath)).toBe(0);
  });

  it("refuses to revive a retired source when retention leaves it in place", () => {
    const runId = "thread-retired-reopen";
    const sourcePath = seedSession(runId, 60);
    const runs = new StateRunDurabilityRepository(driver);
    runs.ensureInitialEpoch({ runId, openedAt: "2026-01-01T00:00:00.000Z" });
    runs.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath,
      lastSequence: 2,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    runs.retireJournalSource({
      sourcePath,
      reason: "retention",
      observedAt: NOW,
    });

    const resumed = new RolloutStore({
      cwd,
      sessionId: runId,
      agencVersion: "0.6.2",
      resume: true,
      autoStartScheduler: false,
    });
    try {
      expect(() =>
        resumed.open({
          sessionId: runId,
          timestamp: NOW,
          cwd,
          originator: "retention-test",
          agencVersion: "0.6.2",
        }),
      ).toThrow(/refusing to reopen inactive canonical journal source/);
    } finally {
      resumed.close();
    }
    expect(existsSync(sourcePath)).toBe(true);
  });

  it("rebuilds inactive historical bindings that were superseded, not retired", () => {
    const runId = "thread-superseded-source";
    const historicalPath = seedSession(runId, 60);
    const currentPath = join(
      join(driver.projectDir, "sessions", runId),
      `rollout-2026-02-01T00-00-00-000Z-${runId}.jsonl`,
    );
    writeFileSync(currentPath, readFileSync(historicalPath));

    const runs = new StateRunDurabilityRepository(driver);
    runs.ensureInitialEpoch({ runId, openedAt: "2026-01-01T00:00:00.000Z" });
    runs.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: historicalPath,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    runs.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: currentPath,
      boundAt: "2026-02-01T00:00:00.000Z",
    });
    expect(runs.getJournalBinding(historicalPath)).toMatchObject({ active: false });
    expect(runs.getJournalBinding(historicalPath)?.gapReason).toBeUndefined();
    driver.prepareState(
      `INSERT INTO agent_runs (
         id, objective, status, started_at, last_active_at, current_session_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "superseded binding recovery test",
      "running",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      runId,
    );
    driver
      .prepareState("DELETE FROM thread_rollout_items WHERE source_path = ?")
      .run(historicalPath);
    expect(mirrorRowCountForSource(historicalPath)).toBe(0);

    expect(recoverCanonicalRunJournalForRun(driver, runId)).toMatchObject({
      filesScanned: 2,
    });
    expect(mirrorRowCountForSource(historicalPath)).toBe(2);
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

  it("defers retention when a writer wins the lease race after observation", () => {
    const rolloutPath = seedSession("thread-lock-race", 90);
    const acquire = vi
      .spyOn(SessionLock.prototype, "acquire")
      .mockImplementationOnce(() => {
        throw new SessionLockedError(process.pid, `${rolloutPath}.lock`);
      });
    try {
      expect(
        pruneRolloutSessions(driver, {
          sessionsDir: join(driver.projectDir, "sessions"),
          retention_days: 30,
          now: () => NOW,
        }),
      ).toMatchObject({ prunedSessions: 0, prunedMirrorRows: 0 });
      expect(existsSync(rolloutPath)).toBe(true);
      expect(mirrorRowCountForSource(rolloutPath)).toBe(2);
    } finally {
      acquire.mockRestore();
    }
  });

  it("skips the whole session when any canonical rollout sibling is corrupt", () => {
    const sessionId = "thread-corrupt-sibling";
    const rolloutPath = seedSession(sessionId, 90);
    const corruptPath = join(
      driver.projectDir,
      "sessions",
      sessionId,
      `rollout-2026-01-02T00-00-00-000Z-${sessionId}.jsonl`,
    );
    writeFileSync(corruptPath, "{ not valid canonical json }\n");
    const when = new Date(NOW_MS - 90 * DAY_MS);
    utimesSync(corruptPath, when, when);

    expect(
      pruneRolloutSessions(driver, {
        sessionsDir: join(driver.projectDir, "sessions"),
        retention_days: 30,
        now: () => NOW,
      }),
    ).toMatchObject({ prunedSessions: 0, prunedMirrorRows: 0 });
    expect(existsSync(rolloutPath)).toBe(true);
    expect(existsSync(corruptPath)).toBe(true);
    expect(mirrorRowCountForSource(rolloutPath)).toBe(2);
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
