import { describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import type { LLMProviderTraceEvent, LLMStreamChunk } from "../../../../src/llm/types.js";

async function* nativeStream(response: unknown): AsyncGenerator<unknown> {
  yield { message: { role: "assistant", content: "I will update the tests:" } };
  yield response;
}

describe("Ollama native finish reasons", () => {
  test.each([
    { streaming: false, toolArguments: undefined },
    { streaming: false, toolArguments: { path: "tests.ts" } },
    { streaming: false, toolArguments: '{"path":"tests.ts' },
    { streaming: true, toolArguments: undefined },
    { streaming: true, toolArguments: { path: "tests.ts" } },
    { streaming: true, toolArguments: '{"path":"tests.ts' },
  ])("preserves explicit length and withholds tools ($streaming streaming, $toolArguments arguments)", async ({ streaming, toolArguments }) => {
    const nativeResponse = {
      model: "qwen3-coder:30b",
      message: {
        role: "assistant",
        content: streaming ? "" : "I will update the tests:",
        ...(toolArguments !== undefined ? {
          tool_calls: [{ function: { name: "edit_file", arguments: toolArguments } }],
        } : {}),
      },
      done: true,
      done_reason: "length",
      prompt_eval_count: 128,
      eval_count: 4_096,
    };
    const provider = new OllamaProvider({ model: "qwen3-coder:30b" });
    const chat = vi.fn(async () => streaming ? nativeStream(nativeResponse) : nativeResponse);
    Object.assign(provider, { client: { chat, list: async () => ({ models: [] }) } });
    const chunks: LLMStreamChunk[] = [];
    const traces: LLMProviderTraceEvent[] = [];
    const options = {
      maxOutputTokens: 4_096,
      trace: { onProviderTraceEvent: (event: LLMProviderTraceEvent) => traces.push(event) },
    };
    const messages = [{ role: "user" as const, content: "update the tests" }];

    const response = streaming
      ? await provider.chatStream(messages, (chunk) => chunks.push(chunk), options)
      : await provider.chat(messages, options);

    expect(response.finishReason).toBe("length");
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.completionTokens).toBe(4_096);
    expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual([]);
    expect(traces.find((event) => event.kind === "response")?.payload)
      .toMatchObject({ done_reason: "length" });
  });

  test.each([false, true])("does not infer truncation solely from usage at the cap (streaming=%s)", async (streaming) => {
    const response = {
      model: "qwen3-coder:30b",
      message: { role: "assistant", content: "finished" },
      done: true,
      done_reason: "stop",
      eval_count: 4_096,
    };
    const provider = new OllamaProvider({ model: "qwen3-coder:30b" });
    Object.assign(provider, {
      client: {
        chat: async () => streaming ? nativeStream(response) : response,
        list: async () => ({ models: [] }),
      },
    });
    const messages = [{ role: "user" as const, content: "finish" }];
    const result = streaming
      ? await provider.chatStream(messages, () => {}, { maxOutputTokens: 4_096 })
      : await provider.chat(messages, { maxOutputTokens: 4_096 });

    expect(result.finishReason).toBe("stop");
  });
});
