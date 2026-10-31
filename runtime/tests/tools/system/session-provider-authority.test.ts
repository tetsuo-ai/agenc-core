/**
 * A tool call uses one session's provider authority from end to end, the
 * session that made the call (a sub-agent runs its parent's tool objects):
 * endpoint, credential, auth mode and credential home resolve together, and
 * nothing falls back to the session the tool registry was built for.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveHomeContext, type HomeContext } from "../../../src/config/home.js";
import type { SecureStorageData } from "../../../src/utils/secureStorage/index.js";

const secureStorageModulePath = "../../../src/utils/secureStorage/index.js";
const nativeSecureStorageModulePath = "../../../src/utils/secureStorage/native.js";

let testRoot = "";
let stored = new Map<string, SecureStorageData>();

function storageKey(home: HomeContext): string {
  return [home.identityKey, home.oauthFileSuffix, home.secureStorageAccount].join("\0");
}

function readStored(home: HomeContext): SecureStorageData {
  return structuredClone(stored.get(storageKey(home)) ?? {});
}

/** Stored sign-ins live in this test's map, never the host keychain. */
function installSecureStorage(): void {
  vi.doMock(nativeSecureStorageModulePath, async (importOriginal) => ({
    ...await importOriginal<typeof import("../../../src/utils/secureStorage/native.js")>(),
    readNativeSecureStorage: (home: HomeContext) => readStored(home),
  }));
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (home: HomeContext) => ({
      name: "session-provider-authority-test",
      read: () => readStored(home),
      readFresh: () => readStored(home),
      readAsync: async () => readStored(home),
      update: (data: SecureStorageData) => {
        stored.set(storageKey(home), structuredClone(data));
        return { success: true };
      },
      delete: () => stored.delete(storageKey(home)),
    }),
  }));
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "agenc-session-provider-authority-"));
  stored = new Map();
  vi.resetModules();
  installSecureStorage();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock(secureStorageModulePath);
  vi.doUnmock(nativeSecureStorageModulePath);
  vi.clearAllMocks();
  vi.resetModules();
  stored.clear();
  await rm(testRoot, { recursive: true, force: true });
});

async function createHome(name: string): Promise<HomeContext> {
  const path = join(testRoot, name);
  await mkdir(path, { recursive: true });
  return resolveHomeContext({ AGENC_HOME: path }, { platformHome: testRoot });
}

/** A home whose stored xAI sign-in is `accessToken`. */
async function signedInHome(name: string, accessToken: string): Promise<HomeContext> {
  const home = await createHome(name);
  const { saveXaiOauthCredentials } = await import("../../../src/utils/xaiOauthCredentials.js");
  saveXaiOauthCredentials(home, { accessToken });
  return home;
}

/**
 * Sessions as the runtime hands them to a tool: the registry is built for
 * the parent, and each call carries the session that made it. Every module
 * is loaded after the storage mock, so all of them share it.
 */
