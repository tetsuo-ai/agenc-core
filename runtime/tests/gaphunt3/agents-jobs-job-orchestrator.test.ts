import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordAgentJobResult,
  runAgentsOnCsv,
  type AgentJobSpawn,
} from "src/agents/jobs/job-orchestrator";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agenc-gaphunt3-job-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Spawn that reports a result for every item on the next microtask, the
 * normal fast path (workers report well before max_runtime_seconds).
 */
function fastSpawnReporter(): AgentJobSpawn {
  return {
    async spawn(ctx) {
      queueMicrotask(() => {
        recordAgentJobResult({
          jobId: ctx.jobId,
          itemId: ctx.itemId,
          result: { echoed: ctx.row.value ?? "" },
        });
      });
    },
    async cancelOutstanding() {},
  };
}

describe("gaphunt3 #6: per-item runtime watchdog timer is cleared on completion", () => {
  it("leaves no armed watchdog timers after every row completes normally", async () => {
    // Fake timers so we can count the watchdog setTimeouts the orchestrator
    // arms per item. The spawn reporter resolves via queueMicrotask (not a
    // timer), so completion does not depend on the fake clock.
    vi.useFakeTimers();

    const csvPath = join(workDir, "input.csv");
    await writeFile(
      csvPath,
      "id,value\nrow1,a\nrow2,b\nrow3,c\nrow4,d\nrow5,e\n",
      "utf8",
    );

    const result = await runAgentsOnCsv({
      csvPath,
      instruction: "process {value}",
      idColumn: "id",
      // Large runtime budget; each watchdog would otherwise stay armed for
      // this whole window after its item already completed.
      maxRuntimeSeconds: 1800,
      spawn: fastSpawnReporter(),
    });

    expect(result.items.every((item) => item.status === "completed")).toBe(
      true,
    );

    // With the fix, every per-item watchdog setTimeout is cleared in the
    // finally block once completion wins the race. Before the fix the handle
    // is discarded and never cleared, so each completed row leaves one armed
    // timer. Assert no timers survive the resolved run.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fire a 'exceeded max_runtime_seconds' rejection after completion", async () => {
    vi.useFakeTimers();

    const csvPath = join(workDir, "input.csv");
    await writeFile(csvPath, "id,value\nrow1,a\nrow2,b\n", "utf8");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const result = await runAgentsOnCsv({
        csvPath,
        instruction: "process {value}",
        idColumn: "id",
        maxRuntimeSeconds: 1800,
        spawn: fastSpawnReporter(),
      });

      expect(result.items.every((item) => item.status === "completed")).toBe(
        true,
      );

      // Advance well past the runtime budget. With the fix there are no armed
      // watchdog timers, so nothing fires. Before the fix the leaked watchdog
      // timers would each reject with "exceeded max_runtime_seconds" — and
      // because the race they lost is gone, those rejections are unhandled.
      vi.advanceTimersByTime(1800 * 1000 + 1000);
      // Let any microtasks queued by a stray rejection settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(vi.getTimerCount()).toBe(0);
      const runtimeRejections = unhandled.filter(
        (reason) =>
          reason instanceof Error &&
          reason.message.includes("exceeded max_runtime_seconds"),
      );
      expect(runtimeRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
