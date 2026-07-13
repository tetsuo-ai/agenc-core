// Heartbeat (TODO task 14). The gates + the budget wire-in are the point:
// admit -> run -> reconcile; a budget refusal skips the turn and delivers a
// paused notice; HEARTBEAT_OK suppresses delivery.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  resolveHeartbeatPolicy,
  parseActiveHours,
  parseTarget,
} from "../../src/heartbeat/config.js";
import { HeartbeatRunner, heartbeatPrompt } from "../../src/heartbeat/runner.js";
import { HeartbeatScheduler } from "../../src/heartbeat/scheduler.js";
import { WorkspaceHeartbeatFileReader } from "../../src/heartbeat/heartbeat-file.js";
import {
  HEARTBEAT_OK,
  type HeartbeatBudgetGate,
  type HeartbeatClock,
  type HeartbeatDelivery,
  type HeartbeatFileReader,
  type HeartbeatPolicy,
  type HeartbeatTurnRunner,
  type HeartbeatUsage,
} from "../../src/heartbeat/types.js";
import { BudgetEnforcer } from "../../src/budget/enforcer.js";
import { BudgetLedger } from "../../src/budget/ledger.js";
import { budgetGate } from "../../src/heartbeat/wire.js";

// ---- config ---------------------------------------------------------------

describe("resolveHeartbeatPolicy", () => {
  test("disabled by default; 30-min interval; always active", () => {
    const p = resolveHeartbeatPolicy(undefined, {});
    expect(p.enabled).toBe(false);
    expect(p.intervalSeconds).toBe(1800);
    expect(p.activeHours).toBeNull();
    expect(p.target).toEqual({ kind: "none" });
    expect(p.skipWhenBusy).toBe(true);
  });

  test("env overrides config (env > config > default)", () => {
    const p = resolveHeartbeatPolicy(
      { enabled: true, interval_seconds: 60, model: "cfg-model" },
      { AGENC_HEARTBEAT_INTERVAL: "120", AGENC_HEARTBEAT_MODEL: "env-model" },
    );
    expect(p.intervalSeconds).toBe(120);
    expect(p.model).toBe("env-model");
  });

  test("active hours + channel target parse from env", () => {
    const p = resolveHeartbeatPolicy(
      { enabled: true },
      { AGENC_HEARTBEAT_ACTIVE_HOURS: "8-22", AGENC_HEARTBEAT_TARGET: "tg:chat-1" },
    );
    expect(p.activeHours).toEqual([8, 22]);
    expect(p.target).toEqual({ kind: "channel", channelId: "tg", conversationId: "chat-1" });
  });

  test("parseActiveHours + parseTarget edge cases", () => {
    expect(parseActiveHours("always")).toBeNull();
    expect(parseActiveHours("22-8")).toBeNull(); // start >= end invalid
    expect(parseActiveHours("9-17")).toEqual([9, 17]);
    expect(parseTarget("none")).toEqual({ kind: "none" });
    expect(parseTarget("bogus")).toEqual({ kind: "none" }); // no colon
    expect(parseTarget("a:b")).toEqual({ kind: "channel", channelId: "a", conversationId: "b" });
  });
});

describe("WorkspaceHeartbeatFileReader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenc-hb-file-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("returns null when absent, content when present", () => {
    const reader = new WorkspaceHeartbeatFileReader(dir);
    expect(reader.read()).toBeNull();
    writeFileSync(join(dir, "HEARTBEAT.md"), "check the inbox");
    expect(reader.read()).toBe("check the inbox");
  });
});

// ---- runner (gates + budget) ----------------------------------------------

class FakeRunner implements HeartbeatTurnRunner {
  reply = HEARTBEAT_OK;
  usage: HeartbeatUsage = { inputTokens: 500, outputTokens: 100 };
  /** When set, run() throws after recording the prompt (GW-07). */
  throwOnRun: Error | null = null;
  readonly prompts: string[] = [];
  readonly models: (string | undefined)[] = [];
  async run(prompt: string, model: string | undefined) {
    this.prompts.push(prompt);
    this.models.push(model);
    if (this.throwOnRun !== null) throw this.throwOnRun;
    return { finalMessage: this.reply, usage: this.usage };
  }
}

class FakeDelivery implements HeartbeatDelivery {
  readonly sent: { target: unknown; text: string }[] = [];
  throwOnDeliver: Error | null = null;
  async deliver(target: unknown, text: string) {
    if (this.throwOnDeliver !== null) throw this.throwOnDeliver;
    this.sent.push({ target, text });
  }
}