async function harness() {
  const [{ createProvider, readProviderFactoryOptions }, { createModelFacingTools },
    { attachToolRuntimeContext }, { createImagineImageTool }, { createImagineVideoTool },
    { runWithStartupProviderSelection }] = await Promise.all([
    import("../../../src/llm/provider.js"),
    import("../../../src/bin/model-facing-tools.js"),
    import("../../../src/tools/runtimes/context.js"),
    import("../../../src/tools/system/imagine-image.js"),
    import("../../../src/tools/system/imagine-video.js"),
    import("../../../src/utils/model/providers.js"),
  ]);
  let sub = 0;
  /**
   * A session; `authority` is what a sub-agent carries from creation (a
   * registry's own session may leave it out: the tool was built with its).
   */
  const sessionOf = (id: string, provider: unknown, authority: {
    readonly providerEnvironment?: Record<string, string>;
    readonly credentialHome?: HomeContext;
  } = {}) => ({
    conversationId: id,
    nextInternalSubId: () => `${id}-sub-${++sub}`,
    services: {
      admissionRequired: false,
      provider,
      ...(authority.providerEnvironment !== undefined
        ? { providerEnvironment: Object.freeze({ ...authority.providerEnvironment }) }
        : {}),
      ...(authority.credentialHome !== undefined ? { credentialHome: authority.credentialHome } : {}),
    },
  });
  const dispatched = (args: Record<string, unknown>, session: unknown, toolName: string) => {
    const value = { ...args };
    attachToolRuntimeContext(value, {
      callId: `${toolName}-${++sub}`,
      toolName,
      approvalPolicy: "on_request",
      requestedSandboxMode: "workspace_write",
      sandboxMode: "workspace_write",
      approvalResolved: false,
      rawArgs: JSON.stringify(args),
      invocation: { session },
    } as never);
    return value;
  };
  const chat = vi.fn(async () => ({
    content: "Found a post https://x.com/xai/status/1",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "grok-4.6",
    finishReason: "stop" as const,
    providerEvidence: {
      citations: ["https://x.com/xai/status/1"],
      serverSideToolCalls: [{ type: "x_search_call", toolType: "x_search", id: "c1" }],
    },
  }));
  const factory = vi.fn((...args: Parameters<typeof createProvider>) =>
    Object.assign(createProvider(...args), { chat }));
  type ModelFacingTool = ReturnType<typeof createModelFacingTools>[number];
  /** XSearch from a registry built for `parent`, inside its startup scope. */
  const withXSearch = (home: HomeContext, parent: unknown, run: (xSearch: ModelFacingTool) => Promise<void>) =>
    runWithStartupProviderSelection({
      provider: "grok",
      model: "grok-4.6",
      environment: { AGENC_HOME: home.path },
    }, async () => run(createModelFacingTools({
      workspaceRoot: process.cwd(),
      agencHome: home.path,
      getSession: () => parent as never,
      env: { AGENC_HOME: home.path },
      grokCapabilities: { x_search: true },
      providerFactory: factory,
    }).find((tool) => tool.name === "XSearch")!));
  /** Where each provider XSearch built would send which bearer, under which selection. */
  const xSearchCredentials = () => factory.mock.results.map((result) => {
    const options = readProviderFactoryOptions(result.value);
    return { baseURL: options.baseURL, bearer: options.apiKey, authMode: options.extra?.authMode };
  });
  const media = (kind: "image" | "video", home: HomeContext, root: string, parent: unknown,
    env: Record<string, string> = {}) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    const options = {
      workspaceRoot: root,
      home,
      getSession: () => parent as never,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    const tool = kind === "image" ? createImagineImageTool(options) : createImagineVideoTool(options);
    const requests = () => fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      authorization: (init as { headers?: Record<string, string> } | undefined)?.headers?.authorization,
    }));
    return { tool, requests };
  };
  return { createProvider, sessionOf, dispatched, withXSearch, xSearchCredentials, media };
}

