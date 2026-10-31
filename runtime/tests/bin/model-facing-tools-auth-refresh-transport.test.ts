/**
 * A provider a tool rebuilds for a call (XSearch's, Grok native WebSearch's)
 * refreshes an xAI sign-in through the calling session's transport: the
 * sign-in discovery and token requests carry the same proxy, client
 * certificate and key, and CA trust as the provider's inference requests,
 * both when an expiring grant is refreshed before the request and when a
 * 401 is retried after a refresh.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";

type Environment = Readonly<Record<string, string | undefined>>;

const proxyModulePath = "../../src/utils/proxy.js";
const secureStorageModulePath = "../../src/utils/secureStorage/index.js";
const nativeSecureStorageModulePath = "../../src/utils/secureStorage/native.js";

/** What a dispatcher carries: the transport settings it was built from. */
function transport(environment: Environment) {
  return {
    proxy: environment.HTTPS_PROXY,
    cert: environment.AGENC_CLIENT_CERT,
    key: environment.AGENC_CLIENT_KEY,
    ca: environment.NODE_EXTRA_CA_CERTS,
  };
}

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

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

let testRoot = "";
let stored = new Map<string, SecureStorageData>();

function storageKey(home: HomeContext): string {
  return [home.identityKey, home.oauthFileSuffix, home.secureStorageAccount].join("\0");
}

function readStored(home: HomeContext): SecureStorageData {
  return structuredClone(stored.get(storageKey(home)) ?? {});
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "agenc-auth-refresh-transport-"));
  stored = new Map();
  vi.resetModules();
  // Every dispatcher names the environment it was built from.
  vi.doMock(proxyModulePath, async (importOriginal) => ({
    ...await importOriginal<typeof import("../../src/utils/proxy.js")>(),
    getProxyFetchOptions: (options: { readonly environment: Environment }) => ({
      dispatcher: { builtFrom: transport(options.environment) },
    }),
  }));
  // Stored sign-ins live in this test's map, never the host keychain.
  vi.doMock(nativeSecureStorageModulePath, async (importOriginal) => ({
    ...await importOriginal<typeof import("../../src/utils/secureStorage/native.js")>(),
    readNativeSecureStorage: (home: HomeContext) => readStored(home),
  }));
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (home: HomeContext) => ({
      name: "auth-refresh-transport-test",
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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock(proxyModulePath);
  vi.doUnmock(secureStorageModulePath);
  vi.doUnmock(nativeSecureStorageModulePath);
  vi.resetModules();
  stored.clear();
  await rm(testRoot, { recursive: true, force: true });
});

/** A home whose stored xAI sign-in expires `expiresInMs` from now (refresh one hour before). */
async function signedInHome(expiresInMs: number): Promise<HomeContext> {
  const path = join(testRoot, "child-home");
  await mkdir(path, { recursive: true });
  const home = resolveHomeContext({ AGENC_HOME: path }, { platformHome: testRoot });
  const { saveXaiOauthCredentials } = await import("../../src/utils/xaiOauthCredentials.js");
  // No token endpoint stored, so a refresh discovers it first.
  saveXaiOauthCredentials(home, {
    accessToken: "old-access",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + expiresInMs,
  });
  return home;
}

/**
 * The network: xAI's sign-in discovery and token endpoints, and its API,
 * which answers 401 to the old bearer when `rejectOldBearer`. Records every
 * request with the transport its dispatcher was built from.
 */
function network(options: { readonly rejectOldBearer: boolean }) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === DISCOVERY_URL) {
      return Response.json({ authorization_endpoint: "https://auth.x.ai/oauth2/auth", token_endpoint: TOKEN_URL });
    }
    if (url === TOKEN_URL) {
      return Response.json({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 21_600, token_type: "Bearer" });
    }
    if (url.startsWith("https://api.x.ai/")) {
      const bearer = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization");
      if (options.rejectOldBearer && bearer === "Bearer old-access") {
        return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
      }
      return Response.json({ error: { message: "not served in this test" } }, { status: 400 });
    }
    if (url.includes("duckduckgo.com/html")) {
      return new Response("<html><body>no results</body></html>", { headers: { "content-type": "text/html" } });
    }
    return Response.json({}, { status: 503 });
  });
  const requests = () => fetchImpl.mock.calls.map(([input, init]) => ({
    url: String(input instanceof Request ? input.url : input),
    authorization: new Headers((init as RequestInit | undefined)?.headers).get("authorization"),
    transport: (init as { dispatcher?: { builtFrom?: unknown } } | undefined)?.dispatcher?.builtFrom,
  }));
  return { fetchImpl, requests };
}

