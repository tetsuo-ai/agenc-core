import { expect, test, vi } from "vitest";
import type { LLMMessage, LLMTool } from "../../src/llm/types.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";

test.each([
  ["cerebras", "gpt-oss-120b", "https://example.test/image.png"],
  ["kimi", "kimi-k3", "https://example.test/image.png"],
  ["zai", "glm-5.3-flash", "https://example.test/image.gif"],
  ["zai", "glm-5.3", "https://example.test/image.png"],
] as const)("preflights the %s image contract without a provider call", async (providerName, model, url) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new OpenAIProvider({ providerName, model, apiKey: "test-only",
    useResponsesApi: false, fetchImpl });
  const messages: LLMMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
  await expect(Promise.resolve().then(() => provider.validateRequest(messages, {})))
    .rejects.toMatchObject({ name: "LLMCapabilityError", capability: "request_features" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("preflights Zai tool limits with the same wire omission policy", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new OpenAIProvider({ providerName: "zai", model: "glm-5.3",
    apiKey: "test-only", useResponsesApi: false, fetchImpl });
  const tools: LLMTool[] = Array.from({ length: 129 }, (_, index) => ({ type: "function", function: {
    name: `tool_${index}`, description: "Test", parameters: { type: "object" },
  } }));
  const messages: LLMMessage[] = [{ role: "user", content: "Choose one tool." }];
  await expect(Promise.resolve().then(() => provider.validateRequest(messages, { tools })))
    .rejects.toMatchObject({ name: "LLMCapabilityError", capability: "request_features" });
  expect(() => provider.validateRequest(messages, { tools, toolChoice: "none" })).not.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
