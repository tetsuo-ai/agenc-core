/**
 * Gateway cron delivery tests (TODO task 16).
 *
 * Delivery-tagged cron tasks run in isolated gateway daemon sessions and
 * route their result to a channel adapter and/or webhook POST. Restart
 * re-arms from the persisted `.agenc/scheduled_tasks.json` and delivery
 * still routes. Budget refusal pauses the fire instead of running the turn.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  startCronDelivery,
  type CronDeliveryClock,
} from "../../src/gateway/cron-delivery.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayDaemonClient,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
  GatewaySessionCreateOptions,
} from "../../src/gateway/types.js";
import {
  addCronTask,
  readCronTasks,
  normalizeDelivery,
} from "../../src/utils/cronTasks.js";
import type { AgenCConfig } from "../../src/config/schema.js";

class EchoSession implements GatewaySession {
  readonly sessionId: string;
  readonly reply: string;
  prompts: string[] = [];
  constructor(sessionId: string, reply: string) {
    this.sessionId = sessionId;
    this.reply = reply;
  }
  async prompt(
    text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult> {
    this.prompts.push(text);
    await handlers.onEvent({ type: "text", delta: this.reply });
    return {
      stopReason: "completed",
      finalMessage: this.reply,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

class RecordingClient implements GatewayDaemonClient {
  created = 0;
  attached: string[] = [];
  labels: (string | undefined)[] = [];
  readonly sessions: EchoSession[] = [];
  readonly reply: string;
  constructor(reply = "cron result") {
    this.reply = reply;
  }
  async createSession(
    options?: GatewaySessionCreateOptions,
  ): Promise<GatewaySession> {
    this.created += 1;
    this.labels.push(options?.label);
    const s = new EchoSession(`cron-sess-${this.created}`, this.reply);
    this.sessions.push(s);
    return s;
  }
  async attachSession(sessionId: string): Promise<GatewaySession> {
    this.attached.push(sessionId);
    const s = new EchoSession(sessionId, this.reply);
    this.sessions.push(s);
    return s;
  }
  async close(): Promise<void> {}
}

/** Manual clock: fires armed timers when advanced past their deadline. */
function manualClock(startMs: number): {
  clock: CronDeliveryClock;
  advance(ms: number): Promise<void>;
} {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  // The runner's arm()/tick() await real fs I/O (readCronTasks), which
  // resolves on the macrotask queue — hop it, not just microtasks, or the
  // armed timer is invisible to advance().
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return {
    clock: {
      now: () => new Date(now),
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (handle) => {
        timers.delete(handle as unknown as number);
      },
    },
    async advance(ms: number) {
      const target = now + ms;
      await flush();
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const t = timers.get(dueId)!;
        timers.delete(dueId);
        now = t.at;
        t.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const NO_BUDGET_CONFIG = {} as unknown as AgenCConfig;

describe("startCronDelivery", () => {
  let home: string;
  let ws: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-cron-del-"));
    ws = join(home, "ws");
    mkdirSync(join(ws, ".agenc"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function writeTasks(tasks: object[]): void {
    writeFileSync(
      join(ws, ".agenc", "scheduled_tasks.json"),
      JSON.stringify({ tasks }, null, 2),
    );
  }

  function baseOptions(client: GatewayDaemonClient, mem: InMemoryChannelAdapter) {
    return {
      agencHome: home,
      workspaceDir: ws,
      config: NO_BUDGET_CONFIG,
      env: {},
      client,
      adapters: [mem] as const,
    };
  }

  test("fake-clock fire: posts the result to the channel and stamps lastFiredAt", async () => {
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeTasks([
      {
        id: "cronch01",
        cron: "* * * * *", // every minute
        prompt: "summarize the day",
        createdAt: startMs - 1_000,
        recurring: true,
        deliver: { channel: "mem", to: "ops" },
      },
    ]);
    const client = new RecordingClient("all quiet");
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    const { clock, advance } = manualClock(startMs);

    const handle = startCronDelivery({ ...baseOptions(client, mem), clock });
    // 70s crosses exactly ONE minute boundary (10:01:00) — 90s would land on
    // 10:02:00 and legitimately fire twice.
    await advance(70_000);

    expect(mem.lastText("ops")).toBe("all quiet");
    // Turn ran in an ISOLATED gateway session labeled for the task.
    expect(client.labels).toEqual(["cron|default|cronch01"]);
    expect(client.sessions[0].prompts).toEqual(["summarize the day"]);
    // lastFiredAt persisted → restart will not replay this occurrence.
    const persisted = await readCronTasks(ws);
    expect(persisted[0].lastFiredAt).toBeGreaterThanOrEqual(startMs);
    await handle.stop();
  });

  test("restart re-arms from disk and delivery still routes (acceptance)", async () => {
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeTasks([
      {
        id: "cronch02",
        cron: "* * * * *",
        prompt: "tick",
        createdAt: startMs - 1_000,
        recurring: true,
        deliver: { channel: "mem", to: "ops" },
      },
    ]);
    const client1 = new RecordingClient("first run");
    const mem1 = new InMemoryChannelAdapter({ id: "mem" });
    const t1 = manualClock(startMs);
    const h1 = startCronDelivery({
      ...baseOptions(client1, mem1),
      clock: t1.clock,
    });
    await t1.advance(90_000);
    expect(mem1.lastText("ops")).toBe("first run");
    await h1.stop();

    // Simulated gateway restart: fresh runner over the same workspace. It
    // must re-arm from the persisted file, reattach the persisted session
    // (no new daemon agent), and route the NEXT occurrence.
    const client2 = new RecordingClient("second run");
    const mem2 = new InMemoryChannelAdapter({ id: "mem" });
    const t2 = manualClock(startMs + 90_000);
    const h2 = startCronDelivery({
      ...baseOptions(client2, mem2),
      clock: t2.clock,
    });
    await t2.advance(120_000);
    expect(mem2.lastText("ops")).toBe("second run");
    expect(client2.created).toBe(0); // reattached, not re-provisioned
    expect(client2.attached).toEqual(["cron-sess-1"]);
    await h2.stop();
  });

  test("one-shot: fires once, delivers, and deletes itself", async () => {
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeTasks([
      {
        id: "cronch03",
        cron: "* * * * *",
        prompt: "one shot",
        createdAt: startMs - 1_000,
        deliver: { channel: "mem", to: "ops" },
      },
    ]);
    const client = new RecordingClient("done once");
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    const { clock, advance } = manualClock(startMs);
    const handle = startCronDelivery({ ...baseOptions(client, mem), clock });

    await advance(90_000);
    expect(mem.lastText("ops")).toBe("done once");
    expect(await readCronTasks(ws)).toHaveLength(0);

    // No further fires after deletion.
    await advance(180_000);
    expect(mem.sent.filter((m) => m.text === "done once")).toHaveLength(1);
    await handle.stop();
  });

  test("webhook delivery POSTs the result as JSON (webhook-only task)", async () => {
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeTasks([
      {
        id: "cronch04",
        cron: "* * * * *",
        prompt: "report",
        createdAt: startMs - 1_000,
        recurring: true,
        deliver: { webhook: "https://hooks.example/cron" },
      },
    ]);
    const client = new RecordingClient("webhook payload");
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    const { clock, advance } = manualClock(startMs);
    const posts: { url: string; body: unknown }[] = [];
    const handle = startCronDelivery({
      ...baseOptions(client, mem),
      clock,
      postWebhook: async (url, body) => {
        posts.push({ url, body });
      },
    });

    await advance(70_000); // exactly one minute boundary
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.example/cron");
    expect(posts[0].body).toMatchObject({
      taskId: "cronch04",
      prompt: "report",
      finalMessage: "webhook payload",
      stopReason: "completed",
    });
    // Webhook-only: nothing went to any channel.
    expect(mem.sent).toHaveLength(0);
    await handle.stop();
  });

  test("BUDGET REFUSAL: the turn does NOT run; a paused notice is delivered", async () => {
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeTasks([
      {
        id: "cronch05",
        cron: "* * * * *",
        prompt: "expensive work",
        createdAt: startMs - 1_000,
        recurring: true,
        deliver: { channel: "mem", to: "ops" },
      },
    ]);
    const client = new RecordingClient("should never run");
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    const { clock, advance } = manualClock(startMs);
    const handle = startCronDelivery({
      ...baseOptions(client, mem),
      config: {
        budget: { enabled: true, daily_tokens: 1 },
      } as unknown as AgenCConfig,
      clock,
    });

    await advance(90_000);
    // No session, no turn — the refusal happened before any daemon work.
    expect(client.created).toBe(0);
    const last = mem.lastText("ops") ?? "";
    expect(last).toContain("paused");
    await handle.stop();
  });

  test("unknown channel: fire is skipped gracefully without crashing", async () => {
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeTasks([
      {
        id: "cronch06",
        cron: "* * * * *",
        prompt: "hello",
        createdAt: startMs - 1_000,
        recurring: true,
        deliver: { channel: "nope", to: "x" },
      },
    ]);
    const client = new RecordingClient("orphan");
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    const { clock, advance } = manualClock(startMs);
    const lines: string[] = [];
    const handle = startCronDelivery({
      ...baseOptions(client, mem),
      clock,
      log: (l) => lines.push(l),
    });

    await advance(90_000);
    expect(mem.sent).toHaveLength(0);
    expect(lines.some((l) => l.includes("unknown channel"))).toBe(true);
    await handle.stop();
  });
});

describe("cron task delivery persistence", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "agenc-cron-tasks-"));
    mkdirSync(join(ws, ".agenc"), { recursive: true });
  });
  afterEach(async () => {
    const { resetStateForTests } = await import("../../src/bootstrap/state.js");
    resetStateForTests();
    rmSync(ws, { recursive: true, force: true });
  });

  test("addCronTask persists deliver and readCronTasks round-trips it", async () => {
    const { setProjectRoot } = await import("../../src/bootstrap/state.js");
    setProjectRoot(ws);
    await addCronTask("* * * * *", "p", true, true, undefined, {
      channel: "telegram",
      to: "123",
      webhook: "https://hooks.example/x",
    });
    const tasks = await readCronTasks(ws);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].deliver).toEqual({
      channel: "telegram",
      to: "123",
      webhook: "https://hooks.example/x",
    });
  });

  test("normalizeDelivery: channel requires to; webhook must be http(s)", () => {
    expect(normalizeDelivery({ channel: "tg" })).toBeUndefined();
    expect(normalizeDelivery({ channel: "tg", to: "1" })).toEqual({
      channel: "tg",
      to: "1",
    });
    expect(normalizeDelivery({ webhook: "ftp://x" })).toBeUndefined();
    expect(normalizeDelivery({ webhook: "https://x.example" })).toEqual({
      webhook: "https://x.example",
    });
    expect(normalizeDelivery(undefined)).toBeUndefined();
    expect(normalizeDelivery("junk")).toBeUndefined();
  });

  test("malformed on-disk deliver degrades to a plain task (no misroute)", async () => {
    writeFileSync(
      join(ws, ".agenc", "scheduled_tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: "aaaa0001",
            cron: "* * * * *",
            prompt: "p",
            createdAt: 1,
            deliver: { channel: 42 },
          },
        ],
      }),
    );
    const tasks = await readCronTasks(ws);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].deliver).toBeUndefined();
  });
});
