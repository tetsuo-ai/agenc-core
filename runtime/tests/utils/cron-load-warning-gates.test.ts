import "../helpers/cron-os-home.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetStateForTests, setScheduledTasksEnabled } from "src/bootstrap/state.js";
import { startCronDelivery, type CronDeliveryClock } from "src/gateway/cron-delivery.js";
import { CronScheduler } from "src/utils/cronScheduler.js";
import { logForDebugging } from "src/utils/debug.js";
import type { AgenCConfig } from "src/config/schema.js";
import type { GatewayDaemonClient } from "src/gateway/types.js";

const outbox = vi.hoisted(() => ({ failure: undefined as unknown }));

vi.mock("src/gateway/cron-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/gateway/cron-outbox.js")>()),
  CronDeliveryOutboxStore: class {
    async schedule(): Promise<never> {
      throw outbox.failure;
    }
  },
}));
vi.mock("src/utils/debug.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/utils/debug.js")>()),
  logForDebugging: vi.fn(),
}));

// A Windows `.agenc` whose ACL was rejected: same code as CronStorageAclError.
const unsafeAcl = () => Object.assign(
  new Error("Cron storage must be owned by the current user and not writable by other users: rejected .agenc"),
  { code: "CRON_STORAGE_UNSAFE_ACL" },
);

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "agenc-cron-gates-"));
  mkdirSync(join(workspace, ".agenc"), { mode: 0o700 });
  outbox.failure = unsafeAcl();
  vi.mocked(logForDebugging).mockClear();
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  resetStateForTests();
});

function writeTaskFile(): void {
  writeFileSync(join(workspace, ".agenc", "scheduled_tasks.json"), '{"tasks":[]}\n', { mode: 0o600 });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("gateway cron delivery scan", () => {
  async function scanTwice(): Promise<string[]> {
    const lines: string[] = [];
    const timers: Array<() => void | Promise<void>> = [];
    const clock: CronDeliveryClock = {
      now: () => new Date(Date.parse("2026-10-07T21:00:00Z")),
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    };
    const handle = startCronDelivery({
      agencHome: workspace,
      workspaceDir: workspace,
      config: {} as unknown as AgenCConfig,
      env: {},
      client: {} as unknown as GatewayDaemonClient,
      adapters: [],
      log: (line) => lines.push(line),
      clock,
    });
    await settle();
    // The 5-minute rescan.
    await timers.at(-1)?.();
    await settle();
    await handle.stop();
    return lines.filter((line) => line.startsWith("cron: delivery state unavailable"));
  }

  test("stays quiet for a rejected .agenc with no task file on every scan", async () => {
    expect(await scanTwice()).toEqual([]);
  });

  test("still reports a rejected .agenc that holds a task file", async () => {
    writeTaskFile();
    const lines = await scanTwice();
    // Initial arm, then the rescan's tick and re-arm.
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.includes("rejected .agenc"))).toBe(true);
  });

  test("still reports other delivery state failures", async () => {
    outbox.failure = new Error("state database is corrupt");
    expect(await scanTwice()).toEqual(
      Array.from({ length: 3 }, () => "cron: delivery state unavailable: state database is corrupt"),
    );
  });
});

describe("in-session cron scheduler default load-error report", () => {
  beforeEach(() => {
    setScheduledTasksEnabled(true);
  });

  async function loadOnce(): Promise<string[]> {
    const scheduler = new CronScheduler({
      now: () => 0,
      monotonicNow: () => 0,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      loadTasks: async () => {
        throw outbox.failure;
      },
      enqueue: vi.fn(),
    });
    scheduler.start({
      queueOwner: { kind: "session", conversationId: "cron-gates" },
      workspaceRoot: workspace,
    });
    await settle();
    scheduler.stop();
    return vi.mocked(logForDebugging).mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[CronScheduler] durable scheduled tasks unavailable"));
  }

  test("stays quiet for a rejected .agenc with no task file", async () => {
    expect(await loadOnce()).toEqual([]);
  });

  test("still warns for a rejected .agenc that holds a task file", async () => {
    writeTaskFile();
    expect(await loadOnce()).toEqual([
      "[CronScheduler] durable scheduled tasks unavailable: Cron storage must be owned by the current user and not writable by other users: rejected .agenc",
    ]);
  });
});
