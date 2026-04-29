import { describe, expect, test, vi } from "vitest";

import { LMStudioProvider } from "./index.js";

describe("LMStudioProvider", () => {
  test("omits authorization when no API key is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_lmstudio",
          model: "qwen2.5-coder:7b",
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
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new LMStudioProvider({
      model: "qwen2.5-coder:7b",
      baseURL: "http://localhost:1234/v1",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("http://localhost:1234/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
  });

  test("uses optional bearer auth when an API key is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_lmstudio_keyed",
          model: "qwen2.5-coder:7b",
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
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new LMStudioProvider({
      apiKey: "lmstudio-test",
      model: "qwen2.5-coder:7b",
      baseURL: "http://localhost:1234/v1",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer lmstudio-test");
  });
});
