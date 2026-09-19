import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GOAL_INTEGRITY_CONSTRAINT, type GoalVerificationResult, type SessionGoal } from "../../src/goal/goal.js";
import type { GoalGateDeps } from "../../src/goal/runtime-deps.js";
import { getSessionGoal, restoreSessionGoal } from "../../src/goal/session-goal.js";
import { completionGate } from "../../src/phases/completion-gate.js";
import { goalGate, setGoalGateDepsForTests } from "../../src/phases/goal-gate.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { CompletedToolResultRecord, TurnState } from "../../src/session/turn-state.js";

// Synthetic observations only: no tool, provider, git, or shell execution.
function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: "g", objective: "npm test passes after adding clear()", verification: [{ label: "tests", script: "npm test" }], criteria: [],
    constraints: [GOAL_INTEGRITY_CONSTRAINT], budget: { maxRounds: 4 }, status: "active", rounds: 0, stalledRounds: 0,
    startedAt: "2026-09-19T00:00:00.000Z", startCostUsd: 0, baseCommit: "abc1234", ...overrides,
  };
}
const pass: GoalVerificationResult = { label: "tests", script: "npm test", exitCode: 0, timedOut: false, durationMs: 5, excerpt: "4 passed" };
const fail: GoalVerificationResult = { ...pass, exitCode: 1, excerpt: "1 failing: clear() is not a function" };
const tool = (callId: string, isError = false): CompletedToolResultRecord =>
  ({ callId, toolName: "Edit", arguments: "{}", content: "ok", isError }) as CompletedToolResultRecord;

function fixture(g: SessionGoal | undefined, text = "Done. clear() is implemented.") {
  let n = 0;
  const session = {
    emit: vi.fn(), nextInternalSubId: () => `sub-${(n += 1)}`,
    services: { runtimeOptions: {} }, sessionConfiguration: { sessionSource: "cli_main" },
  } as unknown as Session & { emit: ReturnType<typeof vi.fn> };
  if (g !== undefined) restoreSessionGoal(session, g);
  const ctx = { subId: "turn-1", depth: 0, cwd: "/repo", config: { maxTurns: 50 }, permissionMode: "default" } as unknown as TurnContext;
  const state = {
    messages: [{ role: "user", content: "kickoff" }],
    assistantMessages: [{ uuid: "a", role: "assistant", text, toolCalls: [] }],
    toolUseBlocks: [], needsFollowUp: false, transition: undefined, turnCount: 2,
    completedToolResults: [tool("edit-1")], goalGateToolLedgerMark: 0,
    completionGate: undefined, completionGateRound: 0, completionGateToolLedgerMark: 0, completionGateSettled: false,
  } as unknown as TurnState;
  const causes = () => session.emit.mock.calls.map(([event]) => event.msg).filter((msg) => msg.type === "warning").map((msg) => msg.payload.cause);
  return { session, ctx, state, causes };
}

let restore: () => void;
let deps: { [K in keyof GoalGateDeps]: ReturnType<typeof vi.fn> };
beforeEach(() => {
  deps = {
    now: vi.fn(() => "2026-09-19T01:00:00.000Z"), sessionCostUsd: vi.fn(() => 0),
    runVerification: vi.fn(async () => [pass]), changedPaths: vi.fn(async () => ["src/todo.js"]),
    diff: vi.fn(async () => ({ stat: " src/todo.js | 5 +", diff: "+clear() {}" })),
    judge: vi.fn(async () => '{"verdict":"met","reason":"clear() exists and is tested","unmet":[]}'),
  };
  restore = setGoalGateDepsForTests(deps as unknown as GoalGateDeps);
});
afterEach(() => restore());

