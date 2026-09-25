import { describe, expect, test, vi } from "vitest";

import type { SessionGoalResult, SessionGoalSnapshot } from "../../src/app-server/protocol/index.js";
import { formatGoalStatus, goalCommand } from "../../src/commands/goal.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

function snapshot(overrides: Partial<SessionGoalSnapshot> = {}): SessionGoalSnapshot {
  return {
    id: "g", objective: "npm test passes", verification: [{ label: "tests", script: "npm test" }], criteria: [],
    constraints: ["Do not modify, skip, weaken, or delete tests or checks to make them pass."], budget: { maxRounds: 20 },
    status: "active", rounds: 2, stalledRounds: 0, startedAt: "2026-09-19T00:00:00.000Z", startCostUsd: 1, ...overrides,
  };
}
function ctx(argsRaw: string, bridge?: (params: unknown) => Promise<SessionGoalResult>): SlashCommandContext {
  return {
    session: (bridge === undefined ? {} : { updateDaemonSessionGoal: bridge }) as SlashCommandContext["session"],
    argsRaw, cwd: "/repo", home: "/tmp",
  };
}

describe("/goal", () => {
  test("setting a goal sends the structured request and starts the work as the next turn", async () => {
    const bridge = vi.fn(async () => ({ ok: true, goal: snapshot(), detectedVerification: false }));
    const result = await goalCommand.execute(ctx('npm test passes --verify "tests=npm test" --max-rounds 5', bridge));
    expect(bridge).toHaveBeenCalledWith({
      action: "set",
      request: { objective: "npm test passes", verify: [{ label: "tests", script: "npm test" }], noVerify: false, maxRounds: 5 },
    });
    expect(result).toEqual({ kind: "prompt", content: expect.stringContaining("npm test passes") });
  });

  test("a refused goal shows the daemon's remedy and starts nothing", async () => {
    const bridge = vi.fn(async () => ({ ok: false, message: 'no test command was found\n  /goal x --verify "tests=<your test command>"' }));
    const result = await goalCommand.execute(ctx("make it better", bridge));
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("--verify") });
  });

  test("a malformed command is rejected before any daemon call", async () => {
    const bridge = vi.fn();
    expect(await goalCommand.execute(ctx("do it --max-rounds 0", bridge))).toMatchObject({ kind: "error" });
    expect(bridge).not.toHaveBeenCalled();
  });

  test("no argument shows status, or says there is no goal", async () => {
    const withGoal = await goalCommand.execute(ctx("", vi.fn(async () => ({ ok: true, goal: snapshot(), sessionCostUsd: 1.5 }))));
    expect(withGoal).toMatchObject({ kind: "text", text: expect.stringContaining("Goal: npm test passes") });
    const none = await goalCommand.execute(ctx("", vi.fn(async () => ({ ok: true }))));
    expect(none).toMatchObject({ kind: "text", text: expect.stringContaining("No goal is set") });
  });

  test("resume continues the work; pause and clear only report", async () => {
    const bridge = vi.fn(async (params: { action: string }) =>
      params.action === "clear" ? { ok: true, message: "Goal cleared: npm test passes" } : { ok: true, goal: snapshot({ status: params.action === "pause" ? "paused" : "active" }) });
    expect(await goalCommand.execute(ctx("resume", bridge as never))).toMatchObject({ kind: "prompt" });
    expect(await goalCommand.execute(ctx("pause", bridge as never))).toMatchObject({ kind: "text", text: expect.stringContaining("Status: paused") });
    expect(await goalCommand.execute(ctx("stop", bridge as never))).toEqual({ kind: "text", text: "Goal cleared: npm test passes" });
    expect(bridge.mock.calls.map(([params]) => params.action)).toEqual(["resume", "pause", "clear"]);
  });

  test("without a daemon-backed session the command says so", async () => {
    expect(await goalCommand.execute(ctx("pause"))).toMatchObject({ kind: "error", message: expect.stringContaining("daemon-backed") });
  });
});

test("status shows rounds, spend since the goal was set, the last verdict, and how to continue a stopped goal", () => {
  const text = formatGoalStatus(
    snapshot({ status: "budget_exhausted", pauseReason: "the goal used all 20 rounds", rounds: 20, budget: { maxRounds: 20, maxCostUsd: 5 },
      lastVerdict: { verdict: "verification_failed", reason: "verification failed: tests", at: "2026-09-19T00:30:00.000Z" } }),
    3.25, Date.parse("2026-09-19T01:30:00.000Z"),
  );
  expect(text).toContain("Status: stopped: budget exhausted (the goal used all 20 rounds)");
  expect(text).toContain("Rounds: 20 of 20 · running 1 h 30 min · spent $2.25 of $5.00");
  expect(text).toContain("Last verdict: verification failed — verification failed: tests");
  expect(text).toContain("/goal resume");
});
