import { expect, test, vi } from "vitest";
import type { LLMChatOptions } from "../../../../src/llm/types.js";
import { GeminiProvider } from "../../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../../src/llm/providers/gemini/endpoint-plan.js";

test("disabled Gemini schemas are absent from both local validation and the wire request", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidates: [{
    content: { role: "model", parts: [{ text: "plain answer" }] }, finishReason: "STOP",
  }] }));
  const provider = new GeminiProvider({ model: "gemini-2.5-pro", fetchImpl,
    credentialPlan: { kind: "api-key", credential: "test-only", source: "factory" },
    endpointPlan: createGeminiEndpointPlan() });
  const messages = [{ role: "user" as const, content: "Answer in plain text." }];
  const options: LLMChatOptions = { structuredOutput: { enabled: false, schema: {
    type: "json_schema", name: "inactive", schema: { type: "object", not: { type: "string" } },
  } } };
  await provider.validateRequest!(messages, options);
  await provider.chat(messages, options);
  expect(fetchImpl).toHaveBeenCalledOnce();
  const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
  expect(body.generationConfig).not.toHaveProperty("responseMimeType");
  expect(body.generationConfig).not.toHaveProperty("responseJsonSchema");
});
