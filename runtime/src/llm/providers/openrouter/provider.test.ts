import { describe, expect, test, vi } from "vitest";

import { OpenRouterProvider } from "./index.js";

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
    expect(headers.get("http-referer")).toBe(
      "https://github.com/tetsuo-ai/agenc-core",
    );
    expect(headers.get("x-title")).toBe("AgenC");
  });
});
