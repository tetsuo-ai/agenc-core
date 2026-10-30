import { describe, expect, test } from "vitest";

import {
  pickToolResultDispatch,
  resultTextForTuiTool,
  summarizeWebFetchResult,
  summarizeWebSearchResult,
  webFetchResultLine,
} from "./tool-result-routing.js";

describe("pickToolResultDispatch — TUI tool routing", () => {
  test("system.bash with <bash-stdout> envelope routes to bash-output-view", () => {
    const target = pickToolResultDispatch(
      "system.bash",
      "<bash-stdout>hello</bash-stdout>[exit_code=0]",
    );
    expect(target).toBe("bash-output-view");
  });

  test("system.bash with empty <bash-stdout></bash-stdout> envelope still routes to bash-output-view (silent successful command)", () => {
    const target = pickToolResultDispatch(
      "system.bash",
      "<bash-stdout></bash-stdout>[exit_code=0]",
    );
    expect(target).toBe("bash-output-view");
  });

  test("historical Bash transcript envelopes remain renderable", () => {
    expect(
      pickToolResultDispatch("Bash", "<bash-stdout>old</bash-stdout>"),
    ).toBe("bash-output-view");
  });

  test("Bash tool with no envelope (legacy plain string) falls through to generic — guards the renderer's tag extraction against null", () => {
    const target = pickToolResultDispatch("Bash", "raw legacy string");
    expect(target).toBe("generic");
  });

  test("Bash tool with empty content falls through to generic", () => {
    const target = pickToolResultDispatch("Bash", "");
    expect(target).toBe("generic");
  });

  test("Bash dispatch is exact-case — lowercase 'bash' does NOT route to bash-output-view", () => {
    const target = pickToolResultDispatch(
      "bash",
      "<bash-stdout>hello</bash-stdout>",
    );
    expect(target).toBe("generic");
  });

  test("Unknown tool name with content that happens to contain <bash-stdout> does NOT route to bash-output-view (no substring or prefix matching across tool names)", () => {
    const target = pickToolResultDispatch(
      "XYZUnknown",
      "<bash-stdout>hello</bash-stdout>",
    );
    expect(target).toBe("generic");
  });

  test("Empty tool name does not throw and routes to generic", () => {
    const target = pickToolResultDispatch("", "<bash-stdout>x</bash-stdout>");
    expect(target).toBe("generic");
  });

  test("Edit tool with <edit-diff> envelope routes to edit-diff-view", () => {
    const target = pickToolResultDispatch(
      "Edit",
      "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a\n+new</edit-diff>",
    );
    expect(target).toBe("edit-diff-view");
  });

  test("Edit tool without <edit-diff> envelope (legacy / error-path payload) falls through to generic", () => {
    const target = pickToolResultDispatch("Edit", "raw error string");
    expect(target).toBe("generic");
  });

  test("Edit dispatch is exact-case — lowercase 'edit' does NOT route to edit-diff-view", () => {
    const target = pickToolResultDispatch(
      "edit",
      "<edit-diff>diff</edit-diff>",
    );
    expect(target).toBe("generic");
  });

  test("Bash and Edit envelope tags do not cross-route — Edit tool with <bash-stdout> routes to generic, Bash tool with <edit-diff> routes to generic", () => {
    expect(
      pickToolResultDispatch("Edit", "<bash-stdout>x</bash-stdout>"),
    ).toBe("generic");
    expect(pickToolResultDispatch("Bash", "<edit-diff>x</edit-diff>")).toBe(
      "generic",
    );
  });

  test("FileRead with <read-content> envelope routes to file-read-view (live tool name is 'FileRead', NOT 'Read')", () => {
    expect(
      pickToolResultDispatch("FileRead", "<read-content>body</read-content>"),
    ).toBe("file-read-view");
  });

  test("'Read' (the old wrong pre-seed name) does NOT route to file-read-view — even with the correct envelope (canonicalization fix)", () => {
    expect(
      pickToolResultDispatch("Read", "<read-content>body</read-content>"),
    ).toBe("generic");
  });

  test("Write with <write-summary> envelope routes to file-write-view", () => {
    expect(
      pickToolResultDispatch("Write", "<write-summary>Wrote 42 bytes</write-summary>"),
    ).toBe("file-write-view");
  });

  test("Grep with <grep-matches> envelope routes to grep-matches-view", () => {
    expect(
      pickToolResultDispatch("Grep", "<grep-matches>file:1:hit</grep-matches>"),
    ).toBe("grep-matches-view");
  });

  test("Glob with <glob-paths> envelope routes to glob-paths-view", () => {
    expect(
      pickToolResultDispatch("Glob", "<glob-paths>src/foo.ts</glob-paths>"),
    ).toBe("glob-paths-view");
  });

  test("Tool error envelope dispatches to tool-error-view regardless of tool name (cross-cutting error channel)", () => {
    expect(
      pickToolResultDispatch("Bash", "<tool-error>permission denied</tool-error>"),
    ).toBe("tool-error-view");
    expect(
      pickToolResultDispatch("XYZUnknown", "<tool-error>boom</tool-error>"),
    ).toBe("tool-error-view");
    expect(
      pickToolResultDispatch("FileRead", "<tool-error>not found</tool-error>"),
    ).toBe("tool-error-view");
  });

  test("Tool error envelope takes precedence over per-tool envelope when both are present (defensive ordering)", () => {
    expect(
      pickToolResultDispatch(
        "Bash",
        "<bash-stdout>x</bash-stdout><tool-error>but also failed</tool-error>",
      ),
    ).toBe("tool-error-view");
  });

  test("Per-tool envelope dispatch is exact-case for every routed tool (FileRead/Write/Grep/Glob lowercase variants all fall through to generic)", () => {
    expect(
      pickToolResultDispatch("fileread", "<read-content>x</read-content>"),
    ).toBe("generic");
    expect(
      pickToolResultDispatch("write", "<write-summary>x</write-summary>"),
    ).toBe("generic");
    expect(pickToolResultDispatch("grep", "<grep-matches>x</grep-matches>")).toBe(
      "generic",
    );
    expect(pickToolResultDispatch("glob", "<glob-paths>x</glob-paths>")).toBe(
      "generic",
    );
  });

  test("Cross-routing: every per-tool envelope on a non-matching tool name routes to generic", () => {
    expect(
      pickToolResultDispatch("FileRead", "<bash-stdout>x</bash-stdout>"),
    ).toBe("generic");
    expect(
      pickToolResultDispatch("Bash", "<read-content>x</read-content>"),
    ).toBe("generic");
    expect(
      pickToolResultDispatch("Edit", "<glob-paths>x</glob-paths>"),
    ).toBe("generic");
  });
});

