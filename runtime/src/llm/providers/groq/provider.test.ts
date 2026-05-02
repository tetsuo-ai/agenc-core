import { describe, expect, test, vi } from "vitest";

import {
  GROQ_DEFAULT_MODEL,
  GROQ_MODEL_CATALOG,
  GroqProvider,
} from "./index.js";

describe("GroqProvider", () => {
  test("uses the OpenAI-compatible Groq endpoint and bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_groq",
          model: GROQ_DEFAULT_MODEL,
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
      model: GROQ_DEFAULT_MODEL,
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://api.groq.com/openai/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer groq-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe(GROQ_DEFAULT_MODEL);
    expect(requestBody.stream).toBe(false);
  });

  test.each([
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
  ] as const)("routes Groq model %s through chat completions", async (model) => {
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
      model: GROQ_DEFAULT_MODEL,
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model },
    );

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://api.groq.com/openai/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer groq-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe(model);
    expect(GROQ_MODEL_CATALOG).toContain(model);
  });
});
