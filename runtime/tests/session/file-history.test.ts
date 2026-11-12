import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkOriginFileChanged,
  computeDiffStats,
  copyFileHistoryForResume,
  FileHistory,
  FileHistorySidecar,
  fileHistoryCanRestore,
  fileHistoryGetDiffStats,
  fileHistoryHasAnyChanges,
  fileHistoryRestoreStateFromLog,
  fileHistoryRewind,
  resolveFileHistoryTargets,
  type FileHistoryBackup,
  type FileHistorySnapshot,
} from "./file-history.js";
import { applyPatchText } from "../../src/tools/apply-patch/runtime.js";
import type { RolloutItem } from "./rollout-item.js";
import {
  acquireCanonicalCompactionLease,
  withCanonicalBackgroundWork,
} from "../../src/session/canonical-background-work.js";

let previousAgencHome: string | undefined;

beforeEach(() => {
  previousAgencHome = process.env.AGENC_HOME;
  // Coordinator persistence can finish after a test's assertion. Give every
  // case its own hermetic home so one case cannot discover another's state;
  // the test boundary owns removal after all worker activity has settled.
  process.env.AGENC_HOME = mkdtempSync(join(tmpdir(), "agenc-filehist-home-"));
});

afterEach(() => {
  if (previousAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = previousAgencHome;
  }
});

describe("FileHistory (I-28)", () => {
  let project = "";

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-"));
  });
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("defers snapshot diagnostics while compaction owns the journal", async () => {
    const key = join(project, "rollout#epoch:1");
    const directory = join(project, "new-scene");
    const events: string[] = [];
    const history = new FileHistory({
      projectDir: project,
      onDiagnostic: (diagnostic) => { events.push(diagnostic.cause); },
      withCanonicalBackgroundWork: (work) => withCanonicalBackgroundWork(key, work),
    });
    // Shell tracking can record a nonexistent path that becomes a directory.
    await history.trackEdit(directory, "before");
    mkdirSync(directory);
    const lease = await acquireCanonicalCompactionLease(key, () => new Error("busy"));
    await history.makeSnapshot("after");
    // Real filesystem work finished, but its EISDIR warning cannot enter
    // the intent-to-commit window. The sidecar drain waits for publication.
    expect(history.getState().snapshots.at(-1)?.messageId).toBe("after");
    expect(events).toEqual([]);
    let flushed = false;
    const drain = history.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    lease.release();
    await drain;
    expect(events).toEqual(["file_history_snapshot_failed"]);
    history.stop();
  });

  test("a failed diagnostic delivery does not block later diagnostics or restore", async () => {
    const key = join(project, "rollout#epoch:1");
    const file = join(project, "durable.txt");
    writeFileSync(file, "original\n");
    let attempts = 0;
    const delivered: string[] = [];
    const history = new FileHistory({
      projectDir: project,
      onDiagnostic: (diagnostic) => {
        if (++attempts === 1) throw new Error("canonical run journal is sealed");
        delivered.push(diagnostic.cause);
      },
      withCanonicalBackgroundWork: (work) => withCanonicalBackgroundWork(key, work),
    });
    const sidecar = new FileHistorySidecar({ fileHistory: history });
    try {
      await history.makeSnapshot("before-edit");
      await history.trackEdit(file, "edit");
      writeFileSync(file, "changed\n");
      // Trying to back up a directory produces real filesystem diagnostics.
      await history.trackEdit(project, "first-diagnostic");
      await history.trackEdit(project, "second-diagnostic");
      await expect(history.flush()).resolves.toBeUndefined();
      expect(attempts).toBe(2);
      expect(delivered).toEqual(["file_history_track_failed"]);
      expect((await history.previewRewind("before-edit"))?.filesChanged).toEqual([file]);
      await expect(history.rewindToMessage("before-edit")).resolves.toEqual([file]);
      expect(readFileSync(file, "utf8")).toBe("original\n");
      await expect(sidecar.stop()).resolves.toBeUndefined();
    } finally {
      history.stop();
    }
  });

  test("resumes published barriers without overwriting origins or another session", async () => {
    const file = join(project, "durable.txt");
    writeFileSync(file, "original\n");
    const first = new FileHistory({ projectDir: project, sessionId: "first" });
    await first.makeSnapshot("before-edit");
    await first.trackEdit(file, "edit");
    writeFileSync(file, "changed\n");
    await first.makeSnapshot("after-edit");
    first.stop();
    const other = new FileHistory({ projectDir: project, sessionId: "other" });
    await other.trackEdit(file, "other-edit");
    other.stop();
    const diagnostics: string[] = [];
    const resumed = new FileHistory({
      projectDir: project,
      sessionId: "first",
      onDiagnostic: ({ cause }) => { diagnostics.push(cause); },
    });
    await resumed.loadFromDisk();
    await resumed.flush();
    expect(diagnostics).toEqual([]);
    expect((await resumed.previewRewind("before-edit"))?.filesChanged).toEqual([file]);
    await resumed.rewindToMessage("before-edit");
    expect(readFileSync(file, "utf8")).toBe("original\n");
    await resumed.makeSnapshot("restored");
    await resumed.trackEdit(file, "again");
    writeFileSync(file, "another\n");
    await resumed.makeSnapshot("after-again");
    await resumed.rewindToMessage("after-edit");
    expect(readFileSync(file, "utf8")).toBe("changed\n");
    resumed.stop();
  });

  test.each(["root", "sibling-prefix", "other-session", "traversal", "relative"])(
    "rejects a persisted %s backup path without loading the index",
    async (kind) => {
      const file = join(project, "durable.txt");
      writeFileSync(file, "original\n");
      const first = new FileHistory({ projectDir: project, sessionId: "first" });
      await first.trackEdit(file, "edit");
      await first.flush();
      first.stop();
      const other = new FileHistory({ projectDir: project, sessionId: "other" });
      other.stop();
      const invalidPaths: Record<string, string> = {
        root: first.historyDir,
        "sibling-prefix": join(`${first.historyDir}-other`, "v1"),
        "other-session": join(other.historyDir, "v1"),
        traversal: `${first.historyDir}${sep}..${sep}outside`,
        relative: "v1",
      };
      const indexPath = join(first.historyDir, "snapshots.json");
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const backup = index.snapshots[0].trackedFileBackups[file];
      expect(backup.backupFileName).toBeTypeOf("string");
      backup.backupFileName = invalidPaths[kind];
      writeFileSync(indexPath, JSON.stringify(index));
      const diagnostics: string[] = [];
      const resumed = new FileHistory({
        projectDir: project,
        sessionId: "first",
        onDiagnostic: ({ cause }) => { diagnostics.push(cause); },
      });
      try {
        await resumed.loadFromDisk();
        await resumed.flush();
        expect(diagnostics).toEqual(["file_history_load_failed"]);
        expect(resumed.getState().snapshots).toEqual([]);
        expect(resumed.getState().trackedFiles.size).toBe(0);
        expect(readFileSync(file, "utf8")).toBe("original\n");
      } finally {
        resumed.stop();
      }
    },
  );

  test("trackEdit creates v1 backup of tracked file", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "original", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    expect(hist.getState().trackedFiles.has(file)).toBe(true);
    const snapshots = hist.getState().snapshots;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
  });

  test("I-28: LRU eviction flips isFileHistoryComplete to false", async () => {
    const hist = new FileHistory({ projectDir: project, maxSnapshots: 3 });
    const file = join(project, "a.txt");
    writeFileSync(file, "a", "utf8");
    await hist.trackEdit(file, "m0");
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(file, `version-${i}`, "utf8");
      await hist.makeSnapshot(`msg-${i}`);
    }
    const state = hist.getState();
    expect(state.snapshots.length).toBeLessThanOrEqual(3);
    expect(state.isFileHistoryComplete).toBe(false);
    expect(state.evictedCount).toBeGreaterThan(0);
  });

  test("computeDiffStats counts insertions + deletions", () => {
    const a = "line1\nline2\nline3\n";
    const b = "line1\nmodified\nline3\nline4\n";
    const stats = computeDiffStats(a, b);
    expect(stats.insertions).toBeGreaterThanOrEqual(1);
    expect(stats.deletions).toBeGreaterThanOrEqual(1);
  });

  test("computeDiffStats empty strings", () => {
    expect(computeDiffStats("", "")).toEqual({ insertions: 0, deletions: 0 });
    // "a\nb\n".split("\n") → ["a", "b", ""] so 3 "lines" (trailing
    // empty) — this matches diffLines-style behavior.
    const d1 = computeDiffStats("a\nb\n", "");
    expect(d1.insertions).toBe(0);
    expect(d1.deletions).toBeGreaterThan(0);
    const d2 = computeDiffStats("", "a\nb\n");
    expect(d2.insertions).toBeGreaterThan(0);
    expect(d2.deletions).toBe(0);
  });

  test("makeSnapshot attaches DiffStats + aggregate to snapshot", async () => {
    const hist = new FileHistory({ projectDir: project });
    const file = join(project, "src.txt");
    writeFileSync(file, "line1\nline2\n", "utf8");
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "line1\nline2\nline3\n", "utf8");
    await hist.makeSnapshot("msg-2");
    const state = hist.getState();
    const last = state.snapshots.at(-1);
    expect(last?.aggregateDiffStats).toBeDefined();
    expect(last?.aggregateDiffStats?.insertions).toBeGreaterThan(0);
    expect(last?.aggregateDiffStats?.filesChanged).toContain(file);
  });

  test("rewindToMessage writes contents back", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "original", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "modified", "utf8");
    await hist.makeSnapshot("msg-2");
    const restored = await hist.rewindToMessage("msg-1");
    expect(restored).toContain(file);
    // Content post-restore should be original (from v1 backup).
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("rewindToMessage restores files first tracked AFTER the target snapshot to their origin", async () => {
    const hist = new FileHistory({ projectDir: project });
    const early = join(project, "early.txt");
    writeFileSync(early, "early-original", "utf8");
    await hist.trackEdit(early, "msg-1");
    await hist.makeSnapshot("msg-1");

    // A second file is first edited only after msg-1's snapshot.
    const late = join(project, "late.txt");
    writeFileSync(late, "late-original", "utf8");
    await hist.trackEdit(late, "msg-2");
    writeFileSync(late, "late-modified", "utf8");
    await hist.makeSnapshot("msg-2");

    const restored = await hist.rewindToMessage("msg-1");
    // Rewinding to "before msg-2" must undo the late file's edit too,
    // via its v1 origin backup.
    expect(restored).toContain(late);
    expect(readFileSync(late, "utf8")).toBe("late-original");
  });

  test("previewRewind reports changed files without touching disk", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "original", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "modified", "utf8");
    await hist.makeSnapshot("msg-2");

    const preview = await hist.previewRewind("msg-1");
    expect(preview).not.toBeNull();
    expect(preview?.filesChanged).toContain(file);
    expect(
      (preview?.insertions ?? 0) + (preview?.deletions ?? 0),
    ).toBeGreaterThan(0);
    // Dry-run: disk untouched.
    expect(readFileSync(file, "utf8")).toBe("modified");
    // Unknown snapshot → null.
    expect(await hist.previewRewind("msg-unknown")).toBeNull();
  });

  test("hasSnapshotFor reflects snapshot presence", async () => {
    const hist = new FileHistory({ projectDir: project });
    const file = join(project, "src.txt");
    writeFileSync(file, "x", "utf8");
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    expect(hist.hasSnapshotFor("msg-1")).toBe(true);
    expect(hist.hasSnapshotFor("msg-2")).toBe(false);
  });
});

