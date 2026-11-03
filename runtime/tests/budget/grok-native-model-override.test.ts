import { describe, expect, it, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import type { LLMChatOptions } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import { createAllowAdmissionHarness } from "./admission-test-harness.js";

function fixture(configuredModel: string, requestModel: string, hardCap: boolean) {
  const state = createAllowAdmissionHarness({ scope: hardCap ? { maxCostUsd: 1 } : {} });
  const provider = new GrokProvider({ apiKey: "fixture", model: configuredModel, webSearch: true });
  const create = vi.fn((_body: Record<string, unknown>, _options?: unknown) => ({ withResponse: async () => ({ response: new Response("", { status: 200 }),
    data: { id: "response-test", status: "completed", model: requestModel,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    },
  }) }));
  (provider as unknown as { client: unknown }).client = { responses: { create } };
  const session = { conversationId: "session", services: { executionAdmission: state.admission },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  const messages = [{ role: "user" as const, content: "Hello" }];
  const invoke = vi.fn((options: LLMChatOptions) => provider.chat(messages, options));
  const call = (options: LLMChatOptions = {}) => runAdmittedModelCall({ session, provider, messages,
    options: { tools: [], model: requestModel, maxOutputTokens: 100, contextWindowTokens: 100_000, ...options },
    model: requestModel, providerName: "grok", stepId: "model:override", invoke,
  });
  return { ...state, provider, create, invoke, call };
}

describe("Grok native catalog under request model overrides", () => {
  it.each([undefined, ["web_search"]])("admits an actually tool-free override with allowlist %s", async (allowedToolNames) => {
    const state = fixture("grok-code-fast-1", "grok-4.5", true);
    await state.call(allowedToolNames === undefined ? {} : { toolRouting: { allowedToolNames } });
    expect(state.invoke).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ model: "grok-4.5" }), expect.anything());
    expect((state.create.mock.calls[0]![0] as Record<string, unknown>).tools).toBeUndefined();
    expect(state.acquire.mock.calls[0]![0].denialReason).toBeUndefined();
    expect(state.acquire.mock.calls[0]![0].maxInputTokens).toBeLessThan(100_000);
  });

  it("denies actual unbounded native search even when the override model has no native catalog", async () => {
    const state = fixture("grok-4.5", "grok-code-fast-1", true);
    await expect(state.call()).rejects.toMatchObject({ reason: "unbounded_provider_tool_under_hard_cap" });
    expect(state.invoke).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.markDispatched).not.toHaveBeenCalled();
  });

  it("reserves the context for the native search actually sent on an uncapped override", async () => {
    const state = fixture("grok-4.5", "grok-code-fast-1", false);
    await state.call();
    expect((state.create.mock.calls[0]![0] as Record<string, unknown>).tools).toContainEqual({ type: "web_search" });
    expect(state.acquire.mock.calls[0]![0].maxInputTokens).toBe(100_000);
  });

  it("allows a suppressed native catalog on the same override", async () => {
    const state = fixture("grok-4.5", "grok-code-fast-1", true);
    await state.call({ toolRouting: { allowedToolNames: [] } });
    expect(state.create).toHaveBeenCalledOnce();
    expect((state.create.mock.calls[0]![0] as Record<string, unknown>).tools).toBeUndefined();
  });
});
