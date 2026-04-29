import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import {
  createNew,
  tasksDir,
  updateOne,
  type ListedTask,
  type TaskStoreOptions,
} from "../../bin/task-store.js";
import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { useTasksList } from "./useTasksList.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(
  element: React.ReactElement,
): Promise<{ unmount: () => void; stdout: PassThrough }> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    stdout,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

describe("useTasksList", () => {
  test("re-reads on onTasksUpdated emission", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tui-task-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "agenc-tui-task-workspace-"),
    );
    const opts: TaskStoreOptions = { workspaceRoot: workspace, agencHome: home };
    const observed: Array<readonly ListedTask[] | undefined> = [];

    function Consumer(): null {
      const tasks = useTasksList({ opts });
      observed.push(tasks);
      return null;
    }

    try {
      const { unmount } = await mount(<Consumer />);
      // Initial render reports the loading/empty snapshot.
      expect(observed[0]).toEqual([]);

      const created = await createNew(opts, { subject: "first" });
      // Allow the signal-driven re-read to flush.
      await new Promise((r) => setTimeout(r, 100));
      const latestAfterCreate = observed[observed.length - 1] ?? [];
      expect(latestAfterCreate.map((t) => t.id)).toEqual([created.id]);

      await updateOne(opts, created.id, { status: "completed" });
      await new Promise((r) => setTimeout(r, 100));
      const latestAfterUpdate = observed[observed.length - 1] ?? [];
      expect(latestAfterUpdate[0]?.status).toBe("completed");

      unmount();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("re-reads when the task directory changes outside the process", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tui-task-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "agenc-tui-task-workspace-"),
    );
    const opts: TaskStoreOptions = { workspaceRoot: workspace, agencHome: home };
    const observed: Array<readonly ListedTask[] | undefined> = [];

    function Consumer(): null {
      const tasks = useTasksList({ opts });
      observed.push(tasks);
      return null;
    }

    try {
      const { unmount } = await mount(<Consumer />);
      const dir = tasksDir(opts);
      await mkdir(dir, { recursive: true });
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(
        join(dir, "1.json"),
        `${JSON.stringify(
          {
            id: "1",
            subject: "external",
            description: "",
            status: "pending",
            blocks: [],
            blockedBy: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await new Promise((r) => setTimeout(r, 150));
      const latest = observed[observed.length - 1] ?? [];
      expect(latest.map((task) => task.subject)).toContain("external");

      unmount();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