/** Every backup file below a history directory; the index is not a backup. */
function listBackupFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listBackupFiles(path);
    return entry.name === "snapshots.json" ? [] : [path];
  });
}

describe("FileHistory unchanged files (#3434)", () => {
  let project = "";
  const engines: FileHistory[] = [];

  function engine(sessionId?: string): FileHistory {
    const history = new FileHistory({ projectDir: project, sessionId });
    engines.push(history);
    return history;
  }

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-carry-"));
  });
  afterEach(() => {
    for (const history of engines.splice(0)) history.stop();
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("an unchanged tracked file is not copied again by later snapshots", async () => {
    const file = join(project, "steady.txt");
    writeFileSync(file, "line1\nline2\n", "utf8");
    const hist = engine("carry");
    await hist.trackEdit(file, "m0");
    const origin = hist.getState().snapshots[0]!.trackedFileBackups[file]!;
    expect(origin.version).toBe(1);
    expect(listBackupFiles(hist.historyDir)).toEqual([origin.backupFileName]);

    for (let i = 1; i <= 4; i += 1) await hist.makeSnapshot(`m${i}`);

    // Still the one backup file, shared by every snapshot.
    expect(listBackupFiles(hist.historyDir)).toEqual([origin.backupFileName]);
    const snapshots = hist.getState().snapshots;
    expect(snapshots.map((snapshot) => snapshot.messageId)).toEqual([
      "m0", "m1", "m2", "m3", "m4",
    ]);
    for (const snapshot of snapshots.slice(1)) {
      const entry = snapshot.trackedFileBackups[file];
      expect(entry).toEqual({
        backupFileName: origin.backupFileName,
        version: 1,
        backupTimeMs: origin.backupTimeMs,
      });
      expect(entry).not.toHaveProperty("diffStats");
      expect(snapshot.aggregateDiffStats).toBeUndefined();
    }
    // The index on disk says the same: one entry per snapshot, one backup.
    const index = JSON.parse(
      readFileSync(join(hist.historyDir, "snapshots.json"), "utf8"),
    ) as { snapshots: FileHistorySnapshot[] };
    expect(
      index.snapshots.map((snapshot) => snapshot.trackedFileBackups[file]?.backupFileName),
    ).toEqual(Array.from({ length: 5 }, () => origin.backupFileName));

    // A shared backup still restores the file.
    writeFileSync(file, "edited\n", "utf8");
    await expect(hist.rewindToMessage("m3")).resolves.toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("line1\nline2\n");
  });

  test("a same-size rewrite gets a new backup and diff stats", async () => {
    const file = join(project, "same-size.txt");
    writeFileSync(file, "aaaa\nbbbb\n", "utf8");
    const sizeBefore = statSync(file).size;
    const hist = engine();
    await hist.trackEdit(file, "m0");
    await hist.makeSnapshot("m1");
    writeFileSync(file, "aaaa\ncccc\n", "utf8");
    expect(statSync(file).size).toBe(sizeBefore);
    await hist.makeSnapshot("m2");

    const [, m1, m2] = hist.getState().snapshots;
    const before = m1!.trackedFileBackups[file]!;
    const after = m2!.trackedFileBackups[file]!;
    expect(before.version).toBe(1);
    expect(after.version).toBe(2);
    expect(after.backupFileName).not.toBe(before.backupFileName);
    expect(readFileSync(before.backupFileName!, "utf8")).toBe("aaaa\nbbbb\n");
    expect(readFileSync(after.backupFileName!, "utf8")).toBe("aaaa\ncccc\n");
    expect(after.diffStats).toEqual({ insertions: 1, deletions: 1 });
    expect(m2!.aggregateDiffStats).toEqual({
      insertions: 1,
      deletions: 1,
      filesChanged: [file],
    });
    expect(listBackupFiles(hist.historyDir)).toHaveLength(2);

    // Unchanged again: the new backup is shared, without its diff stats.
    await hist.makeSnapshot("m3");
    const m3 = hist.getState().snapshots.at(-1)!;
    expect(m3.trackedFileBackups[file]).toEqual({
      backupFileName: after.backupFileName,
      version: 2,
      backupTimeMs: after.backupTimeMs,
    });
    expect(m3.trackedFileBackups[file]).not.toHaveProperty("diffStats");
    expect(m3.aggregateDiffStats).toBeUndefined();
    expect(listBackupFiles(hist.historyDir)).toHaveLength(2);
  });

  test.each([
    ["truncated", "the same engine"],
    ["deleted", "the same engine"],
    ["truncated", "a reloaded engine"],
    ["deleted", "a reloaded engine"],
  ])(
    "a %s backup is not carried into the next snapshot by %s",
    async (damage, engineKind) => {
      const file = join(project, "notes.txt");
      writeFileSync(file, "IMPORTANT CONTENT\n", "utf8");
      let hist = engine("damaged");
      await hist.trackEdit(file, "m0");
      await hist.makeSnapshot("m1");
      const carried = hist.getState().snapshots.at(-1)!.trackedFileBackups[file]!;
      // m1 shares the origin backup.
      expect(carried.backupFileName).toBe(
        hist.getState().snapshots[0]!.trackedFileBackups[file]!.backupFileName,
      );

      if (damage === "truncated") truncateSync(carried.backupFileName!, 4);
      else rmSync(carried.backupFileName!);
      if (engineKind === "a reloaded engine") {
        // No digest in memory: this engine reads the backup as it is now.
        hist = engine("damaged");
        await hist.loadFromDisk();
      }

      await hist.makeSnapshot("m2");
      const fresh = hist.getState().snapshots.at(-1)!.trackedFileBackups[file]!;
      expect(fresh.backupFileName).not.toBe(carried.backupFileName);
      expect(fresh.version).toBe(2);
      expect(readFileSync(fresh.backupFileName!, "utf8")).toBe("IMPORTANT CONTENT\n");

      // From here on the intact backup is the one that is shared.
      await hist.makeSnapshot("m3");
      expect(
        hist.getState().snapshots.at(-1)!.trackedFileBackups[file]!.backupFileName,
      ).toBe(fresh.backupFileName);
      writeFileSync(file, "edited by the agent\n", "utf8");
      await expect(hist.rewindToMessage("m3")).resolves.toEqual([file]);
      expect(readFileSync(file, "utf8")).toBe("IMPORTANT CONTENT\n");
    },
  );

  test("a file that stays missing keeps its one entry across snapshots", async () => {
    const neverCreated = join(project, "never-created.txt");
    const removed = join(project, "removed.txt");
    writeFileSync(removed, "one\ntwo\n", "utf8");
    const hist = engine();
    await hist.trackEdits([neverCreated, removed], "m0");
    rmSync(removed);
    await hist.makeSnapshot("m1");

    const m1 = hist.getState().snapshots.at(-1)!;
    const absentEntry = m1.trackedFileBackups[neverCreated]!;
    const removedEntry = m1.trackedFileBackups[removed]!;
    expect(absentEntry).toMatchObject({ backupFileName: null, version: 1 });
    expect(removedEntry).toMatchObject({
      backupFileName: null,
      version: 2,
      diffStats: { insertions: 0, deletions: 2 },
    });
    expect(m1.aggregateDiffStats).toEqual({
      insertions: 0,
      deletions: 2,
      filesChanged: [removed],
    });

    await hist.makeSnapshot("m2");
    await hist.makeSnapshot("m3");
    for (const snapshot of hist.getState().snapshots.slice(-2)) {
      // Same entries, same versions: nothing happened to either path.
      expect(snapshot.trackedFileBackups[neverCreated]).toEqual(absentEntry);
      expect(snapshot.trackedFileBackups[removed]).toEqual(removedEntry);
      expect(Object.keys(snapshot.trackedFileBackups)).toHaveLength(2);
      expect(snapshot.aggregateDiffStats).toBeUndefined();
    }
    // Only the removed file's origin was ever copied.
    expect(listBackupFiles(hist.historyDir)).toHaveLength(1);

    // A file that comes back gets the next version.
    writeFileSync(removed, "back\n", "utf8");
    await hist.makeSnapshot("m4");
    const returned = hist.getState().snapshots.at(-1)!.trackedFileBackups[removed]!;
    expect(returned.version).toBe(3);
    expect(readFileSync(returned.backupFileName!, "utf8")).toBe("back\n");
  });

  test("an unchanged file is still carried forward after a reload from disk", async () => {
    const file = join(project, "steady.txt");
    writeFileSync(file, "kept\n", "utf8");
    const first = engine("reload");
    await first.trackEdit(file, "m0");
    await first.makeSnapshot("m1");
    first.stop();
    const origin = first.getState().snapshots[0]!.trackedFileBackups[file]!;

    // A new engine has no digest in memory; it reads the backup once.
    const resumed = engine("reload");
    await resumed.loadFromDisk();
    await resumed.makeSnapshot("m2");
    await resumed.makeSnapshot("m3");
    expect(listBackupFiles(resumed.historyDir)).toEqual([origin.backupFileName]);
    for (const snapshot of resumed.getState().snapshots.slice(-2)) {
      const entry = snapshot.trackedFileBackups[file];
      expect(entry).toEqual({
        backupFileName: origin.backupFileName,
        version: 1,
        backupTimeMs: origin.backupTimeMs,
      });
      expect(entry).not.toHaveProperty("diffStats");
    }

    // A change made after the reload is still seen, at the same size.
    writeFileSync(file, "KEPT\n", "utf8");
    await resumed.makeSnapshot("m4");
    const changed = resumed.getState().snapshots.at(-1)!.trackedFileBackups[file]!;
    expect(changed.version).toBe(2);
    expect(changed.backupFileName).not.toBe(origin.backupFileName);
    expect(listBackupFiles(resumed.historyDir)).toHaveLength(2);
  });

  test("trackEdits tracks every path in one call and repeats are no-ops", async () => {
    const a = join(project, "a.txt");
    const b = join(project, "b.txt");
    writeFileSync(a, "a\n", "utf8");
    writeFileSync(b, "b\n", "utf8");
    const hist = engine();
    await hist.trackEdits([a, b, a], "m0");

    const state = hist.getState();
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]!.messageId).toBe("m0");
    expect(Object.keys(state.snapshots[0]!.trackedFileBackups)).toEqual([a, b]);
    expect(state.snapshots[0]!.trackedFileBackups[a]!.version).toBe(1);
    expect(state.snapshots[0]!.trackedFileBackups[b]!.version).toBe(1);
    expect(listBackupFiles(hist.historyDir)).toHaveLength(2);

    await hist.trackEdits([b, a], "m1");
    await hist.trackEdit(a, "m1");
    await hist.trackEdits([], "m1");
    expect(hist.getState()).toBe(state);
    expect(listBackupFiles(hist.historyDir)).toHaveLength(2);
  });
});

