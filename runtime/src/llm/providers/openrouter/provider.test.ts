import { describe, expect, test, vi } from "vitest";

import {
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
  OPENROUTER_MODEL_CATALOG,
  OpenRouterProvider,
} from "./index.js";

describe("OpenRouterProvider", () => {
  test("sends OpenRouter routing headers on chat-completions requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_openrouter",
          model: "openai/gpt-5",
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
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new OpenRouterProvider({
      apiKey: "or-test",
      model: "openai/gpt-5",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer or-test");
    expect(headers.get("http-referer")).toBe(OPENROUTER_DEFAULT_REFERER);
    expect(headers.get("x-title")).toBe(OPENROUTER_DEFAULT_TITLE);
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe("openai/gpt-5");
    expect(requestBody.stream).toBe(false);
  });

  test.each([
    "openai/gpt-5-mini",
    "x-ai/grok-code-fast-1",
  ] as const)(
    "routes OpenRouter model %s through chat completions",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "chatcmpl_openrouter_route",
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
              prompt_tokens: 4,
              completion_tokens: 1,
              total_tokens: 5,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const provider = new OpenRouterProvider({
        apiKey: "or-test",
        model: "openai/gpt-5",
        fetchImpl,
      });

      const response = await provider.chat(
        [{ role: "user", content: "hello" }],
        { model },
      );

      expect(response.content).toBe("ok");
      const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(requestUrl)).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer or-test");
      expect(headers.get("http-referer")).toBe(OPENROUTER_DEFAULT_REFERER);
      expect(headers.get("x-title")).toBe(OPENROUTER_DEFAULT_TITLE);
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestBody.model).toBe(model);
      expect(OPENROUTER_MODEL_CATALOG).toContain(model);
    },
  );

  test("lets explicit OpenRouter routing headers override AgenC defaults", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_openrouter_headers",
          model: "openai/gpt-5",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new OpenRouterProvider({
      apiKey: "or-test",
      model: "openai/gpt-5",
      defaultHeaders: {
        "HTTP-Referer": "https://app.agenc.tech",
        "X-Title": "AgenC Test",
      },
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("http-referer")).toBe("https://app.agenc.tech");
    expect(headers.get("x-title")).toBe("AgenC Test");
  });
});
