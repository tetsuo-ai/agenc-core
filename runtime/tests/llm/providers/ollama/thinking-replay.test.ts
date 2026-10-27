import { describe, expect, test, vi } from "vitest";

import { OllamaProvider } from "./adapter.js";
import type { LLMChatOptions, LLMMessage } from "../../../../src/llm/types.js";

const ECHO = {
  type: "function" as const,
  function: {
    name: "system.echo",
    description: "Echo text",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  },
};

function setClient(provider: OllamaProvider, client: Record<string, unknown>): void {
  (provider as unknown as { client: unknown }).client = client;
}

async function profiledParams(provider: OllamaProvider, messages: LLMMessage[], options: LLMChatOptions = {}) {
  setClient(provider, {});
  const profile = await provider.getExecutionProfile(options);
  return (provider as any).buildParams(messages, {
    ...options,
    providerExecutionHandle: profile.providerExecutionHandle,
  }) as { readonly messages: readonly Record<string, unknown>[] };
}

async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

function callTurn(id: string, reasoning?: { readonly text: string; readonly provider: string; readonly model: string }): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "system.echo", arguments: '{"text":"hi"}' }],
      ...(reasoning === undefined ? {} : {
        providerReasoningContent: reasoning.text,
        providerReasoningProvenance: { provider: reasoning.provider, model: reasoning.model },
      }),
    },
    { role: "tool", toolCallId: id, toolName: "system.echo", content: "hi" },
  ];
}

describe("Ollama thinking inside a tool loop", () => {
  test("a streamed reply that calls tools keeps its thinking for the next request", async () => {
    const chat = vi.fn().mockResolvedValue(streamChunks([
      { model: "gpt-oss:20b", message: { role: "assistant", content: "", thinking: "Need the echo. " } },
      { model: "gpt-oss:20b", message: { role: "assistant", content: "", thinking: "Call it with hi." } },
      {
        model: "gpt-oss:20b",
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "system.echo", arguments: { text: "hi" } } }] },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 12,
        eval_count: 9,
      },
    ]));
    const provider = new OllamaProvider({ model: "gpt-oss:20b", tools: [ECHO] });
    setClient(provider, { chat });

    const response = await provider.chatStream([{ role: "user", content: "echo hi" }], () => {});

    expect(response.finishReason).toBe("tool_calls");
    expect(response.providerReasoningContent).toBe("Need the echo. Call it with hi.");
    expect(response.providerReasoningProvenance).toEqual({ provider: "ollama", model: "gpt-oss:20b" });
  });

  test("a non-streamed reply that calls tools keeps its thinking too", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "gpt-oss:20b",
      message: {
        role: "assistant",
        content: "",
        thinking: "Call echo.",
        tool_calls: [{ function: { name: "system.echo", arguments: { text: "hi" } } }],
      },
      done_reason: "stop",
      prompt_eval_count: 8,
      eval_count: 2,
    });
    const provider = new OllamaProvider({ model: "gpt-oss:20b", tools: [ECHO] });
    setClient(provider, { chat });

    const response = await provider.chat([{ role: "user", content: "echo hi" }]);

    expect(response.providerReasoningContent).toBe("Call echo.");
    expect(response.providerReasoningProvenance).toEqual({ provider: "ollama", model: "gpt-oss:20b" });
  });

  test("a final answer keeps no thinking for replay", async () => {
    const chat = vi.fn().mockResolvedValue(streamChunks([
      { model: "gpt-oss:20b", message: { role: "assistant", content: "", thinking: "Just answer." } },
      { model: "gpt-oss:20b", message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop" },
    ]));
    const provider = new OllamaProvider({ model: "gpt-oss:20b", tools: [ECHO] });
    setClient(provider, { chat });

    const response = await provider.chatStream([{ role: "user", content: "say hi" }], () => {});

    expect(response.content).toBe("hi");
    expect(response.providerReasoningContent).toBeUndefined();
  });

  test("the request sends the thinking back with the call it led to", async () => {
    const provider = new OllamaProvider({ model: "gpt-oss:20b", tools: [ECHO] });
    const params = await profiledParams(provider, [
      { role: "user", content: "echo hi" },
      ...callTurn("call_1", { text: "Need the echo.", provider: "ollama", model: "gpt-oss:20b" }),
    ]);

    expect(params.messages[1]).toEqual({
      role: "assistant",
      content: "",
      thinking: "Need the echo.",
      tool_calls: [{ function: { name: "system.echo", arguments: { text: "hi" } } }],
    });
  });

  test("only the running loop's thinking from the same model and provider goes back", async () => {
    const provider = new OllamaProvider({ model: "gpt-oss:20b", tools: [ECHO] });
    const params = await profiledParams(provider, [
      { role: "user", content: "first" },
      ...callTurn("call_old", { text: "OLD_LOOP", provider: "ollama", model: "gpt-oss:20b" }),
      { role: "assistant", content: "done" },
      { role: "user", content: "second" },
      ...callTurn("call_other_model", { text: "OTHER_MODEL", provider: "ollama", model: "qwen3:8b" }),
      ...callTurn("call_other_provider", { text: "OTHER_PROVIDER", provider: "ollama-cloud", model: "gpt-oss:20b" }),
      ...callTurn("call_plain"),
      ...callTurn("call_now", { text: "CURRENT", provider: "ollama", model: "GPT-OSS:20b" }),
    ]);

    const thinking = params.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.thinking);
    expect(thinking).toEqual([undefined, undefined, undefined, undefined, undefined, "CURRENT"]);
  });
});
