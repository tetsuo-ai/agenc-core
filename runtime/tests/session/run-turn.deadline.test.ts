import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { runTurn } from "../../src/session/run-turn.js";
import { setRunDeadlineClockForTests } from "../../src/session/run-deadline.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Event } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";
import {
  createFakeRunDeadlineClock,
  type FakeRunDeadlineClock,
} from "../helpers/fake-run-deadline-clock.js";

/**
 * Regression from Terminal-Bench `photonic-waveguide-routing__MPtWQPp` (#2503).
 *
 * The agent had a passing routing hours before Harbor's 8-hour cutoff, kept
 * optimizing, and was killed with a failing intermediate file on disk. It
 * never knew how much time it had. A run with a deadline now tells the model
 * its budget, stamps the remaining time on every tool result, enters a
 * reserve in which the model is told to restore its best verified state and
 * finish, and ends as `deadline_reached` when time runs out.
 */

let clock: FakeRunDeadlineClock;

beforeEach(() => {
  clock = createFakeRunDeadlineClock();
  setRunDeadlineClockForTests(clock);
});

afterEach(() => {
  setRunDeadlineClockForTests(null);
});

const TURN_REMINDER = "This run has a fixed time budget";
const RESERVE_REMINDER = "Time is nearly up";

function deadlineExercise(options: {
  readonly toolRounds: number;
  readonly stepMs: number;
  readonly budgetMs?: number;
  readonly reserveMs?: number;
  readonly withDeadline?: boolean;
  /** Runs inside the fixture tool after the clock advanced. */
  readonly onTool?: (round: number) => void | Promise<void>;
}) {
  const requests: LLMMessage[][] = [];
  let samples = 0;
  const provider = mkProvider();
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(messages.map((message) => ({ ...message })));
    samples += 1;
    const wantsTool = samples <= options.toolRounds;
    return {
      content: wantsTool ? "Checking the current result." : "Done: the saved result passes.",
      toolCalls: wantsTool
        ? [{ id: `call-${samples}`, name: "slow_probe", arguments: JSON.stringify({ round: samples }) }]
        : [],
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      model: "test-model",
      finishReason: wantsTool ? "tool_calls" : "stop",
    };
  };
  const registry = {
    tools: [{
      name: "slow_probe",
      description: "Run the slow check",
      inputSchema: { type: "object" },
      requiresApproval: false,
      recoveryCategory: "idempotent",
      execute: async (args: { round: number }) => {
        clock.advance(options.stepMs);
        await options.onTool?.(args.round);
        return { content: `probe ${args.round}`, isError: false };
      },
    }],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
  const runtimeOptions = resolveAgentRuntimeOptions({}, {
    nonInteractive: true,
    ...(options.withDeadline === false
      ? {}
      : {
          deadlineAt: clock.now() + (options.budgetMs ?? 120_000),
          deadlineReserveMs: options.reserveMs ?? 60_000,
        }),
  });
  const { session, events, state } = mkSession({ provider, registry, services: { runtimeOptions } });
  return { session, events, state, requests, samples: () => samples };
}

async function collect(session: ReturnType<typeof mkSession>["session"]): Promise<PhaseEvent[]> {
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(session, mkCtx(), "optimize the routing and keep it passing")) {
    phases.push(phase);
  }
  return phases;
}

const text = (messages: readonly LLMMessage[]): string => JSON.stringify(messages);