describe("FileHistory eviction deletes unreferenced backups (#3435)", () => {
  let project = "";
  let diagnostics: string[] = [];
  const engines: FileHistory[] = [];

  function engine(options: { sessionId?: string; maxSnapshots: number }): FileHistory {
    const history = new FileHistory({
      projectDir: project,
      ...options,
      onDiagnostic: ({ cause }) => { diagnostics.push(cause); },
    });
    engines.push(history);
    return history;
  }

  /** The backup the newest snapshot names for `file`. */
  function newestBackup(history: FileHistory, file: string): string {
    const backup = history.getState().snapshots.at(-1)?.trackedFileBackups[file];
    if (!backup || backup.backupFileName === null) {
      throw new Error(`the newest snapshot has no backup for ${file}`);
    }
    return backup.backupFileName;
  }

  /** Per-path backup directories below a history directory. */
  function backupDirectories(history: FileHistory): string[] {
    return readdirSync(history.historyDir).filter((name) => name !== "snapshots.json");
  }

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-evict-"));
    diagnostics = [];
  });
  afterEach(() => {
    for (const history of engines.splice(0)) history.stop();
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test.each([
    ["an engine with a session id", "evict"],
    ["an engine without a session id", undefined],
  ])("%s deletes the backups that only evicted snapshots named", async (_layout, sessionId) => {
    const busy = join(project, "busy.txt");
    const removed = join(project, "removed.txt");
    const neverCreated = join(project, "never-created.txt");
    writeFileSync(busy, "busy 0\n", "utf8");
    writeFileSync(removed, "removed\n", "utf8");
    const hist = engine({ sessionId, maxSnapshots: 3 });
    await hist.trackEdits([busy, removed, neverCreated], "m0");
    const removedOrigin = newestBackup(hist, removed);
    const busyBackups = [newestBackup(hist, busy)];
    rmSync(removed);
    for (let i = 1; i <= 2; i += 1) {
      writeFileSync(busy, `busy ${i}\n`, "utf8");
      await hist.makeSnapshot(`m${i}`);
      busyBackups.push(newestBackup(hist, busy));
    }
    // At the cap, but nothing was evicted yet: every backup is still named.
    expect(hist.getState().evictedCount).toBe(0);
    expect(listBackupFiles(hist.historyDir).sort()).toEqual(
      [removedOrigin, ...busyBackups].sort(),
    );

    writeFileSync(busy, "busy 3\n", "utf8");
    await hist.makeSnapshot("m3");
    busyBackups.push(newestBackup(hist, busy));

    // m0 is evicted, and the two backups that only m0 named went with it.
    expect(hist.getState().snapshots.map((snapshot) => snapshot.messageId)).toEqual([
      "m1", "m2", "m3",
    ]);
    expect(existsSync(busyBackups[0]!)).toBe(false);
    expect(existsSync(removedOrigin)).toBe(false);
    expect(listBackupFiles(hist.historyDir).sort()).toEqual(busyBackups.slice(1).sort());
    // `removed.txt` has no backup left, so its directory is gone as well.
    expect(existsSync(dirname(removedOrigin))).toBe(false);
    expect(backupDirectories(hist)).toEqual([basename(dirname(busyBackups[0]!))]);

    // A tree that keeps changing holds one backup per retained snapshot.
    for (let i = 4; i <= 9; i += 1) {
      writeFileSync(busy, `busy ${i}\n`, "utf8");
      await hist.makeSnapshot(`m${i}`);
      busyBackups.push(newestBackup(hist, busy));
      expect(listBackupFiles(hist.historyDir).sort()).toEqual(busyBackups.slice(-3).sort());
    }
    // Once it stops changing, only the backup the retained snapshots share is left.
    for (let i = 10; i <= 14; i += 1) await hist.makeSnapshot(`m${i}`);
    expect(listBackupFiles(hist.historyDir)).toEqual([busyBackups.at(-1)]);
    expect(backupDirectories(hist)).toEqual([basename(dirname(busyBackups[0]!))]);
    expect(hist.getState()).toMatchObject({ evictedCount: 12, isFileHistoryComplete: false });
    expect(diagnostics).toEqual(["file_history_cap_reached"]);

    // What is left still restores the file.
    writeFileSync(busy, "edited\n", "utf8");
    await expect(hist.rewindToMessage("m12")).resolves.toEqual([busy]);
    expect(readFileSync(busy, "utf8")).toBe("busy 9\n");
    expect(existsSync(removed)).toBe(false);
  });

  test("an origin backup that retained snapshots still name survives eviction and restores its file", async () => {
    const steady = join(project, "steady.txt");
    const busy = join(project, "busy.txt");
    writeFileSync(steady, "steady origin\n", "utf8");
    writeFileSync(busy, "busy 0\n", "utf8");
    const hist = engine({ sessionId: "carried", maxSnapshots: 2 });
    await hist.trackEdits([steady, busy], "m0");
    const steadyOrigin = hist.getState().snapshots[0]!.trackedFileBackups[steady]!;
    expect(steadyOrigin.version).toBe(1);
    for (let i = 1; i <= 4; i += 1) {
      writeFileSync(busy, `busy ${i}\n`, "utf8");
      await hist.makeSnapshot(`m${i}`);
    }

    // Three snapshots are gone, the one that first named the origin among them.
    const retained = hist.getState().snapshots;
    expect(retained.map((snapshot) => snapshot.messageId)).toEqual(["m3", "m4"]);
    expect(hist.getState().evictedCount).toBe(3);
    for (const snapshot of retained) {
      expect(snapshot.trackedFileBackups[steady]).toEqual({
        backupFileName: steadyOrigin.backupFileName,
        version: 1,
        backupTimeMs: steadyOrigin.backupTimeMs,
      });
    }
    expect(readFileSync(steadyOrigin.backupFileName!, "utf8")).toBe("steady origin\n");
    expect(listBackupFiles(hist.historyDir).sort()).toEqual([
      steadyOrigin.backupFileName,
      retained[0]!.trackedFileBackups[busy]!.backupFileName,
      retained[1]!.trackedFileBackups[busy]!.backupFileName,
    ].sort());

    // A file first tracked now has its origin on the newest snapshot. A rewind
    // to the older one falls back to that origin.
    const late = join(project, "late.txt");
    writeFileSync(late, "late origin\n", "utf8");
    await hist.trackEdit(late, "late-edit");

    writeFileSync(steady, "steady edited\n", "utf8");
    writeFileSync(busy, "busy edited\n", "utf8");
    writeFileSync(late, "late edited\n", "utf8");
    const restored = await hist.rewindToMessage("m3");
    expect([...restored].sort()).toEqual([busy, late, steady].sort());
    expect(readFileSync(steady, "utf8")).toBe("steady origin\n");
    expect(readFileSync(busy, "utf8")).toBe("busy 3\n");
    expect(readFileSync(late, "utf8")).toBe("late origin\n");
  });

  test("a file without an entry at the target is left alone once its origin is evicted", async () => {
    const path = join(project, "replaced.txt");
    writeFileSync(path, "one\n", "utf8");
    const hist = engine({ sessionId: "unknown-origin", maxSnapshots: 2 });
    await hist.trackEdit(path, "m0");
    writeFileSync(path, "two\n", "utf8");
    await hist.makeSnapshot("m1");
    // A directory cannot be backed up, so m2 has no entry for the path, and
    // the same snapshot evicts m0, which held its origin.
    rmSync(path);
    mkdirSync(path);
    await hist.makeSnapshot("m2");
    expect(diagnostics).toEqual(["file_history_snapshot_failed", "file_history_cap_reached"]);
    const [m1, m2] = hist.getState().snapshots;
    expect([m1!.messageId, m2!.messageId]).toEqual(["m1", "m2"]);
    expect(m1!.trackedFileBackups[path]!.version).toBe(2);
    expect(m2!.trackedFileBackups[path]).toBeUndefined();
    expect(listBackupFiles(hist.historyDir)).toEqual([m1!.trackedFileBackups[path]!.backupFileName]);

    // What the path held at m2 is unknown: neither reader touches it.
    rmSync(path, { recursive: true });
    writeFileSync(path, "three\n", "utf8");
    await expect(hist.previewRewind("m2")).resolves.toEqual({
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      perFile: {},
    });
    await expect(hist.rewindToMessage("m2")).resolves.toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("three\n");
    // The snapshot that does have an entry still restores it.
    await expect(hist.rewindToMessage("m1")).resolves.toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("two\n");
  });

  test("the index written after eviction reloads and rewinds to every retained snapshot", async () => {
    const steady = join(project, "steady.txt");
    const busy = join(project, "busy.txt");
    writeFileSync(steady, "steady origin\n", "utf8");
    writeFileSync(busy, "busy 0\n", "utf8");
    const first = engine({ sessionId: "reload", maxSnapshots: 3 });
    await first.trackEdits([steady, busy], "m0");
    for (let i = 1; i <= 5; i += 1) {
      writeFileSync(busy, `busy ${i}\n`, "utf8");
      await first.makeSnapshot(`m${i}`);
    }
    first.stop();
    const backupsOnDisk = listBackupFiles(first.historyDir).sort();
    expect(backupsOnDisk).toHaveLength(4);

    const resumed = engine({ sessionId: "reload", maxSnapshots: 3 });
    await resumed.loadFromDisk();
    await resumed.flush();
    // Only the first engine's cap warning: the index loaded cleanly.
    expect(diagnostics).toEqual(["file_history_cap_reached"]);
    const state = resumed.getState();
    expect(state.snapshots.map((snapshot) => snapshot.messageId)).toEqual(["m3", "m4", "m5"]);
    expect(state).toMatchObject({
      evictedCount: 3,
      isFileHistoryComplete: false,
      snapshotSequence: 5,
    });
    // The index names exactly the backups on disk: none it needs was deleted
    // and none it no longer names was left behind.
    const named = new Set(state.snapshots.flatMap((snapshot) =>
      Object.values(snapshot.trackedFileBackups).map((backup) => backup.backupFileName)));
    expect([...named].sort()).toEqual(backupsOnDisk);
    for (const snapshot of state.snapshots) {
      await expect(fileHistoryCanRestore(state, snapshot.messageId)).resolves.toBe(true);
    }

    for (const [messageId, content] of [["m3", "busy 3\n"], ["m5", "busy 5\n"], ["m4", "busy 4\n"]]) {
      writeFileSync(steady, "steady edited\n", "utf8");
      await expect(resumed.rewindToMessage(messageId!)).resolves.toEqual([steady, busy]);
      expect(readFileSync(steady, "utf8")).toBe("steady origin\n");
      expect(readFileSync(busy, "utf8")).toBe(content);
    }

    // The resumed engine goes on evicting, and deletes what it evicts.
    const evictedNext = state.snapshots[0]!.trackedFileBackups[busy]!.backupFileName!;
    writeFileSync(busy, "busy 6\n", "utf8");
    await resumed.makeSnapshot("m6");
    expect(existsSync(evictedNext)).toBe(false);
    expect(listBackupFiles(resumed.historyDir).sort()).toEqual([
      ...backupsOnDisk.filter((backup) => backup !== evictedNext),
      newestBackup(resumed, busy),
    ].sort());
    expect(resumed.getState().evictedCount).toBe(4);
  });
});

