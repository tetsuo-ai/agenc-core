import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import {
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
} from "../../src/llm/token-accounting.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import {
  getActiveContextTokenUsage,
  getPreSamplingAutoCompactTokenLimit,
} from "../../src/session/run-turn-compaction.js";
import { AUTOCOMPACT_MAX_WINDOW_FRACTION } from "../../src/services/compact/thresholds.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

const WINDOW = 100_000;
const MAX_OUTPUT = 32_000;
// Large enough that the conservative-fallback input alone clears 0.75 of the
// window, and input plus the reserved output no longer fits.
const OVER_THRESHOLD_TOOL_RESULT = "t".repeat(250_000);
// Retained with the assistant tool-call message. Tool-result offload and
// truncate-to-fit do not apply to it, so the next prepared request still
// carries it. Sized so the conservative-fallback input alone no longer
// leaves a usable output reservation.
const RETAINED_REASONING = "r".repeat(400_000);

function zaiContext() {
  const provider = mkProvider();
  Object.assign(provider, { name: "zai-coding-plan" });
  const base = mkCtx();
  const ctx = mkCtx({
    modelProviderId: "zai-coding-plan",
    provider,
    modelInfo: {
      ...base.modelInfo,
      slug: "glm-5.3",
      contextWindow: WINDOW,
      maxOutputTokens: MAX_OUTPUT,
      effectiveContextWindowPercent: 100,
    },
  });
  return { provider, ctx };
}

function pressureOf(messages: readonly LLMMessage[]) {
  return estimateTokenAccountingRequest(createTokenAccountingRequest({
    provider: "zai-coding-plan",
    model: "glm-5.3",
    messages,
    options: { contextWindowTokens: WINDOW, maxOutputTokens: MAX_OUTPUT },
    contextWindowTokens: WINDOW,
    reservedOutputTokens: MAX_OUTPUT,
  }));
}

