/**
 * WebSearch with an Ollama Cloud, OpenRouter or Venice session's own key
 * (jobs/pv owner request, 2026-10-20): the session's provider searches first,
 * with its own key only, and records the charge; a failure falls through to
 * the configured chain and says why.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import type { Session } from "../../src/session/session.js";
import { summarizeWebSearchResult } from "../../src/tui/tool-result-routing.js";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const session = (name: string, config: Record<string, unknown>) =>
  ({ services: { provider: { name, config } } }) as unknown as Session;
const webSearch = (s: Session, env: Record<string, string> = {}) =>
  createModelFacingTools({ workspaceRoot: process.cwd(), getSession: () => s, env }).find(t => t.name === "WebSearch")!;
afterEach(() => vi.unstubAllGlobals());

describe("WebSearch with the session provider's own search", () => {
  it("Ollama Cloud: Ollama's web search API with the session key, 0.008 USD per request", async () => {
    const fetch = vi.fn(async () => response({ results: [
      { title: "Ollama web search", url: "https://ollama.com/blog/web-search", content: "A new web search API is now available." },
    ] }));
    vi.stubGlobal("fetch", fetch);
    const search = webSearch(session("ollama-cloud", { apiKey: "ollama-session", baseURL: "https://ollama.com/v1", model: "deepseek-v4.1-flash" }),
      { OPENROUTER_API_KEY: "independent", VENICE_API_KEY: "independent" });
    expect(search.admissionEstimate?.({ query: "ollama", max_results: 3 }).maxCostUsd).toBe(0.008);
    const result = await search.execute({ query: "ollama web search", max_results: 3 });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ollama.com/api/web_search");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ollama-session");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({ query: "ollama web search", max_results: 3 });
    expect(JSON.parse(result.content)).toMatchObject({
      source: "ollama-cloud_web_search", provider: "ollama-cloud",
      results: [{ title: "Ollama web search", url: "https://ollama.com/blog/web-search" }],
    });
    expect(result.admissionUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0.008 });
    expect(summarizeWebSearchResult(result.content)).toMatchObject({ source: "Ollama web search" });
  });

  // Authenticated Ollama /api/usage receipts on 2026-10-21: one result
  // costs $0.006 and eight cost $0.013. A flat $0.008 under-reserves the default.
  it.each([
    { requested: 1, sent: 1, cost: 0.006 },
    { requested: 8, sent: 8, cost: 0.013 },
    { requested: undefined, sent: 8, cost: 0.013 },
    { requested: 100, sent: 8, cost: 0.013 },
    { requested: 0, sent: 1, cost: 0.006 },
  ])("Ollama reserves and records the fee for $requested results", async ({ requested, sent, cost }) => {
    const fetch = vi.fn(async () => response({ results: Array.from({ length: sent }, (_, i) => ({
      title: `Result ${i}`, url: `https://example.org/${i}`, content: "Search result",
    })) }));
    vi.stubGlobal("fetch", fetch);
    const search = webSearch(session("ollama-cloud", { apiKey: "ollama-session", model: "deepseek-v4-pro:0813" }));
    const args = { query: "Ollama API documentation", ...(requested === undefined ? {} : { max_results: requested }) };
    expect(search.admissionEstimate?.(args).maxCostUsd).toBeCloseTo(cost, 9);
    const result = await search.execute(args);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_results).toBe(sent);
    expect(result.admissionUsage?.costUsd).toBeCloseTo(cost, 9);
  });

  it("reserves the ten-result provider request used before domain filtering", async () => {
    const fetch = vi.fn(async () => response({ results: [
      { title: "Allowed", url: "https://example.org/a", content: "x" },
    ] }));
    vi.stubGlobal("fetch", fetch);
    const search = webSearch(session("ollama-cloud", { apiKey: "ollama-session", model: "deepseek-v4-pro:0813" }));
    const args = { query: "docs", max_results: 1, allowed_domains: ["example.org"] };
    expect(search.admissionEstimate?.(args).maxCostUsd).toBeCloseTo(0.015, 9);
    const result = await search.execute(args);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_results).toBe(10);
    expect(result.admissionUsage?.costUsd).toBeCloseTo(0.015, 9);
  });

  it("OpenRouter: the web plugin on the session model, its url_citation results and reported cost", async () => {
    const fetch = vi.fn(async () => response({
      choices: [{ message: { role: "assistant", content: "x", annotations: [
        { type: "url_citation", url_citation: { url: "https://nodejs.org/en/blog/release", title: "Node.js releases", content: "Node.js 26 ..." } },
      ] } }],
      usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.0074 },
    }));
    vi.stubGlobal("fetch", fetch);
    const result = await webSearch(session("openrouter", { apiKey: "sk-or-session", model: "z-ai/glm-5.3-flash" }))
      .execute({ query: "latest Node.js release", blocked_domains: ["reddit.com"] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-or-session");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "z-ai/glm-5.3-flash", plugins: [{ id: "web", engine: "exa", exclude_domains: ["reddit.com"] }], usage: { include: true },
    });
    expect(JSON.parse(result.content)).toMatchObject({ source: "openrouter_web_search", results: [{ url: "https://nodejs.org/en/blog/release" }] });
    expect(result.admissionUsage?.costUsd).toBe(0.0074);
  });

  it("OpenRouter: the search call asks for zero data retention when the session does", async () => {
    const reply = () => response({ choices: [{ message: { role: "assistant", content: "x", annotations: [] } }], usage: { cost: 0.007 } });
    const fetch = vi.fn(async () => reply());
    vi.stubGlobal("fetch", fetch);
    await webSearch(session("openrouter", { apiKey: "sk-or-session", model: "z-ai/glm-5.3", zeroDataRetention: true }))
      .execute({ query: "zero data retention" });
    await webSearch(session("openrouter", { apiKey: "sk-or-session", model: "z-ai/glm-5.3" }))
      .execute({ query: "zero data retention" });
    const bodies = (fetch.mock.calls as unknown as [string, RequestInit][])
      .filter(([url]) => url === "https://openrouter.ai/api/v1/chat/completions")
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ provider: { zdr: true }, plugins: [{ id: "web", engine: "exa" }] });
    // A session that turned it off sends none, like its own requests.
    expect(bodies[1]).not.toHaveProperty("provider");
  });

  it("Venice: web search with citations on the session model, 0.01 USD plus its listed token price", async () => {
    const fetch = vi.fn(async () => response({
      choices: [{ message: { role: "assistant", content: "x" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 10 },
      venice_parameters: { web_search_citations: [{ title: "Paris weather", url: "https://weather.example/paris", content: "57F overcast" }] },
    }));
    vi.stubGlobal("fetch", fetch);
    const result = await webSearch(session("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" }))
      .execute({ query: "weather in Paris today" });
    // The Venice media tools read Venice's model list too; the search is the chat call.
    const [url, init] = fetch.mock.calls.find(c => String(c[0]).endsWith("/chat/completions")) as unknown as [string, RequestInit];
    expect(url).toBe("https://api.venice.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer venice-session");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "zai-org-glm-5-2", venice_parameters: { enable_web_search: "on", enable_web_citations: true },
    });
    expect(JSON.parse(result.content)).toMatchObject({ source: "venice_web_search", results: [{ url: "https://weather.example/paris" }] });
    // zai-org-glm-5-2 lists 1.4 / 4.4 USD per million tokens in the bundled snapshot.
    expect(result.admissionUsage?.costUsd).toBeCloseTo(0.01 + 1000 * 1.4e-6 + 10 * 4.4e-6, 9);
  });

  it("falls through to the chain when the provider search fails, says why, and never uses another provider's key", async () => {
    const fetch = vi.fn(async (input: string) => input.includes("ollama.com")
      ? response({ error: "unauthorized" }, 401)
      : new Response('<a class="result__a" href="https://example.org/a">Example</a>'));
    vi.stubGlobal("fetch", fetch);
    const result = await webSearch(session("ollama-cloud", { apiKey: "ollama-session", baseURL: "https://ollama.com/v1", model: "kimi-k3" }),
      { OPENROUTER_API_KEY: "independent" }).execute({ query: "news" });
    const hosts = fetch.mock.calls.map(c => new URL(String(c[0])).hostname);
    expect(hosts).toEqual(["ollama.com", "html.duckduckgo.com"]);
    for (const call of fetch.mock.calls) {
      expect(new Headers((call[1] as RequestInit | undefined)?.headers).get("authorization") ?? "").not.toContain("independent");
    }
    expect(JSON.parse(result.content)).toMatchObject({ source: "duckduckgo_html", provider_search_fallback: expect.stringContaining("401") });
  });

  it("has no provider search on the managed route, without a key, or when a search provider is named", async () => {
    const fetch = vi.fn(async () => new Response('<a class="result__a" href="https://example.org/a">Example</a>'));
    vi.stubGlobal("fetch", fetch);
    const managed = session("openrouter", { apiKey: "agenc-managed", model: "openrouter/deepseek/deepseek-v4.1-flash", managedGateway: true });
    await webSearch(managed).execute({ query: "news" });
    await webSearch(session("venice", { model: "zai-org-glm-5-2" })).execute({ query: "news" });
    await webSearch(session("ollama-cloud", { apiKey: "k", baseURL: "https://ollama.com/v1", model: "kimi-k3" }), { WEB_SEARCH_PROVIDER: "ddg" })
      .execute({ query: "news" });
    const searched = fetch.mock.calls.map(c => String(c[0])).filter(url => !url.endsWith("/models?type=all"));
    expect(searched.map(url => new URL(url).hostname)).toEqual(["html.duckduckgo.com", "html.duckduckgo.com", "html.duckduckgo.com"]);
  });
});
