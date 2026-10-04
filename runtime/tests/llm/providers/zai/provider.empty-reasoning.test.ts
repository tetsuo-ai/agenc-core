import { describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMResponse } from "../../../../src/llm/types.js";
import { ZaiCodingPlanProvider, ZaiProvider } from "../../../../src/llm/providers/zai/index.js";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import {
  llmMessageToDurableResponseItem, responseItemToLlmMessage,
} from "../../../../src/session/message-history-conversion.js";
import { normalizeHistoryMessages } from "../../../../src/session/session.js";
import { parseRolloutLine, serializeRolloutItem } from "../../../../src/session/rollout-item.js";
import { bodyAt, ECHO_TOOL, sseResponse } from "../openai-compatible-test-helpers.js";

const model = "glm-5.3-flash";
const user: LLMMessage = { role: "user", content: "Inspect both results." };
const calls = (round = 0) => ["a", "b"].map(id => ({
  id: `${id}-${round}`, type: "function",
  function: { name: "system.echo", arguments: JSON.stringify({ text: id }) },
}));

function response(route: string, reasoning: unknown, round = 0, finish = "tool_calls", overrides: Record<string, unknown> = {}, servedModel: unknown = model) {
  const message = { content: "", tool_calls: calls(round),
    ...(reasoning === undefined ? {} : { reasoning_content: reasoning }), ...overrides };
  return route === "stream"
    ? sseResponse([
      `data: ${JSON.stringify({ model: servedModel, choices: [{ index: 0, delta: message }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
      "data: [DONE]\n\n",
    ])
    : new Response(JSON.stringify({ model: servedModel, choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }] }),
      { headers: { "content-type": "application/json" } });
}

function assistant(result: LLMResponse): LLMMessage {
  return { role: "assistant", content: result.content, toolCalls: result.toolCalls,
    ...(result.providerReasoningContent !== undefined ? {
      providerReasoningContent: result.providerReasoningContent,
      providerReasoningProvenance: result.providerReasoningProvenance,
    } : {}) };
}

function reload(message: LLMMessage): LLMMessage {
  const durable = llmMessageToDurableResponseItem(message);
  const parsed = parseRolloutLine(serializeRolloutItem({ type: "response_item", payload: durable }));
  if (parsed?.type !== "response_item") throw new Error("missing persisted assistant");
  const restored = responseItemToLlmMessage(parsed.payload);
  expect(restored.providerReasoningContent).toBe(message.providerReasoningContent);
  expect(restored.providerReasoningProvenance).toEqual(message.providerReasoningProvenance);
  const normalized = normalizeHistoryMessages([parsed.payload])[0]!;
  expect(normalized.providerReasoningContent).toBe(message.providerReasoningContent);
  expect(normalized.providerReasoningProvenance).toEqual(message.providerReasoningProvenance);
  return normalized;
}

describe.each([["zai", ZaiProvider], ["zai-coding-plan", ZaiCodingPlanProvider]] as const)(
  "%s completed empty reasoning", (providerId, Provider) => {
    describe.each(["json", "stream"])("%s", route => {
      const sample = (provider: ZaiProvider | ZaiCodingPlanProvider, messages: LLMMessage[]) =>
        route === "stream" ? provider.chatStream(messages, () => {}) : provider.chat(messages);

      test.each([
        ["empty first", ["", "later reasoning\nexact bytes  "]],
        ["empty middle", ["first reason", "", "last reason"]],
        ["empty last", ["first reason", ""]],
        ["all empty", ["", ""]],
      ])("replays %s through durable reload and reversed parallel batches", async (_name, reasons) => {
        const sequence = reasons as string[];
        const fetchImpl = vi.fn<typeof fetch>();
        sequence.forEach((reason, i) => fetchImpl.mockResolvedValueOnce(response(route, reason, i)));
        fetchImpl.mockResolvedValueOnce(response(route, undefined, sequence.length));
        const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
        const history: LLMMessage[] = [user];
        for (const reason of sequence) {
          const result = await sample(provider, history);
          expect(result.providerReasoningContent).toBe(reason);
          expect(result.providerReasoningProvenance).toEqual({ provider: providerId, model });
          if (reason === "") expect(result.thinking).toBeUndefined();
          history.push(reload(assistant(result)), ...[...result.toolCalls].reverse().map(call => ({
            role: "tool" as const, toolCallId: call.id, content: "observed", toolName: call.name,
          })));
        }
        const result = await sample(provider, history);
        // A completed provider tool response may omit the optional reasoning field.
        expect(result.providerReasoningContent).toBe("");
        const body = bodyAt(fetchImpl, sequence.length);
        expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
        const messages = body.messages as Array<Record<string, unknown>>;
        expect(messages.filter(m => m.role === "assistant").map(m => m.reasoning_content)).toEqual(sequence);
        expect(messages.filter(m => m.role === "tool").map(m => m.tool_call_id))
          .toEqual(history.filter(m => m.role === "tool").map(m => m.toolCallId));
      });

      test.each(["missing-content", "missing-origin", "wrong-model", "wrong-provider", "missing-result", "duplicate-result", "orphan", "user-boundary", "compaction"])(
        "does not preserve an invalid %s chain", async kind => {
          const fetchImpl = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response(route, ""))
            .mockResolvedValueOnce(response(route, undefined, 1));
          const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
          const result = await sample(provider, [user]);
          const first = assistant(result);
          const history: LLMMessage[] = [user, first, ...result.toolCalls.map(call => ({
            role: "tool" as const, toolCallId: call.id, content: "observed", toolName: call.name,
          }))];
          if (kind === "missing-content") delete first.providerReasoningContent;
          if (kind === "missing-origin") delete first.providerReasoningProvenance;
          if (kind === "wrong-model") first.providerReasoningProvenance = { provider: providerId, model: "glm-5.3" };
          if (kind === "wrong-provider") first.providerReasoningProvenance = { provider: "qwen", model };
          if (kind === "missing-result") history.pop();
          if (kind === "duplicate-result") history[3] = { ...history[2]! };
          if (kind === "orphan") history.push({ role: "tool", toolCallId: "orphan", content: "unmatched" });
          if (kind === "user-boundary") history.push({ role: "user", content: "New request." });
          if (kind === "compaction") history.splice(2, 0, { role: "system", content: "[boundary] compacted history" });
          await sample(provider, history);
          const body = bodyAt(fetchImpl, 1);
          expect(body.thinking).toEqual({ type: "enabled", clear_thinking: true });
          expect((body.messages as Array<Record<string, unknown>>).filter(m => m.role === "assistant")
            .every(m => m.reasoning_content === undefined)).toBe(true);
        },
      );

      test.each(["length", "network_error", "sensitive"])("never upgrades a %s response", async finish => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, "", 0, finish));
        const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
        const result = await sample(provider, [user]);
        expect(result.providerReasoningContent).toBeUndefined();
        expect(result.providerReasoningProvenance).toBeUndefined();
        expect(result.toolCalls).toEqual([]);
      });

      test("does not upgrade malformed reasoning discarded by the parser", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, { truncated: "bad value" }));
        const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
        const result = await sample(provider, [user]);
        expect(result.toolCalls).toHaveLength(2);
        expect(result.providerReasoningContent).toBeUndefined();
      });

      test("does not mark a completed text-only reply as known-empty", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, "", 0, "stop", { tool_calls: [] }));
        const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
        expect((await sample(provider, [user])).providerReasoningContent).toBeUndefined();
      });

      test("does not bind empty reasoning from a different served model", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, "", 0, "tool_calls", {}, "glm-5.3"));
        const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
        const result = await sample(provider, [user]);
        expect(result.toolCalls).toHaveLength(2);
        expect(result.providerReasoningContent).toBeUndefined();
        expect(result.providerReasoningProvenance).toBeUndefined();
      });

      test.each([null, 123, ""])("does not bind empty reasoning from malformed model metadata %s", async servedModel => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, "", 0, "tool_calls", {}, servedModel));
        const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
        expect((await sample(provider, [user])).providerReasoningContent).toBeUndefined();
      });

      if (route === "json") {
        test("rejects invalid native JSON without establishing replay state", async () => {
          const badCalls = [{ ...calls()[0]!, function: { name: "system.echo", arguments: "not-json" } }];
          const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, "", 0, "tool_calls", { tool_calls: badCalls }));
          const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
          await expect(provider.chat([user], { singleWireAttempt: true })).rejects.toThrow();
        });
      }
    });

    test("does not upgrade invalid native argument recovery", async () => {
      const badCalls = [{ ...calls()[0]!, function: { name: "system.echo", arguments: "not-json" } }];
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("stream", "", 0, "tool_calls", { tool_calls: badCalls }));
      const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
      const result = await provider.chatStream([user], () => {});
      expect(result.toolCallRecovery).toMatchObject({ reason: "invalid_arguments" });
      expect(result.toolCalls).toEqual([]);
      expect(result.providerReasoningContent).toBeUndefined();
    });

    test("rejects a stream cut after a tool fragment without establishing replay state", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
        `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: calls() } }] })}\n\n`,
      ]));
      const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
      await expect(provider.chatStream([user], () => {}, { singleWireAttempt: true })).rejects.toThrow(/finish_reason/);
    });

    test("does not let a later matching model erase an earlier stream identity conflict", async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
        `data: ${JSON.stringify({ model: "glm-5.3", choices: [{ index: 0, delta: {} }] })}\n\n`,
        `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: calls() } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]));
      const provider = new Provider({ apiKey: "zai-test", model, tools: [ECHO_TOOL], fetchImpl });
      const result = await provider.chatStream([user], () => {});
      expect(result.toolCalls).toHaveLength(2);
      expect(result.providerReasoningContent).toBeUndefined();
    });
  },
);

test.each(["json", "stream"])("keeps non-GLM %s behavior unchanged", async route => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(route, ""));
  const provider = new OpenAIProvider({ apiKey: "test", model: "other-model", providerName: "openai-compatible",
    useResponsesApi: false, baseURL: "https://example.invalid/v1", tools: [ECHO_TOOL], fetchImpl });
  const result = route === "stream" ? await provider.chatStream([user], () => {}) : await provider.chat([user]);
  expect(result.providerReasoningContent).toBeUndefined();
  expect(result.providerReasoningProvenance).toBeUndefined();
});
