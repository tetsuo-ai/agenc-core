import { describe, expect, test, vi } from "vitest";

import {
  TOKEN_ACCOUNTING_NATIVE_COUNT_DECISION_HEADROOM,
  TokenAccountingService,
  createTokenAccountingRequest,
  type ProviderNativeTokenCountResult,
  type ProviderTokenCountCapability,
  type TokenAccountingRequest,
} from "../../src/llm/token-accounting.js";
import type { LLMContentPart } from "../../src/llm/types.js";

function request(content: string | LLMContentPart[] = "hello there", scope = "conversation-1"): TokenAccountingRequest {
  return createTokenAccountingRequest({
    provider: "gemini",
    model: "gemini-4-argon",
    messages: [{ role: "user", content }],
    options: { maxOutputTokens: 64 },
    contextWindowTokens: 1_048_576,
    reservedOutputTokens: 64,
    calibrationScope: scope,
  });
}

function native(inputTokens: number): ProviderNativeTokenCountResult {
  return {
    inputTokens,
    complete: true,
    confidence: "exact",
    countedComponents: ["system", "messages", "tools", "tool_choice", "structured_output", "images", "documents", "provider_framing"],
  };
}

function capability(
  countTokens: ProviderTokenCountCapability["countTokens"],
  reportsExactPromptUsage: boolean,
): ProviderTokenCountCapability {
  return {
    ...(reportsExactPromptUsage ? { reportsExactPromptUsage: true as const } : {}),
    capabilityVersion: "count-v1",
    adapterRevision: "adapter-v1",
    configurationRevision: "configuration-v1",
    countTokens,
  };
}

describe("native counting for providers that report exact prompt usage", () => {
  test("keeps the calibrated estimate while it is far below the decision limit", async () => {
    const countTokens = vi.fn(async () => native(5));
    const service = new TokenAccountingService();
    const result = await service.count(request(), {
      capability: capability(countTokens, true),
      nativeCountFromTokens: 700_000,
    });
    expect(countTokens).not.toHaveBeenCalled();
    expect(result.source).toBe("conservative_fallback");
    expect(result.admissible).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("counts natively once the estimate could reach the decision limit", async () => {
    const countTokens = vi.fn(async () => native(5));
    const service = new TokenAccountingService();
    const estimate = service.estimate(request());
    const limit = Math.ceil(estimate.inputTokens * TOKEN_ACCOUNTING_NATIVE_COUNT_DECISION_HEADROOM) - 1;
    const result = await service.count(request(), {
      capability: capability(countTokens, true),
      nativeCountFromTokens: limit,
    });
    expect(countTokens).toHaveBeenCalledOnce();
    expect(result.source).toBe("provider_native");
    expect(result.inputTokens).toBe(5);
  });

  test("keeps native counting for every other provider and for callers without a limit", async () => {
    const service = new TokenAccountingService();
    const other = vi.fn(async () => native(7));
    await service.count(request("first"), { capability: capability(other, false), nativeCountFromTokens: 700_000 });
    expect(other).toHaveBeenCalledOnce();
    const exact = vi.fn(async () => native(9));
    await service.count(request("second"), { capability: capability(exact, true) });
    expect(exact).toHaveBeenCalledOnce();
  });

  test("counts natively when the local estimate cannot cover the request", async () => {
    const countTokens = vi.fn(async () => native(1_200));
    const service = new TokenAccountingService();
    const result = await service.count(request([
      { type: "text", text: "describe this" },
      { type: "image_url", image_url: { url: "https://media.example/a.png" } },
    ]), { capability: capability(countTokens, true), nativeCountFromTokens: 700_000 });
    expect(countTokens).toHaveBeenCalledOnce();
    expect(result.admissible).toBe(true);
  });

  test("a usage report above the estimate raises the next estimate toward the limit", async () => {
    const countTokens = vi.fn(async () => native(5));
    const service = new TokenAccountingService();
    const exact = capability(countTokens, true);
    const first = await service.count(request(), { capability: exact, nativeCountFromTokens: 700_000 });
    expect(countTokens).not.toHaveBeenCalled();
    // The provider read three times what the estimate assumed.
    service.recordProviderUsage(first, first.inputTokens * 3);
    const second = await service.count(request(), { capability: exact, nativeCountFromTokens: 700_000 });
    expect(second.inputTokens).toBeGreaterThanOrEqual(first.inputTokens * 3);
    const limit = Math.ceil(second.inputTokens * TOKEN_ACCOUNTING_NATIVE_COUNT_DECISION_HEADROOM) - 1;
    await service.count(request(), { capability: exact, nativeCountFromTokens: limit });
    expect(countTokens).toHaveBeenCalledOnce();
  });
});
