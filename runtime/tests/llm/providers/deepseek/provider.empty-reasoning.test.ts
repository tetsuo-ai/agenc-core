import { describe, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import type { LLMMessage } from "../../../../src/llm/types.js";
import { buildChatCompletionsRequest } from "../../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../../src/llm/wire/capability-gating.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../../../src/session/message-history-conversion.js";
import { bodyAt, ECHO_TOOL, sseResponse } from "../openai-compatible-test-helpers.js";

const model = "deepseek-flash";
const origin = { provider: "deepseek", model };
const user: LLMMessage = { role: "user", content: "Inspect and finish." };
function response(stream: boolean, reasoning: unknown, finish = "tool_calls", servedModel = model) {
  const message = { content: "", tool_calls: [{ index: 0, id: "call_echo", type: "function",
    function: { name: "system.echo", arguments: '{"text":"ok"}' } }],
    ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) };
  return stream ? sseResponse([
    `data: ${JSON.stringify({ model: servedModel, choices: [{ index: 0, delta: message }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n",
  ]) : new Response(JSON.stringify({ model: servedModel, choices: [{ message, finish_reason: finish }] }),
    { headers: { "content-type": "application/json" } });
}

describe.each([false, true])("native DeepSeek known-empty tool reasoning stream=%s", stream => {
  test.each([undefined, null, ""])("restores thinking after a completed response with %s reasoning, including durable reload", async reasoning => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      // Reproduce the real API's rejection on the request after recovery.
      if (body.thinking.type === "enabled" && body.messages.some((m: Record<string, unknown>) =>
        m.role === "assistant" && typeof m.reasoning_content !== "string")) {
        return new Response(JSON.stringify({ error: { message: "reasoning_content must be passed back" } }), { status: 400 });
      }
      return response(stream, reasoning);
    });
    const provider = new DeepSeekProvider({ apiKey: "test", model, tools: [ECHO_TOOL], fetchImpl });
    const options = { reasoningEffort: "high" as const, maxOutputTokens: 8192, singleWireAttempt: true };
    const sample = (history: LLMMessage[], disabled = false) => {
      const opts = { ...options, ...(disabled ? { disableThinkingForRecovery: true as const } : {}) };
      return stream ? provider.chatStream(history, () => {}, opts) : provider.chat(history, opts);
    };
    const result = await sample([user], true);
    expect(result.providerReasoningContent).toBe("");
    expect(result.providerReasoningProvenance).toEqual(origin);
    expect(result.thinking).toBeUndefined();
    const assistant: LLMMessage = { role: "assistant", content: result.content, toolCalls: result.toolCalls,
      providerReasoningContent: result.providerReasoningContent, providerReasoningProvenance: result.providerReasoningProvenance };
    const restored = responseItemToLlmMessage(JSON.parse(JSON.stringify(llmMessageToDurableResponseItem(assistant))));
    await sample([user, restored, { role: "tool", toolCallId: result.toolCalls[0]!.id, content: "ok" }]);
    const body = bodyAt(fetchImpl, 1);
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 8192 });
    expect((body.messages as Record<string, unknown>[]).find(m => m.role === "assistant")).toHaveProperty("reasoning_content", "");
  });

  test("also preserves an enabled response with no reasoning, as observed before recovery", async () => {
    const provider = new DeepSeekProvider({ apiKey: "test", model, tools: [ECHO_TOOL],
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(stream, "")) });
    const result = stream ? await provider.chatStream([user], () => {}) : await provider.chat([user]);
    expect(result.providerReasoningContent).toBe("");
    expect(result.providerReasoningProvenance).toEqual(origin);
  });

  test.each([
    ["length", undefined, model],
    ["tool_calls", { invalid: true }, model],
    ["tool_calls", "", "deepseek-v4-pro"],
  ] as const)("does not manufacture empty reasoning from %s/%j/%s", async (finish, reasoning, servedModel) => {
    const provider = new DeepSeekProvider({ apiKey: "test", model, tools: [ECHO_TOOL],
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(stream, reasoning, finish, servedModel)) });
    const result = stream ? await provider.chatStream([user], () => {}) : await provider.chat([user]);
    expect(result.providerReasoningContent).toBeUndefined();
    expect(result.providerReasoningProvenance).toBeUndefined();
  });
});

test.each(["missing-content", "missing-origin", "foreign-provider", "foreign-model", "text-only"])(
  "does not invent or rebind %s empty reasoning during replay", kind => {
    const assistant: LLMMessage = { role: "assistant", content: "", toolCalls: [{ id: "one", name: "system.echo", arguments: "{}" }],
      providerReasoningContent: "", providerReasoningProvenance: origin };
    if (kind === "missing-content") delete assistant.providerReasoningContent;
    if (kind === "missing-origin") delete assistant.providerReasoningProvenance;
    if (kind === "foreign-provider") assistant.providerReasoningProvenance = { provider: "zai", model: "glm-5.3" };
    if (kind === "foreign-model") assistant.providerReasoningProvenance = { provider: "deepseek", model: "deepseek-v4-pro" };
    if (kind === "text-only") delete assistant.toolCalls;
    const body = buildChatCompletionsRequest({ model, messages: [user, assistant,
      ...(assistant.toolCalls ? [{ role: "tool" as const, toolCallId: "one", content: "ok" }] : [])], tools: [ECHO_TOOL],
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("deepseek", model) });
    expect((body.messages as Record<string, unknown>[]).find(m => m.role === "assistant")?.reasoning_content).toBeUndefined();
  },
);
