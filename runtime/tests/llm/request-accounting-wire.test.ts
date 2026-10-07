import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import fixture from "./fixtures/request-accounting-wire.v1.json" with { type: "json" };
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import {
  createTokenAccountingRequest,
  estimateTokenAccountingRequest,
  TokenAccountingService,
  type TokenAccountingRequest,
} from "../../src/llm/token-accounting.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "../../src/llm/types.js";

interface RecordedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

function restoreMessage(message: RecordedMessage): LLMMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id !== undefined ? { toolCallId: message.tool_call_id } : {}),
    ...(message.tool_calls !== undefined ? {
      toolCalls: message.tool_calls.map(call => ({
        id: call.id, name: call.function.name, arguments: call.function.arguments,
      })),
    } : {}),
    ...(message.reasoning_content !== undefined ? {
      providerReasoningContent: message.reasoning_content,
      providerReasoningProvenance: { provider: "deepseek", model: "deepseek-flash" },
    } : {}),
  };
}

// Preserve main's recorded HTTP bytes, including schema key order, empty
// reasoning replay and tool results, across accounting preparation/reuse.
// The fixture hashes come from real headless requests, not this serializer.
test("keeps all thirteen recorded main request bodies byte-identical after accounting", async () => {
  const initial = JSON.parse(fixture.initial_request) as {
    model: string; tools: LLMTool[]; messages: RecordedMessage[]; max_tokens: number;
  };
  const messages = initial.messages.map(restoreMessage);
  const bodies: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(typeof init?.body).toBe("string");
    bodies.push(init!.body as string);
    return new Response(
      `data: ${JSON.stringify({ id: "fixture", model: initial.model,
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const provider = new DeepSeekProvider({
    apiKey: "fixture-key", model: initial.model, tools: initial.tools, fetchImpl,
  });
  const options: LLMChatOptions = {
    tools: initial.tools, maxOutputTokens: initial.max_tokens, reasoningEffort: "high",
  };
  const service = new TokenAccountingService();
  let snapshot: TokenAccountingRequest | undefined;
  const capability = {
    capabilityVersion: "fixture-v1", adapterRevision: "fixture-v1", configurationRevision: "fixture-v1",
    async countTokens(request: TokenAccountingRequest) {
      snapshot = request;
      return { inputTokens: 10, complete: true, confidence: "exact" as const,
        countedComponents: ["system", "messages", "tools", "tool_choice", "structured_output", "provider_framing", "images", "documents"] as const };
    },
  };
  try {
    for (let index = 0; index < fixture.request_sha256.length; index++) {
      const before = JSON.stringify({ messages, options });
      const request = createTokenAccountingRequest({
        provider: "deepseek", model: initial.model, messages, options,
        contextWindowTokens: 131072, reservedOutputTokens: initial.max_tokens,
      });
      const estimate = estimateTokenAccountingRequest(request);
      expect((await service.count(request, { capability })).cacheStatus).toBe("miss");
      expect(snapshot).toBeDefined();
      // Exercise already-owned immutable nodes through both estimate and digest.
      expect(estimateTokenAccountingRequest(snapshot!)).toEqual(estimate);
      expect((await service.count(snapshot!, { capability })).cacheStatus).toBe("hit");
      expect(JSON.stringify({ messages, options })).toBe(before);
      await provider.chatStream(messages, () => {}, options);
      expect(bodies).toHaveLength(index + 1);
      expect(createHash("sha256").update(bodies[index]!).digest("hex"))
        .toBe(fixture.request_sha256[index]);
      if (index === 0) expect(bodies[0]).toBe(fixture.initial_request);
      const continuation = fixture.continuations[index];
      if (continuation) messages.push(...(continuation as RecordedMessage[]).map(restoreMessage));
    }
    expect(fetchImpl).toHaveBeenCalledTimes(13);
  } finally {
    await provider.dispose?.();
  }
});
