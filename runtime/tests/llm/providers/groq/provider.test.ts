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
