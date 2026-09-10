import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { TokenAccountingRequest } from "../../src/llm/token-accounting.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import type { AutoCompactResult } from "../../src/session/run-turn-compaction.js";
import * as compactService from "../../src/services/compact/compact.js";
import * as autoCompactService from "../../src/services/compact/autoCompact.js";
import { CompactionCannotReduceError } from "../../src/services/compact/transaction-types.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { routeSwarmTask } from "../../src/agents/swarm-routing.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

function createToolExercise(toolRounds: number, largeResultAt?: number) {
  let samples = 0;
  let tools = 0;
  const requests: LLMMessage[][] = [];
  const outputLimits: Array<number | undefined> = [];
  const provider = mkProvider();
  provider.chatStream = async (messages, _onChunk, options): Promise<LLMResponse> => {
    requests.push([...messages]);
    outputLimits.push(options?.maxOutputTokens);
    samples += 1;
    return {
      content: samples <= toolRounds ? "Continue the implementation." : "finished",
      toolCalls: samples <= toolRounds
        ? [{ id: `read-${samples}`, name: "read_probe", arguments: JSON.stringify({ round: samples }) }]
        : [],
      usage: { promptTokens: 3_100, completionTokens: 1, totalTokens: 3_101 },
      model: "test-model",
      finishReason: samples <= toolRounds ? "tool_calls" : "stop",
    };
  };
  const nextResult = async () => {
    tools += 1;
    return {
      content: tools === largeResultAt ? "fresh oversized result ".repeat(1_000) : `fresh result ${tools}`,
      isError: false,
    };
  };
  const registry = {
    tools: [{
      name: "read_probe",
      description: "Read the next result",
      inputSchema: { type: "object" },
      requiresApproval: false,
      recoveryCategory: "read-only",
      execute: nextResult,
    }],
    toLLMTools: () => [],
    dispatch: nextResult,
  } as unknown as ToolRegistry;
  const { session, events } = mkSession({ provider, registry });
  const base = mkCtx();
  const ctx = mkCtx({
    modelInfo: {
      ...base.modelInfo,
      contextWindow: 4_096,
      maxOutputTokens: 2_048,
      autoCompactTokenLimit: 3_000,
    },
  });
  return { session, events, ctx, requests, outputLimits, samples: () => samples };
}

function noShrink(): AutoCompactResult {
  return {
    wasCompacted: false,
    skippedCode: "no_shrink",
    skippedReason: "compaction candidate cannot meet minimum savings",
    consecutiveFailures: 1,
  };
}

function summaryRejected(): AutoCompactResult {
  return {
    wasCompacted: false,
    advisoryFailure: "summary_rejected",
    skippedReason: "facts[0] cites an unplanned source ref",
    consecutiveFailures: 1,
  };
}

const advisoryRefusals = [
  { name: "no shrink", refuse: noShrink },
  { name: "durably rejected summary", refuse: summaryRejected },
];