describe("FileHistorySidecar event wiring", () => {
  let project = "";

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-sidecar-"));
  });
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  async function waitForTracked(
    hist: FileHistory,
    file: string,
  ): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if (hist.getState().trackedFiles.has(file)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  function startedEvent(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Parameters<FileHistorySidecar["onEvent"]>[0] {
    return {
      id,
      msg: {
        type: "tool_call_started",
        payload: { callId: id, toolName, args: JSON.stringify(args) },
      },
    } as Parameters<FileHistorySidecar["onEvent"]>[0];
  }

  test("tracks Edit calls via the live `file_path` arg key", async () => {
    // Live Edit/Write schemas use `file_path` — the sidecar must track
    // from it (the original port only read `path`/`filePath`, so file
    // history captured NOTHING at runtime).
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({ fileHistory: hist });
    const file = join(project, "edited.txt");
    writeFileSync(file, "before", "utf8");
    sidecar.onEvent(startedEvent("ev-1", "Edit", { file_path: file }));
    await waitForTracked(hist, file);
    expect(hist.getState().trackedFiles.has(file)).toBe(true);
  });

  test("tracks NotebookEdit and MultiEdit tool calls", async () => {
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({ fileHistory: hist });
    const notebook = join(project, "nb.ipynb");
    const multi = join(project, "multi.txt");
    writeFileSync(notebook, "{}", "utf8");
    writeFileSync(multi, "m", "utf8");
    sidecar.onEvent(
      startedEvent("ev-nb", "NotebookEdit", { notebook_path: notebook }),
    );
    sidecar.onEvent(startedEvent("ev-me", "MultiEdit", { file_path: multi }));
    await waitForTracked(hist, notebook);
    await waitForTracked(hist, multi);
    expect(hist.getState().trackedFiles.has(notebook)).toBe(true);
    expect(hist.getState().trackedFiles.has(multi)).toBe(true);
  });

  test("tracks every file named by an apply_patch payload", async () => {
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({ fileHistory: hist });
    const a = join(project, "a.txt");
    const b = join(project, "b.txt");
    writeFileSync(a, "aa", "utf8");
    writeFileSync(b, "bb", "utf8");
    const input = [
      "*** Begin Patch",
      `*** Update File: ${a}`,
      "@@",
      "-aa",
      "+aa2",
      `*** Delete File: ${b}`,
      "*** End Patch",
    ].join("\n");
    sidecar.onEvent(startedEvent("ev-patch", "apply_patch", { input }));
    await waitForTracked(hist, a);
    await waitForTracked(hist, b);
    expect(hist.getState().trackedFiles.has(a)).toBe(true);
    expect(hist.getState().trackedFiles.has(b)).toBe(true);
  });

  test.each([false, true])("rewind restores both sides of a patch move (existing destination=%s)", async (existing) => {
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({ fileHistory: hist, workspaceRoot: project });
    const source = join(project, "source.txt");
    const destination = join(project, "destination.txt");
    writeFileSync(source, "before\n");
    if (existing) writeFileSync(destination, "destination original\n");
    const input = [
      "*** Begin Patch", "*** Update File: source.txt", "*** Move to: destination.txt",
      "@@", "-before", "+after", "*** End Patch",
    ].join("\n");
    try {
      await hist.makeSnapshot("before-move");
      sidecar.onEvent(startedEvent("move", "apply_patch", { input }));
      await waitForTracked(hist, source);
      await waitForTracked(hist, destination);
      await applyPatchText(input, { cwd: project, allowedPaths: [project] });
      await hist.makeSnapshot("after-move");
      expect(readFileSync(destination, "utf8")).toBe("after\n");
      await hist.rewindToMessage("before-move");
      expect(readFileSync(source, "utf8")).toBe("before\n");
      if (existing) expect(readFileSync(destination, "utf8")).toBe("destination original\n");
      else expect(() => readFileSync(destination, "utf8")).toThrow();
    } finally {
      await sidecar.stop();
    }
  });

  test("user_message events take a barrier snapshot keyed by the event id", async () => {
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({ fileHistory: hist });
    const file = join(project, "tracked.txt");
    writeFileSync(file, "v1", "utf8");
    sidecar.onEvent(startedEvent("ev-edit", "Edit", { file_path: file }));
    await waitForTracked(hist, file);

    sidecar.onEvent({
      id: "user-msg-123",
      msg: {
        type: "user_message",
        payload: { message: "next prompt" },
      },
    } as Parameters<FileHistorySidecar["onEvent"]>[0]);
    for (let i = 0; i < 50 && !hist.hasSnapshotFor("user-msg-123"); i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(hist.hasSnapshotFor("user-msg-123")).toBe(true);

    // Restoring to the barrier reverts edits made after the message.
    writeFileSync(file, "v2-after-message", "utf8");
    await hist.rewindToMessage("user-msg-123");
    expect(readFileSync(file, "utf8")).toBe("v1");
  });

  test("backs up the workspace files an exec_command rm is about to remove", async () => {
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({
      fileHistory: hist,
      workspaceRoot: project,
    });
    const doomed = join(project, "arcade15", "game.js");
    mkdirSync(join(project, "arcade15"), { recursive: true });
    writeFileSync(doomed, "export const game = 1;", "utf8");

    sidecar.onEvent(
      startedEvent("ev-rm", "exec_command", {
        cmd: "rm arcade15/game.js && ls -la arcade15",
        workdir: project,
      }),
    );
    await waitForTracked(hist, doomed);

    expect(hist.getState().trackedFiles.has(doomed)).toBe(true);
    const backup =
      hist.getState().snapshots.at(-1)?.trackedFileBackups[doomed];
    expect(backup?.backupFileName).not.toBeNull();
    expect(readFileSync(backup!.backupFileName!, "utf8")).toBe(
      "export const game = 1;",
    );

    // The removal itself lands in the snapshot taken when the call completes.
    rmSync(doomed);
    sidecar.onEvent({
      id: "ev-rm-done",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "ev-rm", toolName: "exec_command", result: "" },
      },
    } as Parameters<FileHistorySidecar["onEvent"]>[0]);
    for (let i = 0; i < 50 && !hist.hasSnapshotFor("ev-rm-done"); i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(
      hist.getState().snapshots.at(-1)?.trackedFileBackups[doomed]?.backupFileName,
    ).toBeNull();
  });

  test("tracks both sides of a system.bash rename and skips directories", async () => {
    const hist = new FileHistory({ projectDir: project });
    const sidecar = new FileHistorySidecar({
      fileHistory: hist,
      workspaceRoot: project,
    });
    const from = join(project, "old.js");
    const to = join(project, "new.js");
    writeFileSync(from, "old", "utf8");
    writeFileSync(to, "to be replaced", "utf8");
    mkdirSync(join(project, "scratch"));

    sidecar.onEvent(
      startedEvent("ev-mv", "system.bash", {
        command: "mv old.js new.js && rm -r scratch",
        cwd: project,
      }),
    );
    await waitForTracked(hist, from);
    await waitForTracked(hist, to);

    const tracked = hist.getState().trackedFiles;
    expect(tracked.has(from)).toBe(true);
    expect(tracked.has(to)).toBe(true);
    expect(tracked.has(join(project, "scratch"))).toBe(false);
  });

  test("ignores shell deletions without a workspace root or outside it", async () => {
    const hist = new FileHistory({ projectDir: project });
    const rootless = new FileHistorySidecar({ fileHistory: hist });
    const scoped = new FileHistorySidecar({
      fileHistory: hist,
      workspaceRoot: join(project, "inner"),
    });
    const outside = join(project, "outside.txt");
    mkdirSync(join(project, "inner"));
    writeFileSync(outside, "keep", "utf8");

    rootless.onEvent(
      startedEvent("ev-rootless", "exec_command", { cmd: `rm ${outside}` }),
    );
    scoped.onEvent(
      startedEvent("ev-scoped", "exec_command", { cmd: "rm ../outside.txt" }),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    expect(hist.getState().trackedFiles.size).toBe(0);
  });
});

describe("resolveFileHistoryTargets (#3436)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agenc-filehist-targets-"));
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ["Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, "src/a.ts"],
    ["MultiEdit", { file_path: "src/b.ts", edits: [] }, "src/b.ts"],
    ["Write", { file_path: "notes/c.md", content: "c\n" }, "notes/c.md"],
    ["NotebookEdit", { notebook_path: "nb/d.ipynb", new_source: "" }, "nb/d.ipynb"],
    ["Edit", { path: "legacy/e.ts" }, "legacy/e.ts"],
    ["Write", { filePath: "legacy/f.ts" }, "legacy/f.ts"],
  ])("%s names one file, resolved against the workspace root", (toolName, args, named) => {
    expect(resolveFileHistoryTargets({ toolName, args, workspaceRoot: root })).toEqual({
      paths: [join(root, named)],
      regularFilesOnly: false,
    });
  });

  test("an edit tool path is normalized, and an absolute one is kept", () => {
    const elsewhere = join(dirname(root), "elsewhere", "g.ts");
    expect(resolveFileHistoryTargets({
      toolName: "Edit",
      args: { file_path: "src/./deep/../a.ts" },
      workspaceRoot: root,
    }).paths).toEqual([join(root, "src", "a.ts")]);
    expect(resolveFileHistoryTargets({
      toolName: "Write",
      args: { file_path: elsewhere },
      workspaceRoot: root,
    }).paths).toEqual([elsewhere]);
  });

  test("a Write of ~/x is keyed under the workspace: the home directory is not expanded", () => {
    expect(resolveFileHistoryTargets({
      toolName: "Write",
      args: { file_path: "~/x" },
      workspaceRoot: root,
    })).toEqual({ paths: [join(root, "~", "x")], regularFilesOnly: false });
  });

  test("without a workspace root an edit tool path is returned as written", () => {
    expect(resolveFileHistoryTargets({
      toolName: "Edit",
      args: { file_path: "src/../a.ts" },
      workspaceRoot: undefined,
    })).toEqual({ paths: ["src/../a.ts"], regularFilesOnly: false });
    expect(resolveFileHistoryTargets({
      toolName: "apply_patch",
      args: { input: "*** Begin Patch\n*** Add File: new.txt\n+x\n*** End Patch" },
      workspaceRoot: undefined,
    })).toEqual({ paths: ["new.txt"], regularFilesOnly: false });
  });

  test("the first path key that is set wins, and an edit call that names no file has no targets", () => {
    expect(resolveFileHistoryTargets({
      toolName: "Edit",
      args: { file_path: "first.ts", notebook_path: "second.ipynb", path: "third.ts", filePath: "fourth.ts" },
      workspaceRoot: root,
    }).paths).toEqual([join(root, "first.ts")]);
    expect(resolveFileHistoryTargets({
      toolName: "NotebookEdit",
      args: { notebook_path: "second.ipynb", path: "third.ts" },
      workspaceRoot: root,
    }).paths).toEqual([join(root, "second.ipynb")]);
    for (const args of [null, {}, { file_path: "" }, { file_path: 7 }, { input: 7 }]) {
      expect(resolveFileHistoryTargets({ toolName: "Write", args, workspaceRoot: root }))
        .toEqual({ paths: [], regularFilesOnly: false });
    }
  });

  test("apply_patch names every file in its hunk headers, in order", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+new",
      "*** Update File: src/updated.txt",
      "*** Move to: src/moved.txt",
      "@@",
      "-old",
      "+new",
      "*** Delete File: gone.txt",
      "*** Update File:   ",
      "*** End Patch",
    ].join("\n");
    expect(resolveFileHistoryTargets({
      toolName: "apply_patch",
      args: { input },
      workspaceRoot: root,
    })).toEqual({
      paths: ["added.txt", "src/updated.txt", "src/moved.txt", "gone.txt"].map((named) =>
        join(root, named)),
      regularFilesOnly: false,
    });
  });

  test.each([
    ["exec_command", (cmd: string, cwd?: string) => ({ cmd, ...(cwd ? { workdir: cwd } : {}) })],
    ["system.bash", (command: string, cwd?: string) => ({ command, ...(cwd ? { cwd } : {}) })],
  ])("%s names the workspace files its command writes, removes or moves", (toolName, argsFor) => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "old.js"), "old", "utf8");
    writeFileSync(join(root, "sub", "inner.txt"), "inner", "utf8");
    const targets = (command: string, cwd?: string) =>
      resolveFileHistoryTargets({ toolName, args: argsFor(command, cwd), workspaceRoot: root });

    expect(targets("rm old.js")).toEqual({
      paths: [join(root, "old.js")],
      regularFilesOnly: true,
    });
    expect(targets("mv old.js new.js").paths).toEqual([join(root, "old.js"), join(root, "new.js")]);
    expect(targets("echo hi > created.txt").paths).toEqual([join(root, "created.txt")]);
    // Relative to the call's working directory, and normalized.
    expect(targets("rm inner.txt", "sub").paths).toEqual([join(root, "sub", "inner.txt")]);
    expect(targets("rm ./sub/../old.js", root).paths).toEqual([join(root, "old.js")]);
    // Outside the workspace, and commands whose targets cannot be read off them.
    expect(targets("rm ../outside.txt").paths).toEqual([]);
    expect(targets("git checkout -- old.js")).toEqual({ paths: [], regularFilesOnly: true });
  });

  test("system.bash also reads the operands it is given as an args array", () => {
    writeFileSync(join(root, "old.js"), "old", "utf8");
    expect(resolveFileHistoryTargets({
      toolName: "system.bash",
      args: { command: "rm", args: ["old.js"] },
      workspaceRoot: root,
    })).toEqual({ paths: [join(root, "old.js")], regularFilesOnly: true });
  });

  test("a shell tool has no targets without a workspace root or without a command", () => {
    writeFileSync(join(root, "old.js"), "old", "utf8");
    expect(resolveFileHistoryTargets({
      toolName: "exec_command",
      args: { cmd: `rm ${join(root, "old.js")}`, workdir: root },
      workspaceRoot: undefined,
    })).toEqual({ paths: [], regularFilesOnly: true });
    // The process's own working directory does not stand in for the root.
    expect(resolveFileHistoryTargets({
      toolName: "system.bash",
      args: { command: "rm relative-to-the-process.txt" },
      workspaceRoot: undefined,
    })).toEqual({ paths: [], regularFilesOnly: true });
    for (const args of [null, {}, { cmd: "   " }, { cmd: 7 }, { command: "rm old.js" }]) {
      expect(resolveFileHistoryTargets({ toolName: "exec_command", args, workspaceRoot: root }))
        .toEqual({ paths: [], regularFilesOnly: true });
    }
  });

  test("a shell command is resolved against the file system as it is at the time of the call", () => {
    writeFileSync(join(root, "old.js"), "old", "utf8");
    const resolveMove = () => resolveFileHistoryTargets({
      toolName: "exec_command",
      args: { cmd: "mv old.js dest", workdir: root },
      workspaceRoot: root,
    }).paths;

    expect(resolveMove()).toEqual([join(root, "old.js"), join(root, "dest")]);
    // Same call, different answer: the move now lands inside the directory.
    mkdirSync(join(root, "dest"));
    expect(resolveMove()).toEqual([join(root, "old.js"), join(root, "dest", "old.js")]);
  });

  test("a tool that is neither an edit tool nor a shell has no targets", () => {
    for (const toolName of ["FileRead", "Grep", "write_stdin", "constructor"]) {
      expect(resolveFileHistoryTargets({
        toolName,
        args: { file_path: "a.txt", cmd: "rm a.txt", command: "rm a.txt" },
        workspaceRoot: root,
      })).toEqual({ paths: [], regularFilesOnly: false });
    }
  });

  test("editToolNames replaces the default edit tools and is looked at before the shell tools", () => {
    writeFileSync(join(root, "old.js"), "old", "utf8");
    const editToolNames = ["CustomWrite", "exec_command"];
    expect(resolveFileHistoryTargets({
      toolName: "CustomWrite",
      args: { file_path: "a.txt" },
      workspaceRoot: root,
      editToolNames,
    })).toEqual({ paths: [join(root, "a.txt")], regularFilesOnly: false });
    expect(resolveFileHistoryTargets({
      toolName: "Write",
      args: { file_path: "a.txt" },
      workspaceRoot: root,
      editToolNames,
    })).toEqual({ paths: [], regularFilesOnly: false });
    expect(resolveFileHistoryTargets({
      toolName: "exec_command",
      args: { cmd: "rm old.js", file_path: "a.txt" },
      workspaceRoot: root,
      editToolNames,
    })).toEqual({ paths: [join(root, "a.txt")], regularFilesOnly: false });
  });
});

