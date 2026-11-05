import { describe, expect, it, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import type { LLMChatOptions, LLMResponse } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import { createAllowAdmissionHarness } from "./admission-test-harness.js";

function fixture(hardCap: boolean, remoteMcp = false) {
  const state = createAllowAdmissionHarness({ scope: hardCap ? { maxCostUsd: 1 } : {} });
  const provider = new GrokProvider({ apiKey: "fixture", model: "grok-4.5", webSearch: !remoteMcp,
    ...(remoteMcp ? { remoteMcp: { enabled: true, servers: [{ serverLabel: "remote", serverUrl: "https://mcp.example" }] } } : {}),
  });
  if (remoteMcp) Object.assign(provider, { tokenCountCapability: {
    capabilityVersion: "complete-native-v1", adapterRevision: "test-v1", configurationRevision: "test-config",
    countTokens: async () => ({ inputTokens: 100, complete: true, confidence: "exact",
      countedComponents: ["messages", "tools", "provider_framing"] }),
  } });
  const session = { conversationId: "session", services: { executionAdmission: state.admission },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  const invoke = vi.fn(async (): Promise<LLMResponse> => ({ content: "ok", toolCalls: [], model: "grok-4.5",
    finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110,
      availability: "reported", provenance: "provider", webSearchRequests: 1 },
  }));
  const call = (options: LLMChatOptions = {}) => runAdmittedModelCall({ session, provider, messages: [{ role: "user", content: "hello" }],
    options: { tools: [], maxOutputTokens: 200, contextWindowTokens: 100_000, ...options },
    stepId: "model:implicit", model: "grok-4.5", providerName: "grok", invoke });
  return { ...state, invoke, call };
}

describe("implicitly selected provider-native tool accounting", () => {
  it("denies configured native search under a hard cap without an explicit allowlist", async () => {
    const state = fixture(true);
    await expect(state.call()).rejects.toMatchObject({ reason: "unbounded_provider_tool_under_hard_cap" });
    expect(state.acquire).toHaveBeenCalledWith(expect.objectContaining({ maxInputTokens: 100_000 }), undefined);
    expect(state.invoke).not.toHaveBeenCalled();
    expect(state.markDispatched).not.toHaveBeenCalled();
  });

  it("reserves the context and search price even when the caller advertises no function tools", async () => {
    const state = fixture(false);
    await state.call();
    expect(state.acquire).toHaveBeenCalledWith(expect.objectContaining({ maxInputTokens: 100_000,
      maxCostUsd: expect.any(Number) }), undefined);
    expect(state.acquire.mock.calls[0]![0].maxCostUsd).toBeGreaterThan(0.2);
    expect(state.invoke).toHaveBeenCalledOnce();
  });

  it("retains unknown MCP cost while reconciling its complete token usage", async () => {
    const state = fixture(false, true);
    await state.call();
    expect(state.acquire).toHaveBeenCalledWith(expect.objectContaining({ maxInputTokens: 100_000 }), undefined);
    expect(state.reconcile).toHaveBeenCalledWith("reservation-1", {
      inputTokens: 100, outputTokens: 10, costUsd: null,
    });
  });

  it("allows explicitly suppressed native tools under the hard cap", async () => {
    const state = fixture(true);
    await state.call({ toolRouting: { allowedToolNames: [] } });
    expect(state.invoke).toHaveBeenCalledOnce();
    expect(state.acquire.mock.calls[0]![0].maxInputTokens).toBeLessThan(100_000);
  });
});
