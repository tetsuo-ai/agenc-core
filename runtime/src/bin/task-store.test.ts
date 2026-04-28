import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNew,
  deriveUnresolvedBlockers,
  listWithUnresolved,
  loadAll,
  loadOne,
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

      expect(created.id).toMatch(/^task-\d+$/);
      expect(created.status).toBe("pending");
      expect(created.owner).toBe("/root/task_3");
      expect(created.metadata).toEqual({ ticket: "ABC-7" });
      expect(created.blocks).toEqual([]);
      expect(created.blockedBy).toEqual([]);
      expect(created.createdAt).toEqual(created.updatedAt);

      const loaded = await loadOne(opts, created.id);
      expect(loaded).toEqual(created);

      const all = await loadAll(opts);
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(created.id);
    });
  });

  it("allocates unique ids under concurrent creates", async () => {
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

      const files = await readdir(tasksDir(opts));
      const taskFiles = files.filter((name) => name.startsWith("task-"));
      expect(taskFiles).toHaveLength(5);
    });
  });

  it("returns null for missing or malformed ids", async () => {
    await withTempStore(async (opts) => {
      expect(await loadOne(opts, "task-9999")).toBeNull();
      expect(await loadOne(opts, "not-a-task")).toBeNull();
    });
  });

  it("ignores foreign files in the tasks directory", async () => {
    await withTempStore(async (opts) => {
      await createNew(opts, { subject: "real" });
      const dir = tasksDir(opts);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "garbage.json"), "{}", "utf8");
      await writeFile(join(dir, "task-bogus.json"), '{"id":"task-bogus"}', "utf8");
      const all = await loadAll(opts);
      expect(all).toHaveLength(1);
      expect(all[0]?.subject).toBe("real");
    });
  });

  it("updateOne reports Task not found for missing id", async () => {
    await withTempStore(async (opts) => {
      const outcome = await updateOne(opts, "task-9999", { status: "completed" });
      expect(outcome.task).toBeUndefined();
      expect(outcome.error?.message).toBe("Task not found");
    });
  });

  it("rejects unknown task references when adding dependencies", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const outcome = await updateOne(opts, a.id, {
        addBlocks: ["task-9999"],
      });
      expect(outcome.task).toBeUndefined();
      expect(outcome.error?.message).toBe("Unknown task reference");
      expect(outcome.error?.missing).toEqual(["task-9999"]);
    });
  });

  it("rejects self-references on dependency adds", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const outcome = await updateOne(opts, a.id, { addBlocks: [a.id] });
      expect(outcome.error?.message).toContain("Self-reference");
    });
  });

  it("rejects edges to deleted tasks", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      await updateOne(opts, b.id, { status: "deleted" });
      const outcome = await updateOne(opts, a.id, { addBlocks: [b.id] });
      expect(outcome.error?.message).toBe("Unknown task reference");
      expect(outcome.error?.missing).toEqual([b.id]);
    });
  });

  it("dedupes added dependency ids", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });

      const first = await updateOne(opts, a.id, { addBlocks: [b.id] });
      expect(first.task?.blocks).toEqual([b.id]);

      const second = await updateOne(opts, a.id, { addBlocks: [b.id, b.id] });
      expect(second.task?.blocks).toEqual([b.id]);
    });
  });

  it("applies remove + add in the same call", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      const c = await createNew(opts, { subject: "C" });

      await updateOne(opts, a.id, { addBlocks: [b.id] });
      const swapped = await updateOne(opts, a.id, {
        addBlocks: [c.id],
        removeBlocks: [b.id],
      });
      expect(swapped.task?.blocks).toEqual([c.id]);
    });
  });

  it("merges metadata partially and clears owner with null", async () => {
    await withTempStore(async (opts) => {
      const t = await createNew(opts, {
        subject: "A",
        owner: "/root/task_1",
        metadata: { kept: 1, replaced: 1 },
      });
      const result = await updateOne(opts, t.id, {
        owner: null,
        metadata: { replaced: 2, added: 3 },
      });
      expect(result.task?.owner).toBeUndefined();
      expect(result.task?.metadata).toEqual({ kept: 1, replaced: 2, added: 3 });
    });
  });

  it("tombstones deleted tasks (loadOne still returns them)", async () => {
    await withTempStore(async (opts) => {
      const t = await createNew(opts, { subject: "A" });
      await updateOne(opts, t.id, { status: "deleted" });
      const reloaded = await loadOne(opts, t.id);
      expect(reloaded?.status).toBe("deleted");
    });
  });

  it("listWithUnresolved hides deleted by default", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      await updateOne(opts, b.id, { status: "deleted" });

      const visible = await listWithUnresolved(opts);
      expect(visible.map((t) => t.id)).toEqual([a.id]);

      const withDeleted = await listWithUnresolved(opts, { includeDeleted: true });
      expect(withDeleted.map((t) => t.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );

      const onlyDeleted = await listWithUnresolved(opts, { status: "deleted" });
      expect(onlyDeleted.map((t) => t.id)).toEqual([b.id]);
    });
  });

  it("derives unresolvedBlockers correctly", async () => {
    await withTempStore(async (opts) => {
      const a = await createNew(opts, { subject: "A" });
      const b = await createNew(opts, { subject: "B" });
      const c = await createNew(opts, { subject: "C" });

      // T blocked by A (pending), B (completed), and a missing id.
      const t = await createNew(opts, { subject: "T" });
      await updateOne(opts, t.id, { addBlockedBy: [a.id, b.id] });
      // Manually inject a stale blocker by directly editing the file
      // — simulates a deleted-then-removed-from-disk blocker.
      const path = join(tasksDir(opts), `${t.id}.json`);
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as StoredTask;
      const tampered: StoredTask = {
        ...parsed,
        blockedBy: [...parsed.blockedBy, "task-9999"],
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify(tampered), "utf8");

      // Mark B completed.
      await updateOne(opts, b.id, { status: "completed" });

      const list = await listWithUnresolved(opts);
      const tListed = list.find((task) => task.id === t.id);
      expect(tListed?.unresolvedBlockers).toEqual([a.id]);

      // C is unaffected.
      const cListed = list.find((task) => task.id === c.id);
      expect(cListed?.unresolvedBlockers).toEqual([]);
    });
  });

  it("deriveUnresolvedBlockers is pure over its inputs", () => {
    const taskA: StoredTask = {
      id: "task-1",
      subject: "A",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: ["task-2", "task-3", "task-4"],
      createdAt: "0",
      updatedAt: "0",
    };
    const byId = new Map<string, StoredTask>([
      [
        "task-2",
        {
          id: "task-2",
          subject: "B",
          description: "",
          status: "completed",
          blocks: [],
          blockedBy: [],
          createdAt: "0",
          updatedAt: "0",
        },
      ],
      [
        "task-3",
        {
          id: "task-3",
          subject: "C",
          description: "",
          status: "in_progress",
          blocks: [],
          blockedBy: [],
          createdAt: "0",
          updatedAt: "0",
        },
      ],
      [
        "task-4",
        {
          id: "task-4",
          subject: "D",
          description: "",
          status: "deleted",
          blocks: [],
          blockedBy: [],
          createdAt: "0",
          updatedAt: "0",
        },
      ],
    ]);
    expect(deriveUnresolvedBlockers(taskA, byId)).toEqual(["task-3"]);
  });
});
