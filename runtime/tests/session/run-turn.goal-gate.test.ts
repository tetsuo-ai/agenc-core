import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { GOAL_INTEGRITY_CONSTRAINT, type GoalVerificationResult, type SessionGoal } from "../../src/goal/goal.js";
import type { GoalGateDeps } from "../../src/goal/runtime-deps.js";
import { getSessionGoal, goalFromRolloutItems, restoreSessionGoal } from "../../src/goal/session-goal.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { setGoalGateDepsForTests } from "../../src/phases/goal-gate.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Event } from "../../src/session/session.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

// The real turn loop with a scripted model. Verification, git and the judge are
// scripted observations: nothing here runs a shell, git, or a provider.
const OBJECTIVE = "npm test passes after adding a clear() method";

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: "g", objective: OBJECTIVE, verification: [{ label: "tests", script: "npm test" }], criteria: [],
    constraints: [GOAL_INTEGRITY_CONSTRAINT], budget: { maxRounds: 3 }, status: "active", rounds: 0, stalledRounds: 0,
    startedAt: "2026-09-19T00:00:00.000Z", startCostUsd: 0, baseCommit: "abc1234", ...overrides,
  };
}
const pass: GoalVerificationResult = { label: "tests", script: "npm test", exitCode: 0, timedOut: false, durationMs: 5, excerpt: "4 passed" };
const fail: GoalVerificationResult = { ...pass, exitCode: 1, excerpt: "TypeError: todos.clear is not a function" };

const work = (id: string): Partial<LLMResponse> => ({ content: "", toolCalls: [{ id, name: "goal_probe", arguments: "{}" }], finishReason: "tool_calls" });
const say = (content: string): Partial<LLMResponse> => ({ content, toolCalls: [], finishReason: "stop" });

function scriptedProvider(script: readonly Partial<LLMResponse>[]) {
  const requests: LLMMessage[][] = [];
  const provider = mkProvider();
  let index = 0;
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(messages.map((message) => ({ ...message })));
    const step = script[Math.min(index, script.length - 1)] ?? {};
    index += 1;
    return { content: "", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "test-model", finishReason: "stop", ...step };
  };
  return { provider, requests };
}

