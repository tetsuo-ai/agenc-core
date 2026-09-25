// OpenAI's Chat Completions rules for its reasoning models (Using GPT-6 guide
// and the GPT-5.4 parameter compatibility guide, read 2026-09-22): temperature
// is accepted only when the effective reasoning effort is none, and function
// tools with a reasoning effort are rejected on GPT-6 Sol and Luna ("Function
// tools with reasoning_effort are not supported for gpt-6-sol in
// /v1/chat/completions", seen live) and never accepted on GPT-6 Astra. The
// OpenAI provider reaches Chat Completions through useResponsesApi: false.
import { describe, expect, test, vi } from "vitest";
import type { LLMChatOptions, LLMTool } from "../../types.js";
import { OpenAIProvider } from "./adapter.js";

const TOOL: LLMTool = {
  type: "function",
  function: {
    name: "get_time",
    description: "Returns the current time",
    parameters: { type: "object", properties: {} },
  },
};

function jsonResponse(url: string): Response {
  const body = url.endsWith("/responses")
    ? {
      status: "completed",
      model: "gpt-6-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }
    : {
      model: "gpt-6-sol",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function chatCompletionsCall(model: string, options: LLMChatOptions) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    jsonResponse(String(input)));
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    model,
    useResponsesApi: false,
    fetchImpl,
  });
  await provider.chat([{ role: "user", content: "hello" }], options);
  return {
    url: String(fetchImpl.mock.calls[0]?.[0]),
    body: JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>,
  };
}

describe("OpenAI Chat Completions temperature rule", () => {
  test.each([
    ["gpt-6-luna", "low"],
    ["gpt-6-sol", undefined],
    ["gpt-5.5", "medium"],
    ["gpt-5", undefined],
  ] as const)("drops temperature on %s at effort %s", async (model, effort) => {
    const call = await chatCompletionsCall(model, {
      temperature: 0.2,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.body).not.toHaveProperty("temperature");
  });

  test.each([
    ["gpt-6-luna", "none"],
    ["gpt-5.4", undefined],
    ["gpt-4.1", undefined],
  ] as const)("keeps temperature on %s at effort %s", async (model, effort) => {
    const call = await chatCompletionsCall(model, {
      temperature: 0.2,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
    expect(call.body.temperature).toBe(0.2);
  });
});

describe("OpenAI function tools that Chat Completions rejects go through Responses", () => {
  test.each([
    ["gpt-6-sol", "low"],
    ["gpt-6-luna", undefined],
    ["gpt-6-astra", "none"],
  ] as const)("routes %s with tools at effort %s to /responses", async (model, effort) => {
    const call = await chatCompletionsCall(model, {
      tools: [TOOL],
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "get_time" }),
    ]);
  });

  test.each([
    ["gpt-6-sol", "none", [TOOL]],
    ["gpt-6-sol", "low", []],
    ["gpt-5.4", "low", [TOOL]],
  ] as const)("keeps %s at effort %s on Chat Completions", async (model, effort, tools) => {
    const call = await chatCompletionsCall(model, { tools: [...tools], reasoningEffort: effort });
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("routes a streamed Sol tool call with effort to /responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      jsonResponse(String(input)));
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-6-sol",
      useResponsesApi: false,
      fetchImpl,
    });
    await provider
      .chatStream([{ role: "user", content: "hello" }], () => undefined, {
        tools: [TOOL],
        reasoningEffort: "high",
      })
      .catch(() => undefined);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
  });
});
