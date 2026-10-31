import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelFacingTools, __setLiveWebFetchDnsAllLookupForTests } from "../../src/bin/model-facing-tools.js";
import { createEmptyToolPermissionContext, type ToolPermissionContext } from "../../src/permissions/types.js";
import type { Session } from "../../src/session/session.js";
import { attachToolRuntimeContext, type ToolRuntimeAttemptContext } from "../../src/tools/runtimes/context.js";

/** The "never asks" session with no web_fetch rules: the only one that uses Ollama's fetch. */
const NEVER_ASKS = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";

function ollamaSession(
  overrides: Record<string, unknown> = {},
  permissions: ToolPermissionContext | null | (() => ToolPermissionContext) = NEVER_ASKS,
): Session {
  return {
    services: {
      provider: { name: "ollama-cloud", config: { apiKey: "session-key", model: "gemma4:31b", ...overrides } },
      // Its own tool authority, as every session carries from creation.
      providerEnvironment: Object.freeze({}),
    },
    ...(permissions === null ? {} : {
      permissionModeRegistry: { current: typeof permissions === "function" ? permissions : () => permissions },
    }),
  } as unknown as Session;
}

const toolFor = (session: Session | (() => Session)) => createModelFacingTools({
  workspaceRoot: process.cwd(),
  env: {},
  getSession: typeof session === "function" ? session : () => session,
}).find(t => t.name === "web_fetch")!;
const tool = (overrides = {}) => toolFor(ollamaSession(overrides));

/** Args as the runtime dispatches them: carrying the invoking session and call id. */
function dispatchedArgs(args: Record<string, unknown>, session: Session, callId: string): Record<string, unknown> {
  const dispatched = { ...args };
  attachToolRuntimeContext(dispatched, {
    callId, toolName: "web_fetch", approvalPolicy: "on_request", requestedSandboxMode: "workspace_write",
    sandboxMode: "workspace_write", approvalResolved: false, rawArgs: JSON.stringify(args), invocation: { session },
  } as unknown as ToolRuntimeAttemptContext);
  return dispatched;
}

const ollamaPage = () => new Response(JSON.stringify({ title: "Docs", content: "Readable documentation", links: [] }));
const fetchedUrls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(call => String(call[0]));
/** Ollama answers with the page; every other URL is the local fetcher's request. */
function routedFetch(local: (url: string) => Response = () => new Response("local page", { headers: { "content-type": "text/plain" } })) {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    return url === OLLAMA_FETCH_URL ? ollamaPage() : local(url);
  });
}

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