function registry(): ToolRegistry {
  const tool: Tool = {
    name: "goal_probe", description: "scripted unit of work", inputSchema: { type: "object" },
    isReadOnly: true, requiresApproval: false, recoveryCategory: "idempotent",
    execute: async () => ({ content: "edited src/todo.js", isError: false }),
  };
  return {
    tools: [tool],
    toLLMTools: () => [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
    dispatch: async () => ({ content: "unexpected legacy dispatch", isError: true }),
  } as ToolRegistry;
}

const userTexts = (request: readonly LLMMessage[]): string[] =>
  request.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
const goalEvents = (events: readonly Event[]) => events.filter((event) => event.msg.type === "goal_changed").map((event) => event.msg.payload as { goal: SessionGoal; cause: string });
function expectCompletedTurn(events: readonly Event[]) {
  expect(events.flatMap((event) => { const t = classifyTurnTerminal(event.msg); return t === undefined ? [] : [t]; }))
    .toEqual([expect.objectContaining({ outcome: "completed", code: 0 })]);
}

let restore: () => void;
let deps: { [K in keyof GoalGateDeps]: ReturnType<typeof vi.fn> };
beforeEach(() => {
  deps = {
    now: vi.fn(() => "2026-09-19T01:00:00.000Z"), sessionCostUsd: vi.fn(() => 0),
    runVerification: vi.fn(async () => [pass]), changedPaths: vi.fn(async () => ["src/todo.js"]),
    diff: vi.fn(async () => ({ stat: " src/todo.js | 5 +", diff: "+  clear() { this.#items = []; }" })),
    judge: vi.fn(async () => '{"verdict":"met","reason":"clear() exists, is tested, and the suite passes","unmet":[]}'),
  };
  restore = setGoalGateDepsForTests(deps as unknown as GoalGateDeps);
});
afterEach(() => restore());

async function run(script: readonly Partial<LLMResponse>[], g: SessionGoal | undefined, prompt = OBJECTIVE) {
  const { provider, requests } = scriptedProvider(script);
  const { session, events } = mkSession({ provider, registry: registry() });
  if (g !== undefined) restoreSessionGoal(session, g);
  for await (const _phase of runTurn(session, mkCtx(), prompt)) void _phase;
  return { session, events, requests };
}

describe("runTurn with an active goal", () => {
  test("a premature 'done' is refused with the real failure, work continues, and the goal ends only when checks and the reviewer agree", async () => {
    deps.runVerification.mockResolvedValueOnce([fail]).mockResolvedValueOnce([pass]);
    const { session, events, requests } = await run([work("w1"), say("Done, clear() is in."), work("w2"), say("Now it really works.")], goal());

    // Sample 3 is the re-entry: it must carry the command's real output and the objective verbatim.
    const reentry = userTexts(requests[2] ?? []).at(-1) ?? "";
    expect(reentry).toContain('<goal_gate round="1" of="3">');
    expect(reentry).toContain("TypeError: todos.clear is not a function");
    expect(reentry).toContain(OBJECTIVE);
    expect(reentry).toContain(GOAL_INTEGRITY_CONSTRAINT);

    expect(requests).toHaveLength(4);
    expect(deps.runVerification).toHaveBeenCalledTimes(2);
    // Asked both rounds; its "met" beside the failing first check did not count.
    expect(deps.judge).toHaveBeenCalledTimes(2);
    expect(getSessionGoal(session)).toMatchObject({ status: "met", rounds: 1 });
    expect(goalEvents(events).map((payload) => [payload.cause, payload.goal.status])).toEqual([["round", "active"], ["settled", "met"]]);
    for (const payload of goalEvents(events)) expect(isCanonicalEventPayload("goal_changed", payload)).toBe(true);
    expectCompletedTurn(events);
  });

  test("the round budget ends the turn as budget_exhausted, never as met", async () => {
    deps.runVerification.mockResolvedValue([fail]);
    const { session, events, requests } = await run([work("w1"), say("Done."), work("w2"), say("Done again."), work("w3"), say("Done for real.")], goal({ budget: { maxRounds: 2 } }));
    expect(getSessionGoal(session)).toMatchObject({ status: "budget_exhausted", rounds: 2 });
    // Consulted on each failing round, but its default "met" never counts against failing checks.
    expect(deps.judge).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(6);
    expect(events.some((event) => event.msg.type === "warning" && event.msg.payload.cause === "goal_budget_exhausted")).toBe(true);
    expectCompletedTurn(events);
  });

  test("the goal is restated at the top of a later user turn, so a new prompt or a compacted history still starts from it", async () => {
    const { requests } = await run([say("Sure, looking now.")], goal(), "also, what does list() return?");
    const firstRequest = JSON.stringify(requests[0] ?? []);
    expect(firstRequest).toContain("A goal is now active for this session");
    expect(firstRequest).toContain(OBJECTIVE);
  });

  test("a turn without a goal is untouched", async () => {
    const { events, requests } = await run([work("w1"), say("Done.")], undefined);
    expect(requests).toHaveLength(2);
    expect(deps.runVerification).not.toHaveBeenCalled();
    expect(goalEvents(events)).toEqual([]);
  });

  test("the journal alone restores an open goal: paused when the turn was cut off mid-goal, as settled otherwise", async () => {
    deps.runVerification.mockResolvedValue([fail]);
    const { session, events } = await run([work("w1"), say("Done."), say("Still done.")], goal({ budget: { maxRounds: 5 } }));
    // Repeating "done" with no tool call trips the stall guard; that is how this turn ends.
    expect(getSessionGoal(session)?.status).toBe("stalled");
    const journal = events.map((event) => ({ type: "event_msg", payload: { msg: event.msg } }));
    expect(goalFromRolloutItems(journal)).toMatchObject({ objective: OBJECTIVE, status: "stalled" });
    // A daemon crash or an interrupt right after the first round leaves `active` as the last snapshot.
    const firstRound = journal.findIndex((item) => item.payload.msg.type === "goal_changed");
    expect(goalFromRolloutItems(journal.slice(0, firstRound + 1))).toMatchObject({
      objective: OBJECTIVE, status: "paused", rounds: 1, pauseReason: "the session was reopened",
    });
  });
});