describe("resultTextForTuiTool — content shape coercion", () => {
  test("returns strings unchanged", () => {
    expect(resultTextForTuiTool("hello")).toBe("hello");
  });

  test("joins arrays with newlines (recursive)", () => {
    expect(resultTextForTuiTool(["a", "b", "c"])).toBe("a\nb\nc");
  });

  test("flattens the structured-content-block array shape (the shape formatStructuredToolResult produces) by joining .text fields with newlines", () => {
    const blocks = [
      { type: "text", text: "<bash-stdout>line</bash-stdout>" },
      { type: "text", text: "[exit_code=0]" },
    ];
    expect(resultTextForTuiTool(blocks)).toBe(
      "<bash-stdout>line</bash-stdout>\n[exit_code=0]",
    );
  });

  test("extracts the .content field of an object-shaped result", () => {
    expect(resultTextForTuiTool({ content: "extracted" })).toBe("extracted");
  });

  test("falls back to short JSON for arbitrary objects", () => {
    expect(resultTextForTuiTool({ foo: 1, bar: "baz" })).toContain("baz");
  });

  test("never throws on null", () => {
    expect(() => resultTextForTuiTool(null)).not.toThrow();
  });

  test("never throws on undefined", () => {
    expect(() => resultTextForTuiTool(undefined)).not.toThrow();
  });

  test("never throws on a circular-reference object — short JSON has no infinite recursion path", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => resultTextForTuiTool(cyc)).not.toThrow();
  });
});

describe("WebSearch results in the TUI", () => {
  const deepseek = JSON.stringify({
    query: "DeepSeek V4.1",
    source: "deepseek_search",
    provider: "deepseek",
    results: [
      { title: "DeepSeek API Docs", url: "https://api-docs.deepseek.com/news/news261017/", snippet: "s" },
      { title: " ", url: "https://vercel.com/changelog", snippet: "s" },
    ],
  });

  test("routes the live JSON result to the web search view, anything else to generic", () => {
    expect(pickToolResultDispatch("WebSearch", deepseek)).toBe("web-search-view");
    expect(pickToolResultDispatch("WebSearch", JSON.stringify({ error: "query is required" }))).toBe("generic");
    expect(pickToolResultDispatch("WebSearch", "Web search results for query")).toBe("generic");
    expect(pickToolResultDispatch("web_fetch", deepseek)).toBe("generic");
  });

  test("names the search that answered and lists its sources", () => {
    expect(summarizeWebSearchResult(deepseek)).toEqual({
      source: "DeepSeek search",
      results: [
        { title: "DeepSeek API Docs", url: "https://api-docs.deepseek.com/news/news261017/" },
        { title: "https://vercel.com/changelog", url: "https://vercel.com/changelog" },
      ],
    });
    expect(
      summarizeWebSearchResult(JSON.stringify({
        query: "q",
        source: "duckduckgo_html",
        results: [{ title: "Fallback", url: "https://fallback.example/" }],
        deepseek_search_fallback: "HTTP 402: Insufficient Balance",
      })),
    ).toEqual({
      source: "DuckDuckGo",
      results: [{ title: "Fallback", url: "https://fallback.example/" }],
      deepseekFallback: "HTTP 402: Insufficient Balance",
    });
    expect(summarizeWebSearchResult(JSON.stringify({ source: "grok_web_search", results: [] }))?.source)
      .toBe("Grok web search");
    expect(
      summarizeWebSearchResult(JSON.stringify({ source: "https://searx.local:8443/search", kind: "searxng", results: [] }))?.source,
    ).toBe("searx.local:8443");
  });
});