describe("Ollama Cloud web fetch gate (follows redirects on Ollama's servers)", () => {
  it("keeps the local fetcher, unbilled, in every session that can ask or has a web_fetch rule", async () => {
    const rules = (overrides: Partial<ToolPermissionContext>) =>
      createEmptyToolPermissionContext({ mode: "bypassPermissions", ...overrides });
    const local: ReadonlyArray<{ readonly name: string; readonly permissions: ToolPermissionContext | null }> = [
      { name: "asks first (default)", permissions: createEmptyToolPermissionContext() },
      { name: "edits freely", permissions: createEmptyToolPermissionContext({ mode: "acceptEdits" }) },
      { name: "auto approve", permissions: createEmptyToolPermissionContext({ mode: "auto" }) },
      { name: "rules only", permissions: createEmptyToolPermissionContext({ mode: "dontAsk" }) },
      { name: "plan only", permissions: createEmptyToolPermissionContext({ mode: "plan" }) },
      { name: "no readable permission context", permissions: null },
      { name: "never asks, domain allow rule", permissions: rules({ alwaysAllowRules: { userSettings: ["web_fetch(domain:example.com)"] } }) },
      { name: "never asks, domain deny rule", permissions: rules({ alwaysDenyRules: { userSettings: ["web_fetch(domain:evil.example)"] } }) },
      { name: "never asks, domain ask rule", permissions: rules({ alwaysAskRules: { projectSettings: ["web_fetch(domain:docs.example)"] } }) },
      { name: "never asks, whole-tool allow rule", permissions: rules({ alwaysAllowRules: { session: ["web_fetch"] } }) },
    ];
    for (const entry of local) {
      const fetch = routedFetch(); vi.stubGlobal("fetch", fetch);
      const fetchTool = toolFor(ollamaSession({}, entry.permissions));
      expect(fetchTool.admissionEstimate?.({ url: "https://example.com/" }).maxCostUsd, entry.name).toBe(0);
      const result = await fetchTool.execute({ url: "https://example.com/" });
      expect(fetchedUrls(fetch), entry.name).toEqual(["https://example.com/"]);
      expect(JSON.parse(result.content), entry.name).toMatchObject({ status: 200, content: "local page" });
      expect(JSON.parse(result.content).source, entry.name).toBeUndefined();
      expect(result.admissionUsage?.costUsd, entry.name).toBe(0);
    }
    // Never asks, and the only rules name other tools: Ollama fetches.
    const fetch = routedFetch(); vi.stubGlobal("fetch", fetch);
    const result = await toolFor(ollamaSession({}, rules({ alwaysAllowRules: { userSettings: ["Grep"] } })))
      .execute({ url: "https://example.com/" });
    expect(fetchedUrls(fetch)).toEqual([OLLAMA_FETCH_URL]);
    expect(JSON.parse(result.content).source).toBe("ollama-cloud_web_fetch");
  });

  it("refuses a cross-host redirect locally where the session asks, instead of letting Ollama follow it", async () => {
    // docs.example redirects to another host. Ollama would follow it on its
    // servers and return that page; the local fetcher refuses the hop.
    const fetch = routedFetch((url) => url.startsWith("https://docs.example.com/")
      ? new Response(null, { status: 302, headers: { location: "https://evil.example/landing" } })
      : new Response("other host page", { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await toolFor(ollamaSession({}, createEmptyToolPermissionContext()))
      .execute({ url: "https://docs.example.com/start" });
    expect(fetchedUrls(fetch)).toEqual(["https://docs.example.com/start"]);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/redirect target changes host from docs\.example\.com to evil\.example/u);
    expect(result.admissionUsage?.costUsd).toBe(0);
  });

  it("never sends a preapproved, IP-address, non-public or privately resolving URL to Ollama", async () => {
    for (const url of ["https://docs.python.org/3/", "https://93.184.216.34/page", "https://printer.local/status", "https://intranet/"]) {
      const fetch = routedFetch(); vi.stubGlobal("fetch", fetch);
      const fetchTool = tool();
      expect(fetchTool.admissionEstimate?.({ url }).maxCostUsd, url).toBe(0);
      await fetchTool.execute({ url });
      expect(fetchedUrls(fetch), url).not.toContain(OLLAMA_FETCH_URL);
    }
    // A public name that resolves to a private address stays local, where it is refused.
    __setLiveWebFetchDnsAllLookupForTests((_host, callback) => callback(null, [{ address: "10.0.0.7", family: 4 }]));
    const fetch = routedFetch(); vi.stubGlobal("fetch", fetch);
    const result = await tool().execute({ url: "https://internal-looking.example.com/" });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.admissionUsage?.costUsd).toBe(0);
  });

  it("uses Ollama for a dispatched call only when admission priced it for Ollama", async () => {
    let permissions = createEmptyToolPermissionContext();
    const session = ollamaSession({}, () => permissions);
    const fetchTool = toolFor(session);
    const asked = dispatchedArgs({ url: "https://example.com/" }, session, "call-asked");
    expect(fetchTool.admissionEstimate?.(asked).maxCostUsd).toBe(0);
    // The user switches to "never asks" while the call waits: it stays free.
    permissions = NEVER_ASKS;
    const fetch = routedFetch(); vi.stubGlobal("fetch", fetch);
    const local = await fetchTool.execute(asked);
    expect(fetchedUrls(fetch)).toEqual(["https://example.com/"]);
    expect(local.admissionUsage?.costUsd).toBe(0);
    // A call admitted in "never asks" uses Ollama and is billed.
    const priced = dispatchedArgs({ url: "https://example.com/" }, session, "call-priced");
    expect(fetchTool.admissionEstimate?.(priced).maxCostUsd).toBe(0.001);
    const viaOllama = routedFetch(); vi.stubGlobal("fetch", viaOllama);
    const result = await fetchTool.execute(priced);
    expect(fetchedUrls(viaOllama)).toEqual([OLLAMA_FETCH_URL]);
    expect(result.admissionUsage?.costUsd).toBe(0.001);
  });

  it("chooses Ollama from the invoking sub-agent session, with its own key", async () => {
    const openAiSession = {
      services: {
        provider: { name: "openai", config: { apiKey: "sk-openai", model: "gpt-5.5" } },
        providerEnvironment: Object.freeze({}),
      },
      permissionModeRegistry: { current: () => NEVER_ASKS },
    } as unknown as Session;
    // An OpenAI child of a "never asks" Ollama parent fetches locally.
    const parentTool = toolFor(ollamaSession({ apiKey: "parent-key" }));
    const childArgs = dispatchedArgs({ url: "https://example.com/" }, openAiSession, "child-1");
    expect(parentTool.admissionEstimate?.(childArgs).maxCostUsd).toBe(0);
    const local = routedFetch(); vi.stubGlobal("fetch", local);
    await parentTool.execute(childArgs);
    expect(fetchedUrls(local)).toEqual(["https://example.com/"]);
    // An Ollama child of an OpenAI parent fetches through Ollama with the child's key.
    const ollamaChild = ollamaSession({ apiKey: "child-key" });
    const openAiParentTool = toolFor(openAiSession);
    const ollamaArgs = dispatchedArgs({ url: "https://example.com/" }, ollamaChild, "child-2");
    expect(openAiParentTool.admissionEstimate?.(ollamaArgs).maxCostUsd).toBe(0.001);
    const viaOllama = routedFetch(); vi.stubGlobal("fetch", viaOllama);
    await openAiParentTool.execute(ollamaArgs);
    expect(fetchedUrls(viaOllama)).toEqual([OLLAMA_FETCH_URL]);
    expect(new Headers(viaOllama.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer child-key");
  });
});
