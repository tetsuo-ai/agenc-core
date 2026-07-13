import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ProviderHttpClientSession,
  ProviderHttpError,
} from "./client-session.js";
import {
  LLMCaptivePortalError,
  LLMCertificateError,
  LLMInvalidResponseError,
} from "./errors.js";

function streamFromChunks(
  chunks: Array<string | Uint8Array>,
  options: { delayMs?: number } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const pump = () => {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
        if (options.delayMs && index < chunks.length) {
          setTimeout(pump, options.delayMs);
        } else {
          pump();
        }
      };
      pump();
    },
  });
}

function streamWithFailure(
  chunks: Array<string | Uint8Array>,
  error: Error,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
        return;
      }
      controller.error(error);
    },
  });
}

const PROVIDER_PROJECT_HEADER = "Open" + "AI-Project";

describe("ProviderHttpClientSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("merges provider query params, request headers, and auth headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolveAuthHeaders = vi.fn().mockResolvedValue({
      Authorization: "Bearer runtime-token",
    });
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "http://127.0.0.1:40123/v1",
      wireApi: "responses",
      defaultHeaders: { [PROVIDER_PROJECT_HEADER]: "proj-1" },
      defaultQuery: { "api-version": "2025-04-01-preview" },
      resolveAuthHeaders,
      fetchImpl,
    });

    await session.requestJson<{ ok: boolean }>({
      method: "POST",
      headers: { "x-request-id": "req-1" },
      query: { debug: true },
      body: { hello: "world" },
    });

    expect(resolveAuthHeaders).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "http://127.0.0.1:40123/v1/responses?api-version=2025-04-01-preview&debug=true",
    );
    const headers = init?.headers as Headers;
    expect(headers.get(PROVIDER_PROJECT_HEADER)).toBe("proj-1");
    expect(headers.get("Authorization")).toBe("Bearer runtime-token");
    expect(headers.get("x-request-id")).toBe("req-1");
  });

  test("rejects successful malformed JSON from requestJson as a provider response error", async () => {
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "http://127.0.0.1:40123/v1",
      wireApi: "responses",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    await expect(
      session.requestJson({ body: { ping: "pong" } }),
    ).rejects.toMatchObject<Partial<ProviderHttpError>>({
      name: "ProviderHttpError",
      status: 200,
      body: "{not-json",
      message: expect.stringContaining("Invalid JSON response"),
    });
  });

  test("rejects successful non-JSON bodies from requestJson as provider response errors", async () => {
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "http://127.0.0.1:40123/v1",
      wireApi: "responses",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("OK", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    });

    await expect(
      session.requestJson({ body: { ping: "pong" } }),
    ).rejects.toMatchObject<Partial<ProviderHttpError>>({
      name: "ProviderHttpError",
      status: 200,
      body: "OK",
      message: expect.stringContaining("Non-JSON response"),
    });
  });

  test("retries request transport failures with default budget", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
    });

    const pending = session.requestJson<{ ok: boolean }>({
      body: { ping: "pong" },
    });
    await vi.runOnlyPendingTimersAsync();
    const response = await pending;

    expect(response.data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("retries TLS validation failures once with a fresh handshake even when transport retries are disabled", async () => {
    const tlsError = Object.assign(
      new Error("Hostname/IP does not match certificate's altnames"),
      {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        issuer: "Corp Proxy CA",
        subject: "api.openai.com",
        valid_to: "2026-05-01T00:00:00Z",
      },
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(tlsError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 0,
        retryTransport: false,
      },
      fetchImpl,
    });

    const pending = session.requestJson<{ ok: boolean }>({
      body: { ping: "pong" },
    });
    await vi.runOnlyPendingTimersAsync();
    const response = await pending;

    expect(response.data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("surfaces exhausted TLS validation failures as LLMCertificateError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        Object.assign(new Error("certificate has expired"), {
          code: "CERT_HAS_EXPIRED",
          issuer: "Corp Proxy CA",
          subject: "api.openai.com",
          valid_from: "2026-01-01T00:00:00Z",
          valid_to: "2026-04-01T00:00:00Z",
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 0,
        retryTransport: false,
      },
      fetchImpl,
    });

    const pending = expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject<Partial<LLMCertificateError>>({
      name: LLMCertificateError.name,
      providerName: "openai",
      tlsCode: "CERT_HAS_EXPIRED",
      issuer: "Corp Proxy CA",
      subject: "api.openai.com",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "2026-04-01T00:00:00Z",
    });
    await vi.runOnlyPendingTimersAsync();
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not retry 429 unless the retry budget enables it", async () => {
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    await expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject<Partial<ProviderHttpError>>({
      status: 429,
      providerName: "openai",
    });
  });

  test("triggers provider fallback after repeated overload responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "http://127.0.0.1:8000/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 4,
        baseDelayMs: 1,
        retry5xx: true,
      },
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
      fetchImpl,
    });

    const pending = expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "openai",
      toProvider: "grok",
      fromModel: "gpt-5",
      toModel: "grok-4-fast",
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("fallback wait retries custom request statuses outside the normal retry policy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "http://127.0.0.1:8000/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 4,
        baseDelayMs: 1,
      },
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        statuses: [429],
        maxFailures: 2,
      },
      fetchImpl,
    });

    const pending = expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "openai",
      toProvider: "grok",
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("fallback recognizes structured overloaded_error bodies without 529 status", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { type: "overloaded_error", message: "busy" },
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    );
    const session = new ProviderHttpClientSession({
      providerName: "anthropic",
      baseURL: "http://127.0.0.1:8000/v1",
      wireApi: "messages",
      requestRetry: {
        maxRetries: 4,
        baseDelayMs: 1,
        retry5xx: false,
      },
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
      fetchImpl,
    });

    const pending = expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "anthropic",
      toProvider: "grok",
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("fallback wait retries custom stream statuses outside the normal retry policy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "http://127.0.0.1:8000/v1",
      wireApi: "responses",
      streamRetry: {
        maxRetries: 4,
        baseDelayMs: 1,
      },
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        statuses: [429],
        maxFailures: 2,
      },
      fetchImpl,
    });

    const pending = expect(
      session.requestStream({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "openai",
      toProvider: "grok",
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("honors Retry-After seconds when retrying 429 responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "2",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 1,
        retry429: true,
      },
      fetchImpl,
    });

    const pending = session.requestJson<{ ok: boolean }>({
      body: { ping: "pong" },
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("aborts retry when an HTTP-date Retry-After exceeds the documented T13 ceiling", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00Z"));
    const warnings: Array<{ cause: string; message: string }> = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "Tue, 21 Apr 2026 13:00:00 GMT",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 1,
        retry429: true,
      },
      fetchImpl,
      emitWarning: (warning) => warnings.push(warning),
    });

    await expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject<Partial<ProviderHttpError>>({
      status: 429,
      providerName: "openai",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "rate_limit_exceeds_max_wait",
      }),
    );
  });

  test("emits warning and aborts retry when Retry-After exceeds the documented max wait", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "600",
        },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 1,
        retry429: true,
      },
      fetchImpl,
      emitWarning: (warning) => warnings.push(warning),
    });

    await expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject<Partial<ProviderHttpError>>({
      status: 429,
      providerName: "openai",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "rate_limit_exceeds_max_wait",
      }),
    );
  });

  test("emits warning on ambiguous Retry-After headers and falls back to exponential backoff", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "soon-ish",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 1,
        retry429: true,
        baseDelayMs: 200,
      },
      fetchImpl,
      emitWarning: (warning) => warnings.push(warning),
    });

    const pending = session.requestJson<{ ok: boolean }>({
      body: { ping: "pong" },
    });
    await vi.runOnlyPendingTimersAsync();
    const response = await pending;

    expect(response.data.ok).toBe(true);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "retry_after_ambiguous",
      }),
    );
  });

  test("classifies HTML JSON responses as captive portal / proxy intercept failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><title>Login</title></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      requestRetry: {
        maxRetries: 3,
        retryTransport: true,
      },
      fetchImpl,
    });

    await expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject<Partial<LLMCaptivePortalError>>({
      name: LLMCaptivePortalError.name,
      providerName: "openai",
      causeCode: "captive_portal_or_proxy_intercept",
      contentType: "text/html; charset=utf-8",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("requestStream exposes chunked responses with auth and explicit api routing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(streamFromChunks(["part-1", "part-2"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "anthropic",
      baseURL: "https://example.test/v1",
      wireApi: "messages",
      authHeaders: { "x-api-key": "anthropic-key" },
      fetchImpl,
    });

    const stream = await session.requestStream({
      api: "messages",
      method: "POST",
      body: { stream: true },
    });

    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(decoder.decode(chunk.value));
    }

    expect(chunks).toEqual(["part-1", "part-2"]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://example.test/v1/messages");
    const headers = init?.headers as Headers;
    expect(headers.get("x-api-key")).toBe("anthropic-key");
  });

  test("requestStream aborts stalled streams with the configured idle timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      streamIdleTimeoutMs: 50,
      fetchImpl,
    });

    const stream = await session.requestStream({
      body: { stream: true },
    });

    const consume = (async () => {
      for await (const _chunk of stream) {
        // no-op
      }
    })();

    const assertion = expect(consume).rejects.toThrow("openai stream idle for 50ms");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  test("requestStream rejects HTML responses before stream parsing begins", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(streamFromChunks(["<html>login</html>"]), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
    });

    await expect(
      session.requestStream({
        body: { stream: true },
      }),
    ).rejects.toMatchObject<Partial<LLMCaptivePortalError>>({
      name: LLMCaptivePortalError.name,
      providerName: "openai",
      causeCode: "captive_portal_or_proxy_intercept",
      contentType: "text/html; charset=utf-8",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("requestStream retries transport failures only before any body bytes yield (LLM-01)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(streamWithFailure([], new Error("socket hang up")), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(streamFromChunks(["part-2"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      streamRetry: {
        maxRetries: 1,
      },
      fetchImpl,
    });

    const stream = await session.requestStream({
      body: { stream: true },
    });

    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(decoder.decode(chunk.value));
    }

    expect(chunks).toEqual(["part-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("requestStream does not splice a second body after partial yield (LLM-01)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          streamWithFailure(["part-1"], new Error("socket hang up")),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(streamFromChunks(["part-2"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      streamRetry: {
        maxRetries: 1,
      },
      fetchImpl,
    });

    const stream = await session.requestStream({
      body: { stream: true },
    });

    const decoder = new TextDecoder();
    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of stream) {
        chunks.push(decoder.decode(chunk.value));
      }
    }).rejects.toThrow(/socket hang up|transport|ECONNRESET|network/i);

    expect(chunks).toEqual(["part-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("requestJson carries prompt_cache_key and previous_response_id through shared continuity state", async () => {
    const sharedState = {
      conversationId: "conv-123",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hi" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "resp_2", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const first = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: sharedState,
    });
    const second = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: sharedState,
    });

    await first.requestJson({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: false,
      },
    });

    await second.requestJson({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "follow up" }],
          },
        ],
        stream: false,
      },
    });

    const firstBody = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    const secondBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;

    expect(firstBody.prompt_cache_key).toBe("conv-123");
    expect(secondBody.prompt_cache_key).toBe("conv-123");
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow up" }],
      },
    ]);
  });

  test("requestStream records completed responses for the next turn session", async () => {
    const sharedState = {
      conversationId: "conv-123",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          streamFromChunks([
            'event: response.completed\n',
            'data: {"type":"response.completed","response":{"id":"resp_stream_1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"stream hi"}]}]}}\n\n',
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          streamFromChunks([
            'event: response.completed\n',
            'data: {"type":"response.completed","response":{"id":"resp_stream_2","output":[]}}\n\n',
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );
    const first = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: sharedState,
    });
    const second = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: sharedState,
    });

    const firstStream = await first.requestStream({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: true,
      },
    });
    for await (const _chunk of firstStream) {
      // consume stream fully so the final response.completed event is seen
    }

    const secondStream = await second.requestStream({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "stream hi" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "follow up" }],
          },
        ],
        stream: true,
      },
    });
    for await (const _chunk of secondStream) {
      // consume stream fully
    }

    const secondBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(secondBody.previous_response_id).toBe("resp_stream_1");
    expect(secondBody.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow up" }],
      },
    ]);
  });

  test("requestStream aborts the responses-continuation accumulation buffer when an SSE frame exceeds the cap", async () => {
    // The continuation accumulation path (decodeSseFrames) buffers bytes while
    // waiting for a \n\n frame separator. A misbehaving provider/proxy that
    // streams bytes continuously without a separator would grow this buffer to
    // the full stream size (OOM) while the idle watchdog (idle-only) never
    // fires. The cap must abort with the typed LLMInvalidResponseError instead.
    const MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;
    const oversizedNoSeparator = `data: ${"x".repeat(MAX_SSE_FRAME_BYTES + 16)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(streamFromChunks([oversizedNoSeparator]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: { conversationId: "conv-cap" },
    });

    const stream = await session.requestStream({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: true,
      },
    });

    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // drain until the accumulation buffer trips the cap
        }
      })(),
    ).rejects.toBeInstanceOf(LLMInvalidResponseError);
  });

  test("I-14: requestJson retries once with full history when previous_response_id expires", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const sharedState = {
      conversationId: "conv-123",
      lastRequest: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: false,
        prompt_cache_key: "conv-123",
      },
      lastResponseId: "resp_expired",
      lastResponseOutput: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "previous_response_id expired",
            },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_2",
            output: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: sharedState,
      emitWarning: (warning) => warnings.push(warning),
    });

    await session.requestJson({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "follow up" }],
          },
        ],
        stream: false,
      },
    });

    const retryBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(retryBody.previous_response_id).toBeUndefined();
    expect(retryBody.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow up" }],
      },
    ]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "previous_response_id_expired",
      }),
    );
  });

  test("I-14: requestStream retries once with full history when previous_response_id expires", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const sharedState = {
      conversationId: "conv-123",
      lastRequest: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: true,
        prompt_cache_key: "conv-123",
      },
      lastResponseId: "resp_stream_expired",
      lastResponseOutput: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "stream hi" }],
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "previous response not found",
            },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          streamFromChunks([
            'event: response.completed\n',
            'data: {"type":"response.completed","response":{"id":"resp_stream_retry","output":[]}}\n\n',
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
      responsesContinuationState: sharedState,
      emitWarning: (warning) => warnings.push(warning),
    });

    const stream = await session.requestStream({
      body: {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "stream hi" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "follow up" }],
          },
        ],
        stream: true,
      },
    });
    for await (const _chunk of stream) {
      // consume retried stream
    }

    const retryBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(retryBody.previous_response_id).toBeUndefined();
    expect(retryBody.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "stream hi" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow up" }],
      },
    ]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "previous_response_id_expired",
      }),
    );
  });

  test("flags capability drift when the provider rejects an advertised feature", async () => {
    const capabilityWarnings: Array<{ message: string; status?: number }> = [];
    const session = new ProviderHttpClientSession({
      providerName: "openai",
      model: "gpt-5",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "reasoning is not supported for this model",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
      onCapabilityDrift: (warning) => capabilityWarnings.push(warning),
    });

    await expect(
      session.requestJson({
        body: { ping: "pong" },
      }),
    ).rejects.toMatchObject<Partial<ProviderHttpError>>({
      status: 400,
      providerName: "openai",
    });

    expect(capabilityWarnings).toContainEqual(
      expect.objectContaining({
        status: 400,
      }),
    );
  });
});
