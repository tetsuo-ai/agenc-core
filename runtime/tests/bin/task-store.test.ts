import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNew,
  deleteTask,
  deriveUnresolvedBlockers,
  listWithUnresolved,
  loadAll,
  loadOne,
  onTasksUpdated,
  tasksDir,
  updateOne,
  type StoredTask,
  type TaskStoreOptions,
} from "./task-store.js";

async function withTempStore<T>(
  fn: (opts: TaskStoreOptions) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "agenc-task-store-"));
  const workspace = await mkdtemp(join(tmpdir(), "agenc-task-workspace-"));
  try {
    return await fn({ workspaceRoot: workspace, agencHome: home });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("task-store", () => {
  it("creates and round-trips a task with all fields", async () => {
    await withTempStore(async (opts) => {
      const created = await createNew(opts, {
        subject: "Wire dashboard",
        description: "Connect metrics to the home page",
        activeForm: "Wiring dashboard",
        owner: "/root/task_3",
        metadata: { ticket: "ABC-7" },
      });

      expect(created.id).toMatch(/^\d+$/);
      expect(created.id).toBe("1");
      expect(created.status).toBe("pending");
      expect(created.owner).toBe("/root/task_3");
      expect(created.metadata).toEqual({ ticket: "ABC-7" });
      expect(created.blocks).toEqual([]);
      expect(created.blockedBy).toEqual([]);
      expect(created).not.toHaveProperty("createdAt");
      expect(created).not.toHaveProperty("updatedAt");

      const loaded = await loadOne(opts, created.id);
      expect(loaded).toEqual(created);

      const all = await loadAll(opts);
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(created.id);
    });
  });

  it("allocates sequential ids under concurrent creates", async () => {
    await withTempStore(async (opts) => {
      const results = await Promise.all([
        createNew(opts, { subject: "A" }),
        createNew(opts, { subject: "B" }),
        createNew(opts, { subject: "C" }),
        createNew(opts, { subject: "D" }),
        createNew(opts, { subject: "E" }),
      ]);
      const ids = new Set(results.map((task) => task.id));
      expect(ids.size).toBe(5);
      expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);

      const files = await readdir(tasksDir(opts));
      const taskFiles = files.filter((name) => name.endsWith(".json"));
      expect(taskFiles).toHaveLength(5);
    });
  });

  it("never recycles deleted ids", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      expect(a.id).toBe("1");
      expect(b.id).toBe("2");
      const deleted = await deleteTask(opts, b.id);
      expect(deleted.deleted).toBe(true);
      expect(await loadOne(opts, b.id)).toBeNull();
      const c = await createNew(opts, { subject: "C" });
      expect(c.id).toBe("3");
    });
  });

  it("returns null for missing or malformed ids", async () => {
    await withTempStore(async (opts) => {
      expect(await loadOne(opts, "9999")).toBeNull();
      expect(await loadOne(opts, "not-a-task")).toBeNull();
    });
  });

  it("ignores foreign files in the tasks directory", async () => {
    await withTempStore(async (opts) => {
      await createNew(opts, { subject: "real" });
      const dir = tasksDir(opts);
      await writeFile(join(dir, "garbage.json"), "{}", "utf8");
      await writeFile(join(dir, "task-bogus.json"), '{"id":"task-bogus"}', "utf8");
      const all = await loadAll(opts);
      expect(all).toHaveLength(1);
      expect(all[0]?.subject).toBe("real");
    });
  });

  it("rejects persisted tasks with array-shaped metadata", async () => {
    await withTempStore(async (opts) => {
      const created = await createNew(opts, {
        subject: "metadata",
        metadata: { owner: "agent" },
      });
      await writeFile(
        join(tasksDir(opts), `${created.id}.json`),
        `${JSON.stringify({ ...created, metadata: [] }, null, 2)}\n`,
        "utf8",
      );

      expect(await loadOne(opts, created.id)).toBeNull();
      expect(await loadAll(opts)).toEqual([]);
    });
  });

  it("updateOne reports Task not found for missing id", async () => {
    await withTempStore(async (opts) => {
      const outcome = await updateOne(opts, "9999", { status: "completed" });
      expect(outcome.task).toBeUndefined();
      expect(outcome.error?.message).toBe("Task not found");
    });
  });

  it("rejects unknown task references when adding dependencies", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const outcome = await updateOne(opts, a.id, {
        subject: "should not persist",
        addBlocks: ["9999"],
      });
      expect(outcome.task).toBeUndefined();
      expect(outcome.error?.message).toBe("Unknown task reference");
      expect(outcome.error?.missing).toEqual(["9999"]);
      expect((await loadOne(opts, a.id))?.subject).toBe("A");
    });
  });

  it("rejects self-references on dependency adds", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const outcome = await updateOne(opts, a.id, { addBlocks: [a.id] });
      expect(outcome.error?.message).toContain("Self-reference");
    });
  });

  it("rejects edges to physically deleted tasks", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      await updateOne(opts, b.id, { status: "deleted" });
      const outcome = await updateOne(opts, a.id, { addBlocks: [b.id] });
      expect(outcome.error?.message).toBe("Unknown task reference");
      expect(outcome.error?.missing).toEqual([b.id]);
    });
  });

  it("auto-mirrors addBlocks on both endpoints", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });

      const result = await updateOne(opts, a.id, { addBlocks: [b.id] });
      expect(result.task?.blocks).toEqual([b.id]);

      const reloadedA = await loadOne(opts, a.id);
      const reloadedB = await loadOne(opts, b.id);
      expect(reloadedA?.blocks).toEqual([b.id]);
      expect(reloadedB?.blockedBy).toEqual([a.id]);
    });
  });

  it("auto-mirrors addBlockedBy with the inverse direction", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });

      // "A is blockedBy B" means B blocks A.
      const result = await updateOne(opts, a.id, { addBlockedBy: [b.id] });
      expect(result.task?.blockedBy).toEqual([b.id]);

      const reloadedB = await loadOne(opts, b.id);
      expect(reloadedB?.blocks).toEqual([a.id]);
    });
  });

  it("dedupes duplicate edge adds", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });

      await updateOne(opts, a.id, { addBlocks: [b.id] });
      const second = await updateOne(opts, a.id, { addBlocks: [b.id, b.id] });
      expect(second.task?.blocks).toEqual([b.id]);

      const reloadedB = await loadOne(opts, b.id);
      expect(reloadedB?.blockedBy).toEqual([a.id]);
    });
  });

  it("merges metadata partially, deletes null metadata keys, and clears owner", async () => {
    await withTempStore(async (opts) => {
      const t = await createNew(opts, {
        subject: "A",
        owner: "/root/task_1",
        metadata: { kept: 1, replaced: 1 },
      });
      const result = await updateOne(opts, t.id, {
        owner: null,
        metadata: { kept: null, replaced: 2, added: 3 },
      });
      expect(result.task?.owner).toBeUndefined();
      expect(result.task?.metadata).toEqual({ replaced: 2, added: 3 });
    });
  });

  it("physically deletes tasks through the deleted status action", async () => {
    await withTempStore(async (opts) => {
      const t = await createNew(opts, { subject: "A" });
      const outcome = await updateOne(opts, t.id, { status: "deleted" });
      expect(outcome.deleted).toBe(true);
      const reloaded = await loadOne(opts, t.id);
      expect(reloaded).toBeNull();
    });
  });

  it("ignores legacy deleted tombstones when loading and listing", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      const tombstone = {
        ...b,
        status: "deleted",
      };
      await writeFile(
        join(tasksDir(opts), `${b.id}.json`),
        `${JSON.stringify(tombstone, null, 2)}\n`,
        "utf8",
      );

      expect(await loadOne(opts, b.id)).toBeNull();
      expect((await loadAll(opts)).map((t) => t.id)).toEqual([a.id]);

      const visible = await listWithUnresolved(opts);
      expect(visible.map((t) => t.id)).toEqual([a.id]);

      const c = await createNew(opts, { subject: "C" });
      expect(c.id).toBe("3");
    });
  });

  it("cascades dependency references when deleting a task", async () => {
    await withTempStore(async (opts) => {
      const blocker = await createNew(opts, { subject: "Blocker" });
      const target = await createNew(opts, { subject: "Target" });
      const downstream = await createNew(opts, { subject: "Downstream" });

      await updateOne(opts, blocker.id, { addBlocks: [target.id, downstream.id] });
      await updateOne(opts, target.id, { addBlocks: [downstream.id] });

      await updateOne(opts, target.id, { status: "deleted" });

      expect((await loadOne(opts, blocker.id))?.blocks).toEqual([downstream.id]);
      expect((await loadOne(opts, downstream.id))?.blockedBy).toEqual([
        blocker.id,
      ]);
    });
  });

  it("derives unresolvedBlockers correctly", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      const c = await createNew(opts, { subject: "C" });

      const t = await createNew(opts, { subject: "T" });
      await updateOne(opts, t.id, { addBlockedBy: [a.id, b.id] });

      // Inject a stale reference (simulates a blocker file removed
      // out of band).
      const path = join(tasksDir(opts), `${t.id}.json`);
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as StoredTask;
      const tampered: StoredTask = {
        ...parsed,
        blockedBy: [...parsed.blockedBy, "9999"],
      };
      await writeFile(path, JSON.stringify(tampered), "utf8");

      await updateOne(opts, b.id, { status: "completed" });

      const list = await listWithUnresolved(opts);
      const tListed = list.find((task) => task.id === t.id);
      expect(tListed?.unresolvedBlockers).toEqual([a.id]);

      const cListed = list.find((task) => task.id === c.id);
      expect(cListed?.unresolvedBlockers).toEqual([]);
    });
  });

  it("deriveUnresolvedBlockers is pure over its inputs", () => {
    const taskA: StoredTask = {
      id: "1",
      subject: "A",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: ["2", "3", "4"],
    };
    const byId = new Map<string, StoredTask>([
      [
        "2",
        {
          id: "2",
          subject: "B",
          description: "",
          status: "completed",
          blocks: [],
          blockedBy: [],
        },
      ],
      [
        "3",
        {
          id: "3",
          subject: "C",
          description: "",
          status: "in_progress",
          blocks: [],
          blockedBy: [],
        },
      ],
    ]);
    expect(deriveUnresolvedBlockers(taskA, byId)).toEqual(["3"]);
  });

  it("emits onTasksUpdated on create and update", async () => {
    await withTempStore(async (opts) => {
      let count = 0;
      const unsubscribe = onTasksUpdated(() => {
        count += 1;
      });
      try {
        const t = await createNew(opts, { subject: "A" });
        expect(count).toBe(1);
        await updateOne(opts, t.id, { status: "in_progress" });
        expect(count).toBe(2);
      } finally {
        unsubscribe();
      }
    });
  });
});