class FakeFile implements HeartbeatFileReader {
  content: string | null = "do the thing";
  read() {
    return this.content;
  }
}

/** A budget gate that refuses after `admitCount` admits. */
class FakeBudget implements HeartbeatBudgetGate {
  admits = 0;
  reconciles: HeartbeatUsage[] = [];
  refuseAfter = Infinity;
  admit(_input: unknown) {
    this.admits += 1;
    if (this.admits > this.refuseAfter) {
      return { ok: false as const, message: "daily usd cap reached" };
    }
    return { ok: true as const, hold: { id: this.admits } };
  }
  reconcile(_hold: unknown, usage: HeartbeatUsage) {
    this.reconciles.push(usage);
  }
}

const NOW = new Date("2026-07-09T10:00:00"); // local 10:00
const clock: HeartbeatClock = {
  now: () => NOW,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
};

function policy(over: Partial<HeartbeatPolicy> = {}): HeartbeatPolicy {
  return {
    enabled: true,
    intervalSeconds: 60,
    agentId: "hb",
    activeHours: null,
    skipWhenBusy: true,
    target: { kind: "channel", channelId: "tg", conversationId: "c1" },
    ...over,
  };
}

function makeRunner(
  over: Partial<HeartbeatPolicy>,
  parts: {
    runner?: FakeRunner;
    delivery?: FakeDelivery;
    file?: FakeFile;
    budget?: HeartbeatBudgetGate;
    isCronRunning?: () => boolean;
  } = {},
) {
  const runner = parts.runner ?? new FakeRunner();
  const delivery = parts.delivery ?? new FakeDelivery();
  const file = parts.file ?? new FakeFile();
  const budget = parts.budget ?? new FakeBudget();
  const hb = new HeartbeatRunner({
    policy: policy(over),
    clock,
    turnRunner: runner,
    delivery,
    file,
    budget,
    ...(parts.isCronRunning !== undefined ? { isCronRunning: parts.isCronRunning } : {}),
  });
  return { hb, runner, delivery, file, budget };
}

describe("HeartbeatRunner gates", () => {
  test("disabled → skipped", async () => {
    const { hb } = makeRunner({ enabled: false });
    expect(await hb.tick()).toEqual({ kind: "skipped", reason: "disabled" });
  });

  test("outside active hours → skipped", async () => {
    const { hb } = makeRunner({ activeHours: [11, 12] }); // now is 10:00
    expect(await hb.tick()).toMatchObject({ reason: "outside_active_hours" });
  });

  test("cron running → deferred", async () => {
    const { hb } = makeRunner({}, { isCronRunning: () => true });
    expect(await hb.tick()).toMatchObject({ reason: "cron_running" });
  });

  test("no HEARTBEAT.md → skipped", async () => {
    const file = new FakeFile();
    file.content = null;
    const { hb } = makeRunner({}, { file });
    expect(await hb.tick()).toMatchObject({ reason: "no_heartbeat_file" });
  });
});

