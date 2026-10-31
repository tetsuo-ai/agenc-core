/**
 * Transport authority is part of a session's authority: every request a tool
 * makes for a call (web_fetch, WebSearch and the media tools) goes out with
 * the proxy, client certificate and key, and CA trust of the session that
 * made the call, the same environment its endpoint and key come from. A
 * sub-agent runs its parent's tool objects, so none of it may come from the
 * environment the registry was built with, and a sub-agent without its own
 * environment fails closed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Environment = Readonly<Record<string, string | undefined>>;

const recorded = vi.hoisted(() => ({
  /** The environments direct (unproxied) fetches built their TLS from. */
  mtls: [] as Environment[],
  /** What a dispatcher carries: the transport settings it was built from. */
  transport: (environment: Readonly<Record<string, string | undefined>>) => ({
    proxy: environment.HTTPS_PROXY,
    cert: environment.AGENC_CLIENT_CERT,
    key: environment.AGENC_CLIENT_KEY,
    ca: environment.NODE_EXTRA_CA_CERTS,
  }),
}));

vi.mock("../../src/utils/proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/proxy.js")>();
  return {
    ...actual,
    // Every dispatcher names the environment it was built from.
    getProxyFetchOptions: (options: { readonly environment: Environment }) => ({
      dispatcher: { builtFrom: recorded.transport(options.environment) },
    }),
  };
});

vi.mock("../../src/utils/mtls.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/mtls.js")>();
  return {
    ...actual,
    getMTLSConfig: (environment: Environment) => {
      recorded.mtls.push(environment);
      return undefined;
    },
  };
});

import {
  __resetLiveWebFetchSsrfDispatcherForTests,
  __setLiveWebFetchDnsAllLookupForTests,
  createModelFacingTools,
} from "../../src/bin/model-facing-tools.js";
import type { HomeContext } from "../../src/config/home.js";
import { createProvider } from "../../src/llm/provider.js";
import type { LLMProvider } from "../../src/llm/types.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import type { Session } from "../../src/session/session.js";
import {
  attachToolRuntimeContext,
  type ToolRuntimeAttemptContext,
} from "../../src/tools/runtimes/context.js";
import { createImagineImageTool } from "../../src/tools/system/imagine-image.js";
import { mediaTestHome, ownProviderState } from "../tools/system/media-test-helpers.js";

/** The "never asks" session with no web_fetch rules: the only one that uses a provider fetch. */
const NEVER_ASKS = createEmptyToolPermissionContext({ mode: "bypassPermissions" });

const PARENT: Environment = Object.freeze({
  HTTPS_PROXY: "http://parent-proxy.test:8080",
  AGENC_CLIENT_CERT: "/parent/client.pem",
  AGENC_CLIENT_KEY: "/parent/client.key",
  NODE_EXTRA_CA_CERTS: "/parent/ca.pem",
});
const CHILD: Environment = Object.freeze({
  HTTPS_PROXY: "http://child-proxy.test:9090",
  AGENC_CLIENT_CERT: "/child/client.pem",
  AGENC_CLIENT_KEY: "/child/client.key",
  NODE_EXTRA_CA_CERTS: "/child/ca.pem",
});

function chatProvider(name: string, config: Record<string, unknown>): LLMProvider {
  return { name, config, chat: vi.fn(), chatStream: vi.fn(), healthCheck: vi.fn() } as unknown as LLMProvider;
}

/**
 * A session; a sub-agent has its own live provider state, seeded with the
 * environment it was given at creation (a registry's own test session may
 * leave it out: the tool was built with its).
 */
function sessionOn(provider: LLMProvider, providerEnvironment?: Environment, credentialHome?: HomeContext): Session {
  return {
    conversationId: `session-${Math.random()}`,
    abortController: new AbortController(),
    nextInternalSubId: () => "sub-1",
    services: {
      provider,
      admissionRequired: false,
      // A runtime session's shape: what it was created with, and its live state.
      ...(providerEnvironment !== undefined
        ? {
            providerEnvironment,
            ...(credentialHome !== undefined ? { credentialHome } : {}),
            providerService: ownProviderState(provider, providerEnvironment, credentialHome),
          }
        : {}),
    },
    permissionModeRegistry: { current: () => NEVER_ASKS },
  } as unknown as Session;
}

