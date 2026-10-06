import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import type { AutoCompactResult } from "../../src/session/run-turn-compaction.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

type Tier = "standard" | "aggressive_summary" | "emergency_local";

function tierOf(args: readonly unknown[]): Tier {
  return ((args[5] as { tier?: Tier } | undefined)?.tier ?? "standard");
}

function noShrink(): AutoCompactResult {
  return {
    wasCompacted: false,
    skippedCode: "no_shrink",
    skippedReason: "compaction candidate cannot meet minimum savings",
    consecutiveFailures: 1,
  };
}

function committed(summary: string): AutoCompactResult {
  return {
    wasCompacted: true,
    compactionResult: {
      message: summary,
      replacementHistory: [{ role: "user", content: summary }],
    },
  };
}

/**
 * Four tool rounds; the fourth result is oversized so the mid-turn gate
 * defers and the pre-dispatch check makes one mandatory attempt (the seam
 * the ladder hangs off). Mirrors `run-turn.advisory-compaction.test.ts`.
 */
function createToolExercise(options: { readonly nonInteractive?: boolean; readonly emergencyMode?: "always" | "never" } = {}) {
  let samples = 0;
  let tools = 0;
  const requests: LLMMessage[][] = [];
  const provider = mkProvider();
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push([...messages]);
    samples += 1;
    return {
      content: samples <= 4 ? "Continue the implementation." : "finished",
      toolCalls: samples <= 4
        ? [{ id: `read-${samples}`, name: "read_probe", arguments: JSON.stringify({ round: samples }) }]
        : [],
      usage: { promptTokens: 3_100, completionTokens: 1, totalTokens: 3_101 },
      model: "test-model",
      finishReason: samples <= 4 ? "tool_calls" : "stop",
    };
  };
  const nextResult = async () => {
    tools += 1;
    return { content: tools === 4 ? "fresh oversized result ".repeat(1_000) : `fresh result ${tools}`, isError: false };
  };
  const registry = {
    tools: [{ name: "read_probe", description: "Read the next result", inputSchema: { type: "object" },
      requiresApproval: false, recoveryCategory: "read-only", execute: nextResult }],
    toLLMTools: () => [],
    dispatch: nextResult,
  } as unknown as ToolRegistry;
  const { session, events } = mkSession({ provider, registry,
    ...(options.nonInteractive ? { services: { runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive: true }) } } : {}) });
  const base = mkCtx();
  const ctx = mkCtx({
    modelInfo: { ...base.modelInfo, contextWindow: 4_096, maxOutputTokens: 2_048, autoCompactTokenLimit: 3_000 },
    ...(options.emergencyMode ? { config: { ...base.config, compaction: { emergency_mode: options.emergencyMode } } } : {}),
  });
  return { session, events, ctx, requests, samples: () => samples };
}

function degradedWarnings(events: ReturnType<typeof createToolExercise>["events"]): string[] {
  return events.flatMap((event) =>
    event.msg.type === "warning" && event.msg.payload.cause === "auto_compact_degraded" ? [event.msg.payload.message] : []);
}

function terminals(events: ReturnType<typeof createToolExercise>["events"]) {
  return events.map((event) => classifyTurnTerminal(event.msg));
}

