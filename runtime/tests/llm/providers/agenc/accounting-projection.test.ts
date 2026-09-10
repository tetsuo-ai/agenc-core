import { describe, expect, test, vi } from "vitest";
import { AgenCProvider } from "../../../../src/llm/providers/agenc/index.js";
import type { AuthBackend } from "../../../../src/auth/backend.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponse } from "../../../../src/llm/types.js";

describe("AgenC pinned inner request projection", () => {
  test.each([false, true])("uses the same inner handle for accounting and a single wire call (stream=%s)", async streaming => {
    const innerHandle = Object.freeze({});
    const result: LLMResponse = { content: "ok", toolCalls: [], model: "local", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    const seen: LLMChatOptions[] = [];
    const project = vi.fn((messages: readonly LLMMessage[], options: LLMChatOptions) => {
      expect(options.providerExecutionHandle).toBe(innerHandle);
      return { messages, options: { ...options, systemPrompt: "profiled protocol", tools: [] } };
    });
    const invoke = vi.fn(async (_messages: LLMMessage[], options?: LLMChatOptions) => { seen.push(options!); return result; });
    const delegate: LLMProvider = {
      name: "ollama", chat: invoke,
      chatStream: async (messages, _chunk, options) => invoke(messages, options),
      healthCheck: async () => true,
      getExecutionProfile: async () => ({ provider: "ollama", model: "local", usageReporting: "authoritative", supportsMaxOutputTokens: true, providerExecutionHandle: innerHandle }),
      projectRequestForAccounting: project,
    };
    const providerFactory = vi.fn(() => delegate);
    const authBackend = {
      inferAgencModel: () => ({ provider: "ollama", model: "local" }),
      vendKey: () => ({ kind: "api-key", apiKey: "test" }),
    } as unknown as AuthBackend;
    const provider = new AgenCProvider({ model: "agenc:local", sessionId: "local-session", authBackend, providerFactory });
    const profile = await provider.getExecutionProfile();
    const options = { model: "agenc:local", maxOutputTokens: 512, providerExecutionHandle: profile.providerExecutionHandle };
    expect(profile.providerExecutionHandle).not.toBe(innerHandle);
    const projection = provider.projectRequestForAccounting([], options);
    expect(projection.options.systemPrompt).toBe("profiled protocol");
    expect(projection.options.model).toBe("local");
    if (streaming) await provider.chatStream([], () => {}, options);
    else await provider.chat([], options);
    expect(seen).toEqual([{ ...options, model: "local", providerExecutionHandle: innerHandle }]);
    expect(providerFactory).toHaveBeenCalledOnce();
    expect(() => provider.projectRequestForAccounting([], options)).toThrow("prepared execution handle");
    await expect(provider.chat([], options)).rejects.toThrow("already-consumed");
    expect(invoke).toHaveBeenCalledOnce();
  });
});
