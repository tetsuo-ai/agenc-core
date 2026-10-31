import { describe, expect, it, vi } from "vitest";
import { buildProviderModelCatalog } from "../../../src/config/provider-model-authority.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { QwenTokenPlanProvider } from "../../../src/llm/providers/qwen/index.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import type { LLMTool } from "../../../src/llm/types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";

// The Token Plan Models API listed these chat ids beside its five Qwen models
// on 2026-10-31, and each answered a parallel tool call on the plan endpoint.
const HOSTED = [
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731",
  "glm-5.3",
  "glm-5.2",
] as const;
// The PAYG deployment whose contract each Token Plan id uses.
const PAYG_SOURCE: Record<(typeof HOSTED)[number], string> = {
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017": "deepseek-v4.1-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro-0813": "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
  "glm-5.3": "glm-5.3",
  "glm-5.2": "glm-5.2",
};
const tool: LLMTool = { type: "function", function: {
  name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}};
const messages = [{ role: "user" as const, content: "Call echo." }];

describe("QwenCloud Token Plan hosted DeepSeek and GLM models", () => {
  it.each(HOSTED)("accepts %s on the Token Plan and lists it in the picker", (model) => {
    expect(() => new QwenTokenPlanProvider({ apiKey: "sk-sp-test", model })).not.toThrow();
    expect(buildProviderModelCatalog({})["qwen-token-plan"]).toContain(model);
  });

  it("still refuses ids the plan does not serve or that publish no contract", () => {
    for (const model of ["auto", "kimi-k2.7-code", "deepseek-v4-flash", "glm-5.1", "some-third-party-model"]) {
      expect(() => new QwenTokenPlanProvider({ apiKey: "sk-sp-test", model }))
        .toThrow(/not in the current Token Plan chat allowlist/i);
    }
  });

  it.each(HOSTED)("gives %s the PAYG limits, modalities and effort enum of its deployment", (model) => {
    const plan = resolveRegisteredModelCatalogEntry({ provider: "qwen-token-plan", model });
    const payg = resolveRegisteredModelCatalogEntry({ provider: "qwen", model: PAYG_SOURCE[model] });
    expect(payg).toBeDefined();
    expect(plan).toMatchObject({
      provider: "qwen-token-plan",
      model,
      contextWindow: payg!.contextWindow,
      maxOutputTokens: payg!.maxOutputTokens,
      inputModalities: payg!.inputModalities,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportedReasoningLevels: payg!.supportedReasoningLevels,
      visibility: "list",
    });
    expect(plan?.defaultReasoningLevel).toBe(payg!.defaultReasoningLevel);
    expect(resolveReasoningEffort({ provider: "qwen-token-plan", model }))
      .toMatchObject({ acceptsChatEffort: true, levels: payg!.supportedReasoningLevels });
  });

  it.each(HOSTED)("sends %s the same chat request as the PAYG deployment", (model) => {
    const body = (provider: "qwen" | "qwen-token-plan", id: string) => buildChatCompletionsRequest({
      model: id, messages, tools: [tool], maxTokenField: "max_completion_tokens",
      options: { reasoningEffort: "high", toolChoice: "auto", parallelToolCalls: true },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, id),
    });
    expect(body("qwen-token-plan", model)).toEqual({ ...body("qwen", PAYG_SOURCE[model]), model });
  });

  it("streams GLM tool calls and keeps the total-output field through the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      id: "chatcmpl-plan", model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new QwenTokenPlanProvider({
      apiKey: "placeholder", model: "glm-5.3", baseURL: "http://127.0.0.1:1/compatible-mode/v1", fetchImpl,
    });
    await provider.chat(messages, { tools: [tool], toolChoice: "auto", maxOutputTokens: 4096 });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({ model: "glm-5.3", tool_stream: true, max_completion_tokens: 4096 });
    expect(sent).not.toHaveProperty("max_tokens");
  });
});
