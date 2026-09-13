import { describe, expect, test } from "vitest";

import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  buildInitialTurnState,
  restoreFromCheckpoint,
  toCheckpointSlice,
} from "../../src/session/turn-state.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";
import type { Event } from "../../src/session/session.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

const TASK = "Create /app/out.txt containing the word done and make the tests pass";

function toolStep(id: string): Partial<LLMResponse> {
  return {
    content: "",
    toolCalls: [{ id, name: "Bash", arguments: "{}" }],
    finishReason: "tool_calls",
  };
}

function textStep(content: string): Partial<LLMResponse> {
  return { content, toolCalls: [], finishReason: "stop" };
}

function scriptedProvider(script: readonly Partial<LLMResponse>[]) {
  const requests: LLMMessage[][] = [];
  const provider = mkProvider();
  let index = 0;
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(messages.map((message) => ({ ...message })));
    const step = script[Math.min(index, script.length - 1)] ?? {};
    index += 1;
    return {
      content: "",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      finishReason: "stop",
      ...step,
    };
  };
  return { provider, requests };
}

function headlessSession(
  provider: ReturnType<typeof mkProvider>,
  nonInteractive: boolean,
) {
  return mkSession({
    provider,
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive }),
    },
  });
}

function gatePayloads(events: readonly Event[]) {
  return events
    .filter((event) => event.msg.type === "completion_gate")
    .map((event) => event.msg.payload as Record<string, unknown>);
}

function lastUserText(request: readonly LLMMessage[]): string {
  const last = [...request].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
}

async function collect(session: ReturnType<typeof mkSession>["session"], ctx = mkCtx()) {
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(session, ctx, TASK)) phases.push(phase);
  return phases;
}

