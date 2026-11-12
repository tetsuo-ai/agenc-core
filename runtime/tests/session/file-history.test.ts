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
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
      await expect(history.clear()).resolves.toBeUndefined();
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