describe("advisory compaction refusal", () => {
  test.each(advisoryRefusals)("$name: continues admissible fresh tool rounds without retrying unchanged advisory compaction", async ({ refuse }) => {
    const exercise = createToolExercise(4);
    const compact = vi.fn(async (_messages, _context, _tracking, _snip, injection) =>
      injection === "before_last_user_message" ? refuse() : { wasCompacted: false },
    );
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    expect(exercise.samples()).toBe(5);
    expect(compact.mock.calls.filter((call) => call[4] === "before_last_user_message"))
      .toHaveLength(1);
    expect(JSON.stringify(exercise.requests.at(-1))).toContain("fresh result 4");
    expect(JSON.stringify(exercise.requests.at(-1))).toContain("finish the implementation");
    expect(exercise.events.filter((event) => event.msg.type === "warning" &&
      event.msg.payload.cause === "auto_compact_failed")).toHaveLength(0);
    expect(exercise.events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test.each(advisoryRefusals)("$name: a new oversized tool result gets one mandatory attempt without spending advisory failure strikes", async ({ refuse }) => {
    const exercise = createToolExercise(4, 4);
    const compact = vi.fn(async (_messages, _context, _tracking, _snip, injection) =>
      injection === "before_last_user_message" ? refuse() : { wasCompacted: false },
    );
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    expect(exercise.samples()).toBe(4);
    const attempts = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    expect(attempts).toHaveLength(2);
    expect((attempts[1]?.[2] as { consecutiveFailures?: number } | undefined)?.consecutiveFailures ?? 0)
      .toBe(0);
    expect(JSON.stringify(attempts[1]?.[0])).toContain("fresh oversized result");
    expect(exercise.events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "errored", failureCode: "compact_failed" }));
  });

  test.each(advisoryRefusals)("$name: re-prepares after mandatory compaction and continues only with the smaller request", async ({ name, refuse }) => {
    const exercise = createToolExercise(1, 1);
    Object.assign(exercise.session.services.provider, {
      tokenCountCapability: {
        capabilityVersion: "mandatory-compaction-native-count",
        adapterRevision: "1",
        configurationRevision: name,
        countTokens: async (request: TokenAccountingRequest) => ({
          // This request cannot fit even admission's minimum 1,024-token
          // clamped output. The replacement can; changing the output ceiling
          // alone must not make this mandatory-compaction fixture admissible.
          inputTokens: JSON.stringify(request.messages).includes("fresh oversized result") ? 3_073 : 1_024,
          complete: true,
          confidence: "exact" as const,
          countedComponents: ["system", "messages", "tools", "provider_framing"] as const,
        }),
      },
    });
    let attempts = 0;
    setAutoCompactImplForTests(async (_messages, _context, _tracking, _snip, injection) => {
      if (injection !== "before_last_user_message") return { wasCompacted: false };
      attempts += 1;
      if (attempts === 1) return refuse();
      return {
        wasCompacted: true,
        compactionResult: {
          message: "small summary",
          replacementHistory: [{ role: "user", content: "small summary" }],
        },
      };
    });

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    expect(attempts).toBe(2);
    expect(exercise.samples()).toBe(2);
    expect(JSON.stringify(exercise.requests[1])).toContain("small summary");
    expect(JSON.stringify(exercise.requests[1])).not.toContain("fresh oversized result");
    expect(exercise.events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test("does not defer other compaction failures even when the next request could fit", async () => {
    const exercise = createToolExercise(1);
    setAutoCompactImplForTests(async () => ({
      wasCompacted: false,
      skippedReason: "provider authentication failed",
      consecutiveFailures: 1,
    }));

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    expect(exercise.samples()).toBe(1);
    expect(exercise.events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "errored", failureCode: "compact_failed" }));
  });

  test.each(advisoryRefusals.flatMap((refusal) => [0, 1].map((overflow) => ({ ...refusal, overflow }))))("$name: uses native counts at a $overflow-token overflow past the minimum admitted output", async ({ name, refuse, overflow }) => {
    const exercise = createToolExercise(1, 1);
    const capability = {
      capabilityVersion: "advisory-native-count",
      adapterRevision: "1",
      configurationRevision: `${name}-boundary-${overflow}`,
      countTokens: vi.fn(async (request: TokenAccountingRequest) => ({
        inputTokens: JSON.stringify(request.messages).includes("fresh oversized result")
          ? 3_072 + overflow
          : 1_024,
        complete: true,
        confidence: "exact" as const,
        countedComponents: ["system", "messages", "tools", "provider_framing"] as const,
      })),
    };
    Object.assign(exercise.session.services.provider, { tokenCountCapability: capability });
    let attempts = 0;
    setAutoCompactImplForTests(async (_messages, _context, _tracking, _snip, injection) => {
      if (injection !== "before_last_user_message") return { wasCompacted: false };
      attempts += 1;
      return refuse();
    });

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    expect(capability.countTokens).toHaveBeenCalledTimes(2);
    expect(exercise.samples()).toBe(overflow === 0 ? 2 : 1);
    if (overflow === 0) expect(exercise.outputLimits.at(-1)).toBe(1_024);
    expect(attempts).toBe(overflow === 0 ? 1 : 2);
    expect(exercise.events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: overflow === 0 ? "completed" : "errored" }));
  });

  test.each(advisoryRefusals)("$name: admits an Ollama-sized growing request by sharing the output reservation clamp", async ({ name, refuse }) => {
    const exercise = createToolExercise(2);
    Object.assign(exercise.ctx.modelInfo, {
      contextWindow: 31_129,
      maxOutputTokens: 16_384,
      autoCompactTokenLimit: 1,
    });
    Object.assign(exercise.session.services.provider, {
      tokenCountCapability: {
        capabilityVersion: "ollama-reservation-growth",
        adapterRevision: "1",
        configurationRevision: name,
        countTokens: vi.fn(async (request: TokenAccountingRequest) => ({
          inputTokens: JSON.stringify(request.messages).includes("fresh result 2") ? 15_200
            : JSON.stringify(request.messages).includes("fresh result 1") ? 14_800 : 14_451,
          complete: true,
          confidence: "exact" as const,
          countedComponents: ["system", "messages", "tools", "provider_framing"] as const,
        })),
      },
    });
    const compact = vi.fn(async () => refuse());
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "so can u build something?"));

    expect(exercise.samples()).toBe(3);
    expect(compact).toHaveBeenCalledOnce();
    expect(exercise.outputLimits).toEqual([16_384, 16_329, 15_929]);
    expect(JSON.stringify(exercise.requests.at(-1))).toContain("fresh result 2");
    expect(JSON.stringify(exercise.requests.at(-1))).toContain("so can u build something?");
    expect(exercise.events.map((event) => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test("preserves an undispatched required swarm choice through mandatory re-preparation", async () => {
    const exercise = createToolExercise(0);
    const tracking = getAttachmentTrackingState(exercise.session);
    tracking.lastSwarmRoutingTurnId = exercise.ctx.subId;
    tracking.lastSwarmRoutingDecision = {
      ...routeSwarmTask("Implement independent features in parallel"),
      delegationEnforcement: "require_initial_spawn",
    };
    vi.spyOn(exercise.session.services.registry, "toLLMTools").mockReturnValue([{
      type: "function",
      function: { name: "spawn_agent", description: "spawn", parameters: { type: "object" } },
    }]);
    const chatStream = vi.spyOn(exercise.session.services.provider, "chatStream");
    let attempts = 0;
    setAutoCompactImplForTests(async () => {
      attempts += 1;
      if (attempts === 1) return noShrink();
      return {
        wasCompacted: true,
        compactionResult: {
          message: "smaller request",
          replacementHistory: [{ role: "user", content: "smaller request" }],
        },
      };
    });

    await drain(runTurn(exercise.session, exercise.ctx, "parallel implementation ".repeat(1_000)));

    expect(attempts).toBe(2);
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(chatStream.mock.calls[0]?.[2]?.toolChoice).toEqual({ type: "function", name: "spawn_agent" });
    expect(tracking.lastSwarmSpawnToolChoiceTurnId).toBe(exercise.ctx.subId);
  });

  test("retains typed no-shrink evidence instead of interpreting error prose", async () => {
    const compact = vi.spyOn(compactService, "compactConversation")
      .mockRejectedValue(new CompactionCannotReduceError("no_shrink", "insufficient savings"));
    const result = await autoCompactService.autoCompactIfNeeded([], {
      options: { contextWindowTokens: 4_096 },
    }, undefined, "normal", undefined, 0, { force: true });
    expect(result).toMatchObject({ skippedCode: "no_shrink", consecutiveFailures: 1 });
    compact.mockRejectedValue(new Error("no_shrink words do not establish a typed failure"));
    const untyped = await autoCompactService.autoCompactIfNeeded([], {
      options: { contextWindowTokens: 4_096 },
    }, undefined, "normal", undefined, 0, { force: true });
    expect(untyped.skippedCode).toBeUndefined();
  });
});
