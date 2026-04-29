import { describe, expect, test, vi } from "vitest";

import { GeminiProvider } from "./index.js";

describe("GeminiProvider", () => {
  test("uses the Gemini v1beta OpenAI shim with x-goog-api-key auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_gemini",
          model: "gemini-2.5-pro",
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

    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect("store" in requestBody).toBe(false);
  });
});
