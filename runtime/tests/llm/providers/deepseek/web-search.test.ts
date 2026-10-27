import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDeepSeekSearchQuery,
  DEEPSEEK_SEARCH_MAX_QUERY_CHARS,
  DEEPSEEK_SEARCH_SUMMARY_MAX_CHARS,
  deepSeekSearchEndpoint,
  isOfficialDeepSeekApiHost,
  parseDeepSeekSearchResults,
  resolveDeepSeekWebSearchSetting,
  runDeepSeekSearch,
} from "../../../../src/llm/providers/deepseek/web-search.js";

const NO_FILTERS = { allowedDomains: [], blockedDomains: [] } as const;

// Shape recorded from the live API on 2026-10-19 (research/probes/p1-search.json),
// with the long summary shortened.
const LIVE_SHAPED_BODY = {
  results: [
    {
      title: "DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real | DeepSeek API Docs",
      site_name: "DeepSeek",
      site_icon: "https://cdn.deepseek.com/site-icons/deepseek.com",
      authority: 3,
      rerank_score: 2.85,
      date: "2026-10-16T16:00:00+00:00",
      url: "https://api-docs.deepseek.com/news/news261017/",
      summary: "# DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real\n\n## Search & Fetch APIs are now open to everyone!\n\nEach endpoint: $0.75 per 1,000 calls.",
      snippet: "DeepSeek-V4.1-Flash-1017 is here ... Search & Fetch APIs are now open to everyone",
      content: "",
    },
    {
      title: "",
      site_name: null,
      site_icon: null,
      authority: -1,
      rerank_score: 1.2,
      date: null,
      url: "https://example.com/untitled",
      summary: "",
      snippet: "",
      content: "",
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveDeepSeekWebSearchSetting", () => {
  it("lets the session environment win over config, and defaults to auto", () => {
    expect(resolveDeepSeekWebSearchSetting(undefined, undefined)).toBe("auto");
    expect(resolveDeepSeekWebSearchSetting("", undefined)).toBe("auto");
    expect(resolveDeepSeekWebSearchSetting(undefined, true)).toBe("on");
    expect(resolveDeepSeekWebSearchSetting(undefined, false)).toBe("off");
    expect(resolveDeepSeekWebSearchSetting("1", false)).toBe("on");
    expect(resolveDeepSeekWebSearchSetting("on", undefined)).toBe("on");
    expect(resolveDeepSeekWebSearchSetting("0", true)).toBe("off");
    expect(resolveDeepSeekWebSearchSetting("false", undefined)).toBe("off");
    // An unrecognized spelling does not override the configured value.
    expect(resolveDeepSeekWebSearchSetting("maybe", false)).toBe("off");
  });
});

describe("DeepSeek search endpoint", () => {
  it("recognizes only DeepSeek's own HTTPS API host as official", () => {
    expect(isOfficialDeepSeekApiHost("https://api.deepseek.com/v1")).toBe(true);
    expect(isOfficialDeepSeekApiHost("https://api.deepseek.com")).toBe(true);
    expect(isOfficialDeepSeekApiHost("http://api.deepseek.com/v1")).toBe(false);
    expect(isOfficialDeepSeekApiHost("https://api.deepseek.com.evil.test/v1")).toBe(false);
    expect(isOfficialDeepSeekApiHost("http://127.0.0.1:8080/v1")).toBe(false);
    expect(isOfficialDeepSeekApiHost("not a url")).toBe(false);
  });

  it("uses the documented URL on the official host and keeps a proxy's path prefix", () => {
    expect(deepSeekSearchEndpoint("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(deepSeekSearchEndpoint("https://api.deepseek.com/beta/")).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    expect(deepSeekSearchEndpoint("http://127.0.0.1:8080/v1")).toBe(
      "http://127.0.0.1:8080/v1/tools/search",
    );
    expect(deepSeekSearchEndpoint("https://gw.example/deepseek/v1/")).toBe(
      "https://gw.example/deepseek/v1/tools/search",
    );
    expect(deepSeekSearchEndpoint("https://gw.example")).toBe(
      "https://gw.example/v1/tools/search",
    );
    expect(deepSeekSearchEndpoint("ftp://gw.example/v1")).toBeUndefined();
  });
});

describe("buildDeepSeekSearchQuery", () => {
  it("passes a short query through unchanged", () => {
    expect(buildDeepSeekSearchQuery("  DeepSeek   V4.1  release ", NO_FILTERS)).toEqual({
      query: "DeepSeek V4.1 release",
      shortened: false,
    });
  });

  it("keeps a long query within 128 code points, cutting at a word boundary", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const shaped = buildDeepSeekSearchQuery(words, NO_FILTERS);
    expect(shaped.shortened).toBe(true);
    expect(Array.from(shaped.query).length).toBeLessThanOrEqual(DEEPSEEK_SEARCH_MAX_QUERY_CHARS);
    expect(words.startsWith(shaped.query)).toBe(true);
    expect(shaped.query.endsWith(" ")).toBe(false);
    expect(words.charAt(shaped.query.length)).toBe(" ");
  });

  it("counts code points, not UTF-16 units", () => {
    const emoji = "🔍".repeat(128);
    expect(buildDeepSeekSearchQuery(emoji, NO_FILTERS)).toEqual({ query: emoji, shortened: false });
    expect(Array.from(buildDeepSeekSearchQuery(`${emoji}🔍`, NO_FILTERS).query)).toHaveLength(128);
  });

  it("adds site operators for domain filters when they fit", () => {
    expect(
      buildDeepSeekSearchQuery("release notes", {
        allowedDomains: ["github.com", "huggingface.co"],
        blockedDomains: [],
      }).query,
    ).toBe("release notes site:github.com OR site:huggingface.co");
    expect(
      buildDeepSeekSearchQuery("release notes", {
        allowedDomains: [],
        blockedDomains: ["example.com", "spam.test"],
      }).query,
    ).toBe("release notes -site:example.com -site:spam.test");
  });

  it("drops operators that would leave too little room for the words", () => {
    const blocked = Array.from({ length: 8 }, (_, index) => `blocked-domain-${index}.example`);
    const shaped = buildDeepSeekSearchQuery("release notes", {
      allowedDomains: [],
      blockedDomains: blocked,
    });
    expect(shaped).toEqual({ query: "release notes", shortened: false });
  });
});

describe("parseDeepSeekSearchResults", () => {
  it("maps the live response shape to model-facing hits", () => {
    const parsed = parseDeepSeekSearchResults(LIVE_SHAPED_BODY);
    expect(parsed?.resultCount).toBe(2);
    expect(parsed?.hits).toEqual([
      {
        title: "DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real | DeepSeek API Docs",
        url: "https://api-docs.deepseek.com/news/news261017/",
        snippet: "DeepSeek-V4.1-Flash-1017 is here ... Search & Fetch APIs are now open to everyone",
        // Markdown heading marks are dropped and whitespace collapsed.
        summary: "DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real Search & Fetch APIs are now open to everyone! Each endpoint: $0.75 per 1,000 calls.",
        date: "2026-10-16T16:00:00+00:00",
        site: "DeepSeek",
      },
      // No title: the URL stands in. Null and empty fields are omitted.
      { title: "https://example.com/untitled", url: "https://example.com/untitled", snippet: "" },
    ]);
  });

  it("caps long summaries and skips unusable or repeated URLs", () => {
    const long = "word ".repeat(1_000);
    const parsed = parseDeepSeekSearchResults({
      results: [
        { title: "A", url: "https://a.example/", summary: long, snippet: "s" },
        { title: "A again", url: "https://a.example/", snippet: "dup" },
        { title: "Script", url: "javascript:alert(1)", snippet: "x" },
        { title: "No URL", snippet: "x" },
        "not an object",
      ],
    });
    expect(parsed?.resultCount).toBe(5);
    expect(parsed?.hits).toHaveLength(1);
    const summary = parsed?.hits[0]?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(DEEPSEEK_SEARCH_SUMMARY_MAX_CHARS + 1);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("rejects a body without a results array", () => {
    expect(parseDeepSeekSearchResults({ data: [] })).toBeUndefined();
    expect(parseDeepSeekSearchResults(null)).toBeUndefined();
  });
});

describe("runDeepSeekSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the documented request with the session key and reports a billed result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, LIVE_SHAPED_BODY));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await runDeepSeekSearch({
      endpoint: "https://api.deepseek.com/v1/tools/search",
      apiKey: "sk-test-session",
      query: "DeepSeek V4.1 release",
      count: 8,
    });
    expect(outcome.kind).toBe("results");
    expect(outcome.billed).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test-session",
      "content-type": "application/json",
    });
    // Only the model's query and a count: no ori_question, localization or content.
    expect(JSON.parse(String(init.body))).toEqual({ query: "DeepSeek V4.1 release", count: 8 });
  });

  it("clamps count to the API range", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await runDeepSeekSearch({ endpoint: "https://api.deepseek.com/v1/tools/search", apiKey: "k", query: "q", count: 0 });
    await runDeepSeekSearch({ endpoint: "https://api.deepseek.com/v1/tools/search", apiKey: "k", query: "q", count: 99 });
    const counts = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).count,
    );
    expect(counts).toEqual([1, 50]);
  });

  it("treats an empty results array as unbilled and empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { results: [] })));
    await expect(
      runDeepSeekSearch({ endpoint: "https://api.deepseek.com/v1/tools/search", apiKey: "k", query: "q", count: 3 }),
    ).resolves.toEqual({ kind: "empty", billed: false });
  });

  it("turns DeepSeek errors into a short unbilled fallback reason without the request id or key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(402, {
          error: {
            message: "Insufficient Balance for sk-test-session (request_id: 7e1c-42)",
            type: "unknown_error",
            param: null,
            code: "invalid_request_error",
          },
        }),
      ),
    );
    await expect(
      runDeepSeekSearch({ endpoint: "https://api.deepseek.com/v1/tools/search", apiKey: "sk-test-session", query: "q", count: 3 }),
    ).resolves.toEqual({
      kind: "failed",
      reason: "HTTP 402: Insufficient Balance for [redacted]",
      billed: false,
    });
  });

  it("reports a host without the Search API, a malformed body and a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not found</html>", { status: 404 })));
    await expect(
      runDeepSeekSearch({ endpoint: "http://127.0.0.1:1/v1/tools/search", apiKey: "k", query: "q", count: 3 }),
    ).resolves.toEqual({ kind: "failed", reason: "HTTP 404", billed: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not json", { status: 200 })));
    await expect(
      runDeepSeekSearch({ endpoint: "https://api.deepseek.com/v1/tools/search", apiKey: "k", query: "q", count: 3 }),
    ).resolves.toEqual({ kind: "failed", reason: "malformed response", billed: false });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(
      runDeepSeekSearch({ endpoint: "https://api.deepseek.com/v1/tools/search", apiKey: "k", query: "q", count: 3 }),
    ).resolves.toEqual({ kind: "failed", reason: "request failed: fetch failed", billed: false });
  });

  it("falls back on its own timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );
    await expect(
      runDeepSeekSearch({
        endpoint: "https://api.deepseek.com/v1/tools/search",
        apiKey: "k",
        query: "q",
        count: 3,
        timeoutMs: 20,
      }),
    ).resolves.toEqual({ kind: "failed", reason: "timed out after 20ms", billed: false });
  });

  it("propagates the caller's abort instead of falling back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const running = runDeepSeekSearch({
      endpoint: "https://api.deepseek.com/v1/tools/search",
      apiKey: "k",
      query: "q",
      count: 3,
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });
});
