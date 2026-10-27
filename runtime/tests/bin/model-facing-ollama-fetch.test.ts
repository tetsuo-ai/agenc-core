import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelFacingTools, __setLiveWebFetchDnsAllLookupForTests } from "../../src/bin/model-facing-tools.js";
import type { Session } from "../../src/session/session.js";
const tool = (overrides = {}) => createModelFacingTools({ workspaceRoot: process.cwd(), env: {}, getSession: () => ({
  services: { provider: { name: "ollama-cloud", config: { apiKey: "session-key", model: "gemma4:31b", ...overrides } } },
}) as unknown as Session }).find(t => t.name === "web_fetch")!;
beforeEach(() => __setLiveWebFetchDnsAllLookupForTests((_host, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }])));
afterEach(() => { __setLiveWebFetchDnsAllLookupForTests(undefined); vi.unstubAllGlobals(); });
describe("Ollama Cloud web fetch", () => {
  it("uses the session key for Ollama's fetch API and accounts for its fee", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ title: "Docs", content: "Readable documentation", links: ["https://example.com/next"] })));
    vi.stubGlobal("fetch", fetch);
    const result = await tool().execute({ url: "https://example.com" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://ollama.com/api/web_fetch");
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-key");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://example.com/" });
    expect(JSON.parse(result.content)).toMatchObject({ content: "Readable documentation", source: "ollama-cloud_web_fetch" });
    expect(tool().admissionEstimate?.({ url: "https://example.com" }).maxCostUsd).toBe(0.001);
    expect(result.admissionUsage?.costUsd).toBe(0.001);
  });
  it("rejects private hosts before delegating to the provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetch);
    expect((await tool().execute({ url: "https://127.0.0.1/private" })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ baseURL: "https://private.example/v1" }, { managedGateway: true }, { apiKey: undefined }])(
    "keeps ordinary fetch for a non-native session %j", async overrides => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("docs")); vi.stubGlobal("fetch", fetch);
      await tool(overrides).execute({ url: "https://example.com" });
      expect(fetch.mock.calls[0]?.[0]).toBe("https://example.com/");
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
    });
  it("falls back to guarded direct fetch after provider failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response("direct text")); vi.stubGlobal("fetch", fetch);
    const result = await tool().execute({ url: "https://example.com" });
    expect(fetch.mock.calls).toHaveLength(2);
    expect(JSON.parse(result.content)).toMatchObject({ content: "direct text", provider_fetch_fallback: expect.any(String) });
  });
});
