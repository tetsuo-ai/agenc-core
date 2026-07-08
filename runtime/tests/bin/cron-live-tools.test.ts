/**
 * Task 6: the live CronCreate/CronDelete/CronList tools drive the REAL
 * cron scheduler. Before this wiring the live tools only wrote a JSON
 * definition file whose description admitted "an external runner can
 * execute registered jobs" — no runner existed, so nothing ever fired.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelFacingTools } from "./model-facing-tools.js";
import type { Tool } from "../tools/types.js";
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from "../bootstrap/state.js";
import { resetCronSchedulerForTests } from "../utils/cronScheduler.js";
import { listAllCronTasks } from "../utils/cronTasks.js";
import {
  dequeueAll,
  getCommandQueueSnapshot,
} from "../utils/messageQueueManager.js";

let tempRoot: string;

/**
 * The scheduler tick awaits REAL fs I/O (loadTasks / lastFiredAt
 * persistence) between fake-timer hops, so a plain
 * advanceTimersByTimeAsync races the dispatch. Advance in minute steps
 * and yield to the libuv loop between hops so in-flight ticks complete.
 */
async function advanceMinutesWithIo(minutes: number): Promise<void> {
  for (let minute = 0; minute < minutes; minute += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    for (let flush = 0; flush < 20; flush += 1) {
      await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
    }
  }
}

function cronTools(): Map<string, Tool> {
  const tools = createModelFacingTools({
    workspaceRoot: tempRoot,
    getSession: () => null,
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "agenc-cron-live-"));
  setProjectRoot(tempRoot);
  setOriginalCwd(tempRoot);
  setCwdState(tempRoot);
  dequeueAll();
});

afterEach(() => {
  vi.useRealTimers();
  resetCronSchedulerForTests();
  resetStateForTests();
  dequeueAll();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("live Cron tools drive the real scheduler", () => {
  it("CronCreate persists into the scheduler's store; CronList/CronDelete round-trip", async () => {
    const tools = cronTools();
    const created = await tools.get("CronCreate")!.execute({
      cron: "*/5 * * * *",
      prompt: "check the deploy",
      durable: true,
    });
    expect(created.isError).toBeUndefined();
    const createdPayload = JSON.parse(String(created.content)) as {
      cron: { id: string };
    };
    const id = createdPayload.cron.id;
    expect(id).toMatch(/^[a-f0-9]{8}$/);

    // The definition landed in the store the RUNNER reads — not the
    // inert legacy runtime-tools/state.json.
    const stored = await listAllCronTasks(tempRoot);
    expect(stored.map((task) => task.id)).toContain(id);

    const listed = JSON.parse(
      String((await tools.get("CronList")!.execute({})).content),
    ) as { crons: Array<{ id: string; cron: string; prompt: string }> };
    expect(listed.crons).toEqual([
      expect.objectContaining({
        id,
        cron: "*/5 * * * *",
        prompt: "check the deploy",
      }),
    ]);

    const deleted = JSON.parse(
      String((await tools.get("CronDelete")!.execute({ id })).content),
    ) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
    expect(await listAllCronTasks(tempRoot)).toEqual([]);
  });

  it("rejects unparseable cron expressions", async () => {
    const tools = cronTools();
    const result = await tools.get("CronCreate")!.execute({
      cron: "99 99 99 99 99",
      prompt: "never",
    });
    expect(result.isError).toBe(true);
  });

  it("a due job fires: its prompt is enqueued as a session turn", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    // Deterministic jitter.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const tools = cronTools();
      await tools.get("CronCreate")!.execute({
        cron: "* * * * *",
        prompt: "cron fired: run the check",
        durable: true,
        recurring: true,
      });
      expect(getCommandQueueSnapshot()).toHaveLength(0);

      // Advance past the next whole minute (+ scheduler floors/jitter).
      await advanceMinutesWithIo(5);

      const queued = getCommandQueueSnapshot();
      expect(queued.length).toBeGreaterThan(0);
      expect(
        queued.some(
          (command) =>
            typeof command.value === "string" &&
            command.value.includes("cron fired: run the check") &&
            command.mode === "task-notification",
        ),
      ).toBe(true);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("re-arms persisted jobs after a scheduler restart (daemon restart path)", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const tools = cronTools();
      await tools.get("CronCreate")!.execute({
        cron: "* * * * *",
        prompt: "survives restarts",
        durable: true,
        recurring: true,
      });
      // Simulate a daemon restart: the in-memory scheduler dies…
      resetCronSchedulerForTests();
      resetStateForTests();
      setProjectRoot(tempRoot);
      setOriginalCwd(tempRoot);
      setCwdState(tempRoot);
      dequeueAll();

      // …and the bootstrap re-arm path starts a fresh runner from the
      // persisted store.
      const { startCronSchedulerRunner } = await import(
        "./model-facing-tools.js"
      );
      await startCronSchedulerRunner();
      await advanceMinutesWithIo(5);

      const queued = getCommandQueueSnapshot();
      expect(
        queued.some(
          (command) =>
            typeof command.value === "string" &&
            command.value.includes("survives restarts"),
        ),
      ).toBe(true);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