describe("tool calls from a sub-agent with its own xAI authority", () => {
  /** A parent on the stored sign-in and a sub-agent on its own API key, in one home. */
  async function signedInParentAndByokChild(tools: Awaited<ReturnType<typeof harness>>, home: HomeContext) {
    const parent = tools.sessionOf("grok-parent",
      tools.createProvider("grok", { credentialHome: home, model: "grok-4.6" }));
    // The sub-agent got its own copy of the parent's authority at creation.
    const child = tools.sessionOf("grok-child", tools.createProvider("grok", {
      credentialHome: home, apiKey: "child-key", model: "grok-4.6", extra: { authMode: "api_key" },
    }), { providerEnvironment: { AGENC_HOME: home.path }, credentialHome: home });
    return { parent, child };
  }

  it("XSearch keeps a Grok sub-agent on its explicit API key while the home holds the parent's sign-in", async () => {
    const home = await signedInHome("child-byok", "parent-oauth");
    const tools = await harness();
    const { parent, child } = await signedInParentAndByokChild(tools, home);

    await tools.withXSearch(home, parent, async (xSearch) => {
      expect((await xSearch.execute(tools.dispatched({ query: "xAI" }, child, "XSearch"))).isError).toBeUndefined();
      expect((await xSearch.execute(tools.dispatched({ query: "xAI" }, parent, "XSearch"))).isError).toBeUndefined();
    });
    // The rebuilt provider keeps the sub-agent's selection, so the factory
    // cannot swap its key for the stored sign-in; the parent keeps its own.
    expect(tools.xSearchCredentials()).toEqual([
      { baseURL: "https://api.x.ai/v1", bearer: "child-key", authMode: "api_key" },
      { baseURL: "https://api.x.ai/v1", bearer: "parent-oauth", authMode: "oauth" },
    ]);
  });

  it.each([
    ["image", "ImagineImage", "images/generations"],
    ["video", "ImagineVideo", "videos/generations"],
  ] as const)("Imagine %s keeps a Grok sub-agent on its explicit API key while the home holds the parent's sign-in",
    async (kind, toolName, route) => {
      const home = await signedInHome(`child-byok-${kind}`, "parent-oauth");
      const tools = await harness();
      const { parent, child } = await signedInParentAndByokChild(tools, home);
      const { tool, requests } = tools.media(kind, home, await mkdtemp(join(testRoot, "media-")), parent);

      await tool.execute(tools.dispatched({ prompt: "a cat" }, child, toolName));
      await tool.execute(tools.dispatched({ prompt: "a cat" }, parent, toolName));

      expect(requests()).toEqual([
        { url: `https://api.x.ai/v1/${route}`, authorization: "Bearer child-key" },
        { url: `https://api.x.ai/v1/${route}`, authorization: "Bearer parent-oauth" },
      ]);
    });

  it("XSearch never sends a Grok sub-agent's key to the parent's endpoint", async () => {
    const home = await signedInHome("child-gateway", "parent-oauth");
    const tools = await harness();
    // The parent signs in on api.x.ai; the sub-agent's key belongs to its
    // own xAI-compatible gateway.
    const parent = tools.sessionOf("grok-parent",
      tools.createProvider("grok", { credentialHome: home, model: "grok-4.6" }));
    const child = tools.sessionOf("grok-child", tools.createProvider("grok", {
      credentialHome: home, apiKey: "child-key", model: "grok-4.6",
      baseURL: "https://xai-gateway.example/v1", extra: { authMode: "api_key" },
    }), { providerEnvironment: { AGENC_HOME: home.path }, credentialHome: home });

    await tools.withXSearch(home, parent, async (xSearch) => {
      await xSearch.execute(tools.dispatched({ query: "xAI" }, child, "XSearch"));
      await xSearch.execute(tools.dispatched({ query: "xAI" }, parent, "XSearch"));
    });
    expect(tools.xSearchCredentials()).toEqual([
      { baseURL: "https://xai-gateway.example/v1", bearer: "child-key", authMode: "api_key" },
      { baseURL: "https://api.x.ai/v1", bearer: "parent-oauth", authMode: "oauth" },
    ]);
  });

  it("XSearch resolves a non-Grok sub-agent's independent xAI backend from its own environment", async () => {
    const home = await signedInHome("child-environment", "parent-oauth");
    const tools = await harness();
    const parent = tools.sessionOf("grok-parent",
      tools.createProvider("grok", { credentialHome: home, model: "grok-4.6" }));
    // A DeepSeek sub-agent whose environment selects xAI API-key billing.
    const child = tools.sessionOf("deepseek-child", tools.createProvider("deepseek", {
      credentialHome: home, apiKey: "deepseek-key", model: "deepseek-v4-pro",
    }), {
      providerEnvironment: { AGENC_HOME: home.path, GROK_AUTH_MODE: "api-key", XAI_API_KEY: "child-xai-key" },
      credentialHome: home,
    });

    await tools.withXSearch(home, parent, async (xSearch) => {
      expect((await xSearch.execute(tools.dispatched({ query: "xAI" }, child, "XSearch"))).isError).toBeUndefined();
    });
    expect(tools.xSearchCredentials()).toEqual([
      { baseURL: "https://api.x.ai/v1", bearer: "child-xai-key", authMode: "api_key" },
    ]);
  });
});

