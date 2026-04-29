import { describe, expect, test, vi } from "vitest";

import { GroqProvider } from "./index.js";

describe("GroqProvider", () => {
  test("uses the OpenAI-compatible Groq endpoint and bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_groq",
          model: "llama-3.3-70b-versatile",
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
      model: "llama-3.3-70b-versatile",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://api.groq.com/openai/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer groq-test");
  });
});