describe("goalGate", () => {
  test("does nothing, and leaves Phase 4b in charge, when no goal is active", async () => {
    for (const g of [undefined, goal({ status: "paused" }), goal({ status: "met" })]) {
      const f = fixture(g);
      expect(await goalGate(f.state, f.ctx, f.session)).toBe(false);
      expect(deps.runVerification).not.toHaveBeenCalled();
    }
  });

  test("does not govern subagent, editor, plan-mode, or nested turns", async () => {
    const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => { (f.ctx as { depth: number }).depth = 1; },
      (f) => { (f.ctx as { editorInteraction?: unknown }).editorInteraction = {}; },
      (f) => { (f.ctx as { permissionMode: string }).permissionMode = "plan"; },
      (f) => { (f.session.sessionConfiguration as { sessionSource: unknown }).sessionSource = "cli_subagent"; },
    ];
    for (const mutate of variants) {
      const f = fixture(goal()); mutate(f);
      expect(await goalGate(f.state, f.ctx, f.session)).toBe(false);
    }
  });

  test("a failing command re-enters the loop with the real output; a judge's `met` cannot override it", async () => {
    deps.runVerification.mockResolvedValueOnce([fail]);
    const f = fixture(goal());
    expect(await goalGate(f.state, f.ctx, f.session)).toBe(true);
    // The default scripted judge says "met"; failing checks outrank it.
    expect(deps.judge).toHaveBeenCalledTimes(1);
    expect(f.state.transition).toEqual({ reason: "goal_gate" });
    const injected = f.state.messages.at(-1);
    expect(injected?.role).toBe("user");
    expect(String(injected?.content)).toContain("clear() is not a function");
    expect(String(injected?.content)).toContain("npm test passes after adding clear()");
    expect(getSessionGoal(f.session)).toMatchObject({ status: "active", rounds: 1, lastVerdict: { verdict: "verification_failed" } });
    expect(f.causes()).toEqual(["goal_round"]);
    expect(f.state.goalGateToolLedgerMark).toBe(1);
  });

  test("passing checks plus an independent `met` verdict end the goal without another sample", async () => {
    const f = fixture(goal());
    expect(await goalGate(f.state, f.ctx, f.session)).toBe(true);
    expect(f.state.transition).toBeUndefined();
    expect(getSessionGoal(f.session)).toMatchObject({ status: "met", lastVerdict: { verdict: "met" } });
    expect(f.causes()).toEqual(["goal_met"]);
    const judgeInput = deps.judge.mock.calls[0]?.[0] as { userMessage: string };
    expect(judgeInput.userMessage).toContain("+clear() {}");
    // The worker's own claim is not evidence and is not shown to the judge.
    expect(judgeInput.userMessage).not.toContain("Done. clear() is implemented.");
  });

  test("the reward-hacking path: checks pass because a test was deleted, the judge says not_met, work continues", async () => {
    deps.changedPaths.mockResolvedValueOnce(["src/todo.js", "test/todo.test.js"]);
    deps.judge.mockResolvedValueOnce('{"verdict":"not_met","reason":"the failing test was deleted instead of fixed","unmet":["restore the deleted test"]}');
    const f = fixture(goal());
    await goalGate(f.state, f.ctx, f.session);
    expect((deps.judge.mock.calls[0]?.[0] as { userMessage: string }).userMessage).toContain("test/todo.test.js");
    expect(f.state.transition).toEqual({ reason: "goal_gate" });
    expect(String(f.state.messages.at(-1)?.content)).toContain("restore the deleted test");
    expect(getSessionGoal(f.session)).toMatchObject({ status: "active", rounds: 1, lastVerdict: { verdict: "not_met" } });
  });

  test("a malformed verdict gets one repair turn and then counts as not met, never as a pass", async () => {
    deps.judge.mockResolvedValueOnce("Looks good to me!").mockResolvedValueOnce("Yes, it is done.");
    const f = fixture(goal());
    await goalGate(f.state, f.ctx, f.session);
    expect(deps.judge).toHaveBeenCalledTimes(2);
    expect(getSessionGoal(f.session)).toMatchObject({ status: "active", lastVerdict: { verdict: "not_met" } });
    expect(f.state.transition).toEqual({ reason: "goal_gate" });
  });

  test("an unreachable judge is reported and is not a pass", async () => {
    deps.judge.mockRejectedValue(new Error("provider down"));
    const f = fixture(goal());
    await goalGate(f.state, f.ctx, f.session);
    expect(f.causes()).toContain("goal_judge_unavailable");
    expect(getSessionGoal(f.session)?.status).toBe("active");
  });

  test.each(["impossible", "blocked"] as const)("a %s verdict hands control back with the reason", async (verdict) => {
    deps.judge.mockResolvedValueOnce(JSON.stringify({ verdict, reason: "needs a production API key", unmet: [] }));
    const f = fixture(goal());
    await goalGate(f.state, f.ctx, f.session);
    expect(f.state.transition).toBeUndefined();
    expect(getSessionGoal(f.session)?.status).toBe(verdict);
    expect(f.causes()).toContain(`goal_${verdict}`);
  });

  test("with failing checks the worker can argue the goal is impossible, and the judge can agree and stop the loop", async () => {
    deps.runVerification.mockResolvedValueOnce([fail]);
    deps.judge.mockResolvedValueOnce(JSON.stringify({ verdict: "impossible", reason: "the two tests require different defaults", unmet: [] }));
    const f = fixture(goal(), "This cannot pass honestly: the tests contradict each other.");
    await goalGate(f.state, f.ctx, f.session);
    const judgeInput = deps.judge.mock.calls[0]?.[0] as { userMessage: string };
    expect(judgeInput.userMessage).toContain("The worker's final message (a claim, not evidence)");
    expect(judgeInput.userMessage).toContain("the tests contradict each other");
    expect(judgeInput.userMessage).toContain("clear() is not a function");
    expect(f.state.transition).toBeUndefined();
    expect(getSessionGoal(f.session)).toMatchObject({ status: "impossible", lastVerdict: { verdict: "impossible" } });
    expect(f.causes()).toContain("goal_impossible");
  });

  test("the round budget stops the goal as budget_exhausted, not met, before running anything", async () => {
    const f = fixture(goal({ rounds: 4 }));
    await goalGate(f.state, f.ctx, f.session);
    expect(deps.runVerification).not.toHaveBeenCalled();
    expect(getSessionGoal(f.session)?.status).toBe("budget_exhausted");
    expect(f.state.transition).toBeUndefined();
    expect(f.causes()).toContain("goal_budget_exhausted");
  });

  test("three rounds in a row without a successful tool call stall the goal", async () => {
    const f = fixture(goal({ rounds: 3, stalledRounds: 2 }));
    f.state.completedToolResults = [tool("failed", true)];
    await goalGate(f.state, f.ctx, f.session);
    expect(getSessionGoal(f.session)?.status).toBe("stalled");
    expect(deps.runVerification).not.toHaveBeenCalled();
  });

  test("a sample that still calls tools is left alone but stays under the goal, so 4b cannot double-inject", async () => {
    const f = fixture(goal());
    (f.state as { toolUseBlocks: unknown[] }).toolUseBlocks = [{}];
    expect(await goalGate(f.state, f.ctx, f.session)).toBe(true);
    expect(deps.runVerification).not.toHaveBeenCalled();
    const before = f.state.messages.length;
    await completionGate(f.state, f.ctx, f.session);
    expect(f.state.messages.length).toBe(before);
  });
});