describe("completion gate in the turn loop", () => {
  test("a non-interactive turn is asked to verify once and accepted after a tool-backed answer", async () => {
    const { provider, requests } = scriptedProvider([
      toolStep("work-1"),
      textStep("Done. The file is written and the tests pass."),
      toolStep("verify-1"),
      textStep("- [x] /app/out.txt contains done: cat showed it\n- [x] tests: pytest, 3 passed\nDone."),
    ]);
    const { session, events, state } = headlessSession(provider, true);
    const phases = await collect(session);

    expect(requests).toHaveLength(4);
    expect(lastUserText(requests[2] ?? [])).toContain('<completion_gate round="1" of="3">');
    expect(lastUserText(requests[2] ?? [])).toContain(TASK);
    expect(
      (requests[3] ?? []).filter((message) => String(message.content).includes("<completion_gate")),
    ).toHaveLength(1);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "completed" });
    expect(events.filter((event) => event.msg.type === "turn_complete")).toHaveLength(1);
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
    expect(gatePayloads(events)).toEqual([
      expect.objectContaining({ outcome: "injected", reason: "initial", round: 1, maxRounds: 3 }),
      expect.objectContaining({ outcome: "verified", reason: "verified_with_tools", toolCallsSinceInjection: 1 }),
    ]);
    for (const payload of gatePayloads(events)) {
      expect(isCanonicalEventPayload("completion_gate", payload)).toBe(true);
    }
    // The verification request is durable history, not an ephemeral nudge.
    expect(
      state.history.some(
        (message) => message.role === "user" && String(message.content).includes("<completion_gate"),
      ),
    ).toBe(true);
  });

  test("an interactive session is never gated", async () => {
    const { provider, requests } = scriptedProvider([
      toolStep("work-1"),
      textStep("Done."),
    ]);
    const { session, events, state } = headlessSession(provider, false);
    await collect(session);
    expect(requests).toHaveLength(2);
    expect(gatePayloads(events)).toEqual([]);
    expect(state.history.some((message) => String(message.content).includes("<completion_gate"))).toBe(false);
  });

  test("completion_gate.mode overrides the session default in both directions", async () => {
    const always = scriptedProvider([toolStep("w"), textStep("Done."), toolStep("v"), textStep("- [x] ok")]);
    const alwaysSession = headlessSession(always.provider, false);
    const ctx = mkCtx();
    await collect(alwaysSession.session, {
      ...ctx,
      config: { ...(ctx.config as Record<string, unknown>), completionGate: { mode: "always" } },
    } as typeof ctx);
    expect(always.requests).toHaveLength(4);
    expect(gatePayloads(alwaysSession.events).map((payload) => payload.outcome)).toEqual(["injected", "verified"]);

    const never = scriptedProvider([toolStep("w"), textStep("Done.")]);
    const neverSession = headlessSession(never.provider, true);
    await collect(neverSession.session, {
      ...ctx,
      config: { ...(ctx.config as Record<string, unknown>), completionGate: { mode: "never" } },
    } as typeof ctx);
    expect(never.requests).toHaveLength(2);
    expect(gatePayloads(neverSession.events)).toEqual([]);
  });

  test("a model that never verifies is bounded by max_rounds and still completes", async () => {
    const { provider, requests } = scriptedProvider([toolStep("work-1"), textStep("Done.")]);
    const { session, events } = headlessSession(provider, true);
    const ctx = mkCtx();
    const phases = await collect(session, {
      ...ctx,
      config: { ...(ctx.config as Record<string, unknown>), completionGate: { max_rounds: 2 } },
    } as typeof ctx);

    // one work sample, one premature answer, two re-injected answers
    expect(requests).toHaveLength(4);
    expect(lastUserText(requests[2] ?? [])).toContain('<completion_gate round="1" of="2">');
    expect(lastUserText(requests[3] ?? [])).toContain('<completion_gate round="2" of="2">');
    expect(lastUserText(requests[3] ?? [])).toContain("did not run any check");
    expect(gatePayloads(events).map((payload) => [payload.outcome, payload.reason])).toEqual([
      ["injected", "initial"],
      ["injected", "no_verification"],
      ["exhausted", "rounds_exhausted"],
    ]);
    expect(phases.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "completed" });
    expect(events.some((event) => event.msg.type === "turn_failed")).toBe(false);
  });

  test("a plain answer that used no tool is not gated", async () => {
    const { provider, requests } = scriptedProvider([textStep("The answer is 42.")]);
    const { session, events } = headlessSession(provider, true);
    await collect(session);
    expect(requests).toHaveLength(1);
    expect(gatePayloads(events)).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "no_tool_use" }),
    ]);
  });

  test("the continuation nudge keeps precedence over the gate for the same sample", async () => {
    const { provider, requests } = scriptedProvider([
      toolStep("work-1"),
      textStep("Now I'll create the file."),
      textStep("Done."),
      toolStep("verify-1"),
      textStep("- [x] verified"),
    ]);
    const { session, events } = headlessSession(provider, true);
    await collect(session);
    expect(requests).toHaveLength(5);
    expect(lastUserText(requests[2] ?? [])).toBe("Continue with the task. Use the appropriate tools to proceed.");
    expect(lastUserText(requests[3] ?? [])).toContain('<completion_gate round="1"');
    expect(gatePayloads(events).map((payload) => payload.outcome)).toEqual(["injected", "verified"]);
  });

  test("a resumed turn keeps its checkpointed round count", async () => {
    const { provider, requests } = scriptedProvider([textStep("Done.")]);
    const { session, events } = headlessSession(provider, true);
    await drain(
      session.runTurn("", {
        subId: "turn-resumed-gate",
        history: [{ role: "user", content: TASK }],
        rootHumanTurnText: TASK,
        resume: {
          turnId: "turn-resumed-gate",
          fromIteration: 2,
          fromCheckpointSeq: 1,
          persistedMessageCount: 1,
          restoreSlice: {
            turnCount: 2,
            recoveryReentryCount: 0,
            maxOutputTokensRecoveryCount: 0,
            continuationNudgeCount: 0,
            stopHookBlockingCount: 0,
            completionGateRound: 3,
          },
        },
      }),
    );
    expect(requests).toHaveLength(1);
    expect(gatePayloads(events)).toEqual([
      expect.objectContaining({ outcome: "exhausted", reason: "rounds_exhausted", round: 3 }),
    ]);
  });

  test("the checkpoint slice carries the round only once the gate has fired", () => {
    const state = buildInitialTurnState(mkCtx(), { role: "user", content: TASK });
    expect(toCheckpointSlice(state)).not.toHaveProperty("completionGateRound");
    state.completionGateRound = 2;
    expect(toCheckpointSlice(state).completionGateRound).toBe(2);

    const restored = buildInitialTurnState(mkCtx(), { role: "user", content: TASK });
    restoreFromCheckpoint(restored, { ...toCheckpointSlice(state), completionGateRound: 2 });
    expect(restored.completionGateRound).toBe(2);
  });

  test("the event schema rejects a payload without its required fields", () => {
    expect(isCanonicalEventPayload("completion_gate", {})).toBe(false);
    expect(
      isCanonicalEventPayload("completion_gate", {
        turnId: "t",
        round: 1,
        maxRounds: 3,
        outcome: "injected",
        reason: "initial",
        toolCallsSinceInjection: 0,
        unmetItems: ["x"],
      }),
    ).toBe(true);
  });
});