describe("a sub-agent without its own authority", () => {
  type Harness = Awaited<ReturnType<typeof harness>>;
  const deepSeekChild = (tools: Harness, authority: Parameters<Harness["sessionOf"]>[2]) =>
    tools.sessionOf("deepseek-child", tools.createProvider("deepseek", {
      apiKey: "deepseek-key", model: "deepseek-v4-pro",
    }), authority);

  it.each([
    ["image", "ImagineImage"],
    ["video", "ImagineVideo"],
  ] as const)("Imagine %s fails closed without the sub-agent's environment instead of using the parent's key",
    async (kind, toolName) => {
      const home = await createHome(`no-environment-${kind}`);
      const tools = await harness();
      const parent = tools.sessionOf("openai-parent",
        tools.createProvider("openai", { apiKey: "parent-key", model: "gpt-5" }));
      // A credential home, but no provider environment of its own.
      const child = deepSeekChild(tools, { credentialHome: home });
      const { tool, requests } = tools.media(kind, home, await mkdtemp(join(testRoot, "media-")), parent,
        { OPENAI_API_KEY: "parent-key" });

      const result = await tool.execute(tools.dispatched({ prompt: "a cat" }, child, toolName));

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/no provider environment of its own/u);
      expect(requests()).toEqual([]);
    });

  it.each([
    ["image", "ImagineImage"],
    ["video", "ImagineVideo"],
  ] as const)("Imagine %s fails closed without the sub-agent's credential home instead of the parent's sign-in",
    async (kind, toolName) => {
      const home = await signedInHome(`no-home-${kind}`, "parent-oauth");
      const tools = await harness();
      const parent = tools.sessionOf("grok-parent",
        tools.createProvider("grok", { credentialHome: home, model: "grok-4.6" }));
      // An explicitly empty environment, and no credential home anywhere.
      const child = deepSeekChild(tools, { providerEnvironment: {} });
      const { tool, requests } = tools.media(kind, home, await mkdtemp(join(testRoot, "media-")), parent);

      const result = await tool.execute(tools.dispatched({ prompt: "a cat" }, child, toolName));

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/no credential home of its own/u);
      expect(requests()).toEqual([]);
    });

  it("XSearch fails closed without the sub-agent's environment or credential home", async () => {
    const home = await signedInHome("no-authority-xsearch", "parent-oauth");
    const tools = await harness();
    const parent = tools.sessionOf("grok-parent",
      tools.createProvider("grok", { credentialHome: home, model: "grok-4.6" }));
    const noEnvironment = deepSeekChild(tools, { credentialHome: home });
    const noHome = deepSeekChild(tools, { providerEnvironment: {} });

    await tools.withXSearch(home, parent, async (xSearch) => {
      const first = await xSearch.execute(tools.dispatched({ query: "xAI" }, noEnvironment, "XSearch"));
      expect(first.isError).toBe(true);
      expect(first.content).toMatch(/no provider environment of its own/u);
      const second = await xSearch.execute(tools.dispatched({ query: "xAI" }, noHome, "XSearch"));
      expect(second.isError).toBe(true);
      expect(second.content).toMatch(/no credential home of its own/u);
    });
    // Neither call built a provider, so the parent's sign-in was never sent.
    expect(tools.xSearchCredentials()).toEqual([]);
  });
});