describe("FileHistorySidecar capture before a tool call (#3436)", () => {
  let project = "";
  let work = "";
  let diagnostics: string[] = [];
  const engines: FileHistory[] = [];

  type SidecarEvent = Parameters<FileHistorySidecar["onEvent"]>[0];

  /** An engine with an index on disk, so that every queued operation does real I/O. */
  function engine(options: { enabled?: boolean } = {}): FileHistory {
    const history = new FileHistory({
      projectDir: project,
      sessionId: "capture",
      ...options,
      onDiagnostic: ({ cause }) => { diagnostics.push(cause); },
    });
    engines.push(history);
    return history;
  }

  function sidecarFor(history: FileHistory): FileHistorySidecar {
    return new FileHistorySidecar({ fileHistory: history, workspaceRoot: work });
  }

  function userMessage(id: string): SidecarEvent {
    return {
      id,
      msg: { type: "user_message", payload: { message: "next prompt" } },
    } as SidecarEvent;
  }

  function started(id: string, toolName: string, args: Record<string, unknown>): SidecarEvent {
    return {
      id,
      msg: {
        type: "tool_call_started",
        payload: { callId: id, toolName, args: JSON.stringify(args) },
      },
    } as SidecarEvent;
  }

  /** The first state file history recorded for `path`: what a rewind falls back to. */
  function firstStateOf(history: FileHistory, path: string): FileHistoryBackup | undefined {
    for (const snapshot of history.getState().snapshots) {
      const entry = snapshot.trackedFileBackups[path];
      if (entry !== undefined) return entry;
    }
    return undefined;
  }

  function snapshotFor(history: FileHistory, messageId: string): FileHistorySnapshot {
    const snapshot = history.getState().snapshots.find((candidate) =>
      candidate.messageId === messageId);
    if (snapshot === undefined) throw new Error(`no snapshot for ${messageId}`);
    return snapshot;
  }

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-capture-"));
    work = join(project, "work");
    mkdirSync(work);
    diagnostics = [];
  });
  afterEach(() => {
    for (const history of engines.splice(0)) history.stop();
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("returns undefined, and queues nothing, for a call with no targets while no barrier is pending", () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    writeFileSync(join(work, "a.txt"), "a\n", "utf8");
    const state = hist.getState();
    const queue = hist["pending"];

    expect(sidecar.captureBeforeToolCall("FileRead", { file_path: "a.txt" })).toBeUndefined();
    expect(sidecar.captureBeforeToolCall("exec_command", { cmd: "git status", workdir: work }))
      .toBeUndefined();
    // An edit tool whose args name no file has nothing to capture either.
    expect(sidecar.captureBeforeToolCall("Write", { content: "x" })).toBeUndefined();

    expect(hist["pending"]).toBe(queue);
    expect(hist.getState()).toBe(state);
  });

  test("a new file is on record as absent, and an existing one with its content, before the capture resolves", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const created = join(work, "brand-new.txt");
    const existing = join(work, "existing.txt");
    writeFileSync(existing, "BEFORE\n", "utf8");

    const createCapture = sidecar.captureBeforeToolCall("Write", { file_path: "brand-new.txt", content: "NEW\n" });
    expect(createCapture).toBeInstanceOf(Promise);
    await expect(createCapture).resolves.toBeUndefined();
    expect(firstStateOf(hist, created)).toMatchObject({ backupFileName: null, version: 1 });
    // The tool runs only now.
    writeFileSync(created, "NEW\n", "utf8");

    await sidecar.captureBeforeToolCall("Edit", { file_path: existing, old_string: "BEFORE", new_string: "AFTER" });
    const origin = firstStateOf(hist, existing)!;
    expect(origin.version).toBe(1);
    expect(readFileSync(origin.backupFileName!, "utf8")).toBe("BEFORE\n");
    writeFileSync(existing, "AFTER\n", "utf8");

    // The index on disk already names both, and one snapshot holds them.
    const index = JSON.parse(readFileSync(join(hist.historyDir, "snapshots.json"), "utf8")) as {
      snapshots: FileHistorySnapshot[];
    };
    expect(index.snapshots).toHaveLength(1);
    expect(Object.keys(index.snapshots[0]!.trackedFileBackups)).toEqual([created, existing]);
    expect(index.snapshots[0]!.messageId).toMatch(/^capture-[0-9a-f-]{36}$/);

    // A rewind to that point removes the new file and restores the old one.
    await hist.makeSnapshot("after-tools");
    await expect(hist.rewindToMessage(index.snapshots[0]!.messageId)).resolves.toEqual([created, existing]);
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("BEFORE\n");
    expect(diagnostics).toEqual([]);
  });

  test("repeating the capture for a path that is already on record changes nothing", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const file = join(work, "a.txt");
    writeFileSync(file, "a\n", "utf8");
    // The start event queues the backup; the capture waits for the same queue.
    sidecar.onEvent(started("ev-1", "Write", { file_path: file, content: "b\n" }));
    await sidecar.captureBeforeToolCall("Write", { file_path: file, content: "b\n" });

    const state = hist.getState();
    expect(state.snapshots.map((snapshot) => snapshot.messageId)).toEqual(["ev-1"]);
    expect(readFileSync(firstStateOf(hist, file)!.backupFileName!, "utf8")).toBe("a\n");
    expect(listBackupFiles(hist.historyDir)).toHaveLength(1);

    await sidecar.captureBeforeToolCall("Write", { file_path: file, content: "c\n" });
    expect(hist.getState()).toBe(state);
    expect(listBackupFiles(hist.historyDir)).toHaveLength(1);
  });

  test("an untargeted shell call right behind user_message waits for the barrier snapshot", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const notes = join(work, "notes.txt");
    writeFileSync(notes, "FIRST TURN\n", "utf8");
    await hist.trackEdit(notes, "turn-1-edit");
    // Changed by hand between the turns: only the barrier can hold this.
    writeFileSync(notes, "USER EDIT\n", "utf8");
    const call = { cmd: "perl -pi -e 's/USER EDIT/CLOBBERED/' notes.txt", workdir: work };
    expect(resolveFileHistoryTargets({ toolName: "exec_command", args: call, workspaceRoot: work }).paths)
      .toEqual([]);
    expect(sidecar.captureBeforeToolCall("exec_command", call)).toBeUndefined();

    sidecar.onEvent(userMessage("user-2"));
    expect(hist.hasSnapshotFor("user-2")).toBe(false);
    const capture = sidecar.captureBeforeToolCall("exec_command", call);
    expect(capture).toBeInstanceOf(Promise);
    await capture;

    // The barrier is complete, so the command can no longer get ahead of it.
    expect(hist.hasSnapshotFor("user-2")).toBe(true);
    writeFileSync(notes, "CLOBBERED\n", "utf8");
    const barrier = snapshotFor(hist, "user-2").trackedFileBackups[notes]!;
    expect(readFileSync(barrier.backupFileName!, "utf8")).toBe("USER EDIT\n");
    await hist.makeSnapshot("command-done");
    await expect(hist.rewindToMessage("user-2")).resolves.toEqual([notes]);
    expect(readFileSync(notes, "utf8")).toBe("USER EDIT\n");

    // With the barrier settled, a call without targets no longer waits.
    expect(sidecar.captureBeforeToolCall("exec_command", call)).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  test("a call with targets right behind user_message waits for the barrier and for its own backup", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const tracked = join(work, "tracked.txt");
    const fresh = join(work, "fresh.txt");
    writeFileSync(tracked, "TRACKED BEFORE\n", "utf8");
    await hist.trackEdit(tracked, "turn-1-edit");
    writeFileSync(tracked, "TRACKED AT USER-2\n", "utf8");

    sidecar.onEvent(userMessage("user-2"));
    const input = [
      "*** Begin Patch", "*** Update File: tracked.txt", "@@", "-TRACKED AT USER-2", "+PATCHED",
      "*** Add File: fresh.txt", "+FRESH", "*** End Patch",
    ].join("\n");
    await sidecar.captureBeforeToolCall("apply_patch", { input });

    expect(hist.hasSnapshotFor("user-2")).toBe(true);
    await applyPatchText(input, { cwd: work, allowedPaths: [work] });
    expect(readFileSync(tracked, "utf8")).toBe("PATCHED\n");
    expect(readFileSync(fresh, "utf8")).toBe("FRESH\n");

    // Both "before" states sit on the barrier itself.
    const barrier = snapshotFor(hist, "user-2");
    expect(readFileSync(barrier.trackedFileBackups[tracked]!.backupFileName!, "utf8"))
      .toBe("TRACKED AT USER-2\n");
    expect(barrier.trackedFileBackups[fresh]).toMatchObject({ backupFileName: null, version: 1 });
    await hist.makeSnapshot("patch-done");
    await hist.rewindToMessage("user-2");
    expect(readFileSync(tracked, "utf8")).toBe("TRACKED AT USER-2\n");
    expect(existsSync(fresh)).toBe(false);
  });

  test("the newest barrier stays pending when an older one settles", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const file = join(work, "a.txt");
    writeFileSync(file, "a\n", "utf8");
    await hist.trackEdit(file, "m0");
    expect(sidecar["pendingBarrier"]).toBeNull();

    sidecar.onEvent(userMessage("user-1"));
    const first = sidecar["pendingBarrier"];
    sidecar.onEvent(userMessage("user-2"));
    const second = sidecar["pendingBarrier"];
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);
    expect(second).not.toBe(first);

    await first;
    // The second snapshot still has its index to write.
    expect(hist.hasSnapshotFor("user-2")).toBe(false);
    expect(sidecar["pendingBarrier"]).toBe(second);
    const capture = sidecar.captureBeforeToolCall("FileRead", { file_path: file });
    expect(capture).toBeInstanceOf(Promise);

    await capture;
    expect(hist.hasSnapshotFor("user-2")).toBe(true);
    expect(sidecar["pendingBarrier"]).toBeNull();
  });

  test("a disabled engine never makes a call wait", async () => {
    const hist = engine({ enabled: false });
    const sidecar = sidecarFor(hist);
    const file = join(work, "a.txt");
    writeFileSync(file, "a\n", "utf8");

    sidecar.onEvent(userMessage("user-1"));
    expect(sidecar["pendingBarrier"]).toBeInstanceOf(Promise);
    expect(sidecar.captureBeforeToolCall("Write", { file_path: file, content: "b\n" })).toBeUndefined();
    expect(sidecar.captureBeforeToolCall("exec_command", { cmd: "rm a.txt", workdir: work }))
      .toBeUndefined();

    await hist.flush();
    expect(hist.getState().trackedFiles.size).toBe(0);
  });

  test("a call whose signal is already aborted gets a resolved promise and no backup", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const file = join(work, "a.txt");
    writeFileSync(file, "a\n", "utf8");
    const queue = hist["pending"];
    const signal = AbortSignal.abort("stopped before dispatch");

    const capture = sidecar.captureBeforeToolCall("Write", { file_path: file, content: "b\n" }, signal);

    expect(capture).toBeInstanceOf(Promise);
    await expect(capture).resolves.toBeUndefined();
    expect(hist["pending"]).toBe(queue);
    expect(hist.getState().trackedFiles.size).toBe(0);
    expect(getEventListeners(signal, "abort")).toEqual([]);
  });

  test("an abort ends the wait at once and leaves no listener behind", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const file = join(work, "a.txt");
    writeFileSync(file, "a\n", "utf8");
    await hist.trackEdit(file, "m0");
    const controller = new AbortController();

    sidecar.onEvent(userMessage("user-1"));
    const capture = sidecar.captureBeforeToolCall(
      "Write",
      { file_path: file, content: "b\n" },
      controller.signal,
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort("plan mode");
    await expect(capture).resolves.toBeUndefined();

    // It did not wait for the barrier, which still has its index to write.
    expect(hist.hasSnapshotFor("user-1")).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    await hist.flush();
    expect(hist.hasSnapshotFor("user-1")).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  test("a capture that finishes leaves no listener on the signal", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const controller = new AbortController();

    const capture = sidecar.captureBeforeToolCall(
      "Write",
      { file_path: "new.txt", content: "x\n" },
      controller.signal,
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await capture;

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(hist.getState().trackedFiles.has(join(work, "new.txt"))).toBe(true);
  });

  test("a shell call's directory target is skipped, and its files and new paths are tracked", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const scratch = join(work, "scratch");
    const doomed = join(work, "doomed.js");
    const created = join(work, "created.txt");
    mkdirSync(scratch);
    writeFileSync(join(scratch, "inner.txt"), "inner\n", "utf8");
    writeFileSync(doomed, "doomed\n", "utf8");
    const call = { cmd: "rm -r scratch && rm doomed.js && echo hi > created.txt", workdir: work };
    expect(resolveFileHistoryTargets({ toolName: "exec_command", args: call, workspaceRoot: work }))
      .toEqual({ paths: [created, scratch, doomed], regularFilesOnly: true });

    await sidecar.captureBeforeToolCall("exec_command", call);

    expect([...hist.getState().trackedFiles]).toEqual([created, doomed]);
    expect(firstStateOf(hist, created)).toMatchObject({ backupFileName: null, version: 1 });
    expect(readFileSync(firstStateOf(hist, doomed)!.backupFileName!, "utf8")).toBe("doomed\n");
    // Skipped before the engine saw it: no failed backup is reported.
    expect(diagnostics).toEqual([]);
  });

  test("a shell call with only a directory target resolves without queueing anything", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    mkdirSync(join(work, "scratch"));
    const queue = hist["pending"];

    const capture = sidecar.captureBeforeToolCall("exec_command", { cmd: "rm -r scratch", workdir: work });

    expect(capture).toBeInstanceOf(Promise);
    await expect(capture).resolves.toBeUndefined();
    expect(hist["pending"]).toBe(queue);
    expect(hist.getState().trackedFiles.size).toBe(0);
  });

  test("args that cannot be read give no targets, and the call still waits for a pending barrier", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const unreadable = Object.defineProperty({}, "file_path", {
      enumerable: true,
      get: () => { throw new Error("args proxy revoked"); },
    }) as Record<string, unknown>;

    expect(sidecar.captureBeforeToolCall("Write", unreadable)).toBeUndefined();

    sidecar.onEvent(userMessage("user-1"));
    const capture = sidecar.captureBeforeToolCall("Write", unreadable);
    expect(capture).toBeInstanceOf(Promise);
    await capture;
    expect(hist.hasSnapshotFor("user-1")).toBe(true);
    expect(hist.getState().trackedFiles.size).toBe(0);
  });

  test("an edit tool's start event queues one backup operation for all of its files before it returns", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const a = join(work, "a.txt");
    const b = join(work, "b.txt");
    writeFileSync(a, "A0\n", "utf8");
    writeFileSync(b, "B0\n", "utf8");
    const input = [
      "*** Begin Patch", "*** Update File: a.txt", "@@", "-A0", "+A1",
      "*** Update File: b.txt", "@@", "-B0", "+B1", "*** End Patch",
    ].join("\n");
    const queue = hist["pending"];

    sidecar.onEvent(started("ev-patch", "apply_patch", { input }));
    // Already queued. Anything queued from here on runs behind it.
    const queued = hist["pending"];
    expect(queued).not.toBe(queue);
    const later = hist.makeSnapshot("queued-later");
    writeFileSync(a, "A1\n", "utf8");
    writeFileSync(b, "B1\n", "utf8");
    await later;

    const [first, second] = hist.getState().snapshots;
    expect([first!.messageId, second!.messageId]).toEqual(["ev-patch", "queued-later"]);
    expect(Object.keys(first!.trackedFileBackups)).toEqual([a, b]);
    expect(first!.trackedFileBackups[a]!.version).toBe(1);
    expect(first!.trackedFileBackups[b]!.version).toBe(1);
  });

  test("a call that names no file queues nothing when its start event arrives", () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    const queue = hist["pending"];

    sidecar.onEvent(started("ev-1", "Write", { content: "x" }));
    sidecar.onEvent(started("ev-2", "exec_command", { cmd: "git status", workdir: work }));
    sidecar.onEvent(started("ev-3", "FileRead", { file_path: "a.txt" }));

    expect(hist["pending"]).toBe(queue);
  });

  test("only an edit, or a call with targets, is followed by a completion snapshot", async () => {
    const hist = engine();
    const sidecar = sidecarFor(hist);
    writeFileSync(join(work, "a.txt"), "a\n", "utf8");
    const completed = (id: string): SidecarEvent => ({
      id,
      msg: { type: "tool_call_completed", payload: { callId: id, result: "", isError: false } },
    } as SidecarEvent);

    for (const [id, toolName, args] of [
      ["read", "FileRead", { file_path: "a.txt" }],
      ["status", "exec_command", { cmd: "git status", workdir: work }],
      // An edit tool counts even when its args name no file.
      ["write-nothing", "Write", { content: "x" }],
      ["rm", "exec_command", { cmd: "rm a.txt", workdir: work }],
    ] as const) {
      sidecar.onEvent(started(`${id}-started`, toolName, args));
      sidecar.onEvent(completed(`${id}-done`));
    }
    await hist.flush();
    // The backup for `rm` joins the queue after its stat, behind the snapshots.
    for (let i = 0; i < 50 && !hist.getState().trackedFiles.has(join(work, "a.txt")); i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }

    expect(hist.getState().snapshots.map((snapshot) => snapshot.messageId))
      .toEqual(["write-nothing-done", "rm-done"]);
    expect(hist.getState().trackedFiles.has(join(work, "a.txt"))).toBe(true);
  });
});

