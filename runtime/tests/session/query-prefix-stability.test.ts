import { describe, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { buildAnthropicMessagesRequest } from "../../src/llm/wire/messages-anthropic.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { prepareAgenCQueryMessages, preservesQueryPrefix } from "../../src/session/run-turn-query-messages.js";
import { provisionContentReplacementState } from "../../src/session/_deps/tool-result-storage.js";

function exchange(index: number): LLMMessage[] {
  return [
    { role: "assistant", content: "Read the next log.", toolCalls: [{ id: `call-${index}`, name: "exec_command", arguments: "{}" }] },
    { role: "tool", toolCallId: `call-${index}`, toolName: "exec_command", content: `Log ${index}\n${"evidence ".repeat(2300)}` },
  ];
}

const tool = { type: "function" as const, function: { name: "exec_command", description: "Read a log", parameters: { type: "object", properties: {} } } };

// Anthropic cache markers move to the new last block by contract; they do
// not change the tokenized message. Every other field remains byte-identical.
function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCacheMarkers(item)]),
  );
  return value;
}

async function wireMessages(provider: string, messages: LLMMessage[]): Promise<unknown[]> {
  const options = { systemPrompt: "Stable instructions", tools: [tool] };
  if (provider === "anthropic") {
    return withoutCacheMarkers(buildAnthropicMessagesRequest({ model: "claude-sonnet-4-6", messages, tools: [tool], options }).messages) as unknown[];
  }
  if (provider === "gemini") {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }));
    await new GeminiProvider({ credentialPlan: { kind: "api-key", credential: "test", source: "factory" },
      endpointPlan: createGeminiEndpointPlan(), model: "gemini-2.5-pro", fetchImpl }).chat(messages, options);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    return body.contents;
  }
  return buildChatCompletionsRequest({ model: "deepseek-flash", messages, tools: [tool], options,
    providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, "deepseek-flash"),
  }).messages as unknown[];
}

describe("query projection preserves the sent prefix", () => {
  test.each(["deepseek", "openai-compatible", "anthropic", "gemini"])("%s: text pressure does not replace old tool evidence", async provider => {
    const contentReplacementState = provisionContentReplacementState();
    const source: LLMMessage[] = [{ role: "user", content: "Inspect every log." }];
    let previous: unknown[] = [];
    for (let index = 0; index < 12; index++) {
      source.push(...exchange(index));
      const projected = await prepareAgenCQueryMessages({ messages: source, contentReplacementState,
        querySource: "test", preservePrefix: preservesQueryPrefix(provider), toolUseContext: { options: { contextWindowTokens: 1_048_576 } } });
      const wire = await wireMessages(provider, projected.messages);
      expect(JSON.stringify(wire.slice(0, previous.length))).toBe(JSON.stringify(previous));
      expect(projected.messages).toEqual(source);
      previous = wire;
    }
  });

  test("context pressure is left to admitted compaction, without re-truncating sent results", async () => {
    const contentReplacementState = provisionContentReplacementState();
    const source: LLMMessage[] = [{ role: "user", content: "Continue the audit." }];
    let previous: LLMMessage[] = [];
    for (let index = 0; index < 6; index++) {
      source.push(...exchange(index));
      const next = await prepareAgenCQueryMessages({ messages: source, contentReplacementState,
        querySource: "test", preservePrefix: true, toolUseContext: { options: { contextWindowTokens: 12_000 } } });
      expect(JSON.stringify(next.messages.slice(0, previous.length))).toBe(JSON.stringify(previous));
      previous = next.messages;
    }
  });
});