describe("degraded compaction ladder", () => {
  test("a mandatory no_shrink decline is retried with the aggressive summary and the turn continues", async () => {
    const exercise = createToolExercise();
    const compact = vi.fn(async (...args: unknown[]) => {
      if (args[4] !== "before_last_user_message") return { wasCompacted: false };
      return tierOf(args) === "aggressive_summary" ? committed("aggressive summary") : noShrink();
    });
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    const mandatory = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    expect(mandatory.map(tierOf)).toEqual(["standard", "standard", "aggressive_summary"]);
    expect(JSON.stringify(exercise.requests.at(-1))).toContain("aggressive summary");
    expect(JSON.stringify(exercise.requests.at(-1))).not.toContain("fresh oversized result");
    expect(degradedWarnings(exercise.events)).toEqual([
      expect.stringContaining("tier=aggressive_summary attempting after no_shrink"),
      expect.stringContaining("tier=aggressive_summary compacted"),
    ]);
    expect(terminals(exercise.events)).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test("the model-free emergency tier commits when the aggressive summary also declines", async () => {
    const exercise = createToolExercise();
    const compact = vi.fn(async (...args: unknown[]) => {
      if (args[4] !== "before_last_user_message") return { wasCompacted: false };
      return tierOf(args) === "emergency_local" ? committed("emergency summary") : noShrink();
    });
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    const mandatory = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    expect(mandatory.map(tierOf)).toEqual(["standard", "standard", "aggressive_summary", "emergency_local"]);
    expect(JSON.stringify(exercise.requests.at(-1))).toContain("emergency summary");
    expect(terminals(exercise.events)).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
    expect(exercise.events.filter((event) => event.msg.type === "warning" && event.msg.payload.cause === "auto_compact_failed"))
      .toHaveLength(0);
  });

  test("every tier declining ends the turn with compact_failed naming the exhausted ladder", async () => {
    const exercise = createToolExercise({ nonInteractive: true });
    const compact = vi.fn(async (...args: unknown[]) =>
      args[4] === "before_last_user_message" ? noShrink() : { wasCompacted: false });
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    const mandatory = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    expect(mandatory.map(tierOf)).toEqual(["standard", "standard", "aggressive_summary", "emergency_local"]);
    expect(terminals(exercise.events)).toContainEqual(expect.objectContaining({ outcome: "errored", failureCode: "compact_failed" }));
    const failed = exercise.events.find((event) => event.msg.type === "turn_failed");
    expect(failed?.msg).toMatchObject({ payload: { message: expect.stringContaining("compact_ladder_exhausted: tiers=[aggressive_summary,emergency_local]") } });
    expect(JSON.stringify(failed?.msg)).not.toContain("/compact");
    // Exactly one dispatcher decline warning for the whole ladder.
    expect(exercise.events.filter((event) => event.msg.type === "warning" && event.msg.payload.cause === "auto_compact_failed"))
      .toHaveLength(1);
  });

  test("emergency_mode never keeps the model-free tier off and hints interactive users at /compact", async () => {
    const exercise = createToolExercise({ emergencyMode: "never" });
    const compact = vi.fn(async (...args: unknown[]) =>
      args[4] === "before_last_user_message" ? noShrink() : { wasCompacted: false });
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    const mandatory = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    expect(mandatory.map(tierOf)).toEqual(["standard", "standard", "aggressive_summary"]);
    const failed = exercise.events.find((event) => event.msg.type === "turn_failed");
    expect(failed?.msg).toMatchObject({ payload: { message: expect.stringContaining("tiers=[aggressive_summary]") } });
    expect(JSON.stringify(failed?.msg)).toContain("run /compact to retry manually");
  });

  test("a provider-side failure skips the second summarizer pass and goes straight to the emergency tier", async () => {
    const exercise = createToolExercise();
    const compact = vi.fn(async (...args: unknown[]) => {
      if (args[4] !== "before_last_user_message") return { wasCompacted: false };
      if (tierOf(args) === "emergency_local") return committed("emergency summary");
      return { wasCompacted: false, skippedReason: "compaction exceeded its wall-clock budget",
        skippedFailureReason: "wall_time_exceeded", consecutiveFailures: 1 } satisfies AutoCompactResult;
    });
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    const mandatory = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    // Later rounds stay above the fixture's limit and compact again; the
    // first episode is the one under test, and no round ever asks the
    // summarizer a second time.
    expect(mandatory.map(tierOf).slice(0, 2)).toEqual(["standard", "emergency_local"]);
    expect(mandatory.map(tierOf)).not.toContain("aggressive_summary");
    expect(terminals(exercise.events)).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test("a missing rollout owner (pin_failed) runs no ladder", async () => {
    const exercise = createToolExercise();
    const compact = vi.fn(async (...args: unknown[]) =>
      args[4] === "before_last_user_message"
        ? { wasCompacted: false, skippedReason: "durable compaction is unavailable", skippedFailureReason: "pin_failed", consecutiveFailures: 1 } satisfies AutoCompactResult
        : { wasCompacted: false });
    setAutoCompactImplForTests(compact);

    await drain(runTurn(exercise.session, exercise.ctx, "finish the implementation"));

    const mandatory = compact.mock.calls.filter((call) => call[4] === "before_last_user_message");
    expect(mandatory.map(tierOf)).toEqual(["standard"]);
    expect(terminals(exercise.events)).toContainEqual(expect.objectContaining({ outcome: "errored", failureCode: "compact_failed" }));
  });

  test("a committed compaction that is still above the limit escalates once more in the same call", async () => {
    let streamCount = 0;
    const seen: LLMMessage[][] = [];
    const provider = mkProvider({});
    provider.chatStream = async (messages): Promise<LLMResponse> => {
      seen.push([...messages]);
      streamCount += 1;
      if (streamCount === 1) {
        return { content: "need a tool", toolCalls: [{ id: "toolu_force", name: "Read", arguments: "{}" }],
          usage: { promptTokens: 18_130, completionTokens: 10, totalTokens: 18_140 }, model: "test-model", finishReason: "tool_calls" };
      }
      return { content: "after compaction", toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        model: "test-model", finishReason: "stop" };
    };
    const compact = vi.fn(async (...args: unknown[]) => {
      if ((args[5] as { force?: boolean }).force !== true) return { wasCompacted: false };
      // The standard commit is still far above the 18,129-token limit.
      return tierOf(args) === "standard" ? committed("x".repeat(200_000)) : committed("small summary");
    });
    setAutoCompactImplForTests(compact);
    const { session, events } = mkSession({ provider, modelInfo: { autoCompactTokenLimit: 18_129 } as never });

    await drain(runTurn(session, mkCtx({ modelInfo: { ...mkCtx().modelInfo, autoCompactTokenLimit: 18_129 } as never }), "start"));

    const forced = compact.mock.calls.filter((call) => (call[5] as { force?: boolean }).force === true);
    expect(forced.map(tierOf)).toEqual(["standard", "aggressive_summary"]);
    expect(degradedWarnings(events)).toEqual([
      expect.stringContaining("tier=aggressive_summary attempting: history still above the limit after standard"),
      expect.stringContaining("tier=aggressive_summary compacted"),
    ]);
    expect(seen[1]).toEqual([{ role: "user", content: "small summary" }]);
    expect(terminals(events)).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });
});