/** Args as the runtime dispatches them: carrying the invoking session and call id. */
function dispatchedArgs(
  args: Record<string, unknown>,
  session: Session,
  callId: string,
  toolName: string,
): Record<string, unknown> {
  const dispatched = { ...args };
  attachToolRuntimeContext(dispatched, {
    callId,
    toolName,
    approvalPolicy: "on_request",
    requestedSandboxMode: "workspace_write",
    sandboxMode: "workspace_write",
    approvalResolved: false,
    rawArgs: JSON.stringify(args),
    invocation: { session },
  } as unknown as ToolRuntimeAttemptContext);
  return dispatched;
}

/** Records every request with the transport its dispatcher was built from. */
function recordingFetch() {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("duckduckgo.com/html")) {
      return new Response("<html><body>no results</body></html>", { headers: { "content-type": "text/html" } });
    }
    if (url === "https://example.com/page") {
      return new Response("local page", { headers: { "content-type": "text/plain" } });
    }
    return new Response("{}", { status: 503 });
  });
  const requests = () => fetchImpl.mock.calls.map(([url, init]) => ({
    url: String(url),
    transport: (init as { dispatcher?: { builtFrom?: unknown } } | undefined)?.dispatcher?.builtFrom,
  }));
  return { fetchImpl, requests };
}

function tool(parent: Session, name: string) {
  return createModelFacingTools({
    workspaceRoot: process.cwd(),
    getSession: () => parent,
    env: PARENT,
  }).find((entry) => entry.name === name)!;
}

beforeEach(() => {
  recorded.mtls.length = 0;
  __resetLiveWebFetchSsrfDispatcherForTests();
  __setLiveWebFetchDnsAllLookupForTests((_host, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }]));
});

afterEach(() => {
  __setLiveWebFetchDnsAllLookupForTests(undefined);
  vi.unstubAllGlobals();
});

const openAi = () => chatProvider("openai", { apiKey: "sk-openai", baseURL: "https://api.openai.com/v1", model: "gpt-5.5" });

