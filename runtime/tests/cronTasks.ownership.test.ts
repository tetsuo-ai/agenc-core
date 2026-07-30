import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resetStateForTests } from "../src/bootstrap/state.js";
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  removeCronTasks,
} from "../src/utils/cronTasks.js";

const ownerA = {
  kind: "session",
  conversationId: "cron-owner-a",
} as const;
const ownerB = {
  kind: "session",
  conversationId: "cron-owner-b",
} as const;

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-cron-owner-"));
});

afterEach(async () => {
  resetStateForTests();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("cron task ownership", () => {
  test("session tasks are visible and removable only by their creator", async () => {
    const id = await addCronTask(
      "* * * * *",
      "owned reminder",
      true,
      false,
      undefined,
      undefined,
      ownerA,
      workspaceRoot,
    );

    expect(
      (await listAllCronTasks(workspaceRoot, ownerA.conversationId)).map(
        (task) => task.id,
      ),
    ).toEqual([id]);
    expect(
      await listAllCronTasks(workspaceRoot, ownerB.conversationId),
    ).toEqual([]);

    await removeCronTasks([id], workspaceRoot, ownerB.conversationId);
    expect(
      (await listAllCronTasks(workspaceRoot, ownerA.conversationId)).map(
        (task) => task.id,
      ),
    ).toEqual([id]);

    await removeCronTasks([id], workspaceRoot, ownerA.conversationId);
    expect(
      await listAllCronTasks(workspaceRoot, ownerA.conversationId),
    ).toEqual([]);
  });

  test("durable files never persist runtime conversation or teammate routing", async () => {
    await addCronTask(
      "* * * * *",
      "durable reminder",
      true,
      true,
      "runtime-agent",
      undefined,
      ownerA,
      workspaceRoot,
    );

    const parsed = JSON.parse(
      await readFile(getCronFilePath(workspaceRoot), "utf8"),
    ) as { tasks: Array<Record<string, unknown>> };
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]).not.toHaveProperty("queueOwner");
    expect(parsed.tasks[0]).not.toHaveProperty("agentId");
    expect(parsed.tasks[0]).not.toHaveProperty("durable");
  });
});
