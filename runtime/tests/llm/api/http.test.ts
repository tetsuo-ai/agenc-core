import { describe, expect, test, vi } from "vitest";
import { LLMRateLimitError } from "../errors.js";
import { mapAgenCApiErrorToLLMError } from "./errors.js";
import { CannotRetryError } from "./retry.js";
import {
  AgenCApiHttpClient,
  buildApiRequestUrl,
  fetchWithRetry,
  isRetryableFetchError,
} from "./http.js";

describe("llm api http", () => {
  test("builds request URLs with base paths and query params", () => {
    expect(
      buildApiRequestUrl("http://127.0.0.1:11434/v1", "/responses", {
        debug: true,
        empty: undefined,
      }).toString(),
    ).toBe("http://127.0.0.1:11434/v1/responses?debug=true");
  });

  test("sends JSON requests and parses JSON responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new AgenCApiHttpClient({
      baseURL: "http://127.0.0.1:11434/v1",
      defaultHeaders: { authorization: "Bearer token" },
      fetchImpl,
    });

    const response = await client.requestJson<{ ok: boolean }>({
      path: "/responses",
      headers: { "x-request-id": "req-1" },
      body: { input: "hello" },
    });

    expect(response.data.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:11434/v1/responses");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Headers).get("authorization")).toBe("Bearer token");
    expect((init?.headers as Headers).get("x-request-id")).toBe("req-1");
    expect(init?.body).toBe(JSON.stringify({ input: "hello" }));
  });

  test("leaves FormData content-type for fetch boundary handling", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new AgenCApiHttpClient({
      baseURL: "http://127.0.0.1:11434/v1",
      fetchImpl,
    });
    const form = new FormData();
    form.set("file", "contents");

    await client.requestJson({ path: "/upload", body: form });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect((init?.headers as Headers).has("content-type")).toBe(false);
    expect(init?.body).toBe(form);
  });

  test("does not label native URLSearchParams bodies as JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const client = new AgenCApiHttpClient({
      baseURL: "http://127.0.0.1:11434/v1",
      fetchImpl,
    });
    const params = new URLSearchParams({ q: "agenc" });

    await client.requestText({ path: "/search", body: params });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect((init?.headers as Headers).has("content-type")).toBe(false);
    expect(init?.body).toBe(params);
  });

  test("retries retryable HTTP failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new AgenCApiHttpClient({
      baseURL: "http://127.0.0.1:11434/v1",
      fetchImpl,
      retry: { maxRetries: 1, sleep, random: () => 0 },
    });

    await expect(
      client.requestJson<{ ok: boolean }>({ path: "/responses" }),
    ).resolves.toMatchObject({ data: { ok: true }, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500, undefined);
  });

  test("surfaces non-retryable HTTP failures through CannotRetryError", async () => {
    const client = new AgenCApiHttpClient({
      baseURL: "http://127.0.0.1:11434/v1",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
      retry: { maxRetries: 1, sleep: vi.fn().mockResolvedValue(undefined) },
    });

    await expect(client.requestJson({ path: "/responses" })).rejects.toMatchObject<
      Partial<CannotRetryError>
    >({
      name: "CannotRetryError",
    });
  });

  test("maps exhausted client failures through the original API error", async () => {
    const client = new AgenCApiHttpClient({
      baseURL: "http://127.0.0.1:11434/v1",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "1",
          },
        }),
      ),
      retry: { maxRetries: 0, sleep: vi.fn().mockResolvedValue(undefined) },
    });

    let caught: unknown;
    try {
      await client.requestJson({ path: "/responses" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CannotRetryError);
    expect(mapAgenCApiErrorToLLMError("openai", caught, 30_000)).toBeInstanceOf(
      LLMRateLimitError,
    );
  });

  test("fetchWithRetry retries stale socket fetch errors only", async () => {
    expect(isRetryableFetchError(new Error("socket hang up"))).toBe(true);
    expect(
      isRetryableFetchError(new DOMException("aborted", "AbortError")),
    ).toBe(false);

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("ok"));

    await expect(
      fetchWithRetry("http://127.0.0.1:11434", undefined, {
        fetchImpl,
        maxAttempts: 2,
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