describe("web_fetch transport", () => {
  it("sends a sub-agent's fetch through its own proxy and client certificate, and the parent's through its own", async () => {
    const { fetchImpl, requests } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const parent = sessionOn(openAi());
    const child = sessionOn(openAi(), CHILD);
    const webFetch = tool(parent, "web_fetch");

    await webFetch.execute(dispatchedArgs({ url: "https://example.com/page" }, child, "child-fetch", "web_fetch"));
    await webFetch.execute(dispatchedArgs({ url: "https://example.com/page" }, parent, "parent-fetch", "web_fetch"));

    expect(requests()).toEqual([
      { url: "https://example.com/page", transport: recorded.transport(CHILD) },
      { url: "https://example.com/page", transport: recorded.transport(PARENT) },
    ]);
  });

  it("builds a direct fetch's TLS from the sub-agent's own environment", async () => {
    const { fetchImpl } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const unproxied = (environment: Environment): Environment =>
      Object.freeze({ ...environment, HTTPS_PROXY: undefined });
    const parent = sessionOn(openAi());
    const child = sessionOn(openAi(), unproxied(CHILD));
    const webFetch = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => parent,
      env: unproxied(PARENT),
    }).find((entry) => entry.name === "web_fetch")!;

    await webFetch.execute(dispatchedArgs({ url: "https://example.com/page" }, child, "child-direct", "web_fetch"));
    expect(recorded.mtls.map((environment) => environment.AGENC_CLIENT_CERT)).toEqual(["/child/client.pem"]);
    await webFetch.execute(dispatchedArgs({ url: "https://example.com/page" }, parent, "parent-direct", "web_fetch"));
    expect(recorded.mtls.map((environment) => environment.AGENC_CLIENT_CERT))
      .toEqual(["/child/client.pem", "/parent/client.pem"]);
  });

  it.each([
    ["DeepSeek", () => chatProvider("deepseek", { apiKey: "sk-child", baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash" }), "https://api.deepseek.com/v1/tools/fetch"],
    ["Ollama Cloud", () => chatProvider("ollama-cloud", { apiKey: "child-key", model: "gemma4:31b" }), "https://ollama.com/api/web_fetch"],
  ] as const)("sends a %s sub-agent's provider fetch through its own transport", async (_name, provider, endpoint) => {
    const { fetchImpl, requests } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const parent = sessionOn(openAi());
    const child = sessionOn(provider(), CHILD);
    const webFetch = tool(parent, "web_fetch");
    const args = dispatchedArgs({ url: "https://example.com/page" }, child, "child-provider-fetch", "web_fetch");
    // The runtime prices a call before running it.
    webFetch.admissionEstimate?.(args);

    await webFetch.execute(args);

    expect(requests().map((request) => request.url)).toContain(endpoint);
    for (const request of requests()) expect(request.transport).toEqual(recorded.transport(CHILD));
  });
});

describe("WebSearch transport", () => {
  it.each([
    ["DeepSeek's Search API", () => chatProvider("deepseek", { apiKey: "sk-child", baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash" }), "https://api.deepseek.com/v1/tools/search", {}],
    ["Ollama Cloud's search", () => chatProvider("ollama-cloud", { apiKey: "child-key", model: "gemma4:31b" }), "https://ollama.com/api/web_search", {}],
    ["a configured endpoint", openAi, "https://child-search.test/search?q=agenc", { AGENC_WEB_SEARCH_ENDPOINT: "https://child-search.test/search" }],
  ] as const)("sends a sub-agent's search through %s on its own transport", async (_name, provider, endpoint, extra) => {
    const { fetchImpl, requests } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const parent = sessionOn(openAi());
    const child = sessionOn(provider(), Object.freeze({ ...CHILD, ...extra }));

    await tool(parent, "WebSearch").execute(dispatchedArgs({ query: "agenc" }, child, "child-search", "WebSearch"));

    expect(requests().map((request) => request.url)).toContain(endpoint);
    for (const request of requests()) expect(request.transport).toEqual(recorded.transport(CHILD));
  });

  it("rebuilds a Grok sub-agent's native search provider on the sub-agent's own fetch and transport", async () => {
    const globalFetch = recordingFetch();
    vi.stubGlobal("fetch", globalFetch.fetchImpl);
    // The sub-agent's own provider transport (a pinned child fetch, for example).
    const own = recordingFetch();
    const childProvider = createProvider("grok", {
      apiKey: "xai-child", model: "grok-4.6", extra: { fetchImpl: own.fetchImpl as unknown as typeof fetch },
    });
    const parent = sessionOn(openAi());
    const child = sessionOn(childProvider, CHILD);

    await tool(parent, "WebSearch").execute(dispatchedArgs({ query: "agenc" }, child, "child-native", "WebSearch"));

    expect(own.requests().length).toBeGreaterThan(0);
    for (const request of own.requests()) {
      expect(request.url.startsWith("https://api.x.ai/v1/")).toBe(true);
      expect(request.transport).toEqual(recorded.transport(CHILD));
    }
    // What falls through to the search chain stays on the sub-agent's transport too.
    for (const request of globalFetch.requests()) {
      expect(request.url.startsWith("https://api.x.ai/")).toBe(false);
      expect(request.transport).toEqual(recorded.transport(CHILD));
    }
  });

  it("sends a Grok session's native search through its own transport when its provider has no fetch of its own", async () => {
    const globalFetch = recordingFetch();
    vi.stubGlobal("fetch", globalFetch.fetchImpl);
    const session = sessionOn(createProvider("grok", { apiKey: "xai-parent", model: "grok-4.6" }), PARENT);

    await tool(session, "WebSearch").execute(dispatchedArgs({ query: "agenc" }, session, "native", "WebSearch"));

    expect(globalFetch.requests().some((request) => request.url.startsWith("https://api.x.ai/v1/"))).toBe(true);
    for (const request of globalFetch.requests()) expect(request.transport).toEqual(recorded.transport(PARENT));
  });
});

describe("media transport", () => {
  it("sends a sub-agent's image request through its own transport, and the parent's through its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-transport-"));
    try {
      const { fetchImpl, requests } = recordingFetch();
      const childProvider = createProvider("openai", { apiKey: "child-key", model: "gpt-5" });
      const parentProvider = createProvider("openai", { apiKey: "parent-key", model: "gpt-5" });
      const parent = { services: { provider: parentProvider } } as unknown as Session;
      const child = {
        services: { provider: childProvider, providerService: ownProviderState(childProvider, CHILD, mediaTestHome(root)) },
      } as unknown as Session;
      const image = createImagineImageTool({
        workspaceRoot: root,
        home: mediaTestHome(root),
        getSession: () => parent,
        env: PARENT as NodeJS.ProcessEnv,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await image.execute(dispatchedArgs({ prompt: "a cat" }, child, "child-image", "ImagineImage"));
      await image.execute(dispatchedArgs({ prompt: "a cat" }, parent, "parent-image", "ImagineImage"));

      expect(requests()).toEqual([
        { url: "https://api.openai.com/v1/images/generations", transport: recorded.transport(CHILD) },
        { url: "https://api.openai.com/v1/images/generations", transport: recorded.transport(PARENT) },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("XSearch transport", () => {
  /** XSearch from a registry built before its session attaches, as bootstrap builds it. */
  function xSearchFor(getSession: () => Session | null) {
    return createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession,
      env: PARENT,
      grokCapabilities: { x_search: true },
    }).find((entry) => entry.name === "XSearch")!;
  }

  it("rebuilds a Grok sub-agent's provider on the sub-agent's own fetch and transport", async () => {
    const globalFetch = recordingFetch();
    vi.stubGlobal("fetch", globalFetch.fetchImpl);
    // The sub-agent's own provider transport (a pinned child fetch, for example).
    const own = recordingFetch();
    const childProvider = createProvider("grok", {
      apiKey: "xai-child", model: "grok-4.6", extra: { fetchImpl: own.fetchImpl as unknown as typeof fetch },
    });
    const parent = sessionOn(openAi());
    const child = sessionOn(childProvider, CHILD);
    let current: Session | null = null;
    const xSearch = xSearchFor(() => current);
    current = parent;

    await xSearch.execute(dispatchedArgs({ query: "xAI" }, child, "child-x", "XSearch"));

    expect(globalFetch.requests()).toEqual([]);
    expect(own.requests().length).toBeGreaterThan(0);
    for (const request of own.requests()) {
      expect(request.url.startsWith("https://api.x.ai/v1/")).toBe(true);
      expect(request.transport).toEqual(recorded.transport(CHILD));
    }
  });

  it("sends a non-Grok sub-agent's independent XSearch through its own transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "xsearch-transport-"));
    try {
      const globalFetch = recordingFetch();
      vi.stubGlobal("fetch", globalFetch.fetchImpl);
      const parent = sessionOn(openAi());
      const childEnvironment = Object.freeze({ ...CHILD, XAI_API_KEY: "xai-child-key" });
      const child = sessionOn(
        chatProvider("deepseek", { apiKey: "sk-child", baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash" }),
        childEnvironment, mediaTestHome(root));
      let current: Session | null = null;
      const xSearch = xSearchFor(() => current);
      current = parent;

      await xSearch.execute(dispatchedArgs({ query: "xAI" }, child, "child-x", "XSearch"));

      expect(globalFetch.requests().length).toBeGreaterThan(0);
      for (const request of globalFetch.requests()) {
        expect(request.url.startsWith("https://api.x.ai/v1/")).toBe(true);
        expect(request.transport).toEqual(recorded.transport(childEnvironment));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a sub-agent without its own provider state", () => {
  it.each([
    ["web_fetch", { url: "https://example.com/page" }],
    ["WebSearch", { query: "agenc" }],
  ] as const)("%s fails closed instead of using the parent's", async (name, args) => {
    const { fetchImpl } = recordingFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const parent = sessionOn(openAi());
    const child = sessionOn(openAi());

    const result = await tool(parent, name).execute(dispatchedArgs(args, child, "child-call", name));

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no provider state of its own/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
