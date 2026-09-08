import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendCronTask,
  getCronFilePath,
  markCronTasksFired,
  mutateCronFile,
  readCronFile,
  readCronTasks,
  removeCronTasks,
  writeCronTasks,
  type CronTask,
} from "../src/utils/cronTasks.js";
import type { CronDeliveryOccurrence } from "../src/utils/cron-delivery-state.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agenc-cron-transaction-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function task(id: string): CronTask {
  return {
    id,
    cron: "* * * * *",
    prompt: "scheduled work",
    createdAt: 1_000,
    recurring: true,
  };
}

function occurrence(taskId: string): CronDeliveryOccurrence {
  return {
    key: `${taskId}:60000`,
    taskId,
    dueAt: 60_000,
    coalescedAt: 60_000,
    taskFingerprint: "a".repeat(64),
    model: { status: "pending", attempts: 0 },
    webhook: { status: "pending", attempts: 0 },
  };
}

describe("cron file transactions", () => {
  test("serializes concurrent append and stamp operations without losing tasks", async () => {
    await appendCronTask(task("first"), workspace);
    await Promise.all([
      ...Array.from({ length: 20 }, (_, ordinal) =>
        appendCronTask(task(`added-${ordinal}`), workspace),
      ),
      markCronTasksFired(["first"], 75_000, workspace),
    ]);

    const tasks = await readCronTasks(workspace);
    expect(tasks).toHaveLength(21);
    expect(tasks.find((entry) => entry.id === "first")?.lastFiredAt).toBe(75_000);
  });

  test("preserves outbox state across ordinary task writes and removes canceled deliveries", async () => {
    await writeCronTasks([task("delivery"), task("ordinary")], workspace);
    await mutateCronFile(workspace, (state) => {
      state.deliveryOutbox = { version: 1, occurrences: [occurrence("delivery")] };
    });
    await appendCronTask(task("added"), workspace);
    await markCronTasksFired(["ordinary"], 90_000, workspace);
    await removeCronTasks(["added"], workspace);

    expect((await readCronFile(workspace)).deliveryOutbox?.occurrences).toEqual([
      occurrence("delivery"),
    ]);
    await writeCronTasks(await readCronTasks(workspace), workspace);
    expect((await readCronFile(workspace)).deliveryOutbox?.occurrences).toHaveLength(1);
    await removeCronTasks(["delivery"], workspace);
    expect((await readCronFile(workspace)).deliveryOutbox?.occurrences).toEqual([]);
  });

  test("does not publish partial task or outbox changes when a transaction fails", async () => {
    await writeCronTasks([task("kept")], workspace);
    const before = await readFile(getCronFilePath(workspace), "utf8");

    await expect(mutateCronFile(workspace, (state) => {
      state.tasks = [];
      state.deliveryOutbox = { version: 1, occurrences: [occurrence("kept")] };
      throw new Error("before publication");
    })).rejects.toThrow("before publication");
    expect(await readFile(getCronFilePath(workspace), "utf8")).toBe(before);
  });

  test("fails closed on invalid stored outbox state", async () => {
    await writeCronTasks([task("kept")], workspace);
    const invalid = JSON.stringify({ tasks: [task("kept")], deliveryOutbox: { version: 99 } });
    await writeFile(getCronFilePath(workspace), invalid);

    await expect(appendCronTask(task("new"), workspace)).rejects.toThrow("Invalid cron delivery outbox");
    expect(await readFile(getCronFilePath(workspace), "utf8")).toBe(invalid);
  });

  test("publishes private task and payload files", async () => {
    await writeCronTasks([task("private")], workspace);
    if (process.platform !== "win32") {
      expect((await stat(getCronFilePath(workspace))).mode & 0o777).toBe(0o600);
    }
  });
});
