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
import { WebSearchResultsView } from "./tool-rendering.js";

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
  query: "DeepSeek V4.1 Flash 1017",
  source: "deepseek_search",
  provider: "deepseek",
  results: [
    { title: "DeepSeek API Docs", url: "https://api-docs.deepseek.com/news/news261017/", snippet: "s" },
    { title: "Vercel changelog", url: "https://vercel.com/changelog", snippet: "s" },
  ],
});

describe("WebSearchResultsView", () => {
  test("shows one line naming the search, and the sources in verbose", () => {
    const compact = WebSearchResultsView({ content: deepseekResult }) as unknown as {
      readonly type: unknown;
      readonly props: { readonly children?: unknown };
    };
    expect(compact.type).toBe(ResultLine);
    expect(compact.props.children).toBe("2 results via DeepSeek search");

    expect(texts(WebSearchResultsView({ content: deepseekResult, verbose: true }))).toEqual([
      "2 results via DeepSeek search",
      "DeepSeek API Docs",
      "  https://api-docs.deepseek.com/news/news261017/",
      "Vercel changelog",
      "  https://vercel.com/changelog",
    ]);
  });

  test("says why DeepSeek's search fell back", () => {
    const content = JSON.stringify({
      query: "q",
      source: "duckduckgo_instant_answer",
      results: [],
      deepseek_search_fallback: "timed out after 30s",
    });
    const compact = WebSearchResultsView({ content }) as unknown as {
      readonly props: { readonly children?: unknown };
    };
    expect(compact.props.children).toBe(
      "no results via DuckDuckGo (DeepSeek search: timed out after 30s)",
    );
  });
});
