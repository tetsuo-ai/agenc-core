import { describe, expect, test, vi } from "vitest";

import type { LLMMessage } from "../../types.js";
import {
  bodyAt,
  createSuccessfulChatResponse,
  ECHO_TOOL,
} from "../openai-compatible-test-helpers.js";
import { ZaiCodingPlanProvider, ZaiProvider } from "./index.js";

const model = "glm-5.3-flash";
const successfulChat = createSuccessfulChatResponse("chatcmpl_parallel_glm");

function parallelRound(provider: string, suffix: string): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: "Checking both results.",
      toolCalls: ["a", "b"].map((id) => ({
        id: `${id}_${suffix}`,
        name: "system.echo",
        arguments: JSON.stringify({ text: id }),
      })),
      providerReasoningContent: `Unmodified reasoning ${suffix}\nwith spacing.  `,
      providerReasoningProvenance: { provider, model },
    },
    // Concurrent calls can complete in a different order from their emission.
    ...["b", "a"].map((id): LLMMessage => ({
      role: "tool",
      toolCallId: `${id}_${suffix}`,
      toolName: "system.echo",
      content: id,
    })),
  ];
}

describe.each([
  ["zai", ZaiProvider],
  ["zai-coding-plan", ZaiCodingPlanProvider],
] as const)("%s parallel tool reasoning", (providerId, Provider) => {
  function fixture() {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(successfulChat(model));
    const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
    return { fetchImpl, provider };
  }

  test.each([1, 2])("preserves the intact reasoning chain across %i reversed result batches", async (rounds) => {
    const { fetchImpl, provider } = fixture();
    const messages: LLMMessage[] = [
      { role: "user", content: "Inspect both results before answering." },
      ...Array.from({ length: rounds }, (_, index) => parallelRound(providerId, String(index))).flat(),
    ];
    const original = structuredClone(messages);

    await provider.chat(messages);

    const body = bodyAt(fetchImpl);
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    const wire = body.messages as Array<Record<string, unknown>>;
    expect(wire.filter((message) => message.role === "assistant").map((message) => message.reasoning_content))
      .toEqual(messages.filter((message) => message.role === "assistant").map((message) => message.providerReasoningContent));
    expect(wire.filter((message) => message.role === "tool").map((message) => message.tool_call_id))
      .toEqual(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
    expect(messages).toEqual(original);
  });

  test.each([
    "missing",
    "duplicate",
    "unrelated",
    "extra",
    "interrupted",
    "boundary",
    "wrong-model",
    "wrong-provider",
    "missing-reasoning",
  ])("still clears an invalid %s continuation", async (kind) => {
    const { fetchImpl, provider } = fixture();
    const messages: LLMMessage[] = [
      { role: "user", content: "Inspect both results before answering." },
      ...parallelRound(providerId, "0"),
    ];
    if (kind === "missing") messages.pop();
    if (kind === "duplicate") messages[3] = { ...messages[2]! };
    if (kind === "unrelated") messages[3] = { ...messages[3]!, toolCallId: "unknown" };
    if (kind === "extra") messages.push({ ...messages[2]! });
    if (kind === "interrupted") messages.splice(3, 0, { role: "user", content: "A new request." });
    if (kind === "boundary") messages.splice(3, 0, { role: "system", content: "[boundary] compacted history" });
    if (kind === "wrong-model") messages[1] = {
      ...messages[1]!, providerReasoningProvenance: { provider: providerId, model: "glm-5.3" },
    };
    if (kind === "wrong-provider") messages[1] = {
      ...messages[1]!, providerReasoningProvenance: { provider: "unrelated-provider", model },
    };
    if (kind === "missing-reasoning") messages[1] = { ...messages[1]!, providerReasoningContent: undefined };

    await provider.chat(messages);

    const body = bodyAt(fetchImpl);
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect((body.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "assistant")
      .every((message) => message.reasoning_content === undefined)).toBe(true);
  });
});
