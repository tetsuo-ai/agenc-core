import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkOriginFileChanged,
  computeDiffStats,
  copyFileHistoryForResume,
  FileHistory,
  fileHistoryCanRestore,
  fileHistoryGetDiffStats,
  fileHistoryHasAnyChanges,
  fileHistoryRestoreStateFromLog,
  fileHistoryRewind,
  type FileHistorySnapshot,
} from "./file-history.js";
import type { RolloutItem } from "./rollout-item.js";

describe("FileHistory (I-28)", () => {
  let project = "";

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "agenc-filehist-"));
  });
  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
  });

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

  test("restoreToMessage writes contents back", async () => {
    const file = join(project, "src.txt");
    writeFileSync(file, "original", "utf8");
    const hist = new FileHistory({ projectDir: project });
    await hist.trackEdit(file, "msg-1");
    await hist.makeSnapshot("msg-1");
    writeFileSync(file, "modified", "utf8");
    await hist.makeSnapshot("msg-2");
    const restored = await hist.restoreToMessage("msg-1");
    expect(restored).toContain(file);
    // Content post-restore should be original (from v1 backup).
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toBe("original");
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
    await expect(
      fileHistoryCanRestore(hist.getState(), "msg-1"),
    ).resolves.toBe(true);
    // Missing message fails.
    await expect(
      fileHistoryCanRestore(hist.getState(), "does-not-exist"),
    ).resolves.toBe(false);
    // Delete the backup artifact on disk; canRestore must flip to false.
    rmSync(join(project, "file-history"), { recursive: true, force: true });
    await expect(
      fileHistoryCanRestore(hist.getState(), "msg-1"),
    ).resolves.toBe(false);
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
