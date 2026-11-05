import { describe, expect, it, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { tokenAccountingService } from "../../src/llm/token-accounting.js";
import type { LLMProvider, LLMTool } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import { createAllowAdmissionHarness } from "./admission-test-harness.js";

const tools: LLMTool[] = ["mcp.a.b", "mcp__a__b"].map((name) => ({
  type: "function", function: { name, description: "Fixture", parameters: { type: "object" } },
}));
const messages = [{ role: "user" as const, content: "PRIVATE_REQUEST_CANARY" }];
const cases = [
  ["openai-chat", "gpt-6-luna", () => new OpenAIProvider({ apiKey: "fixture", model: "gpt-6-luna", useResponsesApi: false })],
  ["openai-responses", "gpt-6-luna", () => new OpenAIProvider({ apiKey: "fixture", model: "gpt-6-luna", useResponsesApi: true })],
  ["deepseek", "deepseek-flash", () => new OpenAIProvider({ apiKey: "fixture", providerName: "deepseek", model: "deepseek-flash", useResponsesApi: false })],
  ["meta-responses", "muse-wonder-1.0", () => new OpenAIProvider({ apiKey: "fixture", providerName: "meta", model: "muse-wonder-1.0", useResponsesApi: true })],
  ["anthropic", "claude-sonnet-4-5", () => new AnthropicProvider({ apiKey: "fixture", model: "claude-sonnet-4-5" })],
  ["grok", "grok-4.5", () => new GrokProvider({ apiKey: "fixture", model: "grok-4.5" })],
] as const;

describe.each([false, true])("tool-name admission with disabled schema=%s", (disabledSchema) => {
  it.each(cases)("rejects %s collisions before counting or reserving", async (_label, model, makeProvider) => {
    const provider: LLMProvider = makeProvider();
    vi.spyOn(provider, "getExecutionProfile").mockResolvedValue({
      provider: provider.name, model, usageReporting: "authoritative", supportsMaxOutputTokens: true,
    });
    const state = createAllowAdmissionHarness();
    const emit = vi.fn();
    const session = { conversationId: "session", services: { executionAdmission: state.admission },
      emit, nextInternalSubId: () => "diagnostic", abortTerminal: vi.fn(),
    } as unknown as Session;
    const count = vi.spyOn(tokenAccountingService, "count");
    const invoke = vi.fn(async () => { throw new Error("wire-name rejection after dispatch"); });
    try {
      await expect(runAdmittedModelCall({ session, provider, messages,
        options: { tools, maxOutputTokens: 100,
          ...(disabledSchema ? { structuredOutput: { enabled: false } } : {}),
        }, stepId: "aux:tool-names", model, providerName: provider.name, invoke,
      })).rejects.toThrow(/Provider tool-name collision/);
      expect(count).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(state.acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        denialReason: "local_provider_capability_rejection", maxInputTokens: 0,
        maxOutputTokens: 0, maxCostUsd: 0,
      }), undefined);
      expect(state.markDispatched).not.toHaveBeenCalled();
      expect(state.holdUnknown).not.toHaveBeenCalled();
      expect(JSON.stringify(emit.mock.calls)).not.toMatch(/PRIVATE_REQUEST_CANARY|mcp\.a\.b/);
    } finally { vi.restoreAllMocks(); }
  });
});

it("preserves wire omission of colliding tools on auto-only routes", () => {
  for (const config of [
    { providerName: "zai", model: "glm-5.3", useResponsesApi: false },
    { providerName: "meta", model: "muse-wonder-1.0", useResponsesApi: true },
  ]) {
    const provider = new OpenAIProvider({ apiKey: "fixture", ...config });
    expect(() => provider.validateRequest(messages, { tools, toolChoice: "none" })).not.toThrow();
  }
});

it("preserves Grok multi-agent omission of client tools", () => {
  const provider = new GrokProvider({ apiKey: "fixture", model: "grok-4.20-multi-agent-beta-0309" });
  expect(() => provider.validateRequest(messages, { tools })).not.toThrow();
});
