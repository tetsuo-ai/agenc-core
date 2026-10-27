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
import { isLLMPreGenerationRejection } from "../../errors.js";

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

  test("requires supported parameters and retains zero-data-retention routing when configured", async () => {
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
    expect(bodies[0]?.provider).toEqual({ require_parameters: true, zdr: true });
    expect(bodies[1]?.provider).toEqual({ require_parameters: true });
    // An existing routing block keeps its other preferences.
    expect(bodies[2]?.provider).toEqual({ data_collection: "deny", require_parameters: true, zdr: true });
    expect(openRouterExtraBody({})).toEqual({ provider: { require_parameters: true } });
  });

  test("explains a model OpenRouter refuses under zero data retention instead of passing the raw 404", async () => {
    // The refusal OpenRouter sent on 2026-10-22 for qwen/qwen3.7-flash with provider.zdr.
    const refusal = {
      error: {
        message: "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
        code: 404,
        metadata: {
          routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 2 }],
          failed_routing_step: "Filter by Data Policy",
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(refusal), { status: 404, headers: { "content-type": "application/json" } }));
    const provider = new OpenRouterProvider({
      apiKey: "or-test",
      model: "qwen/qwen3.7-flash",
      fetchImpl,
      zeroDataRetention: true,
      maxRetries: 0,
    });
    for (const call of [
      () => provider.chat([{ role: "user", content: "hello" }]),
      () => provider.chatStream([{ role: "user", content: "hello" }], () => {}),
    ]) {
      const error = await call().then(() => undefined, (caught: unknown) => caught as Error & { statusCode?: number });
      expect(error?.name).toBe("LLMProviderError");
      expect(error?.statusCode).toBe(404);
      expect(error?.message).toContain("no zero-data-retention endpoint for this model");
      expect(error?.message).toContain("zero_data_retention = false under [providers.openrouter]");
      expect(error?.message).not.toContain("—");
    }
  });

  test("tells admission that nothing ran when a single-wire request is refused while routing", async () => {
    const refusal = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json" } }));
    const dataPolicy = {
      error: {
        message: "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
        code: 404,
        metadata: { failed_routing_step: "Filter by Data Policy" },
      },
    };
    const refused = async (fetchImpl: typeof fetch, singleWireAttempt: boolean) =>
      new OpenRouterProvider({ apiKey: "or-test", model: "qwen/qwen3.7-flash", fetchImpl, zeroDataRetention: true, maxRetries: 0 })
        .chatStream([{ role: "user", content: "hello" }], () => {}, { singleWireAttempt })
        .then(() => undefined, (caught: unknown) => caught);
    // Admission releases a pre-generation refusal at zero instead of holding it as unknown spend.
    expect(isLLMPreGenerationRejection(await refused(refusal(dataPolicy), true), "openrouter")).toBe(true);
    expect(isLLMPreGenerationRejection(await refused(refusal(dataPolicy), false), "openrouter")).toBe(false);
    // Any other 404 keeps today's evidence rules.
    expect(isLLMPreGenerationRejection(await refused(refusal({ error: { message: "Not Found", code: 404 } }), true), "openrouter")).toBe(false);
  });

  test("names the account's own data policy when that is what refused the model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({
        error: { message: "No endpoints found matching your data policy (Paid model training). Configure: https://openrouter.ai/settings/privacy", code: 404 },
      }), { status: 404, headers: { "content-type": "application/json" } }));
    const error = await new OpenRouterProvider({ apiKey: "or-test", model: "vendor/model", fetchImpl, maxRetries: 0 })
      .chat([{ role: "user", content: "hello" }])
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain("data policy for this account");
    expect(error?.message).not.toContain("zero_data_retention");
  });

  test("sends no routing block on the managed AgenC gateway, which pins zero data retention itself", async () => {
    // The gateway's request schema is strict: an unreviewed `provider` field
    // made every managed DeepSeek request fail as a 503 "provider_unavailable".
    const model = "deepseek/deepseek-v4.1-flash";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_managed",
          model,
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

    await new OpenRouterProvider({
      apiKey: "managed-test",
      model,
      baseURL: "https://id.agenc.ag/v1/auth/openrouter/v1",
      fetchImpl,
      managedRequestId: true,
      zeroDataRetention: true,
    }).chat([{ role: "user", content: "hello" }]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe(model);
    expect(body).not.toHaveProperty("provider");
    expect(
      openRouterExtraBody({ zeroDataRetention: true, managedRequestId: true }),
    ).toBeUndefined();
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

describe("OpenRouter tool-result images", () => {
  // A 1x1 PNG, the shape FileRead returns for an image file.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  test.each([
    ["moonshotai/kimi-k2.7-code", true],
    ["google/gemini-3.8-flash", true],
    ["minimax/minimax-m3", true],
    ["qwen/qwen3-coder-next", false],
    ["deepseek/deepseek-v4-flash", false],
  ] as const)("%s sees a tool-result image: %s", async (model, sees) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "chatcmpl_img", model,
      choices: [{ message: { role: "assistant", content: "red" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenRouterProvider({ apiKey: "or-test", model, fetchImpl });

    await provider.chat([
      { role: "user", content: "What color is shape.png?" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_read", name: "FileRead", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_read", content: [
        { type: "text", text: "Read image shape.png (221B, image/png)" },
        { type: "image_url", image_url: { url: png } },
      ] },
    ]);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { messages: Array<Record<string, unknown>> };
    const tool = body.messages.find(message => message.role === "tool");
    const relayed = JSON.stringify(body.messages.slice(body.messages.indexOf(tool!) + 1));
    if (sees) {
      // The image reaches the model in the user message that follows the tool result.
      expect(relayed).toContain("image_url");
      expect(String(tool!.content)).not.toContain("Image not shown");
    } else {
      expect(JSON.stringify(body)).not.toContain("image_url");
      expect(String(tool!.content)).toContain("Image not shown");
    }
  });
});
