import { describe, expect, test, vi } from "vitest";

import { GroqProvider } from "./index.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../registry/provider-info.js";

describe("GroqProvider", () => {
  test("uses the Groq compatible endpoint and bearer auth", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.groq;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_groq",
          model,
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new GroqProvider({
      apiKey: "groq-test",
      model,
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.groq}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer groq-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe(model);
    expect(requestBody.stream).toBe(false);
  });

  test.each(
    BUILT_IN_PROVIDER_MODEL_CATALOG.groq.filter(
      (model) => model !== BUILT_IN_PROVIDER_DEFAULT_MODELS.groq,
    ),
  )("routes Groq model %s through chat completions", async (model) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_groq_route",
          model,
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new GroqProvider({
      apiKey: "groq-test",
      model: BUILT_IN_PROVIDER_DEFAULT_MODELS.groq,
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model },
    );

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.groq}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer groq-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe(model);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.groq).toContain(model);
  });
});

describe("Groq current tool contracts", () => {
  test.each([
    ["openai/gpt-oss-120b", "high", "high", undefined],
    ["openai/gpt-oss-20b", "none", undefined, undefined],
    ["qwen/qwen3.8-27b", "none", "none", true],
    ["qwen/qwen3.8-27b", "xhigh", undefined, true],
    ["minimaxai/minimax-m2.7", "high", undefined, true],
  ] as const)("serializes effort and tools for %s / %s", async (model, effort, expectedEffort, parallel) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "groq-contract", model, choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: "call_echo", type: "function",
          function: { name: "echo", arguments: '{"value":"ok"}' } }],
      } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new GroqProvider({ model, apiKey: "unit-test", fetchImpl,
      tools: [{ type: "function", function: { name: "echo", description: "Echo text",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }],
    });
    const response = await provider.chat([{ role: "user", content: "Call echo" }], {
      reasoningEffort: effort, parallelToolCalls: true, maxOutputTokens: 32,
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe(expectedEffort);
    expect(body.parallel_tool_calls).toBe(parallel);
    expect(body.tools[0].function.name).toBe("echo");
    expect(response.toolCalls).toEqual([{ id: "call_echo", name: "echo", arguments: '{"value":"ok"}' }]);
  });
});