async function harness() {
  const [{ createProvider }, { createModelFacingTools }, { attachToolRuntimeContext },
    { createEmptyToolPermissionContext }, { SessionProviderService },
    { runWithStartupProviderSelection }] = await Promise.all([
    import("../../src/llm/provider.js"),
    import("../../src/bin/model-facing-tools.js"),
    import("../../src/tools/runtimes/context.js"),
    import("../../src/permissions/types.js"),
    import("../../src/session/provider-service.js"),
    import("../../src/utils/model/providers.js"),
  ]);
  const neverAsks = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
  /** A session as the runtime makes it: its own live provider state. */
  const sessionOn = (provider: unknown, environment: Environment, credentialHome?: HomeContext) => ({
    conversationId: `session-${Math.random()}`,
    abortController: new AbortController(),
    nextInternalSubId: () => "sub-1",
    services: {
      provider,
      admissionRequired: false,
      providerEnvironment: environment,
      ...(credentialHome !== undefined ? { credentialHome } : {}),
      providerService: new SessionProviderService({
        initialProvider: provider as never,
        environment: environment as Record<string, string>,
        ...(credentialHome !== undefined ? { credentialHome } : {}),
      }),
    },
    permissionModeRegistry: { current: () => neverAsks },
  });
  const openAi = () => ({
    name: "openai", config: { apiKey: "sk-parent", model: "gpt-5.5" },
    chat: vi.fn(), chatStream: vi.fn(), healthCheck: vi.fn(),
  });
  /** Args as the runtime dispatches them: carrying the invoking session. */
  const dispatched = (args: Record<string, unknown>, session: unknown, toolName: string) => {
    const value = { ...args };
    attachToolRuntimeContext(value, {
      callId: `${toolName}-call`,
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
  /**
   * The parent's registry, built before its session attaches (as bootstrap
   * builds it), and a Grok sub-agent signed in through `home` on its own
   * transport, calling the parent's tool.
   */
  const run = (toolName: "XSearch" | "WebSearch", home: HomeContext) =>
    runWithStartupProviderSelection({
      provider: "openai",
      model: "gpt-5.5",
      environment: { AGENC_HOME: join(testRoot, "registry-home") },
    }, async () => {
      const parent = sessionOn(openAi(), PARENT);
      let current: unknown = null;
      const tool = createModelFacingTools({
        workspaceRoot: testRoot,
        getSession: () => current as never,
        env: PARENT,
        grokCapabilities: { x_search: true },
      }).find((entry) => entry.name === toolName)!;
      current = parent;
      const child = sessionOn(createProvider("grok", { model: "grok-4.6", credentialHome: home }), CHILD, home);
      const args = toolName === "XSearch" ? { query: "xAI" } : { query: "agenc" };
      return await tool.execute(dispatched(args, child, toolName));
    });
  return { run };
}

describe("a tool's rebuilt Grok provider refreshes a sign-in on the caller's transport", () => {
  it.each(["XSearch", "WebSearch"] as const)(
    "%s: an expiring grant is refreshed, discovery included, through the sub-agent's transport before the request",
    async (toolName) => {
      const home = await signedInHome(60_000);
      const net = network({ rejectOldBearer: false });
      vi.stubGlobal("fetch", net.fetchImpl);
      const { run } = await harness();

      await run(toolName, home);

      const requests = net.requests();
      const signIn = requests.filter((request) => request.url.startsWith("https://auth.x.ai/"));
      expect(signIn.map((request) => request.url)).toEqual([DISCOVERY_URL, TOKEN_URL]);
      const api = requests.filter((request) => request.url.startsWith("https://api.x.ai/"));
      expect(api.length).toBeGreaterThan(0);
      // The refreshed bearer, never the expiring one.
      for (const request of api) expect(request.authorization).toBe("Bearer new-access");
      for (const request of requests) expect(request.transport).toEqual(transport(CHILD));
    },
  );

  it.each(["XSearch", "WebSearch"] as const)(
    "%s: a 401 is retried after a refresh sent through the sub-agent's transport",
    async (toolName) => {
      // Not inside the refresh window: only the 401 triggers the refresh.
      const home = await signedInHome(5 * 3_600_000);
      const net = network({ rejectOldBearer: true });
      vi.stubGlobal("fetch", net.fetchImpl);
      const { run } = await harness();

      await run(toolName, home);

      const requests = net.requests();
      const api = requests.filter((request) => request.url.startsWith("https://api.x.ai/"));
      expect(api.map((request) => request.authorization)).toEqual(["Bearer old-access", "Bearer new-access"]);
      const signIn = requests.filter((request) => request.url.startsWith("https://auth.x.ai/"));
      expect(signIn.map((request) => request.url)).toEqual([DISCOVERY_URL, TOKEN_URL]);
      for (const request of requests) expect(request.transport).toEqual(transport(CHILD));
    },
  );
});
