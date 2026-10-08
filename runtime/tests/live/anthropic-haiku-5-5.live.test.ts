/** Owner-run paid probe. Enable with AGENC_LIVE_HAIKU55=1 and ANTHROPIC_API_KEY.
 * Run with vitest.live.config.ts. Eight single-attempt requests at most.
 */
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "../../src/llm/types.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const enabled = process.env.AGENC_LIVE_HAIKU55 === "1" && apiKey.length > 0;
const model = "claude-haiku-5-5";
const messages: LLMMessage[] = [{ role: "user", content: "Reply with OK." }];
const tools: LLMTool[] = [{ type: "function", function: { name: "echo", description: "Return OK", parameters: { type: "object", properties: {} } } }];
let sent = 0;
const provider = () => new AnthropicProvider({ model, apiKey, timeoutMs: 110_000, fetchImpl: async (input, init) => {
  if (++sent > 8) throw new Error("Haiku 5.5 live request budget exceeded");
  const body = JSON.parse(String(init?.body));
  expect(body).not.toHaveProperty("temperature");
  expect(body).not.toHaveProperty("speed");
  expect(body).not.toHaveProperty("service_tier");
  expect(body.thinking?.type).not.toBe("enabled");
  expect(body.messages.at(-1).role).toBe("user");
  return fetch(input, init);
} });
const options: LLMChatOptions = { maxOutputTokens: 2048, singleWireAttempt: true, temperature: 0.2, serviceTier: "priority" };

describe.skipIf(!enabled)("LIVE Claude Haiku 5.5", () => {
  it.each([undefined, "low", "medium", "high", "xhigh", "max", "none"] as const)("accepts effort %s", { timeout: 120_000 }, async reasoningEffort => {
    const response = await provider().chatStream(messages, () => {}, { ...options, reasoningEffort });
    expect(response.model).toContain(model);
    expect(response.usage.completionTokens).toBeGreaterThan(0);
    expect(response.finishReason).not.toBe("content_filter");
    if (reasoningEffort === "none") expect(response.thinking).toBeUndefined();
  });
  it("accepts forced tool use without a thinking block", { timeout: 120_000 }, async () => {
    const response = await provider().chatStream(messages, () => {}, { ...options, tools, toolChoice: "required", reasoningEffort: "medium" });
    expect(response.toolCalls?.[0]?.name).toBe("echo");
    expect(response.thinking).toBeUndefined();
  });
});
