import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_FETCH_MAX_RETRY_DELAY_MS,
  DEEPSEEK_FETCH_MAX_URL_CHARS,
  DEEPSEEK_FETCH_RETRY_DELAY_MS,
  DEEPSEEK_FETCH_TITLE_MAX_CHARS,
  DEEPSEEK_FETCH_USD_PER_REQUEST,
  deepSeekFetchBudgetMs,
  deepSeekFetchEndpoint,
  deepSeekFetchRetryDelayMs,
  deepSeekFetchSkipReason,
  isRetryableDeepSeekFetchStatus,
  resolveDeepSeekWebFetchSetting,
  runDeepSeekFetch,
} from "../../../../src/llm/providers/deepseek/web-fetch.js";

const ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";

// Shape recorded from the live API on 2026-10-30 (example.com), shortened.
const LIVE_SHAPED_PAGE = {
  content: "This domain is for use in documentation examples without needing permission.\n\n[Learn more](https://iana.org/domains/example)",
  title: "Example Domain",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function deepSeekError(status: number, message: string): Response {
  return jsonResponse(status, {
    error: {
      message: `${message} (request_id: 0f1e2d3c-4b5a)`,
      type: "invalid_request_error",
      param: null,
      code: "invalid_request_error",
    },
  });
}

function pendingUntilAborted() {
  return vi.fn(
    async (_url: string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

describe("resolveDeepSeekWebFetchSetting", () => {
  it("lets the session environment win over config, and defaults to auto", () => {
    expect(resolveDeepSeekWebFetchSetting(undefined, undefined)).toBe("auto");
    expect(resolveDeepSeekWebFetchSetting("", undefined)).toBe("auto");
    expect(resolveDeepSeekWebFetchSetting(undefined, true)).toBe("on");
    expect(resolveDeepSeekWebFetchSetting(undefined, false)).toBe("off");
    expect(resolveDeepSeekWebFetchSetting("1", false)).toBe("on");
    expect(resolveDeepSeekWebFetchSetting("true", undefined)).toBe("on");
    expect(resolveDeepSeekWebFetchSetting("0", true)).toBe("off");
    expect(resolveDeepSeekWebFetchSetting("false", undefined)).toBe("off");
    // An unrecognized spelling does not override the configured value.
    expect(resolveDeepSeekWebFetchSetting("maybe", false)).toBe("off");
  });
});

describe("deepSeekFetchEndpoint", () => {
  it("uses the documented URL on the official host and keeps a proxy's path prefix", () => {
    expect(deepSeekFetchEndpoint("https://api.deepseek.com/v1")).toBe(ENDPOINT);
    expect(deepSeekFetchEndpoint("https://api.deepseek.com/beta/")).toBe(ENDPOINT);
    expect(deepSeekFetchEndpoint("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1/tools/fetch");
    expect(deepSeekFetchEndpoint("https://gw.example/deepseek/v1/")).toBe(
      "https://gw.example/deepseek/v1/tools/fetch",
    );
    expect(deepSeekFetchEndpoint("ftp://gw.example/v1")).toBeUndefined();
  });
});

describe("deepSeekFetchSkipReason", () => {
  it("lets a public DNS name through", () => {
    expect(deepSeekFetchSkipReason("https://example.com/")).toBeUndefined();
    expect(deepSeekFetchSkipReason("https://docs.example.org/a/b?c=d#e")).toBeUndefined();
    expect(deepSeekFetchSkipReason("http://news.ycombinator.com/rss")).toBeUndefined();
    expect(deepSeekFetchSkipReason(`https://example.com/${"a".repeat(DEEPSEEK_FETCH_MAX_URL_CHARS - 21)}`))
      .toBeUndefined();
  });

  it.each([
    ["https://localhost/", ".localhost host"],
    ["https://app.localhost/", ".localhost host"],
    ["https://printer.local/status", ".local host"],
    ["https://db.internal/admin", ".internal host"],
    ["https://wiki.corp/page", ".corp host"],
    ["https://router.home.arpa/", ".arpa host"],
    ["https://nas.lan/", ".lan host"],
    ["https://site.test/", ".test host"],
    ["https://wiki/page", "single-label host"],
    ["https://intranet/", ".intranet host"],
    ["https://127.0.0.1/", "IP address host"],
    ["https://10.0.0.8/", "IP address host"],
    ["https://169.254.169.254/latest/meta-data", "IP address host"],
    ["https://93.184.216.34/", "IP address host"],
    ["https://[::1]/", "IP address host"],
    ["https://[fd00::1]/", "IP address host"],
    ["https://user:secret@example.com/", "URL with credentials"],
    ["https://user@example.com/", "URL with credentials"],
    ["ftp://example.com/file", "not an http or https URL"],
    ["not a url", "not an http or https URL"],
  ])("keeps %s away from DeepSeek (%s)", (url, reason) => {
    expect(deepSeekFetchSkipReason(url)).toBe(reason);
  });

  it("keeps a URL above DeepSeek's 8,192-character limit away from it", () => {
    const url = `https://example.com/${"a".repeat(DEEPSEEK_FETCH_MAX_URL_CHARS)}`;
    expect(deepSeekFetchSkipReason(url)).toBe("URL longer than 8192 characters");
  });
});

describe("DeepSeek fetch retry policy", () => {
  it("retries only what DeepSeek asks clients to retry", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableDeepSeekFetchStatus(status), String(status)).toBe(true);
    }
    for (const status of [400, 401, 402, 403, 404, 413]) {
      expect(isRetryableDeepSeekFetchStatus(status), String(status)).toBe(false);
    }
  });

  it("waits a numeric Retry-After, else one second, and never more than two", () => {
    expect(deepSeekFetchRetryDelayMs(null)).toBe(DEEPSEEK_FETCH_RETRY_DELAY_MS);
    expect(deepSeekFetchRetryDelayMs("")).toBe(DEEPSEEK_FETCH_RETRY_DELAY_MS);
    expect(deepSeekFetchRetryDelayMs("0")).toBe(0);
    expect(deepSeekFetchRetryDelayMs("0.5")).toBe(500);
    expect(deepSeekFetchRetryDelayMs("1")).toBe(1_000);
    expect(deepSeekFetchRetryDelayMs("30")).toBe(DEEPSEEK_FETCH_MAX_RETRY_DELAY_MS);
    expect(deepSeekFetchRetryDelayMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(DEEPSEEK_FETCH_RETRY_DELAY_MS);
    expect(deepSeekFetchRetryDelayMs("-5")).toBe(DEEPSEEK_FETCH_RETRY_DELAY_MS);
  });
});

describe("runDeepSeekFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs only the URL with the session key and reports a billed page", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ...LIVE_SHAPED_PAGE, title: "  Example\n Domain " }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await runDeepSeekFetch({
      endpoint: ENDPOINT,
      apiKey: "sk-test-session",
      url: "https://example.com/",
      retryDelayMs: 0,
    });
    expect(outcome).toEqual({
      kind: "content",
      title: "Example Domain",
      titleTruncated: false,
      content: LIVE_SHAPED_PAGE.content,
      billed: true,
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test-session",
      "content-type": "application/json",
    });
    // Only the URL: nothing else from the conversation.
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://example.com/" });
    expect(DEEPSEEK_FETCH_USD_PER_REQUEST).toBe(0.00075);
  });

  it("keeps an empty title and treats empty content as an unbilled empty page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { title: "", content: "# Doc\n\nText" })));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toMatchObject({ kind: "content", title: "", billed: true });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { title: "Blank", content: " \n " })));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toEqual({ kind: "empty", billed: false, attempts: 1 });
  });

  it.each([
    [400, "'url' must be an HTTP or HTTPS URL"],
    [401, "Authentication Fails, Your api key: ****abcd is invalid"],
    [402, "Insufficient Balance"],
    [403, "request rejected by security policy"],
    [404, "failed to fetch URL"],
    [413, "request body too large"],
  ])("falls back on HTTP %i without a retry, unbilled, with DeepSeek's message", async (status, message) => {
    const fetchMock = vi.fn(async () => deepSeekError(status, message));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "sk-unit-session", url: "https://example.com/", retryDelayMs: 0 }),
    ).resolves.toEqual({ kind: "failed", reason: `HTTP ${status}: ${message}`, billed: false, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "retries HTTP %i once and returns the page when the retry succeeds",
    async (status) => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(deepSeekError(status, "try again"))
        .mockResolvedValueOnce(jsonResponse(200, LIVE_SHAPED_PAGE));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/", retryDelayMs: 0 }),
      ).resolves.toMatchObject({ kind: "content", billed: true, attempts: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("retries at most once, then falls back with the last answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deepSeekError(429, "Rate limit reached"))
      .mockResolvedValueOnce(deepSeekError(503, "Service temporarily unavailable"))
      .mockResolvedValue(jsonResponse(200, LIVE_SHAPED_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/", retryDelayMs: 0 }),
    ).resolves.toEqual({
      kind: "failed",
      reason: "HTTP 503: Service temporarily unavailable, retried once",
      billed: false,
      attempts: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits DeepSeek's Retry-After before the retry", async () => {
    const calls: number[] = [];
    const fetchMock = vi.fn(async () => {
      calls.push(Date.now());
      return calls.length === 1
        ? jsonResponse(429, { error: { message: "Rate limit reached" } }, { "retry-after": "0.2" })
        : jsonResponse(200, LIVE_SHAPED_PAGE);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toMatchObject({ kind: "content", attempts: 2 });
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(150);
  });

  it("does not retry when the wait would outlast its time budget", async () => {
    const fetchMock = vi.fn(async () => deepSeekError(503, "Service temporarily unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/", timeoutMs: 30, retryDelayMs: 1_000 }),
    ).resolves.toEqual({
      kind: "failed",
      reason: "HTTP 503: Service temporarily unavailable",
      billed: false,
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never puts the key or the request id in the reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => deepSeekError(401, "Invalid key sk-test-session")));
    const outcome = await runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "sk-test-session", url: "https://example.com/" });
    expect(outcome).toMatchObject({ kind: "failed", reason: "HTTP 401: Invalid key [redacted]" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connect failed for Bearer sk-test-session");
    }));
    await expect(
      runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "sk-test-session", url: "https://example.com/" }),
    ).resolves.toEqual({
      kind: "failed",
      reason: "request failed: connect failed for Bearer [redacted]",
      billed: false,
      attempts: 1,
    });
  });

  it("reports a host without the Fetch API, a malformed body and a missing content field unbilled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not found</html>", { status: 404 })));
    await expect(runDeepSeekFetch({ endpoint: "http://127.0.0.1:1/v1/tools/fetch", apiKey: "k", url: "https://example.com/" }))
      .resolves.toEqual({ kind: "failed", reason: "HTTP 404", billed: false, attempts: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not json", { status: 200 })));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toEqual({ kind: "failed", reason: "malformed response", billed: false, attempts: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { title: "No content field" })));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toEqual({ kind: "failed", reason: "malformed response", billed: false, attempts: 1 });
  });

  it("leaves a page above the response cap to the local fetcher, unbilled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "content-length": "9000000" } })));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toEqual({ kind: "failed", reason: "response too large", billed: false, attempts: 1 });
  });

  it("does not bill a 200 whose body stalls or breaks off before the page arrives", async () => {
    const encoder = new TextEncoder();
    const stalled = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // Headers and the first bytes arrive; the rest never does.
        controller.enqueue(encoder.encode('{"title":"Slow","content":"# Slo'));
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async () => stalled()));
    await expect(
      runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/", timeoutMs: 40 }),
    ).resolves.toEqual({ kind: "failed", reason: "timed out after 40ms", billed: false, attempts: 1 });

    const broken = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"title":"Gone","content":"# Go'));
        controller.error(new TypeError("terminated"));
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async () => broken()));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toEqual({ kind: "failed", reason: "request failed: terminated", billed: false, attempts: 1 });
  });

  it("caps the title and says when it did", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { title: `${"word ".repeat(100_000)}end`, content: "# Page" })));
    const outcome = await runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" });
    expect(outcome.kind).toBe("content");
    if (outcome.kind !== "content") return;
    expect(outcome.titleTruncated).toBe(true);
    expect(outcome.title.length).toBeLessThanOrEqual(DEEPSEEK_FETCH_TITLE_MAX_CHARS);
    expect(outcome.title.endsWith("…")).toBe(true);
    expect(outcome.content).toBe("# Page");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { title: "t".repeat(DEEPSEEK_FETCH_TITLE_MAX_CHARS), content: "# Page" })));
    await expect(runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/" }))
      .resolves.toMatchObject({ title: "t".repeat(DEEPSEEK_FETCH_TITLE_MAX_CHARS), titleTruncated: false });
  });

  it("counts time the caller already spent against the budget", async () => {
    vi.stubGlobal("fetch", pendingUntilAborted());
    const started = Date.now();
    const outcome = await runDeepSeekFetch({
      endpoint: ENDPOINT,
      apiKey: "k",
      url: "https://example.com/",
      timeoutMs: 400,
      // 380 ms of the budget went to resolving the host before the request.
      budgetStartedAt: Date.now() - 380,
    });
    expect(outcome).toEqual({ kind: "failed", reason: "timed out after 400ms", billed: false, attempts: 1 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(deepSeekFetchBudgetMs(undefined)).toBe(30_000);
    expect(deepSeekFetchBudgetMs(500)).toBe(500);
    expect(deepSeekFetchBudgetMs(10_000_000)).toBe(120_000);
    expect(deepSeekFetchBudgetMs(0)).toBe(1);
  });

  it("falls back on its own timeout", async () => {
    vi.stubGlobal("fetch", pendingUntilAborted());
    await expect(
      runDeepSeekFetch({ endpoint: ENDPOINT, apiKey: "k", url: "https://example.com/", timeoutMs: 20 }),
    ).resolves.toEqual({ kind: "failed", reason: "timed out after 20ms", billed: false, attempts: 1 });
  });

  it("propagates the caller's abort instead of falling back", async () => {
    vi.stubGlobal("fetch", pendingUntilAborted());
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const running = runDeepSeekFetch({
      endpoint: ENDPOINT,
      apiKey: "k",
      url: "https://example.com/",
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });

  it("propagates the caller's abort during the retry wait", async () => {
    const fetchMock = vi.fn(async () => deepSeekError(429, "Rate limit reached"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const running = runDeepSeekFetch({
      endpoint: ENDPOINT,
      apiKey: "k",
      url: "https://example.com/",
      signal: controller.signal,
      retryDelayMs: 5_000,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
