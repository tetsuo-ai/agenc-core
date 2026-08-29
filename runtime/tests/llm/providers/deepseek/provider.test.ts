import { describe, expect, test, vi } from "vitest";

import { DeepSeekProvider } from "./index.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../registry/provider-info.js";

describe("DeepSeekProvider", () => {
  test("maps reasoning_content responses through the compat adapter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_deepseek",
          model: "deepseek-v4-pro",
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
      model: "deepseek-v4-pro",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("reasoning trace");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.deepseek}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer deepseek-test");
  });
});