describe("HeartbeatRunner turn + budget wire-in", () => {
  test("HEARTBEAT_OK reply suppresses delivery; budget admits + reconciles", async () => {
    const { hb, runner, delivery, budget } = makeRunner({});
    runner.reply = HEARTBEAT_OK;
    const outcome = await hb.tick();
    expect(outcome).toEqual({ kind: "ok_suppressed" });
    expect(delivery.sent).toHaveLength(0);
    expect(budget.admits).toBe(1);
    expect(budget.reconciles).toEqual([{ inputTokens: 500, outputTokens: 100 }]);
    // The heartbeat framing wraps HEARTBEAT.md.
    expect(runner.prompts[0]).toContain("do the thing");
    expect(runner.prompts[0]).toContain(HEARTBEAT_OK);
  });

  test("a non-OK reply is delivered to the target", async () => {
    const { hb, runner, delivery } = makeRunner({});
    runner.reply = "3 new emails need replies";
    const outcome = await hb.tick();
    expect(outcome).toEqual({ kind: "delivered", text: "3 new emails need replies" });
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].text).toBe("3 new emails need replies");
  });

  test("BUDGET REFUSAL: the turn does NOT run; a paused notice is delivered", async () => {
    const budget = new FakeBudget();
    budget.refuseAfter = 0; // refuse the very first admit
    const { hb, runner, delivery } = makeRunner({}, { budget });
    const outcome = await hb.tick();
    expect(outcome).toMatchObject({ kind: "budget_paused" });
    expect(runner.prompts).toHaveLength(0); // turn never ran (no silent spend)
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].text).toContain("heartbeat paused");
    expect(budget.reconciles).toHaveLength(0); // no admit hold to reconcile
  });

  test("GW-07: turn throw still reconciles hold once with zeros", async () => {
    const budget = new FakeBudget();
    const runner = new FakeRunner();
    runner.throwOnRun = new Error("turn exploded");
    const { hb } = makeRunner({}, { budget, runner });
    const outcome = await hb.tick();
    expect(outcome).toMatchObject({ kind: "error", message: expect.stringContaining("turn exploded") });
    expect(budget.admits).toBe(1);
    expect(budget.reconciles).toHaveLength(1);
    expect(budget.reconciles[0]).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(runner.prompts).toHaveLength(1); // turn was entered
  });

  test("GW-07: success still reconciles exactly once with real usage", async () => {
    const budget = new FakeBudget();
    const { hb, runner } = makeRunner({}, { budget });
    runner.reply = HEARTBEAT_OK;
    await hb.tick();
    expect(budget.admits).toBe(1);
    expect(budget.reconciles).toHaveLength(1);
    expect(budget.reconciles[0]).toEqual({ inputTokens: 500, outputTokens: 100 });
  });

  test("GW-07: deliver throw after successful turn reconciles real usage", async () => {
    const budget = new FakeBudget();
    const delivery = new FakeDelivery();
    delivery.throwOnDeliver = new Error("channel down");
    const runner = new FakeRunner();
    runner.reply = "something needs attention";
    runner.usage = { inputTokens: 42, outputTokens: 7 };
    const { hb } = makeRunner({}, { budget, runner, delivery });
    const outcome = await hb.tick();
    expect(outcome).toMatchObject({ kind: "error", message: expect.stringContaining("channel down") });
    expect(budget.admits).toBe(1);
    expect(budget.reconciles).toHaveLength(1);
    expect(budget.reconciles[0]).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  test("GW-07 ledger: turn throw refunds hold on real BudgetEnforcer+Ledger", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-hb-ledger-"));
    try {
      const ledger = new BudgetLedger({ agencHome: home });
      const enforcer = new BudgetEnforcer({
        policy: {
          enabled: true,
          softThreshold: 0.8,
          enforceInteractive: false,
          caps: { dailyTokens: 1_000_000 },
        },
        ledger,
        priceOf: () => null,
      });
      const budget = budgetGate(enforcer);
      const runner = new FakeRunner();
      runner.throwOnRun = new Error("turn exploded");
      const { hb } = makeRunner({ agentId: "hb-ledger" }, { budget, runner });
      const outcome = await hb.tick();
      expect(outcome).toMatchObject({ kind: "error" });
      // Re-open ledger to prove disk conservation (same as cron GW-06 test).
      const snap = new BudgetLedger({ agencHome: home }).snapshot("hb-ledger");
      expect(snap.day.tokens).toBe(0);
      expect(snap.day.usd).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the utility model flows through to the turn runner", async () => {
    const { hb, runner } = makeRunner({ model: "grok-4-fast" });
    await hb.tick();
    expect(runner.models[0]).toBe("grok-4-fast");
  });

  test("target 'none' runs the turn but delivers nothing", async () => {
    const { hb, runner, delivery } = makeRunner({ target: { kind: "none" } });
    runner.reply = "something happened";
    const outcome = await hb.tick();
    expect(outcome).toMatchObject({ kind: "delivered" });
    expect(delivery.sent).toHaveLength(0); // no target
  });

  test("heartbeatPrompt frames the file and asks for HEARTBEAT_OK", () => {
    const p = heartbeatPrompt("inbox rules");
    expect(p).toContain("inbox rules");
    expect(p).toContain(HEARTBEAT_OK);
    expect(p).toContain("<heartbeat_instructions>");
  });
});

// ---- scheduler (fake timers) ----------------------------------------------

describe("HeartbeatScheduler", () => {
  test("ticks on the interval and re-arms; stop cancels", async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const sched = new HeartbeatScheduler({
        intervalSeconds: 10,
        clock: {
          now: () => new Date(),
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (h) => clearTimeout(h),
        },
        onTick: async () => {
          ticks += 1;
          return { kind: "ok_suppressed" };
        },
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ticks).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ticks).toBe(2);
      await sched.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ticks).toBe(2); // no more ticks after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
