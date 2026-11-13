import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createModelFacingTools, __setLiveWebFetchDnsAllLookupForTests } from "../../src/bin/model-facing-tools.js";
import { readLocalByokCredential } from "../../src/auth/native-credentials.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import type { ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import type { Session } from "../../src/session/session.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { resolveStandaloneDeepSeek } from "../../src/tools/system/deepseek-standalone.js";
import { frameUntrustedToolResultContent } from "../../src/tools/untrusted-tool-result-framing.js";
import { attachToolRuntimeContext } from "../../src/tools/runtimes/context.js";

vi.mock("../../src/auth/native-credentials.js", () => ({ readLocalByokCredential: vi.fn() }));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../llm/providers/deepseek/fixtures/standalone-${name}.json`, import.meta.url), "utf8"));
const home = resolveHomeContext({ AGENC_HOME: "/tmp/standalone-test-home" }, { platformHome: "/tmp" });
let environment: Record<string, string | undefined>;
let config: Record<string, unknown>;
let permission = createEmptyToolPermissionContext();
let session: Session;
function tool(name: string) {
  return createModelFacingTools({ workspaceRoot: "/tmp", getSession: () => session, env: {}, toolsConfig: config }).find(t => t.name === name)!;
}
beforeEach(() => {
  environment = { DEEPSEEK_API_KEY: "independent-key" };
  config = { web_search_provider: "deepseek", web_fetch_provider: "deepseek" };
  permission = createEmptyToolPermissionContext();
  session = { services: {
    provider: { name: "ollama", config: { apiKey: "reasoning-key", baseURL: "http://localhost:11434" } },
    providerService: { environment: () => environment, credentialHome: () => home },
    configStore: { current: () => ({ tools_config: config }) },
  }, permissionModeRegistry: { current: () => permission } } as unknown as Session;
  __setLiveWebFetchDnsAllLookupForTests((_host, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }]));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); __setLiveWebFetchDnsAllLookupForTests(undefined); });

describe("standalone web tools", () => {
  test.each(["ollama", "openrouter"])("searches with independent credentials for %s and records its fee", async provider => {
    Object.assign(session.services.provider!, { name: provider });
    const transport = vi.fn(async () => Response.json(fixture("search"))); vi.stubGlobal("fetch", transport);
    const search = tool("WebSearch");
    expect(search.admissionEstimate!({ query: "DeepSeek" }).maxCostUsd).toBe(0.00075);
    const result = await search.execute({ query: "DeepSeek", max_results: 1 });
    expect(result.admissionUsage?.costUsd).toBe(0.00075);
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ source: "deepseek_search", provider: "deepseek" });
    expect(payload.results[0].url).toBe(fixture("search").results[0].url);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer independent-key");
    expect(JSON.parse(String(init.body))).toEqual({ query: "DeepSeek", count: 1 });
    expect(frameUntrustedToolResultContent("WebSearch", result.content)).toContain("UNTRUSTED TOOL RESULT DATA");
  });
  test("uses the normal saved DeepSeek credential when its environment key is absent", async () => {
    environment = {};
    vi.mocked(readLocalByokCredential).mockReturnValue({ apiKey: "saved-key" } as never);
    const transport = vi.fn(async () => Response.json(fixture("search"))); vi.stubGlobal("fetch", transport);
    await tool("WebSearch").execute({ query: "test" });
    expect(readLocalByokCredential).toHaveBeenCalledWith(home, "deepseek");
    expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: "Bearer saved-key" });
  });
  test("does not borrow the reasoning key or fall through when the selected backend lacks a key", async () => {
    environment = {}; vi.mocked(readLocalByokCredential).mockReturnValue(undefined);
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const result = await tool("WebSearch").execute({ query: "private query" });
    expect(result.isError).toBe(true); expect(result.admissionUsage?.costUsd).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
  test("empty searches are free and filtered paid searches retain their fee without fallback", async () => {
    const transport = vi.fn(async () => Response.json({ results: [] })); vi.stubGlobal("fetch", transport);
    expect((await tool("WebSearch").execute({ query: "test" })).admissionUsage?.costUsd).toBe(0);
    transport.mockImplementation(async () => Response.json(fixture("search")));
    const result = await tool("WebSearch").execute({ query: "test", allowed_domains: ["unmatched.invalid"] });
    expect(JSON.parse(result.content).results).toEqual([]); expect(result.admissionUsage?.costUsd).toBe(0.00075);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  test("an explicit selection overrides a configured generic endpoint and suppresses provider search", async () => {
    environment.AGENC_WEB_SEARCH_ENDPOINT = "https://other.invalid/search";
    const transport = vi.fn(async () => Response.json(fixture("search"))); vi.stubGlobal("fetch", transport);
    await tool("WebSearch").execute({ query: "test" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("https://api.deepseek.com/v1/tools/search");
  });
  test("Fetch asks before handing the URL and redirects to DeepSeek, and records the fee", async () => {
    const transport = vi.fn(async () => Response.json(fixture("fetch"))); vi.stubGlobal("fetch", transport);
    const fetchTool = tool("web_fetch");
    const input = { url: "https://example.com/" };
    const context = { session, getAppState: () => ({ toolPermissionContext: permission }) } as ToolEvaluatorContext;
    const decision = await fetchTool.checkPermissions!(input, context);
    expect(decision.behavior).toBe("ask"); expect(decision.message).toContain("DeepSeek");
    expect(fetchTool.admissionEstimate!(input).maxCostUsd).toBe(0.00075);
    const result = await fetchTool.execute(input);
    expect(result.admissionUsage?.costUsd).toBe(0.00075);
    expect(JSON.parse(result.content)).toMatchObject({ provider: "deepseek", url: input.url, title: "Example Domain" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("Fetch refuses nonpublic DNS and has no external fallback on backend errors", async () => {
    const transport = vi.fn(async () => Response.json({ error: { message: "private data" } }, { status: 401 })); vi.stubGlobal("fetch", transport);
    const result = await tool("web_fetch").execute({ url: "https://example.com/" });
    expect(result.isError).toBe(true); expect(result.admissionUsage?.costUsd).toBe(0); expect(result.content).not.toContain("private data");
    __setLiveWebFetchDnsAllLookupForTests((_host, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]));
    expect((await tool("web_fetch").execute({ url: "https://private.example.com/" })).isError).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("new routes remain off without configuration", async () => {
    config = {}; environment.AGENC_WEB_SEARCH_ENDPOINT = "https://configured.invalid/search";
    const transport = vi.fn(async () => Response.json({ results: [] })); vi.stubGlobal("fetch", transport);
    await tool("WebSearch").execute({ query: "test" });
    expect(transport.mock.calls.every(args => !String(args[0]).includes("deepseek"))).toBe(true);
  });
  test("a child never borrows its parent's opt-in, credentials, or transport", async () => {
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const args = { query: "child" };
    const child = { services: {} } as unknown as Session;
    attachToolRuntimeContext(args, { callId: "child-call", toolName: "WebSearch", sandboxMode: "workspace_write", invocation: { session: child } } as never);
    const result = await tool("WebSearch").execute(args);
    expect(result.isError).toBe(true); expect(transport).not.toHaveBeenCalled();
  });
  test.each(["WebSearch", "web_fetch"])("%s refuses an unreserved switch to a paid backend", async name => {
    config = { web_fetch_provider: "local" };
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    const selected = tool(name);
    const args = name === "WebSearch" ? { query: "test" } : { url: "https://example.com/" };
    attachToolRuntimeContext(args, { callId: `paid-${name}`, toolName: name, sandboxMode: "workspace_write", invocation: { session } } as never);
    expect(selected.admissionEstimate!(args).maxCostUsd).toBe(0);
    config = { web_fetch_provider: "deepseek", web_search_provider: "deepseek" };
    const result = await selected.execute(args);
    expect(result.isError).toBe(true); expect(result.content).toContain("not admitted");
    expect(transport).not.toHaveBeenCalled();
  });
  test("rejects unsafe configured tool endpoints without exposing secrets", () => {
    for (const baseURL of ["http://remote.example/v1", "https://key:secret@example.com/", "file:///tmp/key", "https://api.deepseek.com/?secret=1"]) {
      const result = resolveStandaloneDeepSeek({ environment: { DEEPSEEK_BASE_URL: baseURL, DEEPSEEK_API_KEY: "test" }, transportEnvironment: {} }, { session: null, registrySession: true }, "search");
      expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toContain(baseURL);
    }
  });
});
