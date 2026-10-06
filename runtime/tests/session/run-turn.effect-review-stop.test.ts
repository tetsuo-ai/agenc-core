import { afterEach, describe, expect, test, vi } from "vitest";
import {
  EFFECT_REVIEW_BLOCK_STOP,
  clearLiveEffectPoison,
  poisonLiveEffect,
} from "../../src/budget/effect-settlement-supervisor.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Event } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

/**
 * Regression from Terminal-Bench trial `risk-scorer-replay__ViaB4mm` (#2501).
 *
 * A refused `Write` poisoned the live-effect gate of an `agenc -p` run.
 * Every later side-effecting call was refused with "ask the user to run
 * /resolve", but nobody was attached, so the model kept trying different
 * commands for ~3.5 hours until the exact-repeat backstop fired. The turn
 * must end at the first refusal when unattended, and after a short streak
 * of refusals in any mode, as the distinct `effect_review_required` stop.
 */

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

const POISON = {
  callId: "call-poisoned-write",
  toolName: "Write",
  runId: "conv-test",
  stepId: "tool:conv-test:call-poisoned-write",
};

function createExercise(options: {
  readonly nonInteractive: boolean;
  readonly toolRounds: number;
  readonly toolName?: "mutate_probe" | "read_probe";
  readonly afterSample?: (sample: number) => void;
}) {
  let samples = 0;
  const executed: string[] = [];
  const toolName = options.toolName ?? "mutate_probe";
  const provider = mkProvider();
  provider.chatStream = async (): Promise<LLMResponse> => {
    samples += 1;
    options.afterSample?.(samples);
    const wantsTool = samples <= options.toolRounds;
    return {
      content: wantsTool ? "Trying another command." : "finished",
      toolCalls: wantsTool
        ? [{
            id: `call-${samples}`,
            name: toolName,
            // Different arguments every time: the exact-repeat backstop
            // never sees an identical call, only the gate does.
            arguments: JSON.stringify({ attempt: samples }),
          }]
        : [],
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      model: "test-model",
      finishReason: wantsTool ? "tool_calls" : "stop",
    };
  };
  const registry = {
    tools: [
      {
        name: "mutate_probe",
        description: "Mutate something",
        inputSchema: { type: "object" },
        requiresApproval: false,
        recoveryCategory: "side-effecting",
        execute: async (args: { attempt: number }) => {
          executed.push(`mutate:${args.attempt}`);
          return { content: "mutated", isError: false };
        },
      },
      {
        name: "read_probe",
        description: "Read something",
        inputSchema: { type: "object" },
        requiresApproval: false,
        recoveryCategory: "idempotent",
        execute: async (args: { attempt: number }) => {
          executed.push(`read:${args.attempt}`);
          return { content: "read", isError: false };
        },
      },
    ],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
  const { session, events } = mkSession({
    provider,
    registry,
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, {
        nonInteractive: options.nonInteractive,
      }),
    },
  });
  poisonLiveEffect(session, POISON);
  return { session, events, executed, samples: () => samples };
}

async function collect(
  exercise: ReturnType<typeof createExercise>,
): Promise<PhaseEvent[]> {
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(exercise.session, mkCtx(), "keep going")) {
    phases.push(phase);
  }
  return phases;
}

function terminals(events: readonly Event[]) {
  return events.flatMap((event) => {
    const terminal = classifyTurnTerminal(event.msg, {
      expectedTurnId: mkCtx().subId,
    });
    return terminal === undefined ? [] : [terminal];
  });
}

function warnings(events: readonly Event[], cause: string) {
  return events.filter(
    (event) => event.msg.type === "warning" && event.msg.payload.cause === cause,
  );
}

describe("effect_review_required ends the turn (#2501)", () => {
  test("an unattended run stops at the first refused side-effecting call", async () => {
    const exercise = createExercise({ nonInteractive: true, toolRounds: 20 });

    const phases = await collect(exercise);

    // One sample, one refusal, no livelock: the model never got a second
    // chance to try a different command.
    expect(exercise.samples()).toBe(1);
    expect(exercise.executed).toEqual([]);
    expect(phases.at(-1)).toMatchObject({ stopReason: "effect_review_required" });
    expect(terminals(exercise.events)).toEqual([
      expect.objectContaining({
        outcome: "errored",
        code: 1,
        failureCode: "effect_review_required",
      }),
    ]);
    expect(exercise.events.some((event) => event.msg.type === "turn_complete")).toBe(false);
    const [warning, ...rest] = warnings(exercise.events, "effect_review_required");
    expect(rest).toEqual([]);
    expect(warning?.msg.payload).toMatchObject({
      message: expect.stringContaining("nobody attached"),
    });
    // The refusal itself reaches the model as the tool result it would have
    // read; the explanation names the poisoned call and the offline remedy.
    expect(JSON.stringify(warning?.msg.payload)).toContain("call-poisoned-write");
    expect(JSON.stringify(warning?.msg.payload)).toContain("agenc state resolve-tool-call");
    expect(warnings(exercise.events, "no_progress_detected")).toEqual([]);
  });

  test("an interactive session stops after the refusal streak, whatever the arguments", async () => {
    const exercise = createExercise({ nonInteractive: false, toolRounds: 20 });

    const phases = await collect(exercise);

    expect(exercise.samples()).toBe(EFFECT_REVIEW_BLOCK_STOP);
    expect(exercise.executed).toEqual([]);
    expect(phases.at(-1)).toMatchObject({ stopReason: "effect_review_required" });
    expect(terminals(exercise.events)).toEqual([
      expect.objectContaining({ outcome: "errored", failureCode: "effect_review_required" }),
    ]);
    expect(warnings(exercise.events, "effect_review_required")).toHaveLength(1);
    expect(warnings(exercise.events, "no_progress_detected")).toEqual([]);
  });

  test("a review before the streak limit lets the interactive turn continue", async () => {
    const exercise = createExercise({
      nonInteractive: false,
      toolRounds: 3,
      afterSample: (sample) => {
        // Two refusals in, the operator runs /resolve: the gate clears and
        // the third call goes through.
        if (sample === EFFECT_REVIEW_BLOCK_STOP) {
          clearLiveEffectPoison(exercise.session, POISON);
        }
      },
    });

    const phases = await collect(exercise);

    expect(phases.at(-1)).toMatchObject({ stopReason: "completed" });
    // The first two calls were refused by the gate; the third reached the
    // dispatcher (the fixture's read-only sandbox then declines it, which
    // is the sandbox's ordinary verdict, not the gate's).
    const results = exercise.events.flatMap((event) =>
      event.msg.type === "tool_call_completed" ? [String(event.msg.payload.result)] : [],
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("live effect settlement is unresolved");
    expect(results[1]).toContain("live effect settlement is unresolved");
    expect(results[2]).not.toContain("live effect settlement is unresolved");
    expect(terminals(exercise.events)).toEqual([
      expect.objectContaining({ outcome: "completed", code: 0 }),
    ]);
    expect(warnings(exercise.events, "effect_review_required")).toEqual([]);
  });

  test("read-only calls are never refused or counted while the gate is poisoned", async () => {
    const exercise = createExercise({
      nonInteractive: true,
      toolRounds: EFFECT_REVIEW_BLOCK_STOP + 1,
      toolName: "read_probe",
    });

    const phases = await collect(exercise);

    expect(phases.at(-1)).toMatchObject({ stopReason: "completed" });
    expect(exercise.executed).toEqual(["read:1", "read:2", "read:3", "read:4"]);
    expect(warnings(exercise.events, "effect_review_required")).toEqual([]);
  });
});
