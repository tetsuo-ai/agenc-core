import { describe, expect, it, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { assertProviderStructuredOutputCompatibility } from "../../src/llm/provider-capabilities.js";
import { tokenAccountingService } from "../../src/llm/token-accounting.js";
import type { LLMProvider } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import { createAllowAdmissionHarness } from "./admission-test-harness.js";

function rejectCapability(): never {
  assertProviderStructuredOutputCompatibility({
    providerName: "deepseek", model: "deepseek-flash", api: "chat_completions",
    structuredOutput: { enabled: true, schema: {
      type: "json_schema", name: "test", schema: { type: "object" },
    } },
  });
  throw new Error("expected local capability rejection");
}

function fixture(validateRequest: () => void) {
  const state = createAllowAdmissionHarness();
  const emit = vi.fn();
  const session = { conversationId: "session", services: {
    executionAdmission: state.admission,
  }, emit, nextInternalSubId: () => "diagnostic" } as unknown as Session;
  const provider = { name: "deepseek", validateRequest,
    getExecutionProfile: async () => ({ provider: "deepseek", model: "deepseek-flash",
      usageReporting: "authoritative", supportsMaxOutputTokens: true }),
  } as unknown as LLMProvider;
  const invoke = vi.fn(async () => { throw new Error("transport lost"); });
  const run = () => runAdmittedModelCall({ session, provider,
    messages: [{ role: "user", content: "private prompt must never reach diagnostics" }],
    options: { maxOutputTokens: 100 }, stepId: "aux:1", model: "deepseek-flash",
    providerName: "deepseek", invoke,
  });
  return { ...state, emit, invoke, run };
}

describe("local capability admission boundary", () => {
  it("records a local rejection with no token counting, dispatch or unknown hold", async () => {
    const count = vi.spyOn(tokenAccountingService, "count");
    try {
      const state = fixture(rejectCapability);
      await expect(state.run()).rejects.toThrow(/structured outputs/);
      expect(count).not.toHaveBeenCalled();
      expect(state.invoke).not.toHaveBeenCalled();
      expect(state.acquire).toHaveBeenCalledWith(expect.objectContaining({
        denialReason: "local_provider_capability_rejection", maxInputTokens: 0,
        maxOutputTokens: 0, maxCostUsd: 0,
      }), undefined);
      expect(state.markDispatched).not.toHaveBeenCalled();
      expect(state.holdUnknown).not.toHaveBeenCalled();
      expect(state.emit).toHaveBeenCalledWith(expect.objectContaining({ msg: {
        type: "warning", payload: { cause: "local_provider_capability_rejection",
          message: expect.stringContaining("structured_output") },
      } }));
      expect(JSON.stringify(state.emit.mock.calls)).not.toContain("private prompt");
    } finally { count.mockRestore(); }
  });

  it("keeps a genuine transport failure charged as unknown", async () => {
    const state = fixture(() => undefined);
    await expect(state.run()).rejects.toThrow("transport lost");
    expect(state.markDispatched).toHaveBeenCalledOnce();
    expect(state.holdUnknown).toHaveBeenCalledWith("reservation-1", "provider_call_failed_after_dispatch");
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it("never treats an error class raised after dispatch as proof of zero usage", async () => {
    const state = fixture(() => undefined);
    state.invoke.mockImplementation(async () => rejectCapability());
    await expect(state.run()).rejects.toThrow(/structured outputs/);
    expect(state.markDispatched).toHaveBeenCalledOnce();
    expect(state.holdUnknown).toHaveBeenCalledOnce();
    expect(state.reconcile).not.toHaveBeenCalled();
  });
});
