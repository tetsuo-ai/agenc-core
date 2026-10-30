import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import { ResultLine } from "./components/v2/primitives.js";
import { WebFetchResultView } from "./tool-rendering.js";

interface ChildElement {
  readonly props: { readonly children?: unknown; readonly dimColor?: boolean };
}

function texts(node: unknown): unknown[] {
  if (!node || typeof node !== "object") return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  const list = (Array.isArray(children) ? children : [children]).flat(Infinity);
  return list.flatMap((child) => {
    if (typeof child !== "object" || child === null) return [];
    const element = child as ChildElement;
    return typeof element.props.children === "string"
      ? [element.props.children]
      : texts(element);
  });
}

const deepseekResult = JSON.stringify({
  source: "deepseek_fetch",
  provider: "deepseek",
  title: "Example Domain",
  ok: true,
  url: "https://example.com/",
  preapproved: false,
  rendered_as: "markdown",
  truncated: false,
  content: "# Example Domain\n\nThis domain is for use in documentation examples.",
});

describe("WebFetchResultView", () => {
  test("shows one line naming DeepSeek's fetch, and the page in verbose", () => {
    const compact = WebFetchResultView({ content: deepseekResult }) as unknown as {
      readonly type: unknown;
      readonly props: { readonly children?: unknown };
    };
    expect(compact.type).toBe(ResultLine);
    expect(compact.props.children).toBe("3 lines via DeepSeek fetch");

    expect(texts(WebFetchResultView({ content: deepseekResult, verbose: true }))).toEqual([
      "3 lines via DeepSeek fetch",
      "Example Domain",
      "  https://example.com/",
      deepseekResult,
    ]);
  });

  test("says why DeepSeek's fetch fell back to the local fetcher", () => {
    const content = JSON.stringify({
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
    const compact = WebFetchResultView({ content }) as unknown as {
      readonly props: { readonly children?: unknown };
    };
    expect(compact.props.children).toBe(
      "5 lines via local fetch (DeepSeek fetch: HTTP 404: failed to fetch URL)",
    );
  });
});
