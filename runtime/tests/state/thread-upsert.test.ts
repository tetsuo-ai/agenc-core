import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStateDatabasePaths, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository, type IndexedThreadRecord } from "../../src/state/threads.js";

let root: string;
let driver: StateSqliteDriver;
let threads: StateThreadRepository;
const initial: IndexedThreadRecord = {
  threadId: "thread", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:01Z",
};
function open(): StateSqliteDriver {
  return openStateDatabasePaths({
    projectDir: root, stateDbPath: join(root, "state.sqlite"), logsDbPath: join(root, "logs.sqlite"),
  }, undefined, { deferLogs: true });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-thread-upsert-"));
  driver = open(); threads = new StateThreadRepository(driver);
  threads.upsertThread(initial);
});
afterEach(() => {
  driver.close(); rmSync(root, { recursive: true, force: true });
});
describe("thread upsert persistence", () => {
  it("reads only pending unarchive cleanup rows and sees external transitions", () => {
    const pending = { ...initial, threadId: "pending", archivedRolloutPath: "/old.jsonl", archiveCleanupGeneration: "generation" };
    threads.upsertThread(pending);
    threads.upsertThread({ ...pending, threadId: "archived", archivedAt: "2026-10-02T00:00:00Z" });
    expect(threads.listPendingUnarchiveCleanup()).toEqual([pending]);
    const other = open();
    try {
      new StateThreadRepository(other).upsertThread({ ...pending, archivedAt: "2026-10-03T00:00:00Z" });
      expect(threads.listPendingUnarchiveCleanup()).toEqual([]);
      new StateThreadRepository(other).upsertThread(pending);
      expect(threads.listPendingUnarchiveCleanup()).toEqual([pending]);
    } finally { other.close(); }
  });

  it("leaves an identical row and WAL unchanged, including after reopen", () => {
    const wal = `${driver.stateDbPath}-wal`;
    const before = statSync(wal, { bigint: true });
    expect(threads.upsertThread(initial)).toBeUndefined();
    expect(driver.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 0 });
    expect(statSync(wal, { bigint: true })).toMatchObject({ size: before.size, mtimeNs: before.mtimeNs });
    driver.close(); driver = open(); threads = new StateThreadRepository(driver);
    expect(threads.getThread(initial.threadId)).toEqual(initial);
    threads.upsertThread(initial);
    expect(driver.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 0 });
  });

  const assignments: ReadonlyArray<Partial<IndexedThreadRecord>> = [
    { name: "name" }, { createdAt: "2026-10-02T00:00:00Z" }, { updatedAt: "2026-10-02T00:00:01Z" },
    { archivedAt: "2026-10-02T00:00:02Z" }, { cwd: "/workspace" }, { source: { type: "cli" } },
    { forkedFromId: "parent" }, { model: "model" }, { modelProvider: "provider" },
    { memoryMode: "enabled" }, { rolloutPath: "/rollout.jsonl" },
    { archivedRolloutPath: "/archived.jsonl" }, { archiveCleanupGeneration: "generation" },
  ];
  it.each(assignments)("persists each assigned field and its return to NULL/default: %j", (patch) => {
    const next = { ...initial, ...patch };
    threads.upsertThread(next);
    expect(driver.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 1 });
    expect(threads.getThread(initial.threadId)).toEqual(next);
    threads.upsertThread(next);
    expect(driver.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 0 });
    threads.upsertThread(initial);
    expect(driver.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 1 });
    expect(threads.getThread(initial.threadId)).toEqual(initial);
  });

  it("checks current SQL state after a competing connection changes the row", () => {
    const other = open();
    try {
      const competitor = new StateThreadRepository(other);
      competitor.upsertThread({ ...initial, name: "competitor" });
      threads.upsertThread(initial);
      expect(driver.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 1 });
      expect(competitor.getThread(initial.threadId)).toEqual(initial);
      competitor.upsertThread(initial);
      expect(other.state.prepare("SELECT changes() AS n").get()).toEqual({ n: 0 });
      threads.upsertThread({ ...initial, threadId: "new-thread" });
      expect(competitor.getThread("new-thread")).toEqual({ ...initial, threadId: "new-thread" });
    } finally { other.close(); }
  });

  it("preserves originator and canonical parent fields it does not assign", () => {
    driver.state.prepare("UPDATE threads SET originator = 'owner' WHERE thread_id = ?").run(initial.threadId);
    driver.state.prepare(`INSERT INTO thread_spawn_edges
      (child_thread_id, parent_thread_id, parent_path, metadata_json, status)
      VALUES (?, 'parent', '[]', '{}', 'running')`).run(initial.threadId);
    threads.upsertThread(initial);
    threads.upsertThread({ ...initial, name: "changed" });
    expect(driver.state.prepare("SELECT originator FROM threads WHERE thread_id = ?").get(initial.threadId))
      .toEqual({ originator: "owner" });
    expect(threads.getThread(initial.threadId)?.parentThreadId).toBe("parent");
  });
});
