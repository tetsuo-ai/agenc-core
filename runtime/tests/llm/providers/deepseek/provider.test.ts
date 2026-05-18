import { describe, expect, test, vi } from "vitest";

import { DeepSeekProvider } from "./index.js";

describe("DeepSeekProvider", () => {
  test("maps reasoning_content responses through the compat adapter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_deepseek",
          model: "deepseek-reasoner",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "reasoning trace",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 2,
            total_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new DeepSeekProvider({
      apiKey: "deepseek-test",
      model: "deepseek-reasoner",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("reasoning trace");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer deepseek-test");
  });
});