describe("session provider authority", () => {
  async function authority() {
    const [{ createProvider }, routes] = await Promise.all([
      import("../../../src/llm/provider.js"),
      import("../../../src/tools/system/session-provider-authority.js"),
    ]);
    return { createProvider, ...routes };
  }

  it("lends a session's API key only with its own endpoint", async () => {
    const { createProvider, sessionApiKeyRoute } = await authority();
    expect(sessionApiKeyRoute(createProvider("openai", {
      apiKey: " child-key ", model: "gpt-5", baseURL: "https://child-openai.example/v1/",
    }), "https://api.openai.com/v1")).toEqual({ bearer: "child-key", baseURL: "https://child-openai.example/v1" });
    // No base URL of its own: the endpoint its model calls use by default.
    expect(sessionApiKeyRoute(createProvider("openai", { apiKey: "child-key", model: "gpt-5" }),
      "https://api.openai.com/v1")).toEqual({ bearer: "child-key", baseURL: "https://api.openai.com/v1" });
  });

  it("lends no credential from a sign-in or a session without a key", async () => {
    const { createProvider, sessionApiKeyRoute } = await authority();
    const signIn = createProvider("openai", {
      model: "gpt-5",
      baseURL: "https://chatgpt.com/backend-api/codex",
      extra: { authMode: "oauth", chatgptBackend: true, oauth: { accessToken: "grant" } },
    });
    expect(sessionApiKeyRoute(signIn, "https://api.openai.com/v1")).toBeUndefined();
    expect(sessionApiKeyRoute(undefined, "https://api.openai.com/v1")).toBeUndefined();
  });

  it("resolves a Grok session's xAI route as its model calls do", async () => {
    const home = await signedInHome("grok-routes", "stored-sign-in");
    const { createProvider, sessionXaiRoute } = await authority();
    const xai = "https://api.x.ai/v1";
    // Signed in: the stored grant from the session's own home.
    expect(sessionXaiRoute(createProvider("grok", { credentialHome: home, model: "grok-4.6" }), xai))
      .toEqual({ bearer: "stored-sign-in", baseURL: xai, authMode: "oauth", credentialHome: home });
    // An explicit API-key selection keeps its key while a sign-in is stored.
    expect(sessionXaiRoute(createProvider("grok", {
      credentialHome: home, apiKey: "byok", model: "grok-4.6", extra: { authMode: "api_key" },
    }), xai)).toEqual({ bearer: "byok", baseURL: xai, authMode: "api_key", credentialHome: home });
    // A key on its own gateway stays on that gateway.
    expect(sessionXaiRoute(createProvider("grok", {
      apiKey: "gateway-key", model: "grok-4.6", baseURL: "https://xai-gateway.example/v1/",
    }), xai)).toEqual({ bearer: "gateway-key", baseURL: "https://xai-gateway.example/v1", authMode: "api_key" });
  });

  it("gives the registry's own session the tool's captured authority, and no other session", async () => {
    const { resolveToolCallAuthority, toolCallSession } = await authority();
    const home = await createHome("captured-authority");
    const captured = { env: Object.freeze({ XAI_API_KEY: "registry-key" }), home };
    const registry = { services: {} };
    const other = { services: {} };
    const own = resolveToolCallAuthority("XSearch", toolCallSession(registry, () => registry), captured, true);
    expect(own).toMatchObject({ environment: { XAI_API_KEY: "registry-key" }, credentialHome: home });
    // A call with no session at all is the registry owner's own as well.
    expect(resolveToolCallAuthority("XSearch", toolCallSession(undefined, () => null), captured, true))
      .toMatchObject({ environment: { XAI_API_KEY: "registry-key" }, credentialHome: home });
    expect(resolveToolCallAuthority("XSearch", toolCallSession(other, () => registry), captured, true))
      .toEqual({ error: expect.stringMatching(/no provider environment of its own/u) });
  });

  it("fills a session's configured provider auth choice into its environment, an exported value first", async () => {
    const { resolveToolCallAuthority, toolCallSession } = await authority();
    const home = await createHome("configured-auth");
    const configStore = { current: () => ({ providers: { grok: { auth: "api-key" } } }) };
    const child = (providerEnvironment: Record<string, string>) => ({
      services: { providerEnvironment: Object.freeze(providerEnvironment), credentialHome: home, configStore },
    });
    const filled = resolveToolCallAuthority("XSearch",
      toolCallSession(child({ XAI_API_KEY: "child-key" }), () => null), {}, true);
    expect(filled).toMatchObject({ environment: { XAI_API_KEY: "child-key", GROK_AUTH_MODE: "api-key" } });
    // The transport environment stays the session's own object.
    const exported = child({ XAI_API_KEY: "child-key", GROK_AUTH_MODE: "oauth" });
    const kept = resolveToolCallAuthority("XSearch", toolCallSession(exported, () => null), {}, true);
    expect(kept).toMatchObject({ environment: { GROK_AUTH_MODE: "oauth" } });
    expect("transportEnvironment" in kept && kept.transportEnvironment).toBe(exported.services.providerEnvironment);
  });

  it("never pairs a sign-in with a custom endpoint", async () => {
    const home = await createHome("grok-custom");
    const { createProvider, sessionXaiRoute } = await authority();
    // A gateway session in automatic mode, then a sign-in saved to its home:
    // re-resolving it would select the sign-in, which never leaves api.x.ai.
    const gateway = createProvider("grok", {
      credentialHome: home, apiKey: "gateway-key", model: "grok-4.6", baseURL: "https://xai-gateway.example/v1",
    });
    const { saveXaiOauthCredentials } = await import("../../../src/utils/xaiOauthCredentials.js");
    saveXaiOauthCredentials(home, { accessToken: "stored-sign-in" });
    expect(sessionXaiRoute(gateway, "https://api.x.ai/v1"))
      .toEqual({ error: expect.stringMatching(/bound to the first-party xAI API endpoint/u) });
  });
});
