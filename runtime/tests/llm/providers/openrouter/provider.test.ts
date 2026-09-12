import { describe, expect, test, vi } from "vitest";

import {
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
  OpenRouterProvider,
  openRouterExtraBody,
} from "./index.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../registry/provider-info.js";

describe("OpenRouterProvider", () => {
  test("sends OpenRouter routing headers on chat-completions requests", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_openrouter",
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
      model,
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.openrouter}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer or-test");
    expect(headers.get("http-referer")).toBe(OPENROUTER_DEFAULT_REFERER);
    expect(headers.get("x-title")).toBe(OPENROUTER_DEFAULT_TITLE);
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe(model);
    expect(requestBody.stream).toBe(false);
  });

  test("routes only to zero-data-retention endpoints when configured, and sends no routing block otherwise", async () => {
    const reply = () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_zdr",
          model: BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter,
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter;

    await new OpenRouterProvider({ apiKey: "or-test", model, fetchImpl, zeroDataRetention: true })
      .chat([{ role: "user", content: "hello" }]);
    await new OpenRouterProvider({ apiKey: "or-test", model, fetchImpl })
      .chat([{ role: "user", content: "hello" }]);
    await new OpenRouterProvider({
      apiKey: "or-test",
      model,
      fetchImpl,
      zeroDataRetention: true,
      extraBody: { provider: { data_collection: "deny" } },
    }).chat([{ role: "user", content: "hello" }]);

    const bodies = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as Record<string, unknown>,
    );
    expect(bodies[0]?.provider).toEqual({ zdr: true });
    expect(bodies[1]).not.toHaveProperty("provider");
    // An existing routing block keeps its other preferences.
    expect(bodies[2]?.provider).toEqual({ data_collection: "deny", zdr: true });
    expect(openRouterExtraBody({})).toBeUndefined();
  });

  test.each(
    BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter.filter(
      (model) => model !== BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter,
    ),
  )(
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
        model: BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter,
        fetchImpl,
      });

      const response = await provider.chat(
        [{ role: "user", content: "hello" }],
        { model },
      );

      expect(response.content).toBe("ok");
      const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(requestUrl)).toBe(
        `${BUILT_IN_PROVIDER_BASE_URLS.openrouter}/chat/completions`,
      );
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer or-test");
      expect(headers.get("http-referer")).toBe(OPENROUTER_DEFAULT_REFERER);
      expect(headers.get("x-title")).toBe(OPENROUTER_DEFAULT_TITLE);
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestBody.model).toBe(model);
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).toContain(model);
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
      model: BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter,
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