function toolContent(messages: readonly LLMMessage[], callId: string): string {
  return JSON.stringify(messages.find((message) => message.toolCallId === callId)?.content);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function warnings(events: readonly Event[], cause: string): string[] {
  return events.flatMap((event) =>
    event.msg.type === "warning" && event.msg.payload.cause === cause
      ? [String(event.msg.payload.message)]
      : [],
  );
}

function terminals(events: readonly Event[]) {
  return events.flatMap((event) => {
    const terminal = classifyTurnTerminal(event.msg, { expectedTurnId: mkCtx().subId });
    return terminal === undefined ? [] : [terminal];
  });
}

describe("run deadline in the turn loop (#2503)", () => {
  test("the model sees its budget, stamped tool results, and one reserve reminder", async () => {
    // 120 s budget, 60 s reserve, each tool takes 20 s: results land at 100,
    // 80, 60 and 40 s remaining; the reserve starts before the fourth sample.
    const exercise = deadlineExercise({ toolRounds: 4, stepMs: 20_000 });

    const phases = await collect(exercise.session);

    expect(exercise.samples()).toBe(5);
    expect(phases.at(-1)).toMatchObject({ stopReason: "completed" });
    const [first, second, third, fourth, fifth] = exercise.requests.map(text);
    expect(first).toContain(`${TURN_REMINDER} and about 2 min of it remain`);
    expect(first).not.toContain(RESERVE_REMINDER);

    expect(toolContent(exercise.requests[1]!, "call-1")).toContain("[time_remaining_sec=100]");
    // A result's stamp never changes between requests (prompt-cache stable).
    expect(toolContent(exercise.requests[4]!, "call-1")).toContain("[time_remaining_sec=100]");
    expect(toolContent(exercise.requests[4]!, "call-2")).toContain("[time_remaining_sec=80]");
    expect(toolContent(exercise.requests[4]!, "call-3")).toContain("[time_remaining_sec=60]");
    expect(toolContent(exercise.requests[4]!, "call-4")).toContain("[time_remaining_sec=40]");

    expect(second).not.toContain(RESERVE_REMINDER);
    expect(third).not.toContain(RESERVE_REMINDER);
    expect(count(fourth!, RESERVE_REMINDER)).toBe(1);
    expect(fourth).toContain("60 s remain");
    expect(count(fifth!, RESERVE_REMINDER)).toBe(1);
    expect(count(fifth!, TURN_REMINDER)).toBe(1);
    expect(warnings(exercise.events, "deadline_reserve")).toHaveLength(1);

    // None of it is durable: the saved history carries no reminder or stamp.
    const history = text(exercise.state.history);
    expect(history).not.toContain(TURN_REMINDER);
    expect(history).not.toContain(RESERVE_REMINDER);
    expect(history).not.toContain("time_remaining_sec");
    expect(terminals(exercise.events)).toEqual([
      expect.objectContaining({ outcome: "completed", code: 0 }),
    ]);
  });

  test("a final answer in the reserve is accepted by the completion gate", async () => {
    const exercise = deadlineExercise({ toolRounds: 4, stepMs: 20_000 });

    await collect(exercise.session);

    const gates = exercise.events.flatMap((event) =>
      event.msg.type === "completion_gate" ? [event.msg.payload] : [],
    );
    expect(gates).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "deadline_reserve" }),
    ]);
  });

  test("a turn still running at the deadline ends deadline_reached", async () => {
    // The third tool call is still running when the deadline passes.
    const exercise = deadlineExercise({
      toolRounds: 10,
      stepMs: 50_000,
      budgetMs: 120_000,
      reserveMs: 30_000,
    });

    const phases = await collect(exercise.session);

    expect(exercise.samples()).toBe(3);
    expect(phases.at(-1)).toMatchObject({ stopReason: "deadline_reached" });
    expect(terminals(exercise.events)).toEqual([
      expect.objectContaining({
        outcome: "errored",
        failureCode: "deadline_reached",
        message: expect.stringContaining("Run stopped at its deadline"),
      }),
    ]);
    expect(exercise.events.some((event) => event.msg.type === "turn_complete")).toBe(false);
    expect(exercise.events.some((event) => event.msg.type === "turn_aborted")).toBe(false);
    expect(warnings(exercise.events, "deadline_reached")).toHaveLength(1);
  });

  test("a deadline that already passed stops the turn before sampling", async () => {
    const exercise = deadlineExercise({ toolRounds: 1, stepMs: 0, budgetMs: 1_000 });
    clock.advance(5_000);

    const phases = await collect(exercise.session);

    expect(exercise.samples()).toBe(0);
    expect(phases.at(-1)).toMatchObject({ stopReason: "deadline_reached" });
  });

  test("a run without a deadline sees no reminders or stamps", async () => {
    const exercise = deadlineExercise({ toolRounds: 2, stepMs: 20_000, withDeadline: false });

    await collect(exercise.session);

    const all = exercise.requests.map(text).join("\n");
    expect(all).not.toContain(TURN_REMINDER);
    expect(all).not.toContain("time_remaining_sec");
    expect(clock.pending()).toBe(0);
  });
});
