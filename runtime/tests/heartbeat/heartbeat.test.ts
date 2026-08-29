// Heartbeat (TODO task 14). Runtime gates and HEARTBEAT_OK delivery suppression
// live here; spend admission is owned by the daemon session used in production.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  resolveHeartbeatPolicy,
  parseActiveHours,
  parseHeartbeatTarget,
} from "../../src/heartbeat/config.js";
import { applyEnvOverrides } from "../../src/config/env.js";
import {
  defaultConfig,
  validateAgenCConfigBlocks,
} from "../../src/config/schema.js";
import { HeartbeatRunner, heartbeatPrompt } from "../../src/heartbeat/runner.js";
import { HeartbeatScheduler } from "../../src/heartbeat/scheduler.js";
import { WorkspaceHeartbeatFileReader } from "../../src/heartbeat/heartbeat-file.js";
import {
  HEARTBEAT_OK,
  type HeartbeatClock,
  type HeartbeatDelivery,
  type HeartbeatFileReader,
  type HeartbeatPolicy,
  type HeartbeatTurnRunner,
} from "../../src/heartbeat/types.js";

// ---- config ---------------------------------------------------------------

describe("resolveHeartbeatPolicy", () => {
  test("disabled by default; 30-min interval; always active", () => {
    const p = resolveHeartbeatPolicy();
    expect(p.enabled).toBe(false);
    expect(p.intervalSeconds).toBe(1800);
    expect(p.activeHours).toBeNull();
    expect(p.target).toEqual({ kind: "none" });
    expect(p.skipWhenBusy).toBe(true);
  });

  test("canonical environment layering overrides the TOML-shaped interval", () => {
    const config = applyEnvOverrides(
      {
        ...defaultConfig(),
        heartbeat: { enabled: true, interval_seconds: 60 },
      },
      { AGENC_HEARTBEAT_INTERVAL: "120" },
    );
    const p = resolveHeartbeatPolicy(config.heartbeat);
    expect(p.intervalSeconds).toBe(120);
  });

  test("active hours + channel target are layered once from env", () => {
    const config = applyEnvOverrides(
      { ...defaultConfig(), heartbeat: { enabled: true } },
      { AGENC_HEARTBEAT_ACTIVE_HOURS: "8-22", AGENC_HEARTBEAT_TARGET: "tg:chat-1" },
    );
    const p = resolveHeartbeatPolicy(config.heartbeat);
    expect(p.activeHours).toEqual([8, 22]);
    expect(p.target).toEqual({ kind: "channel", channelId: "tg", conversationId: "chat-1" });
  });

  test("heartbeat target env rejects malformed values and none explicitly clears TOML", () => {
    for (const target of ["", "bogus", ":thread", "ops:", " : "]) {
      expect(() => applyEnvOverrides(
        { ...defaultConfig(), heartbeat: { target_channel: "ops", target_conversation: "old" } },
        { AGENC_HEARTBEAT_TARGET: target },
      )).toThrow(/invalid AGENC_HEARTBEAT_TARGET.*nonempty-channel.*nonempty-conversation/u);
    }
    const cleared = applyEnvOverrides(
      { ...defaultConfig(), heartbeat: { target_channel: "ops", target_conversation: "old" } },
      { AGENC_HEARTBEAT_TARGET: "none" },
    );
    expect(cleared.heartbeat).not.toHaveProperty("target_channel");
    expect(cleared.heartbeat).not.toHaveProperty("target_conversation");
  });

  test("always active hours remain valid canonical configuration", () => {
    const config = applyEnvOverrides(
      { ...defaultConfig(), heartbeat: { enabled: true } },
      { AGENC_HEARTBEAT_ACTIVE_HOURS: "always" },
    );
    expect(config.heartbeat?.active_hours).toEqual([0, 24]);
    expect(() => validateAgenCConfigBlocks(config)).not.toThrow();
    expect(resolveHeartbeatPolicy(config.heartbeat).activeHours).toEqual([0, 24]);
  });

  test("malformed active hours warn and do not replace TOML", () => {
    const warnings: string[] = [];
    const config = applyEnvOverrides(
      {
        ...defaultConfig(),
        heartbeat: { enabled: true, active_hours: [9, 17] },
      },
      { AGENC_HEARTBEAT_ACTIVE_HOURS: "22-8" },
      (message) => warnings.push(message),
    );
    expect(config.heartbeat?.active_hours).toEqual([9, 17]);
    expect(warnings).toEqual([
      expect.stringContaining("invalid AGENC_HEARTBEAT_ACTIVE_HOURS"),
    ]);
  });

  test("parseActiveHours + parseTarget edge cases", () => {
    expect(parseActiveHours("always")).toBeNull();
    expect(parseActiveHours("22-8")).toBeNull(); // start >= end invalid
    expect(parseActiveHours("9-17")).toEqual([9, 17]);
    expect(parseHeartbeatTarget("none")).toEqual({ kind: "none" });
    expect(() => parseHeartbeatTarget("bogus")).toThrow(/invalid heartbeat target/u);
    expect(parseHeartbeatTarget("a:b")).toEqual({ kind: "channel", channelId: "a", conversationId: "b" });
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
  /** When set, run() throws after recording the prompt. */
  throwOnRun: Error | null = null;
  readonly prompts: string[] = [];
  async run(prompt: string) {
    this.prompts.push(prompt);
    if (this.throwOnRun !== null) throw this.throwOnRun;
    return { finalMessage: this.reply };
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
    isCronRunning?: () => boolean;
  } = {},
) {
  const runner = parts.runner ?? new FakeRunner();
  const delivery = parts.delivery ?? new FakeDelivery();
  const file = parts.file ?? new FakeFile();
  const hb = new HeartbeatRunner({
    policy: policy(over),
    clock,
    turnRunner: runner,
    delivery,
    file,
    ...(parts.isCronRunning !== undefined ? { isCronRunning: parts.isCronRunning } : {}),
  });
  return { hb, runner, delivery, file };
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

describe("HeartbeatRunner turn", () => {
  test("HEARTBEAT_OK reply suppresses delivery", async () => {
    const { hb, runner, delivery } = makeRunner({});
    runner.reply = HEARTBEAT_OK;
    const outcome = await hb.tick();
    expect(outcome).toEqual({ kind: "ok_suppressed" });
    expect(delivery.sent).toHaveLength(0);
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

  test("turn errors become an error outcome", async () => {
    const runner = new FakeRunner();
    runner.throwOnRun = new Error("turn exploded");
    const { hb } = makeRunner({}, { runner });
    const outcome = await hb.tick();
    expect(outcome).toMatchObject({ kind: "error", message: expect.stringContaining("turn exploded") });
    expect(runner.prompts).toHaveLength(1);
  });

  test("delivery errors become an error outcome after a successful turn", async () => {
    const delivery = new FakeDelivery();
    delivery.throwOnDeliver = new Error("channel down");
    const runner = new FakeRunner();
    runner.reply = "something needs attention";
    const { hb } = makeRunner({}, { runner, delivery });
    const outcome = await hb.tick();
    expect(outcome).toMatchObject({ kind: "error", message: expect.stringContaining("channel down") });
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