describe("web_fetch results in the TUI", () => {
  const deepseek = JSON.stringify({
    source: "deepseek_fetch",
    provider: "deepseek",
    title: "Example Domain",
    ok: true,
    url: "https://example.com/",
    preapproved: false,
    rendered_as: "markdown",
    truncated: false,
    content: "# Example Domain\n\nThis domain is for use in documentation examples.\n",
  });
  const fallback = JSON.stringify({
    deepseek_fetch_fallback: "HTTP 404: failed to fetch URL",
    status: 200,
    ok: true,
    url: "https://news.ycombinator.com/rss",
    final_url: "https://news.ycombinator.com/rss",
    content_type: "application/rss+xml",
    preapproved: false,
    rendered_as: "passthrough",
    truncated: false,
    content: "<rss>\n<channel>\n<title>Hacker News</title>\n</channel>\n</rss>",
  });
  const local = JSON.stringify({
    status: 200,
    ok: true,
    url: "https://example.com/",
    final_url: "https://example.com/",
    content_type: "text/html",
    preapproved: false,
    rendered_as: "markdown",
    truncated: false,
    content: "page",
  });

  test("routes a result DeepSeek's fetch answered or fell back from to the web fetch view", () => {
    expect(pickToolResultDispatch("web_fetch", deepseek)).toBe("web-fetch-view");
    expect(pickToolResultDispatch("web_fetch", fallback)).toBe("web-fetch-view");
    // Without DeepSeek in the picture the row stays as it was.
    expect(pickToolResultDispatch("web_fetch", local)).toBe("generic");
    expect(pickToolResultDispatch("web_fetch", "not json")).toBe("generic");
    expect(pickToolResultDispatch("WebSearch", deepseek)).toBe("generic");
  });

  test("says which fetch answered, how much came back, and why DeepSeek's fetch fell back", () => {
    const fromDeepSeek = summarizeWebFetchResult(deepseek)!;
    expect(fromDeepSeek).toEqual({
      source: "DeepSeek fetch",
      lines: 3,
      extracted: false,
      title: "Example Domain",
      url: "https://example.com/",
    });
    expect(webFetchResultLine(fromDeepSeek)).toBe("3 lines via DeepSeek fetch");

    expect(webFetchResultLine(summarizeWebFetchResult(fallback)!)).toBe(
      "5 lines via local fetch (DeepSeek fetch: HTTP 404: failed to fetch URL)",
    );
    expect(webFetchResultLine(summarizeWebFetchResult(JSON.stringify({
      source: "deepseek_fetch",
      ok: true,
      url: "https://example.com/",
      prompt: "Which version?",
      extracted: "Version 9.9.9.",
      content_preview: "...",
    }))!)).toBe("1 line extracted via DeepSeek fetch");
    expect(webFetchResultLine(summarizeWebFetchResult(JSON.stringify({
      deepseek_fetch_fallback: "HTTP 404: failed to fetch URL",
      status: 204,
      ok: true,
      url: "https://httpbin.org/status/204",
      content: "",
    }))!)).toBe("no content via local fetch (DeepSeek fetch: HTTP 404: failed to fetch URL)");
    expect(webFetchResultLine(summarizeWebFetchResult(JSON.stringify({
      deepseek_fetch_fallback: "timed out after 30s",
      status: 503,
      ok: false,
      url: "https://example.com/",
      content: "busy",
    }))!)).toBe("HTTP 503 via local fetch (DeepSeek fetch: timed out after 30s)");
    expect(webFetchResultLine(summarizeWebFetchResult(JSON.stringify({
      deepseek_fetch_fallback: "HTTP 402: Insufficient Balance",
      error: "fetch failed: getaddrinfo ENOTFOUND",
    }))!)).toBe("fetch failed: getaddrinfo ENOTFOUND (DeepSeek fetch: HTTP 402: Insufficient Balance)");
  });
});
