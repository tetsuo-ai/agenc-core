import { describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProviderTraceEvent,
  LLMStreamChunk,
  LLMTool,
} from "../../../../src/llm/types.js";

const editFileTool: LLMTool = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Edit a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
};

const messages: LLMMessage[] = [{ role: "user", content: "update the tests" }];

async function* nativeStream(response: unknown): AsyncGenerator<unknown> {
  yield { message: { role: "assistant", content: "I will update the tests:" } };
  yield response;
}

function attachClient(
  provider: OllamaProvider,
  reply: unknown,
  streaming: boolean,
): void {
  Object.assign(provider, {
    client: {
      chat: vi.fn(async () => streaming ? nativeStream(reply) : reply),
      list: async () => ({ models: [] }),
    },
  });
}

async function completeChat(
  reply: unknown,
  streaming: boolean,
  options: LLMChatOptions = {},
  provider = new OllamaProvider({ model: "qwen3-coder:30b", tools: [editFileTool] }),
): Promise<{
  readonly response: Awaited<ReturnType<OllamaProvider["chat"]>>;
  readonly chunks: LLMStreamChunk[];
  readonly traces: LLMProviderTraceEvent[];
}> {
  attachClient(provider, reply, streaming);
  const chunks: LLMStreamChunk[] = [];
  const traces: LLMProviderTraceEvent[] = [];
  const traced: LLMChatOptions = {
    ...options,
    maxOutputTokens: options.maxOutputTokens ?? 4_096,
    tools: options.tools ?? [editFileTool],
    trace: {
      onProviderTraceEvent: (event: LLMProviderTraceEvent) => traces.push(event),
    },
  };
  const response = streaming
    ? await provider.chatStream(messages, (chunk) => chunks.push(chunk), traced)
    : await provider.chat(messages, traced);
  return { response, chunks, traces };
}

function responseTrace(traces: readonly LLMProviderTraceEvent[]): LLMProviderTraceEvent | undefined {
  return traces.find((event) => event.kind === "response");
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

    const { response, chunks, traces } = await completeChat(nativeResponse, streaming);

    expect(response.finishReason).toBe("length");
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.completionTokens).toBe(4_096);
    expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual([]);
    expect(responseTrace(traces)?.payload).toMatchObject({
      done_reason: "length",
      done_reason_kind: "mapped",
    });
  });

  test.each([false, true])("does not infer truncation solely from usage at the cap (streaming=%s)", async (streaming) => {
    const result = await completeChat({
      model: "qwen3-coder:30b",
      message: { role: "assistant", content: "finished" },
      done: true,
      done_reason: "stop",
      eval_count: 4_096,
    }, streaming);

    expect(result.response.finishReason).toBe("stop");
    expect(responseTrace(result.traces)?.payload).toMatchObject({
      done_reason: "stop",
      done_reason_kind: "mapped",
    });
  });

  test.each([false, true])("maps stop plus complete tools to tool_calls (streaming=%s)", async (streaming) => {
    const { response, chunks } = await completeChat({
      model: "qwen3-coder:30b",
      message: {
        role: "assistant",
        content: streaming ? "" : "",
        tool_calls: [{ function: { name: "edit_file", arguments: { path: "tests.ts" } } }],
      },
      done: true,
      done_reason: "stop",
    }, streaming);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toMatchObject([{ name: "edit_file" }]);
    if (streaming) {
      expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toMatchObject([{ name: "edit_file" }]);
    }
  });

  test.each([false, true])("documents a missing done_reason fallback without inventing truncation (streaming=%s)", async (streaming) => {
    const { response, traces } = await completeChat({
      model: "qwen3-coder:30b",
      message: { role: "assistant", content: "finished" },
      done: true,
      eval_count: 12,
    }, streaming);

    expect(response.finishReason).toBe("stop");
    expect(response.toolCalls).toEqual([]);
    expect(responseTrace(traces)?.payload).toMatchObject({
      done_reason: null,
      done_reason_kind: "missing",
      done_reason_fallback: "stop",
    });
  });

  test.each([false, true])("keeps complete tools when done_reason is missing (streaming=%s)", async (streaming) => {
    const { response } = await completeChat({
      model: "qwen3-coder:30b",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "edit_file", arguments: { path: "tests.ts" } } }],
      },
      done: true,
    }, streaming);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toMatchObject([{ name: "edit_file" }]);
  });

  test.each([false, true])("does not treat an unknown done_reason as a natural stop (streaming=%s)", async (streaming) => {
    const { response, chunks, traces } = await completeChat({
      model: "qwen3-coder:30b",
      message: {
        role: "assistant",
        content: streaming ? "" : "partial answer",
        tool_calls: [{ function: { name: "edit_file", arguments: { path: "tests.ts" } } }],
      },
      done: true,
      done_reason: "future_reason",
    }, streaming);

    expect(response.finishReason).toBe("error");
    expect(response.toolCalls).toEqual([]);
    expect(chunks.flatMap((chunk) => chunk.toolCalls ?? [])).toEqual([]);
    expect(response.error).toMatchObject({
      name: "LLMInvalidResponseError",
      message: expect.stringMatching(/unknown ollama done_reason.*"future_reason"/i),
    });
    expect(responseTrace(traces)?.payload).toMatchObject({
      done_reason: "future_reason",
      done_reason_kind: "unknown",
      done_reason_fallback: "error",
    });
  });

  test("streaming uses the terminal chunk reason even when earlier chunks omit it", async () => {
    const provider = new OllamaProvider({ model: "qwen3-coder:30b" });
    Object.assign(provider, {
      client: {
        chat: async function* () {
          yield { message: { role: "assistant", content: "I will update" } };
          yield { message: { role: "assistant", content: " the tests:" }, done: true, done_reason: "length" };
        },
        list: async () => ({ models: [] }),
      },
    });
    const traces: LLMProviderTraceEvent[] = [];

    const response = await provider.chatStream(
      messages,
      () => {},
      { trace: { onProviderTraceEvent: (event) => traces.push(event) } },
    );

    expect(response.finishReason).toBe("length");
    expect(responseTrace(traces)?.payload).toMatchObject({
      done_reason: "length",
      done_reason_kind: "mapped",
    });
  });

  test("streaming ignores a non-terminal done_reason when the terminal chunk omits it", async () => {
    const provider = new OllamaProvider({ model: "qwen3-coder:30b" });
    Object.assign(provider, {
      client: {
        chat: async function* () {
          yield {
            message: { role: "assistant", content: "finished" },
            done_reason: "length",
          };
          yield {
            message: { role: "assistant", content: "" },
            done: true,
          };
        },
        list: async () => ({ models: [] }),
      },
    });
    const traces: LLMProviderTraceEvent[] = [];

    const response = await provider.chatStream(
      messages,
      () => {},
      { trace: { onProviderTraceEvent: (event) => traces.push(event) } },
    );

    expect(response.finishReason).toBe("stop");
    expect(responseTrace(traces)?.payload).toMatchObject({
      done_reason: null,
      done_reason_kind: "missing",
      done_reason_fallback: "stop",
    });
  });
});