describe("auto-compaction from a conservative-fallback estimate", () => {
  test("the live gate counts a tool-call history on the same scale admission will refuse", () => {
    const { provider, ctx } = zaiContext();
    const { session } = mkSession({ provider });
    const reasoning = "r".repeat(40_000);
    const history: LLMMessage[] = [
      { role: "user", content: "inspect the tree" },
      {
        role: "assistant",
        content: "reading",
        toolCalls: [{ id: "c1", name: "read_probe", arguments: "{\"path\":\"src\"}" }],
        providerReasoningContent: reasoning,
        providerReasoningProvenance: { provider: "zai-coding-plan", model: "glm-5.3" },
      },
      { role: "tool", content: OVER_THRESHOLD_TOOL_RESULT, toolCallId: "c1", toolName: "read_probe" },
    ];
    const state = buildInitialTurnState(ctx, { role: "user", content: "continue" }, {
      priorMessages: history,
    });
    state.messagesForQuery = [...state.messages];
    state.lastResponseUsage = {
      promptTokens: 2_000,
      completionTokens: 1,
      totalTokens: 2_001,
    };
    const accounted = pressureOf(state.messages);
    const limit = getPreSamplingAutoCompactTokenLimit(ctx)!;
    const gate = Math.max(
      state.lastResponseUsage.promptTokens,
      getActiveContextTokenUsage(session, ctx, state),
    );

    expect(accounted.source).toBe("conservative_fallback");
    expect(limit).toBe(Math.floor(WINDOW * AUTOCOMPACT_MAX_WINDOW_FRACTION));
    expect(accounted.inputTokens).toBeGreaterThanOrEqual(limit);
    expect(accounted.totalTokens).toBeGreaterThan(WINDOW);
    // Provider-reported prompt tokens stay far under the limit. The gate has
    // to follow the fallback estimate or this history never compacts.
    expect(state.lastResponseUsage.promptTokens).toBeLessThan(limit);
    expect(gate).toBeGreaterThanOrEqual(limit);
  });

  test("a tool-call follow-up past the fallback window compacts before that sample is refused", async () => {
    const { provider, ctx } = zaiContext();
    let samples = 0;
    const outputLimits: Array<number | undefined> = [];
    const toolCall = { id: "read-1", name: "read_probe", arguments: "{\"round\":1}" };
    provider.chatStream = async (_messages, _onChunk, options): Promise<LLMResponse> => {
      samples += 1;
      outputLimits.push(options?.maxOutputTokens);
      return {
        content: "Continue the implementation.",
        toolCalls: [toolCall],
        usage: { promptTokens: 2_000, completionTokens: 8, totalTokens: 2_008 },
        providerReasoningContent: RETAINED_REASONING,
        providerReasoningProvenance: { provider: "zai-coding-plan", model: "glm-5.3" },
        model: "glm-5.3",
        finishReason: "tool_calls",
      };
    };
    const registry = {
      tools: [{
        name: "read_probe",
        description: "Read the next result",
        inputSchema: { type: "object" },
        requiresApproval: false,
        recoveryCategory: "read-only",
        execute: async () => ({ content: "probe ok", isError: false }),
      }],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "probe ok", isError: false }),
    } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    const compact = vi.fn(async () => ({
      wasCompacted: false,
      skippedReason: "synthetic decline",
      consecutiveFailures: 1,
    }));
    setAutoCompactImplForTests(compact);
    const limit = Math.floor(WINDOW * AUTOCOMPACT_MAX_WINDOW_FRACTION);
    const jumped = pressureOf([
      { role: "user", content: "finish the implementation" },
      {
        role: "assistant",
        content: "Continue the implementation.",
        toolCalls: [toolCall],
        providerReasoningContent: RETAINED_REASONING,
        providerReasoningProvenance: { provider: "zai-coding-plan", model: "glm-5.3" },
      },
      { role: "tool", content: "probe ok", toolCallId: toolCall.id, toolName: toolCall.name },
    ]);

    await drain(runTurn(session, ctx, "finish the implementation"));

    expect(jumped.source).toBe("conservative_fallback");
    expect(jumped.inputTokens).toBeGreaterThanOrEqual(limit);
    expect(jumped.inputTokens).toBeGreaterThan(WINDOW - 1_024);
    expect(compact).toHaveBeenCalled();
    expect(samples).toBe(1);
    expect(outputLimits).toEqual([MAX_OUTPUT]);
    const terminals = events.map((event) => classifyTurnTerminal(event.msg));
    expect(terminals).toContainEqual(expect.objectContaining({
      outcome: "errored",
      failureCode: "compact_failed",
    }));
    expect(terminals).not.toContainEqual(expect.objectContaining({
      failureCode: "turn_execution_failed",
    }));
  });

  test("advisory no-shrink on the prepared request still sends a later mandatory compaction", async () => {
    const { provider, ctx } = zaiContext();
    let samples = 0;
    const seen: string[] = [];
    const toolCall = { id: "read-1", name: "read_probe", arguments: "{\"round\":1}" };
    provider.chatStream = async (messages, _onChunk, _options): Promise<LLMResponse> => {
      samples += 1;
      seen.push(JSON.stringify(messages));
      if (samples === 1) {
        return {
          content: "Continue the implementation.",
          toolCalls: [toolCall],
          usage: { promptTokens: 2_000, completionTokens: 8, totalTokens: 2_008 },
          providerReasoningContent: RETAINED_REASONING,
          providerReasoningProvenance: { provider: "zai-coding-plan", model: "glm-5.3" },
          model: "glm-5.3",
          finishReason: "tool_calls",
        };
      }
      return {
        content: "done",
        usage: { promptTokens: 100, completionTokens: 1, totalTokens: 101 },
        model: "glm-5.3",
        finishReason: "stop",
      };
    };
    const registry = {
      tools: [{
        name: "read_probe",
        description: "Read the next result",
        inputSchema: { type: "object" },
        requiresApproval: false,
        recoveryCategory: "read-only",
        execute: async () => ({ content: "probe ok", isError: false }),
      }],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "probe ok", isError: false }),
    } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    let attempts = 0;
    setAutoCompactImplForTests(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          wasCompacted: false,
          skippedCode: "no_shrink",
          skippedReason: "compaction candidate cannot meet minimum savings",
          consecutiveFailures: 1,
        };
      }
      return {
        wasCompacted: true,
        compactionResult: {
          message: "small summary",
          replacementHistory: [{ role: "user", content: "small summary" }],
        },
      };
    });

    await drain(runTurn(session, ctx, "finish the implementation"));

    expect(attempts).toBe(2);
    expect(samples).toBe(2);
    expect(seen[1]).toContain("small summary");
    expect(seen[1]).not.toContain(RETAINED_REASONING.slice(0, 64));
    const terminals = events.map((event) => classifyTurnTerminal(event.msg));
    expect(terminals).toContainEqual(expect.objectContaining({
      outcome: "completed",
      code: 0,
    }));
    expect(terminals).not.toContainEqual(expect.objectContaining({
      failureCode: "compact_failed",
    }));
  });
});
