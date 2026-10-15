import { afterEach, expect, test } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import {
  createTokenAccountingRequest,
  tokenAccountingService,
  type TokenAccountingRequest,
} from "../../src/llm/token-accounting.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
  tokenAccountingService.clear();
});

for (const accounting of ["native", "calibrated fallback", "calibrated fallback below raw threshold", "calibration raised by advisory refusal"] as const) {
  for (const fits of [false, true]) {
    test(`${accounting}: a replacement below the proactive threshold ${fits ? "is sent when it fits" : "ends compact_failed when it cannot fit"}`, async () => {
      tokenAccountingService.clear();
      const provider = mkProvider();
      Object.assign(provider, { name: "zai-coding-plan" });
      const model = "glm-5.3";
      const replacement = !fits && accounting !== "native"
        ? "small-summary ".repeat(6_500)
        : "small-summary done";
      if (accounting === "native") {
        Object.assign(provider, { tokenCountCapability: {
          runsLocally: true as const,
          capabilityVersion: "prepared-dispatch-fit-after-compaction",
          adapterRevision: "1", configurationRevision: String(fits),
          countTokens: async (request: TokenAccountingRequest) => ({
            inputTokens: JSON.stringify(request.messages).includes(replacement)
              ? (fits ? 97_000 : 99_000) : request.messages.some(message => message.role === "tool") ? 90_000 : 1_000,
            complete: true, confidence: "exact",
            countedComponents: ["system", "messages", "tools", "provider_framing"],
          }),
        } });
      } else if (accounting !== "calibration raised by advisory refusal") {
        // Admission learns this factor from previous reported provider usage.
        // The proactive estimate remains uncalibrated, so the replacement
        // can fall below its threshold while still failing hard admission.
        const seed = await tokenAccountingService.count(createTokenAccountingRequest({
          provider: provider.name, model, calibrationScope: "conv-test",
          messages: [{ role: "user", content: "previous measured sample" }],
          options: { model }, contextWindowTokens: 100_000, reservedOutputTokens: 32_000,
        }));
        tokenAccountingService.recordProviderUsage(seed, seed.inputTokens * 4);
      }
      const requests: LLMMessage[][] = [];
      const outputLimits: Array<number | undefined> = [];
      provider.chatStream = async (messages, _onChunk, options): Promise<LLMResponse> => {
        requests.push([...messages]);
        outputLimits.push(options?.maxOutputTokens);
        const first = requests.length === 1;
        return {
          content: first ? "Read one result." : "done",
          toolCalls: first ? [{ id: "read-1", name: "read_probe", arguments: "{}" }] : [],
          ...(first ? { providerReasoningContent: "r".repeat(accounting === "calibrated fallback below raw threshold" ? 120_000 : accounting === "calibration raised by advisory refusal" ? 280_000 : 400_000),
            providerReasoningProvenance: { provider: provider.name, model } } : {}),
          usage: { promptTokens: 1_000, completionTokens: 1, totalTokens: 1_001 },
          model, finishReason: first ? "tool_calls" : "stop",
        };
      };
      const result = async () => ({ content: "read complete", isError: false });
      const registry = {
        tools: [{ name: "read_probe", description: "Read", inputSchema: { type: "object" },
          requiresApproval: false, recoveryCategory: "read-only", execute: result }],
        toLLMTools: () => [], dispatch: result,
      } as unknown as ToolRegistry;
      const { session, events } = mkSession({ provider, registry, model, services: {
        runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
      } });
      const ctx = mkCtx({ provider, modelProviderId: provider.name, modelInfo: {
        ...mkCtx().modelInfo, slug: model, contextWindow: 100_000,
        maxOutputTokens: 32_000, effectiveContextWindowPercent: 100,
      } });
      let attempts = 0;
      setAutoCompactImplForTests(async () => {
        attempts++;
        if (accounting === "calibration raised by advisory refusal" && attempts === 1) {
          // A real admitted summary response can raise the same conversation
          // calibration even when its candidate is rejected or cannot shrink.
          const seed = await tokenAccountingService.count(createTokenAccountingRequest({
            provider: provider.name, model, calibrationScope: "conv-test",
            messages: [{ role: "user", content: "measured compaction response" }],
            options: { model }, contextWindowTokens: 100_000, reservedOutputTokens: 32_000,
          }));
          tokenAccountingService.recordProviderUsage(seed, seed.inputTokens * 4);
          return { wasCompacted: false, skippedCode: "no_shrink", consecutiveFailures: 1 };
        }
        return { wasCompacted: true, compactionResult: {
          message: replacement, replacementHistory: [{ role: "user", content: replacement }],
        } };
      });
      await drain(runTurn(session, ctx, "Read once and finish."));
      expect(attempts, JSON.stringify(events.map(event => event.msg))).toBe(accounting === "calibration raised by advisory refusal" ? 2 : 1);
      expect(requests).toHaveLength(fits ? 2 : 1);
      const terminals = events.map(event => classifyTurnTerminal(event.msg));
      if (fits) {
        expect(JSON.stringify(requests[1])).toContain(replacement);
        expect(terminals).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
        if (accounting === "native") expect(outputLimits[1]).toBe(3_000);
      } else {
        expect(terminals).toContainEqual(expect.objectContaining({ failureCode: "compact_failed" }));
        expect(terminals).not.toContainEqual(expect.objectContaining({ failureCode: "turn_execution_failed" }));
      }
    });
  }
}
