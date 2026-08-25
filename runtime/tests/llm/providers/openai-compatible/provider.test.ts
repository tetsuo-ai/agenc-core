import { describe, expect, test, vi } from "vitest";

import { OpenAICompatibleProvider } from "./index.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
} from "../../registry/provider-info.js";

describe("OpenAICompatibleProvider", () => {
  test("uses chat completions with no authorization by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_openai_compatible",
          model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
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

    const provider = new OpenAICompatibleProvider({
      model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS["openai-compatible"]}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe(
      BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
    );
    expect(requestBody.stream).toBe(false);
  });

  test("uses optional bearer auth and request-scoped local model overrides", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_openai_compatible_keyed",
          model: "self-hosted-coder",
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

    const provider = new OpenAICompatibleProvider({
      apiKey: "local-token",
      model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
      baseURL: "http://127.0.0.1:9000/v1",
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "self-hosted-coder" },
    );

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("http://127.0.0.1:9000/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer local-token");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe("self-hosted-coder");
  });
});
