import { describe, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import { deepSeekReasoningOnlyReplayProvenance } from "../../../../src/llm/deepseek-reasoning-only-replay.js";
import { runWithStartupProviderSelection } from "../../../../src/utils/model/providers.js";
import { createTokenAccountingRequest, estimateTokenAccountingRequest, TokenAccountingService } from "../../../../src/llm/token-accounting.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../../../src/session/message-history-conversion.js";
import { assistantMessageFromResponse } from "../../../../src/phases/stream-model.js";
import { runMaxOutputTokensRecovery } from "../../../../src/recovery/max-output-tokens.js";
import { EventLog } from "../../../../src/session/event-log.js";
import type { Session } from "../../../../src/session/session.js";
import type { TurnState } from "../../../../src/session/turn-state.js";
import type { LLMMessage } from "../../../../src/llm/types.js";
import { bodyAt, createSuccessfulChatResponse, ECHO_TOOL, sseResponse } from "../openai-compatible-test-helpers.js";

const model = "deepseek-flash";
const provenance = { provider: "deepseek", model };
const thought = "Use the measured boundary and then validate the result.";
const cap: LLMMessage = { role: "assistant", content: "", providerReasoningContent: thought, providerReasoningProvenance: provenance };
const user: LLMMessage = { role: "user", content: "Finish the task." };
const recovery: LLMMessage = { role: "user", content: "Choose the next step." };
const opts = { maxOutputTokens: 8192, reasoningEffort: "high" as const, tools: [ECHO_TOOL] };
function scoped<T>(value: string | undefined, fn: () => T): T {
  return runWithStartupProviderSelection({ provider: "deepseek", model,
    environment: value === undefined ? {} : { AGENC_DEEPSEEK_REASONING_ONLY_REPLAY: value } }, fn);
}

describe("native DeepSeek reasoning-only replay experiment", () => {
  test.each([undefined, "0", "false", "1"])("retains capped reasoning only when enabled: %s", async flag => {
    await scoped(flag, async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(createSuccessfulChatResponse("ok")(model));
      const provider = new DeepSeekProvider({ apiKey: "test", model, fetchImpl });
      const restored = responseItemToLlmMessage(JSON.parse(JSON.stringify(llmMessageToDurableResponseItem(cap))));
      await provider.chat([user, restored, recovery], opts);
      const req = bodyAt(fetchImpl);
      expect(req).toMatchObject({ max_tokens: 8192, reasoning_effort: "high", thinking: { type: "enabled" } });
      const assistants = (req.messages as Record<string, unknown>[]).filter(m => m.role === "assistant");
      expect(assistants).toEqual(flag === "1" ? [{ role: "assistant", content: "", reasoning_content: thought }] : []);
      expect(req).not.toHaveProperty("preservesReasoningOnlyMessages");
    });
  });

  test("the real capped stream survives continuation recovery, reload, and the next enabled tool turn", async () => {
    await scoped("1", async () => {
      const frame = (delta: object, finish_reason: string | null = null, usage?: object) =>
        `data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(sseResponse([frame({ reasoning_content: thought }), frame({}, "length",
          { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202, completion_tokens_details: { reasoning_tokens: 8192 } }), "data: [DONE]\n\n"]))
        .mockResolvedValueOnce(createSuccessfulChatResponse("action")(model, "", { tool_calls: [{ id: "call_echo", type: "function",
          function: { name: "system.echo", arguments: '{"text":"ok"}' } }] }, "tool_calls"))
        .mockResolvedValueOnce(createSuccessfulChatResponse("done")(model));
      const provider = new DeepSeekProvider({ apiKey: "test", model, fetchImpl });
      const response = await provider.chatStream([user], () => {}, opts);
      expect(response.finishReason).toBe("length");
      expect(response.toolCalls).toEqual([]);
      const returned: LLMMessage = { role: "assistant", content: response.content,
        providerReasoningContent: response.providerReasoningContent, providerReasoningProvenance: response.providerReasoningProvenance };
      const state = { messages: [user, returned], assistantMessages: [assistantMessageFromResponse(response, false, "deepseek")],
        lastResponseUsage: response.usage, maxOutputTokensOverride: 8192, maxOutputTokensRecoveryCount: 0,
        streamingToolExecutor: null, toolUseBlocks: [], toolResults: [], completedToolResults: [] } as unknown as TurnState;
      const session = { eventLog: new EventLog(), nextInternalSubId: () => "recovery", services: { provider: { name: "deepseek" } },
        config: { model }, emit: () => {} } as unknown as Session;
      expect(runMaxOutputTokensRecovery({ state, session })).toEqual({ kind: "continuation" });
      const history = state.messages.map(m => responseItemToLlmMessage(JSON.parse(JSON.stringify(llmMessageToDurableResponseItem(m)))));
      const action = await provider.chat(history, { ...opts, disableThinkingForRecovery: true });
      expect(JSON.stringify(bodyAt(fetchImpl, 1))).not.toContain(thought);
      expect(action.providerReasoningContent).toBe("");
      await provider.chat([...history, { role: "assistant", content: action.content, toolCalls: action.toolCalls,
        providerReasoningContent: action.providerReasoningContent, providerReasoningProvenance: action.providerReasoningProvenance },
        { role: "tool", toolCallId: action.toolCalls[0]!.id, content: "ok" }], opts);
      expect(bodyAt(fetchImpl, 2)).toMatchObject({ thinking: { type: "enabled" }, max_tokens: 8192 });
      expect(JSON.stringify(bodyAt(fetchImpl, 2))).toContain(thought);
    });
  });

  test.each([undefined, { provider: "openai", model }, { provider: "deepseek", model: "deepseek-v4-pro" }])("rejects missing or foreign provenance %j", async origin => {
    await scoped("1", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(createSuccessfulChatResponse("ok")(model));
      await new DeepSeekProvider({ apiKey: "test", model, fetchImpl }).chat([user, { ...cap, providerReasoningProvenance: origin }, recovery], opts);
      expect(JSON.stringify(bodyAt(fetchImpl))).not.toContain(thought);
    });
  });

  test("keeps no-tools and other-provider requests unchanged and fails closed outside authority", async () => {
    expect(deepSeekReasoningOnlyReplayProvenance("deepseek", model)).toBeUndefined();
    await scoped("1", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => createSuccessfulChatResponse("ok")(model));
      await new DeepSeekProvider({ apiKey: "test", model, fetchImpl }).chat([user, cap, recovery], { ...opts, tools: [] });
      await new OpenAIProvider({ apiKey: "test", model, providerName: "openrouter", useResponsesApi: false, fetchImpl }).chat([user, cap, recovery], opts);
      expect(JSON.stringify(bodyAt(fetchImpl, 0))).not.toContain(thought);
      expect(JSON.stringify(bodyAt(fetchImpl, 1))).not.toContain(thought);
    });
  });

  test("accounts retained reasoning and changes the admission cache identity", async () => {
    const messages = [user, { ...cap, providerReasoningContent: thought.repeat(500) }, recovery];
    const request = createTokenAccountingRequest({ provider: "deepseek", model, messages, options: opts });
    const off = scoped("0", () => estimateTokenAccountingRequest(request));
    const on = scoped("1", () => estimateTokenAccountingRequest(request));
    expect(on.inputTokens).toBeGreaterThan(off.inputTokens + 1000);
    const service = new TokenAccountingService();
    const countTokens = vi.fn(async () => ({ inputTokens: 123, complete: true, confidence: "exact" as const,
      countedComponents: off.coverage.countedComponents }));
    const capability = { capabilityVersion: "test", adapterRevision: "test", configurationRevision: "test", countTokens };
    await scoped("0", () => service.count(request, { capability }));
    const countedOn = await scoped("1", () => service.count(request, { capability }));
    expect(countedOn.cacheStatus).toBe("miss");
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect((await scoped("0", () => service.count(request, { capability }))).cacheStatus).toBe("hit");
    const withoutTools = { ...request, options: { ...opts, tools: [] } };
    expect(scoped("1", () => estimateTokenAccountingRequest(withoutTools))).toEqual(scoped("0", () => estimateTokenAccountingRequest(withoutTools)));
    const disabled = { ...request, options: { ...opts, disableThinkingForRecovery: true as const } };
    expect(scoped("1", () => estimateTokenAccountingRequest(disabled))).toEqual(scoped("0", () => estimateTokenAccountingRequest(disabled)));
  });
});