describe("FileHistory session-resume surface", () => {
  let project = "";

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-resume-"));
  });
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("fileHistoryRewind restores correct snapshot for messageId", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "v1-origin", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "v2-edited", "utf8");
    await hist.makeSnapshot("msg-2");
    writeFileSync(file, "v3-drifted", "utf8");
    await hist.makeSnapshot("msg-3");

    const changed = await fileHistoryRewind(hist.getState(), "msg-1");
    expect(changed).toContain(file);
    expect(readFileSync(file, "utf8")).toBe("v1-origin");
  });

  test("fileHistoryCanRestore returns false when backup artifact missing", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "origin", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    // Healthy path first.
    await expect(fileHistoryCanRestore(hist.getState(), "msg-1")).resolves.toBe(
      true,
    );
    // Missing message fails.
    await expect(
      fileHistoryCanRestore(hist.getState(), "does-not-exist"),
    ).resolves.toBe(false);
    // Delete the backup artifact on disk; canRestore must flip to false.
    rmSync(join(project, "file-history"), { recursive: true, force: true });
    await expect(fileHistoryCanRestore(hist.getState(), "msg-1")).resolves.toBe(
      false,
    );
  });

  test("fileHistoryGetDiffStats counts added/deleted lines between two snapshots", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "line1\nline2\nline3\n", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "line1\nNEW\nline3\nline4\n", "utf8");
    await hist.makeSnapshot("msg-2");

    const diff = await fileHistoryGetDiffStats(
      hist.getState(),
      "msg-1",
      "msg-2",
    );
    expect(diff.filesChanged).toContain(file);
    expect(diff.insertions).toBeGreaterThan(0);
    expect(diff.deletions).toBeGreaterThan(0);
    expect(diff.perFile[file]).toBeDefined();
  });

  test("fileHistoryHasAnyChanges flips false→true after trackEdit", async () => {
    const hist = new FileHistory({ projectDir: project });
    expect(fileHistoryHasAnyChanges(hist.getState())).toBe(false);
    const file = join(project, "src.txt");
    writeFileSync(file, "initial", "utf8");
    await hist.trackEdit(file, "msg-1");
    expect(fileHistoryHasAnyChanges(hist.getState())).toBe(true);
  });

  test("checkOriginFileChanged detects disk-hash mismatch", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "original", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    const backup = hist.getState().snapshots.at(-1)!.trackedFileBackups[file]!;
    expect(backup.backupFileName).not.toBeNull();
    // Pre-mutation: disk matches backup.
    await expect(
      checkOriginFileChanged(file, backup.backupFileName),
    ).resolves.toBe(false);
    // Post-mutation: disk differs.
    writeFileSync(file, "original-plus-tail", "utf8");
    await expect(
      checkOriginFileChanged(file, backup.backupFileName),
    ).resolves.toBe(true);
    // Null-origin sentinel: file "should not exist" but does exist.
    await expect(checkOriginFileChanged(file, null)).resolves.toBe(true);
  });

  test("fileHistoryRestoreStateFromLog rebuilds state from RolloutItem[] round-trip", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "v1", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "v2", "utf8");
    await hist.makeSnapshot("msg-2");

    const liveState = hist.getState();
    // Emit the same snapshots as event_msg rollout items (mirrors what
    // the session writer will persist).
    const items: RolloutItem[] = liveState.snapshots.map(
      (snap, idx) =>
        ({
          type: "event_msg",
          payload: {
            id: `rollout-${idx}`,
            msg: {
              type: "file_history_snapshot",
              snapshot: snap as unknown as FileHistorySnapshot,
            },
          },
        }) as unknown as RolloutItem,
    );
    // Plus a noise item to prove the filter works.
    items.push({
      type: "event_msg",
      payload: {
        id: "noise",
        msg: { type: "turn_complete" },
      },
    } as unknown as RolloutItem);

    const rebuilt = fileHistoryRestoreStateFromLog(items);
    expect(rebuilt.snapshots.length).toBe(liveState.snapshots.length);
    expect(rebuilt.trackedFiles.has(file)).toBe(true);
    expect(rebuilt.snapshots.at(-1)?.messageId).toBe("msg-2");
    expect(rebuilt.snapshots.at(0)?.messageId).toBe("msg-1");
  });

  test("copyFileHistoryForResume deep-clones state", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "v1", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    const original = hist.getState();
    const clone = copyFileHistoryForResume(original);

    expect(clone.snapshots.length).toBe(original.snapshots.length);
    expect(clone.trackedFiles.has(file)).toBe(true);
    // Deep clone: different container identities.
    expect(clone.snapshots).not.toBe(original.snapshots);
    expect(clone.trackedFiles).not.toBe(original.trackedFiles);
    expect(clone.snapshots[0]).not.toBe(original.snapshots[0]);
    expect(clone.snapshots[0]?.trackedFileBackups).not.toBe(
      original.snapshots[0]?.trackedFileBackups,
    );
  });
});
