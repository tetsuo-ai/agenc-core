import { afterEach, describe, expect, test, vi } from "vitest";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { AutoCompactResult } from "../../src/session/run-turn-compaction.js";
import type { TokenAccountingRequest } from "../../src/llm/token-accounting.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => { setAutoCompactImplForTests(null); vi.restoreAllMocks(); });

describe("independent provider reserve through real turn preflight", () => {
  test.each([
    { input: 948_879, expectedAttempts: 2 },
    { input: 948_914, expectedAttempts: 2 },
    { input: 947_952, expectedAttempts: 1 },
  ])("recompacts only when the buffered input $input cannot fit", async ({ input, expectedAttempts }) => {
    let samples = 0;
    const requests: LLMMessage[][] = [];
    const limits: Array<number | undefined> = [];
    const provider = mkProvider();
    Object.assign(provider, {
      getExecutionProfile: async () => ({ provider: provider.name, model: "test-model", usageReporting: "authoritative", supportsMaxOutputTokens: true, contextSafetyBufferTokens: 1024 }),
      tokenCountCapability: {
        capabilityVersion: "independent-preflight-buffer", adapterRevision: "1", configurationRevision: String(input),
        countTokens: async (request: TokenAccountingRequest) => ({
          inputTokens: JSON.stringify(request.messages).includes("fresh-boundary") ? input
            : JSON.stringify(request.messages).includes("small replacement") ? 1024 : 150000,
          complete: true, confidence: "exact", countedComponents: ["system", "messages", "tools", "provider_framing"],
        }),
      },
    });
    provider.chatStream = async (messages, _onChunk, options): Promise<LLMResponse> => {
      requests.push([...messages]); limits.push(options?.maxOutputTokens); samples += 1;
      return { content: samples === 1 ? "Continue" : "finished",
        toolCalls: samples === 1 ? [{ id: "probe", name: "read_probe", arguments: "{}" }] : [],
        usage: { promptTokens: 150000, completionTokens: 1, totalTokens: 150001 }, model: "test-model",
        finishReason: samples === 1 ? "tool_calls" : "stop" };
    };
    const dispatch = async () => ({ content: "fresh-boundary", isError: false });
    const registry = { tools: [{ name: "read_probe", description: "read", inputSchema: { type: "object" }, requiresApproval: false, recoveryCategory: "read-only", execute: dispatch }], toLLMTools: () => [], dispatch } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    const ctx = mkCtx({ modelInfo: { ...mkCtx().modelInfo, contextWindow: 950000, maxOutputTokens: 131072, autoCompactTokenLimit: 140000 } });
    let attempts = 0;
    setAutoCompactImplForTests(async (_messages, _ctx, _tracking, _snip, injection): Promise<AutoCompactResult> => {
      if (injection !== "before_last_user_message") return { wasCompacted: false };
      attempts += 1;
      if (attempts === 1) return { wasCompacted: false, skippedCode: "no_shrink", skippedReason: "synthetic advisory refusal", consecutiveFailures: 1 };
      return { wasCompacted: true, compactionResult: { message: "small replacement", replacementHistory: [{ role: "user", content: "small replacement" }] } };
    });
    await drain(runTurn(session, ctx, "complete the synthetic task"));
    expect(attempts).toBe(expectedAttempts);
    expect(samples).toBe(2);
    if (expectedAttempts === 2) {
      expect(JSON.stringify(requests[1])).toContain("small replacement");
      expect(JSON.stringify(requests[1])).not.toContain("fresh-boundary");
    } else {
      expect(JSON.stringify(requests[1])).toContain("fresh-boundary");
      expect(limits[1]).toBe(1024);
    }
    expect(events.map(event => classifyTurnTerminal(event.msg))).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });
});
