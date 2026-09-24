import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";

const secureStorageModulePath = "../../src/utils/secureStorage/index.js";

let testRoot = "";
let secureStorageByIdentity = new Map<string, SecureStorageData>();

function secureStorageKey(home: HomeContext): string {
  return [
    home.identityKey,
    home.oauthFileSuffix,
    home.secureStorageAccount,
  ].join("\0");
}

function storedData(home: HomeContext): SecureStorageData {
  return structuredClone(
    secureStorageByIdentity.get(secureStorageKey(home)) ?? {},
  );
}

function installSecureStorage(): void {
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (home: HomeContext) => ({
      name: "provider-credential-authority-test",
      read: () => storedData(home),
      readFresh: () => storedData(home),
      readAsync: async () => storedData(home),
      update: (data: SecureStorageData) => {
        secureStorageByIdentity.set(
          secureStorageKey(home),
          structuredClone(data),
        );
        return { success: true };
      },
      delete: () => secureStorageByIdentity.delete(secureStorageKey(home)),
    }),
  }));
}

async function createHome(name: string): Promise<HomeContext> {
  const path = join(testRoot, name);
  await mkdir(path, { recursive: true });
  return resolveHomeContext({ AGENC_HOME: path }, { platformHome: testRoot });
}

async function loadCredentialModules() {
  const [providerOptions, openAiCredentials, xaiCredentials] =
    await Promise.all([
      import("../../src/llm/provider-options.js"),
      import("../../src/utils/openAiOauthCredentials.js"),
      import("../../src/utils/xaiOauthCredentials.js"),
    ]);
  return { providerOptions, openAiCredentials, xaiCredentials };
}

function managedAuthBackend() {
  return {
    kind: "local" as const,
    login: vi.fn(),
    logout: vi.fn(),
    whoami: vi.fn(),
    vendKey: vi.fn(),
    inferAgencModel: vi.fn(),
    getLlmUsage: vi.fn(),
    getSubscriptionTier: vi.fn(),
  };
}

beforeEach(async () => {
  testRoot = await mkdtemp(
    join(tmpdir(), "agenc-provider-credential-authority-"),
  );
  secureStorageByIdentity = new Map();
  vi.resetModules();
  installSecureStorage();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock(secureStorageModulePath);
  vi.doUnmock("../../src/services/xai/oauth.js");
  vi.doUnmock("../../src/utils/model/providers.js");
  vi.clearAllMocks();
  vi.resetModules();
  secureStorageByIdentity.clear();
  await rm(testRoot, { recursive: true, force: true });
});

describe("provider credential authority", () => {
  test.each(["request", "response body"] as const)("stopping a Grok child during stalled model-list %s settles preparation and cleans up", async (stall) => {
    const home = await createHome(`grok-stalled-models-${stall}`);
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "sign-in" });
    const stop = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const wire = vi.fn<typeof fetch>(async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      if (stall === "request") return new Promise<Response>((resolve, reject) => {
        release = () => resolve(Response.json({ data: [{ id: "grok-4.6" }] }));
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      return new Response(new ReadableStream({ start(controller) {
        release = () => controller.close();
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      } }), { status: 200 });
    });
    const [{ SessionProviderService }, { createProvider }] = await Promise.all([
      import("../../src/session/provider-service.js"), import("../../src/llm/provider.js"),
    ]);
    const service = new SessionProviderService({
      initialProvider: createProvider("ollama", { model: "llama3.3" }), environment: {},
    });
    const pending = service.prepareChild({ provider: "grok", model: "grok-4.6" },
      { model: "grok-4.6", credentialHome: home, extra: { fetchImpl: wire } },
      { signal: stop.signal }, true, undefined,
      { endpoint: "https://api.x.ai/v1", authProfile: "sign_in", billingSource: "sign_in" });
    await vi.waitFor(() => expect(wire).toHaveBeenCalledOnce());
    stop.abort("child stopped");
    const outcome = await Promise.race([
      pending.then(() => "resolved", () => "rejected"),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 150)),
    ]);
    if (outcome === "timed out") release?.();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(outcome).toBe("rejected");
    expect(service.current().provider).toBe("ollama");
  });

  test.each(["request", "response body"] as const)("sign-in model discovery bounds a stalled %s", async (stall) => {
    const home = await createHome(`grok-model-deadline-${stall}`);
    const { assertSignInChildModelEligible } = await import("../../src/llm/sign-in-child-models.js");
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      if (stall === "request") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    });
    await expect(assertSignInChildModelEligible({ provider: "grok", model: "grok-4.6",
      options: { model: "grok-4.6", credentialHome: home, apiKey: "sign-in" },
      environment: {}, fetchImpl, timeoutMs: 25 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(observedSignal?.aborted).toBe(true);
  });

  test("a stopped child does not begin sign-in model discovery", async () => {
    const home = await createHome("grok-model-pre-aborted");
    const { assertSignInChildModelEligible } = await import("../../src/llm/sign-in-child-models.js");
    const stopped = new AbortController();
    stopped.abort("child stopped");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(assertSignInChildModelEligible({ provider: "grok", model: "grok-4.6",
      options: { model: "grok-4.6", credentialHome: home, apiKey: "sign-in" },
      environment: {}, fetchImpl, signal: stopped.signal })).rejects.toThrow(/child stopped/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test.each(["openai", "grok"] as const)("%s selects API billing without deleting a stored OAuth sign-in", async (provider) => {
    const home = await createHome(`choice-${provider}`);
    const { providerOptions, openAiCredentials, xaiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "openai-oauth", accountId: "account" });
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "xai-oauth" });
    const environment = { OPENAI_AUTH_MODE: "api-key", GROK_AUTH_MODE: "api-key", OPENAI_API_KEY: "openai-byok", XAI_API_KEY: "xai-byok" };
    const result = providerOptions.resolveProviderCredentialAuthority(provider, { credentialHome: home }, environment);
    expect(result.credential).toMatchObject({ status: "ready", mode: "api-key", source: "environment" });
    expect(result.factoryOptions.apiKey).toBe(provider === "openai" ? "openai-byok" : "xai-byok");
    expect(result.factoryOptions.extra?.oauth).toBeUndefined();
    expect(openAiCredentials.readOpenAiOauthCredentials(home)?.accessToken).toBe("openai-oauth");
    expect(xaiCredentials.readXaiOauthCredentials(home)?.accessToken).toBe("xai-oauth");
  });

  test.each(["openai", "grok"] as const)("%s selects OAuth even when a factory/environment API key is present", async (provider) => {
    const home = await createHome(`oauth-${provider}`);
    const { providerOptions, openAiCredentials, xaiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "openai-oauth", accountId: "account" });
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "xai-oauth" });
    const result = providerOptions.resolveProviderCredentialAuthority(provider, { credentialHome: home, apiKey: "factory-byok" },
      { OPENAI_AUTH_MODE: "oauth", GROK_AUTH_MODE: "oauth", OPENAI_API_KEY: "env-key", XAI_API_KEY: "env-key" });
    expect(result.credential).toMatchObject({ status: "ready", mode: provider === "openai" ? "openai-oauth" : "xai-oauth" });
    expect(result.factoryOptions.apiKey).toBe(provider === "openai" ? undefined : "xai-oauth");
    if (provider === "openai") expect(result.factoryOptions).toMatchObject({ baseURL: "https://chatgpt.com/backend-api/codex", extra: { authMode: "oauth" } });
  });

  test("cross-provider child preparation keeps OpenAI sign-in on its first-party endpoint", async () => {
    const home = await createHome("child-openai-sign-in");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "child-openai-oauth", accountId: "account" });
    const [{ SessionProviderService }, { createProvider }, { resolveProviderRuntimeRequest }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
      import("../../src/llm/provider-request.js"),
    ]);
    let service!: InstanceType<typeof SessionProviderService>;
    service = new SessionProviderService({
      initialProvider: createProvider("ollama", { model: "llama3.3", baseURL: "http://127.0.0.1:11434" }),
      environment: { OPENAI_AUTH_MODE: "oauth", OPENAI_BASE_URL: "https://untrusted.example.test/v1" },
      resolvePreparationRequest: ({ model }) => ({ requested: resolveProviderRuntimeRequest({
        provider: "openai", model, config: { model_provider: "ollama", model: "llama3.3" },
        environment: service.environment(), credentialHome: home,
      }).requested }),
    });
    const prepared = await service.prepare({ provider: "openai", model: "gpt-5.4" });
    expect(prepared.binding.factoryOptions.baseURL).toBe("https://chatgpt.com/backend-api/codex");
    expect(prepared.binding.factoryOptions.extra?.authMode).toBe("oauth");
    expect(service.current().provider).toBe("ollama");
    const child = service.forkForChild(prepared.binding.instance, { provider: "openai", model: "gpt-5.4" });
    expect(child.current().factoryOptions.baseURL).toBe("https://chatgpt.com/backend-api/codex");
    await prepared.binding.instance.dispose?.();
  });

  test("cross-provider ChatGPT child uses its pinned backend, account and originator", async () => {
    const wire = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer child-openai-oauth");
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account");
      expect(new Headers(init?.headers).get("originator")).toBe("agenc");
      return new Response(JSON.stringify({ models: [{ id: "gpt-6-luna", supports_tool_use: true }] }),
        { headers: { "content-type": "application/json" } });
    });
    const home = await createHome("cross-provider-openai-subscription");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "child-openai-oauth", accountId: "account",
    });
    const [{ SessionProviderService }, { createProvider }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
    ]);
    const service = new SessionProviderService({
      initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth", OPENAI_API_KEY: "leftover-byok",
        OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex" },
    });
    const prepared = await service.prepareChild(
      { provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } },
      {}, true, undefined,
      { endpoint: "https://chatgpt.com/backend-api/codex",
        authProfile: "sign_in", billingSource: "sign_in" },
    );
    expect(prepared.authProfile).toBe("sign_in");
    expect(prepared.billingSource).toBe("sign_in");
    expect(prepared.signInModelCapabilities).toEqual({ supportsToolUse: true });
    expect(prepared.binding.factoryOptions.baseURL).toBe("https://chatgpt.com/backend-api/codex");
    expect(prepared.binding.factoryOptions.extra?.defaultHeaders).toMatchObject({
      "ChatGPT-Account-ID": "account", originator: "agenc",
    });
    const descendantService = service.forkForChild(prepared.binding.instance,
      { provider: "openai", model: "gpt-6-luna" });
    const descendant = await descendantService.prepareChild(
      { provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } },
    );
    expect(descendant.binding.factoryOptions.baseURL).toBe("https://chatgpt.com/backend-api/codex");
    await descendant.binding.instance.dispose?.();
    await prepared.binding.instance.dispose?.();
    expect(wire).toHaveBeenCalledTimes(2);
  });

  test("a BYOK approval refuses a changed ChatGPT sign-in authority before discovery", async () => {
    const home = await createHome("changed-child-authority");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "subscription-bearer", accountId: "account",
    });
    let configuredApiKey: string | undefined = "approved-byok";
    const wire = vi.fn<typeof fetch>(async () => Response.json({ models: [{ id: "gpt-6-luna" }] }));
    const [{ SessionProviderService }, { createProvider }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
    ]);
    const service = new SessionProviderService({
      initialProvider: createProvider("grok", { model: "grok-4.6", apiKey: "parent-key" }),
      environment: {},
      resolvePreparationRequest: ({ model }) => ({ requested: {
        model, credentialHome: home,
        ...(configuredApiKey !== undefined ? { apiKey: configuredApiKey } : {}),
        extra: { fetchImpl: wire },
      } }),
    });
    const selection = { provider: "openai", model: "gpt-6-luna" };
    const approved = await service.previewChildDestination(selection);
    expect(approved).toMatchObject({ endpoint: "https://api.openai.com/v1",
      authProfile: "api_key", billingSource: "byok" });
    configuredApiKey = undefined;
    await expect(service.prepareChild(selection, undefined, {}, true, undefined, approved))
      .rejects.toThrow(/authority differs|new consent/u);
    expect(wire).not.toHaveBeenCalled();
  });

  test("missing DeepSeek BYOK credentials yield an unsent authentication terminal", async () => {
    const [{ SessionProviderService }, { createProvider }, { childTerminalOutcome, childDispatchCertainty }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
      import("../../src/agents/child-terminal.js"),
    ]);
    const service = new SessionProviderService({
      initialProvider: createProvider("grok", { model: "grok-4.6", apiKey: "parent-key" }),
      environment: {},
    });
    const failure = await service.prepareChild({ provider: "deepseek", model: "deepseek-v4-pro" },
      { model: "deepseek-v4-pro" }).then(() => undefined, (error: unknown) => error);
    expect(childTerminalOutcome({ provider: "deepseek", model: "deepseek-v4-pro",
      error: failure, dispatch: childDispatchCertainty(failure) })).toMatchObject({
      reason: "auth_required", retryable: false, dispatch: "not_sent",
    });
  });

  test("ChatGPT child rejects a configured custom endpoint before sending its bearer", async () => {
    const home = await createHome("chatgpt-custom-child-endpoint");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "bearer", accountId: "account" });
    const wire = vi.fn<typeof fetch>(async () => new Response("unexpected"));
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth", OPENAI_BASE_URL: "https://receiver.example/v1" } });
    await expect(service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } }))
      .rejects.toThrow(/default endpoint/u);
    expect(wire).not.toHaveBeenCalled();
  });

  test("three sessions on one home share one rotating ChatGPT refresh", async () => {
    const home = await createHome("shared-chatgpt-refresh");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "old-bearer", refreshToken: "old-refresh", accountId: "account",
    });
    const refresh = vi.fn<typeof fetch>(async (_input, init) => {
      expect(String(init?.body)).toContain("refresh_token=old-refresh");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: "new-bearer", refresh_token: "new-refresh" }),
        { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", refresh);
    const results = await Promise.all([{}, {}, {}].map((environment) =>
      openAiCredentials.refreshOpenAiSubscriptionIfNeeded(home, environment,
        { force: true, rejectedAccessToken: "old-bearer" })));
    expect(refresh).toHaveBeenCalledOnce();
    expect(results.map((result) => result.credentials?.accessToken))
      .toEqual(["new-bearer", "new-bearer", "new-bearer"]);
    const lateChild = await openAiCredentials.refreshOpenAiSubscriptionIfNeeded(home, {},
      { force: true, rejectedAccessToken: "old-bearer" });
    expect(lateChild.credentials?.accessToken).toBe("new-bearer");
    expect(refresh).toHaveBeenCalledOnce();
  });

  test("ChatGPT model-list 401 forces one refresh and retries with the rotated bearer", async () => {
    const home = await createHome("chatgpt-child-401");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "old-bearer", refreshToken: "old-refresh", accountId: "account",
    });
    const tokenRefresh = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: "new-bearer", refresh_token: "new-refresh",
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", tokenRefresh);
    const wire = vi.fn<typeof fetch>(async (_input, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer old-bearer"
        ? new Response("", { status: 401 })
        : new Response(JSON.stringify({ models: [{ id: "gpt-6-luna" }] }),
          { headers: { "content-type": "application/json" } }));
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth" } });
    const prepared = await service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } });
    expect(wire).toHaveBeenCalledTimes(2);
    expect(new Headers(wire.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer new-bearer");
    expect(tokenRefresh).toHaveBeenCalledOnce();
    await prepared.binding.instance.dispose?.();
  });

  test("ChatGPT child inference retries one 401 with the shared refreshed token", async () => {
    const home = await createHome("chatgpt-child-inference-401");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "old-bearer", refreshToken: "old-refresh", accountId: "account",
    });
    const tokenRefresh = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: "new-bearer", refresh_token: "new-refresh",
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", tokenRefresh);
    const inferenceBearers: string[] = [];
    const wire = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/models?")) {
        return Response.json({ models: [{ id: "gpt-6-luna" }] });
      }
      inferenceBearers.push(new Headers(init?.headers).get("authorization") ?? "");
      if (inferenceBearers.length === 1) return Response.json({ error: { message: "expired" } }, { status: 401 });
      const response = { id: "resp_1", status: "completed", model: "gpt-6-luna",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth" } });
    const prepared = await service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } });
    const result = await prepared.binding.instance.chatStream(
      [{ role: "user", content: "hello" }], () => {});
    expect(result.content).toBe("ok");
    expect(inferenceBearers).toEqual(["Bearer old-bearer", "Bearer new-bearer"]);
    expect(tokenRefresh).toHaveBeenCalledOnce();
    expect(service.current().provider).toBe("ollama");
    await prepared.binding.instance.dispose?.();
  });

  test("ChatGPT discovery refresh reaches the first single-wire inference request", async () => {
    const home = await createHome("chatgpt-child-discovery-single-wire");
    const newBearer = `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: "new-account" })).toString("base64url")}.signature`;
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "old-bearer", refreshToken: "old-refresh", accountId: "old-account",
    });
    const tokenRefresh = vi.fn<typeof fetch>(async () => Response.json({
      access_token: newBearer, refresh_token: "new-refresh",
    }));
    vi.stubGlobal("fetch", tokenRefresh);
    const modelBearers: string[] = [];
    const inferenceHeaders: Headers[] = [];
    const wire = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (String(input).includes("/models?")) {
        modelBearers.push(headers.get("authorization") ?? "");
        if (modelBearers.length === 1) return new Response("", { status: 401 });
        expect(headers.get("chatgpt-account-id")).toBe("new-account");
        return Response.json({ models: [{ id: "gpt-6-luna" }] });
      }
      expect(String(input)).toContain("/responses");
      inferenceHeaders.push(headers);
      if (headers.get("authorization") !== `Bearer ${newBearer}` ||
          headers.get("chatgpt-account-id") !== "new-account") {
        return Response.json({ error: { message: "expired" } }, { status: 401 });
      }
      const response = { id: "resp_1", status: "completed", model: "gpt-6-luna",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth" } });
    const prepared = await service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } });
    try {
      const result = await prepared.binding.instance.chatStream(
        [{ role: "user", content: "hello" }], () => {}, { singleWireAttempt: true });
      expect(result.content).toBe("ok");
      expect(modelBearers).toEqual(["Bearer old-bearer", `Bearer ${newBearer}`]);
      expect(inferenceHeaders).toHaveLength(1);
      expect(inferenceHeaders[0]?.get("authorization")).toBe(`Bearer ${newBearer}`);
      expect(inferenceHeaders[0]?.get("chatgpt-account-id")).toBe("new-account");
      expect(tokenRefresh).toHaveBeenCalledOnce();
    } finally {
      await prepared.binding.instance.dispose?.();
    }
  });

  test("failed ChatGPT refresh ends authentication without another model request", async () => {
    const home = await createHome("chatgpt-child-refresh-failed");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, {
      accessToken: "old-bearer", refreshToken: "old-refresh", accountId: "account",
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("denied", { status: 400 })));
    const wire = vi.fn<typeof fetch>(async () => new Response("", { status: 401 }));
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const { classifyChildFailure } = await import("../../src/agents/child-terminal.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth" } });
    const failure = await service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } })
      .then(() => undefined, (error: unknown) => error);
    expect(classifyChildFailure("openai", failure).reason).toBe("auth_required");
    expect(wire).toHaveBeenCalledOnce();
    expect(service.current().provider).toBe("ollama");
  });

  test("subscription model-list usage limit ends with funds and provider retry-after", async () => {
    const home = await createHome("chatgpt-child-limit");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "bearer", accountId: "account" });
    const wire = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: "usage_limit_reached" },
    }), { status: 429, headers: { "retry-after": "37" } }));
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const { classifyChildFailure } = await import("../../src/agents/child-terminal.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth" } });
    const failure = await service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home, extra: { fetchImpl: wire } })
      .then(() => undefined, (error: unknown) => error);
    expect(classifyChildFailure("openai", failure)).toMatchObject({
      reason: "insufficient_funds", retryable: false, retryAfterMs: 37_000,
    });
    expect(wire).toHaveBeenCalledOnce();
  });

  test("Grok sign-in child uses api.x.ai and refuses a model absent from its sign-in list", async () => {
    const home = await createHome("grok-child-models");
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "xai-oauth" });
    const wire = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-oauth");
      return new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }),
        { headers: { "content-type": "application/json" } });
    });
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { GROK_AUTH_MODE: "oauth" } });
    const prepared = await service.prepareChild({ provider: "grok", model: "grok-4.6" },
      { model: "grok-4.6", credentialHome: home, extra: { fetchImpl: wire } });
    expect(prepared.binding.factoryOptions.baseURL).toBe("https://api.x.ai/v1");
    expect(prepared.billingSource).toBe("sign_in");
    await prepared.binding.instance.dispose?.();
    await expect(service.prepareChild({ provider: "grok", model: "grok-4.7" },
      { model: "grok-4.7", credentialHome: home, extra: { fetchImpl: wire } }))
      .rejects.toThrow(/not served by this sign-in/u);
    const { childTerminalOutcome } = await import("../../src/agents/child-terminal.js");
    const failure = await service.prepareChild({ provider: "grok", model: "grok-4.7" },
      { model: "grok-4.7", credentialHome: home, extra: { fetchImpl: wire } })
      .then(() => undefined, (error: unknown) => error);
    expect(childTerminalOutcome({ provider: "grok", model: "grok-4.7", error: failure,
      dispatch: "not_sent" })).toMatchObject({ reason: "model_unavailable", retryable: false,
      dispatch: "not_sent" });
  });

  test("Grok discovery refresh reaches the first single-wire inference request", async () => {
    const home = await createHome("grok-child-discovery-single-wire");
    vi.doMock("../../src/utils/model/providers.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/utils/model/providers.js")>(),
      getSelectedProviderEnvironment: () => ({ AGENC_XAI_STORE: "0" }),
    }));
    const tokenRefresh = vi.fn(async () => ({
      accessToken: "new-xai-bearer", refreshToken: "new-xai-refresh",
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    }));
    vi.doMock("../../src/services/xai/oauth.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/services/xai/oauth.js")>(),
      refreshXaiOauthTokens: tokenRefresh,
    }));
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, {
      accessToken: "old-xai-bearer", refreshToken: "old-xai-refresh",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    });
    const modelBearers: string[] = [];
    const inferenceBearers: string[] = [];
    const wire = vi.fn<typeof fetch>(async (input, init) => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      if (String(input).endsWith("/models")) {
        modelBearers.push(bearer);
        return modelBearers.length === 1
          ? new Response("", { status: 401 })
          : Response.json({ data: [{ id: "grok-4.6" }] });
      }
      expect(String(input)).toContain("/responses");
      inferenceBearers.push(bearer);
      if (bearer !== "Bearer new-xai-bearer") {
        return Response.json({ error: { message: "expired" } }, { status: 401 });
      }
      const response = { id: "resp_1", status: "completed", model: "grok-4.6",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { GROK_AUTH_MODE: "oauth" } });
    const prepared = await service.prepareChild({ provider: "grok", model: "grok-4.6" },
      { model: "grok-4.6", credentialHome: home, extra: { fetchImpl: wire } });
    try {
      const result = await prepared.binding.instance.chatStream(
        [{ role: "user", content: "hello" }], () => {}, { singleWireAttempt: true });
      expect(result.content).toBe("ok");
      expect(modelBearers).toEqual(["Bearer old-xai-bearer", "Bearer new-xai-bearer"]);
      expect(inferenceBearers).toEqual(["Bearer new-xai-bearer"]);
      expect(tokenRefresh).toHaveBeenCalledOnce();
    } finally {
      await prepared.binding.instance.dispose?.();
    }
  });

  test("a signed-out sign-in child cannot be prepared again after restart", async () => {
    const home = await createHome("signed-out-child");
    const { openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "bearer", accountId: "account" });
    openAiCredentials.clearOpenAiOauthCredentials(home);
    const { SessionProviderService } = await import("../../src/session/provider-service.js");
    const { createProvider } = await import("../../src/llm/provider.js");
    const { classifyChildFailure } = await import("../../src/agents/child-terminal.js");
    const service = new SessionProviderService({ initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { OPENAI_AUTH_MODE: "oauth" } });
    const failure = await service.prepareChild({ provider: "openai", model: "gpt-6-luna" },
      { model: "gpt-6-luna", credentialHome: home }).then(() => undefined, (error: unknown) => error);
    expect(classifyChildFailure("openai", failure).reason).toBe("auth_required");
  });

  test("cross-provider child preparation pins xAI sign-in and refuses a custom host", async () => {
    const home = await createHome("child-xai-sign-in");
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "child-xai-oauth" });
    const [{ SessionProviderService }, { createProvider }, { resolveProviderRuntimeRequest }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
      import("../../src/llm/provider-request.js"),
    ]);
    const makeService = (environment: Record<string, string>) => {
      let service!: InstanceType<typeof SessionProviderService>;
      service = new SessionProviderService({
        initialProvider: createProvider("ollama", { model: "llama3.3", baseURL: "http://127.0.0.1:11434" }),
        environment,
        resolvePreparationRequest: ({ model }) => ({ requested: resolveProviderRuntimeRequest({
          provider: "grok", model, config: { model_provider: "ollama", model: "llama3.3" },
          environment: service.environment(), credentialHome: home,
        }).requested }),
      });
      return service;
    };
    const firstParty = makeService({ GROK_AUTH_MODE: "oauth" });
    const prepared = await firstParty.prepare({ provider: "grok", model: "grok-4.6" });
    expect(prepared.binding.factoryOptions.baseURL).toBe("https://api.x.ai/v1");
    expect(prepared.binding.factoryOptions.apiKey).toBe("child-xai-oauth");
    const child = firstParty.forkForChild(prepared.binding.instance, { provider: "grok", model: "grok-4.6" });
    expect(child.current().factoryOptions.baseURL).toBe("https://api.x.ai/v1");
    const custom = makeService({ GROK_AUTH_MODE: "oauth", XAI_BASE_URL: "https://untrusted.example.test/v1" });
    await expect(custom.prepare({ provider: "grok", model: "grok-4.6" }))
      .rejects.toThrow(/xAI sign-in credentials.*custom Grok base URL/u);
    await prepared.binding.instance.dispose?.();
  });

  test("an approved Grok BYOK child keeps API-key billing after a sign-in is saved before its session fork", async () => {
    const home = await createHome("grok-child-billing-fork");
    const { xaiCredentials } = await loadCredentialModules();
    const [{ SessionProviderService }, { createProvider, readProviderFactoryOptions }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
    ]);
    const service = new SessionProviderService({
      initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { XAI_API_KEY: "approved-byok" },
    });
    const prepared = await service.prepareChild(
      { provider: "grok", model: "grok-4.6" },
      { model: "grok-4.6", credentialHome: home }, {}, true, undefined,
      { endpoint: "https://api.x.ai/v1", authProfile: "api_key", billingSource: "byok" },
    );
    expect(prepared.authProfile).toBe("api_key");
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "later-sign-in" });
    const fork = prepared.binding.instance.forkForSession?.({ cwd: testRoot });
    expect(fork).toBeDefined();
    expect(readProviderFactoryOptions(fork!).extra?.authMode).toBe("api_key");
    expect(readProviderFactoryOptions(fork!).apiKey).toBe("approved-byok");
    await fork?.dispose?.();
    await prepared.binding.instance.dispose?.();
  });

  test("an approved Grok sign-in child cannot fork onto API billing after sign-out", async () => {
    const home = await createHome("grok-child-sign-in-fork");
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "approved-sign-in" });
    const wire = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "grok-4.6" }] }));
    const [{ SessionProviderService }, { createProvider }, { classifyChildFailure, childDispatchCertainty }] = await Promise.all([
      import("../../src/session/provider-service.js"),
      import("../../src/llm/provider.js"),
      import("../../src/agents/child-terminal.js"),
    ]);
    const service = new SessionProviderService({
      initialProvider: createProvider("ollama", { model: "llama3.3" }),
      environment: { XAI_API_KEY: "fallback-byok" },
    });
    const prepared = await service.prepareChild(
      { provider: "grok", model: "grok-4.6" },
      { model: "grok-4.6", credentialHome: home, extra: { fetchImpl: wire } },
      {}, true, undefined,
      { endpoint: "https://api.x.ai/v1", authProfile: "sign_in", billingSource: "sign_in" },
    );
    xaiCredentials.clearXaiOauthCredentials(home);
    let failure: unknown;
    try { prepared.binding.instance.forkForSession?.({ cwd: testRoot }); }
    catch (error) { failure = error; }
    expect(String(failure)).toMatch(/sign-in.*(missing|unavailable|expired)/iu);
    expect(classifyChildFailure("grok", failure)).toMatchObject({ reason: "auth_required", retryable: false });
    expect(childDispatchCertainty(failure)).toBe("not_sent");
    await prepared.binding.instance.dispose?.();
  });

  test.each(["openai", "grok"] as const)("%s never falls back to paid API credentials when selected OAuth is absent", async (provider) => {
    const home = await createHome(`absent-${provider}`);
    const { providerOptions } = await loadCredentialModules();
    const readSavedApiKey = vi.fn(async () => "saved-paid-key");
    const authBackend = managedAuthBackend();
    const result = await providerOptions.resolveProviderRuntimeAuthority(provider, { credentialHome: home, apiKey: "factory-paid-key" },
      { OPENAI_AUTH_MODE: "oauth", GROK_AUTH_MODE: "oauth", OPENAI_API_KEY: "env-paid-key", XAI_API_KEY: "env-paid-key" }, { readSavedApiKey, managedKeysEnabled: true, authBackend, sessionId: "oauth-selection", subscriptionTier: "pro" });
    expect(result.credential).toMatchObject({ status: "missing", reason: "mode-required" });
    expect(result.factoryOptions.apiKey).toBeUndefined();
    expect(result.managedCredential).toBe(false);
    expect(readSavedApiKey).not.toHaveBeenCalled();
    expect(authBackend.vendKey).not.toHaveBeenCalled();
  });

  test.each(["openai", "grok"] as const)("%s never substitutes managed credentials for explicit API-key mode", async (provider) => {
    const home = await createHome(`managed-blocked-${provider}`);
    const { providerOptions } = await loadCredentialModules();
    const authBackend = managedAuthBackend();
    const readSavedApiKey = vi.fn(async () => undefined);
    const result = await providerOptions.resolveProviderRuntimeAuthority(
      provider,
      { credentialHome: home },
      { OPENAI_AUTH_MODE: "api-key", GROK_AUTH_MODE: "api-key" },
      { readSavedApiKey, managedKeysEnabled: true, authBackend, sessionId: "api-selection", subscriptionTier: "pro" },
    );

    expect(result.credential.status).toBe("missing");
    expect(result.managedCredential).toBe(false);
    expect(readSavedApiKey).toHaveBeenCalledExactlyOnceWith(provider);
    expect(authBackend.vendKey).not.toHaveBeenCalled();
  });

  test.each(["openai", "grok"] as const)("%s never substitutes OAuth when explicit API mode has no key", async (provider) => {
    const home = await createHome(`missing-key-${provider}`);
    const { providerOptions, openAiCredentials, xaiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "openai-oauth", accountId: "account" });
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "xai-oauth" });
    const result = providerOptions.resolveProviderCredentialAuthority(provider, { credentialHome: home }, { OPENAI_AUTH_MODE: "api-key", GROK_AUTH_MODE: "api-key" });
    expect(result.credential.status).toBe("missing");
    expect(result.factoryOptions.apiKey).toBeUndefined();
    expect(result.factoryOptions.extra?.oauth).toBeUndefined();
  });

  test("preserves per-session auth snapshots when a future session chooses another method", async () => {
    const home = await createHome("frozen-auth");
    const { providerOptions, openAiCredentials } = await loadCredentialModules();
    openAiCredentials.saveOpenAiOauthCredentials(home, { accessToken: "oauth-token", accountId: "account" });
    const { collectDaemonClientEnvOverrides, mergeDaemonClientEnvironment } = await import("../../src/app-server/client-env-snapshot.js");
    const environment = { OPENAI_AUTH_MODE: "oauth", OPENAI_API_KEY: "byok" };
    const original = providerOptions.snapshotProviderEnvironment(mergeDaemonClientEnvironment({}, collectDaemonClientEnvOverrides(environment))!);
    environment.OPENAI_AUTH_MODE = "api-key";
    const future = providerOptions.snapshotProviderEnvironment(mergeDaemonClientEnvironment({}, collectDaemonClientEnvOverrides(environment))!);
    expect(providerOptions.resolveProviderCredentialAuthority("openai", { credentialHome: home }, original).credential).toMatchObject({ mode: "openai-oauth" });
    expect(providerOptions.resolveProviderCredentialAuthority("openai", { credentialHome: home }, future).credential).toMatchObject({ mode: "api-key" });
    expect(original.OPENAI_AUTH_MODE).toBe("oauth");
    expect(Object.isFrozen(original)).toBe(true);
  });

  test("Grok media credential discovery follows explicit auth selection", async () => {
    const home = await createHome("grok-media");
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
    const media = await import("../../src/llm/xai-capability-config.js");
    expect(media.resolveXaiBearerToken(home, { GROK_AUTH_MODE: "api-key", XAI_API_KEY: "byok" })).toBe("byok");
    expect(media.resolveXaiBearerToken(home, { GROK_AUTH_MODE: "oauth", XAI_API_KEY: "byok" })).toBe("oauth-token");
    expect(media.hasXaiCredentials(home, { GROK_AUTH_MODE: "api-key" })).toBe(false);
    expect(media.resolveXaiBearerTokenForBaseUrl(
      home, {}, "https://api.x.ai/v1",
    )).toBe("oauth-token");
    expect(() => media.resolveXaiBearerTokenForBaseUrl(
      home, { XAI_BASE_URL: "https://gateway.example.test/v1" },
      "https://gateway.example.test/v1",
    )).toThrow(/xAI sign-in credentials.*custom Grok base URL/);
    expect(media.resolveXaiBearerTokenForBaseUrl(
      home, { GROK_AUTH_MODE: "api-key", XAI_API_KEY: "byok" },
      "https://gateway.example.test/v1",
    )).toBe("byok");
  });

  test("custom Grok URL uses the explicit gateway key before environment or saved keys", async () => {
    const home = await createHome("explicit-gateway");
    const { providerOptions, xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      { credentialHome: home, model: "grok-4.6", apiKey: "gateway-key",
        baseURL: "https://gateway.example.test/v1" },
      { XAI_API_KEY: "other-endpoint-env-key" },
      { savedApiKey: "other-endpoint-saved-key" },
    );
    expect(resolved.factoryOptions.apiKey).toBe("gateway-key");
    expect(resolved.factoryOptions.extra?.authMode).toBe("api_key");
  });

  test("XSearch uses the selected key on a custom URL and keeps direct OAuth while signed in", async () => {
    const home = await createHome("xsearch-custom");
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
    const { createProvider } = await import("../../src/llm/provider.js");
    const { createModelFacingTools } = await import("../../src/bin/model-facing-tools.js");
    const { runWithStartupProviderSelection } = await import("../../src/utils/model/providers.js");
    const sessionProvider = createProvider("grok", {
      credentialHome: home, apiKey: "gateway-key", model: "grok-4.6",
      baseURL: "https://gateway.example.test/v1", extra: { authMode: "api_key" },
    });
    const chat = vi.fn(async () => ({
      content: "Found a post https://x.com/xai/status/1", toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "grok-4.6", finishReason: "stop" as const,
      providerEvidence: { citations: ["https://x.com/xai/status/1"],
        serverSideToolCalls: [{ type: "x_search_call", toolType: "x_search", id: "c1" }] },
    }));
    const factory = vi.fn((...args: Parameters<typeof createProvider>) =>
      Object.assign(createProvider(...args), { chat }));
    const environment = { AGENC_HOME: home.path, XAI_API_KEY: "gateway-key",
      XAI_BASE_URL: "https://gateway.example.test/v1" };
    await runWithStartupProviderSelection({ provider: "grok", model: "grok-4.6",
      environment }, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home.path,
        getSession: () => ({ conversationId: "xsearch-custom", nextInternalSubId: () => "xsearch-1",
          services: { admissionRequired: false, provider: sessionProvider } }) as never,
        sessionProvider: "grok", sessionBaseURL: "https://gateway.example.test/v1",
        env: environment,
        grokCapabilities: { x_search: true }, providerFactory: factory,
      });
      const result = await tools.find((tool) => tool.name === "XSearch")!.execute({ query: "xAI" });
      expect(result.isError).toBeUndefined();
      expect(factory).toHaveBeenCalledWith("grok", expect.objectContaining({
        apiKey: "gateway-key", baseURL: "https://gateway.example.test/v1",
        extra: expect.objectContaining({ authMode: "api_key" }),
      }));
      expect(chat).toHaveBeenCalled();
    });

    factory.mockClear();
    chat.mockClear();
    const metaProvider = createProvider("meta", {
      apiKey: "meta-key", model: "muse-spark-1.3", baseURL: "https://api.meta.ai/v1",
    });
    await runWithStartupProviderSelection({ provider: "meta", model: "muse-spark-1.3",
      environment: { AGENC_HOME: home.path } }, async () => {
      const directTools = createModelFacingTools({
        workspaceRoot: process.cwd(), agencHome: home.path,
        getSession: () => ({ conversationId: "xsearch-oauth", nextInternalSubId: () => "xsearch-2",
          services: { admissionRequired: false, provider: metaProvider } }) as never,
        sessionProvider: "meta", env: { AGENC_HOME: home.path },
        grokCapabilities: { x_search: true }, providerFactory: factory,
      });
      const directResult = await directTools.find((tool) => tool.name === "XSearch")!
        .execute({ query: "xAI" });
      expect(directResult.isError).toBeUndefined();
      expect(factory).toHaveBeenCalledWith("grok", expect.objectContaining({
        apiKey: "oauth-token", baseURL: "https://api.x.ai/v1",
      }));
      expect(factory.mock.calls[0]?.[1].extra?.authMode).toBeUndefined();
      expect(chat).toHaveBeenCalled();
    });
  });

  test.each(["XAI_API_KEY", "GROK_API_KEY"] as const)(
    "Grok media uses %s for a custom URL in automatic mode", async (keyName) => {
      const home = await createHome("grok-media-custom-auto");
      const { xaiCredentials } = await loadCredentialModules();
      xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
      const media = await import("../../src/llm/xai-capability-config.js");

      expect(media.resolveXaiBearerTokenForBaseUrl(
        home, { [keyName]: "env-api-key" }, "https://gateway.example.test/v1",
      )).toBe("env-api-key");
    },
  );

  test("rejects invalid auth intent and conflicting OpenAI OAuth factory state", async () => {
    const { providerOptions } = await loadCredentialModules();
    expect(() => providerOptions.resolveProviderCredentialAuthority("openai", {}, { OPENAI_AUTH_MODE: "typo" })).toThrow("OPENAI_AUTH_MODE must be");
    expect(() => providerOptions.resolveProviderCredentialAuthority("openai", { extra: { authMode: "oauth" } }, { OPENAI_AUTH_MODE: "api-key" })).toThrow("conflicts with OAuth");
  });

  test("does not let explicit Grok API mode fall back to a composer CLI cached login", async () => {
    const home = await createHome("composer-selection");
    const { providerOptions, xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
    const missing = providerOptions.resolveProviderCredentialAuthority("grok", { credentialHome: home, model: "grok-composer-1" }, { GROK_AUTH_MODE: "api-key" });
    expect(missing.credential.status).toBe("missing");
    const available = providerOptions.resolveProviderCredentialAuthority("grok", { credentialHome: home, model: "grok-composer-1" }, { GROK_AUTH_MODE: "api-key", XAI_API_KEY: "byok" });
    expect(available.credential).toMatchObject({ mode: "api-key", status: "ready" });
    expect(available.factoryOptions.apiKey).toBe("byok");
  });

  test("uses Grok OAuth from the exact HomeContext when the environment omits AGENC_HOME", async () => {
    const selectedHome = await createHome("selected");
    const otherHome = await createHome("other");
    const { providerOptions, xaiCredentials } = await loadCredentialModules();

    expect(
      xaiCredentials.saveXaiOauthCredentials(selectedHome, {
        accessToken: "selected-xai-oauth",
      }).success,
    ).toBe(true);
    expect(
      xaiCredentials.saveXaiOauthCredentials(otherHome, {
        accessToken: "other-xai-oauth",
      }).success,
    ).toBe(true);

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      {
        credentialHome: selectedHome,
        model: "grok-4.6",
      },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "xai-oauth",
      source: "native-sign-in",
    });
    expect(resolved.factoryOptions).toMatchObject({
      credentialHome: selectedHome,
      model: "grok-4.6",
      apiKey: "selected-xai-oauth",
    });
  });

  test.each(["XAI_BASE_URL", "GROK_BASE_URL"] as const)(
    "never resolves a Grok sign-in token for custom %s",
    async (baseUrlName) => {
      const home = await createHome(`custom-${baseUrlName}`);
      const { providerOptions, xaiCredentials } = await loadCredentialModules();
      xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "fake-xai-sign-in-token" });
      const customUrl = "https://gateway.example.test/v1";

      expect(() => providerOptions.resolveProviderCredentialAuthority(
        "grok", { credentialHome: home, model: "grok-4.6" },
        { [baseUrlName]: customUrl },
      )).toThrow(/xAI sign-in credentials.*custom.*base URL/i);

      const withKey = providerOptions.resolveProviderCredentialAuthority(
        "grok", { credentialHome: home, model: "grok-4.6" },
        { [baseUrlName]: customUrl, XAI_API_KEY: "fake-xai-api-key" },
      );
      expect(withKey.credential).toMatchObject({ mode: "api-key", status: "ready" });
      expect(withKey.factoryOptions).toMatchObject({
        apiKey: "fake-xai-api-key",
        baseURL: customUrl,
        extra: { authMode: "api_key" },
      });
      expect(JSON.stringify(withKey.factoryOptions)).not.toContain("fake-xai-sign-in-token");
      expect(() => providerOptions.resolveProviderCredentialAuthority(
        "grok", { credentialHome: home, model: "grok-4.6" },
        { [baseUrlName]: customUrl, XAI_API_KEY: "fake-xai-api-key", GROK_AUTH_MODE: "oauth" },
      )).toThrow(/xAI sign-in credentials.*custom Grok base URL/);
    },
  );

  test("replayed Grok OAuth options cannot become a gateway API key after refresh", async () => {
    const home = await createHome("rotated-grok-oauth");
    const { providerOptions, xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token-t1" });
    const recorded = providerOptions.resolveProviderCredentialAuthority(
      "grok", { credentialHome: home, model: "grok-4.6" }, {},
    ).factoryOptions;
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token-t2" });
    const replayed = {
      ...recorded,
      baseURL: "https://gateway.example.test/v1",
      extra: { ...recorded.extra, authMode: "api_key" },
    };

    expect(() => providerOptions.resolveProviderCredentialAuthority(
      "grok", replayed, { GROK_AUTH_MODE: "api-key" },
    )).toThrow(/xAI sign-in token/);
    const { createProvider } = await import("../../src/llm/provider.js");
    expect(() => createProvider("grok", replayed)).toThrow(/xAI sign-in token/);
  });

  test.each(["explicit", "environment"] as const)(
    "rejects a revoked Grok sign-in token from the %s key in automatic mode on a custom URL",
    async (source) => {
      const home = await createHome(`revoked-custom-${source}`);
      const { providerOptions, xaiCredentials } = await loadCredentialModules();
      xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token-t1" });
      xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token-t2" });
      xaiCredentials.clearXaiOauthCredentials(home);
      expect(xaiCredentials.readXaiOauthAccessToken(home)).toBeUndefined();
      expect(xaiCredentials.isXaiOauthBearer(home, "oauth-token-t1")).toBe(true);

      const requested = {
        credentialHome: home,
        model: "grok-4.6",
        baseURL: "https://gateway.example.test/v1",
        ...(source === "explicit" ? { apiKey: "oauth-token-t1" } : {}),
      };
      const environment = source === "environment"
        ? { XAI_API_KEY: "oauth-token-t1" }
        : {};
      expect(() => providerOptions.resolveProviderCredentialAuthority(
        "grok", requested, environment,
      )).toThrow(/xAI sign-in credentials.*custom Grok base URL/);

      const { resolveGrokProviderCredential } = await import("../../src/llm/xai-capability-config.js");
      expect(resolveGrokProviderCredential(home, requested.apiKey, environment)).toEqual({
        value: "oauth-token-t1",
        isOAuth: true,
      });
    },
  );

  test("registers unrelated tools when a custom xAI host has only stored OAuth", async () => {
    const home = await createHome("oauth-only-xsearch-custom-host");
    const { xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
    const { createProvider } = await import("../../src/llm/provider.js");
    const { createModelFacingTools } = await import("../../src/bin/model-facing-tools.js");
    const { runWithStartupProviderSelection } = await import("../../src/utils/model/providers.js");
    const metaProvider = createProvider("meta", {
      apiKey: "meta-key", model: "muse-spark-1.3", baseURL: "https://api.meta.ai/v1",
    });
    const environment = {
      AGENC_HOME: home.path,
      XAI_BASE_URL: "https://cli-chat-proxy.grok.com/v1",
    };
    await runWithStartupProviderSelection({
      provider: "meta", model: "muse-spark-1.3", environment,
    }, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home.path,
        getSession: () => ({ services: { provider: metaProvider } }) as never,
        sessionProvider: "meta",
        env: environment,
        grokCapabilities: { x_search: true },
      });
      expect(tools.some((tool) => tool.name === "XSearch")).toBe(false);
      expect(tools.some((tool) => tool.name === "NotebookRead")).toBe(true);
    });
  });

  test("loads saved Grok BYOK before rejecting a custom URL", async () => {
    const home = await createHome("saved-grok-custom-url");
    const { providerOptions, xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "oauth-token" });
    const readSavedApiKey = vi.fn(async () => "saved-api-key");
    const resolved = await providerOptions.resolveProviderRuntimeAuthority(
      "grok",
      { credentialHome: home, model: "grok-4.6" },
      { XAI_BASE_URL: "https://gateway.example.test/v1" },
      { readSavedApiKey },
    );

    expect(readSavedApiKey).toHaveBeenCalledExactlyOnceWith("grok");
    expect(resolved.credential).toMatchObject({ status: "ready", mode: "api-key", source: "saved-byok" });
    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "saved-api-key",
      baseURL: "https://gateway.example.test/v1",
      extra: { authMode: "api_key" },
    });
  });

  test("reports Grok environment API keys through the same authority", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      { model: "grok-4.6" },
      { XAI_API_KEY: "xai-environment-key" },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
    });
    expect(resolved.factoryOptions.apiKey).toBe("xai-environment-key");
  });

  test("trims API keys while preserving explicit and environment precedence", async () => {
    const { providerOptions } = await loadCredentialModules();

    const explicit = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      {
        apiKey: "  explicit-key\t",
        model: "grok-4.6",
      },
      {
        XAI_API_KEY: "  xai-environment-key  ",
        GROK_API_KEY: "grok-environment-key",
      },
      { savedApiKey: "saved-key" },
    );

    expect(explicit.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "explicit",
    });
    expect(explicit.factoryOptions.apiKey).toBe("explicit-key");

    const environment = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      {
        apiKey: " \t\n ",
        model: "grok-4.6",
      },
      {
        XAI_API_KEY: " \n ",
        GROK_API_KEY: "  grok-environment-key\t",
      },
      { savedApiKey: "saved-key" },
    );

    expect(environment.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
      provenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "GROK_API_KEY" }],
      },
    });
    expect(environment.factoryOptions.apiKey).toBe("grok-environment-key");
  });

  test("treats empty credentials as absent before saved BYOK fallback", async () => {
    const { providerOptions } = await loadCredentialModules();

    const saved = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      {
        apiKey: " \t\n ",
        model: "claude-opus-4-7",
      },
      {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "  ",
      },
      { savedApiKey: "  saved-anthropic-key  " },
    );

    expect(saved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "saved-byok",
    });
    expect(saved.factoryOptions.apiKey).toBe("saved-anthropic-key");

    const missing = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      {
        apiKey: " ",
        model: "claude-opus-4-7",
      },
      {
        ANTHROPIC_API_KEY: "\t",
        ANTHROPIC_AUTH_TOKEN: "\n",
      },
      { savedApiKey: "  " },
    );

    expect(missing.credential).toMatchObject({
      status: "missing",
      mode: "none",
      reason: "absent",
      missingLabel: "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN",
    });
    expect(missing.factoryOptions.apiKey).toBeUndefined();
    expect(missing.factoryOptions.authToken).toBeUndefined();
  });

  test("isolates credential selection from later environment mutation", async () => {
    const { providerOptions } = await loadCredentialModules();
    const sourceEnvironment: Record<string, string | undefined> = {
      XAI_API_KEY: "captured-xai-key",
      GROK_API_KEY: "captured-grok-key",
    };
    const capturedEnvironment = providerOptions.snapshotProviderEnvironment(
      sourceEnvironment,
    );

    sourceEnvironment.XAI_API_KEY = "mutated-xai-key";
    sourceEnvironment.GROK_API_KEY = undefined;

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      { model: "grok-4.6" },
      capturedEnvironment,
    );

    expect(Object.isFrozen(capturedEnvironment)).toBe(true);
    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
      provenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "XAI_API_KEY" }],
      },
    });
    expect(resolved.factoryOptions.apiKey).toBe("captured-xai-key");
  });

  test("does not require a provider credential for Grok composer models", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      { model: "grok-composer-2.5-fast" },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "not-required",
      mode: "none",
    });
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
  });

  test("does not project a stored Grok sign-in token into composer CLI options", async () => {
    const home = await createHome("composer-oauth");
    const { providerOptions, xaiCredentials } = await loadCredentialModules();
    xaiCredentials.saveXaiOauthCredentials(home, { accessToken: "fake-xai-sign-in-token" });
    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok", { credentialHome: home, model: "grok-composer-2.5-fast" }, {},
    );
    expect(JSON.stringify(resolved.factoryOptions)).not.toContain("fake-xai-sign-in-token");
  });

  test("projects Grok composer inputs from one captured client", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "grok",
      {
        model: "grok-composer-2.5-fast",
        extra: {
          grokAcp: {
            environment: {
              PATH: "/client/bin",
              HOME: "/client/home",
              LANG: "en_CA.UTF-8",
            },
          },
        },
      },
      {
        GROK_API_KEY: "client-grok-key",
        AGENC_GROK_CLI: "/client/bin/grok",
        AGENC_GROK_ACP_PERMISSIONS: "allow",
        PATH: "/client/bin",
      },
    );

    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "client-grok-key",
      extra: {
        grokAcp: {
          binaryPath: "/client/bin/grok",
          allowPermissions: true,
          path: "/client/bin",
          environment: {
            PATH: "/client/bin",
            HOME: "/client/home",
            LANG: "en_CA.UTF-8",
          },
        },
      },
    });
  });

  test("projects OpenRouter attribution headers from one captured client", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "openrouter",
      {
        model: "openai/gpt-5",
        extra: {
          defaultHeaders: { "X-Explicit": "kept" },
        },
      },
      {
        OPENROUTER_API_KEY: "client-openrouter-key",
        AGENC_OPENROUTER_HTTP_REFERER: "https://client.example",
        AGENC_OPENROUTER_TITLE: "Client title",
      },
    );

    expect(resolved.factoryOptions.extra).toMatchObject({
      defaultHeaders: {
        "HTTP-Referer": "https://client.example",
        "X-Title": "Client title",
        "X-Explicit": "kept",
      },
    });
  });

  test("recognizes a stored OpenAI ChatGPT subscription", async () => {
    const home = await createHome("openai-chatgpt");
    const { providerOptions, openAiCredentials } =
      await loadCredentialModules();
    expect(
      openAiCredentials.saveOpenAiOauthCredentials(home, {
        accessToken: "chatgpt-access-token",
        accountId: "chatgpt-account",
      }).success,
    ).toBe(true);

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "openai",
      { credentialHome: home, model: "gpt-5" },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "openai-oauth",
      source: "native-sign-in",
    });
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
    expect(resolved.factoryOptions.extra).toMatchObject({
      authMode: "oauth",
      chatgptBackend: true,
    });
  });

  test("recognizes a stored OpenAI platform key", async () => {
    const home = await createHome("openai-platform");
    const { providerOptions, openAiCredentials } =
      await loadCredentialModules();
    expect(
      openAiCredentials.saveOpenAiOauthCredentials(home, {
        apiKey: "stored-openai-platform-key",
      }),
    ).toMatchObject({ success: true });

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "openai",
      { credentialHome: home, model: "gpt-5" },
      { OPENAI_API_KEY: "ignored-environment-key" },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "native-sign-in",
    });
    expect(resolved.factoryOptions.apiKey).toBe("stored-openai-platform-key");
  });

  test("keeps an explicit OpenAI key ahead of stored native credentials", async () => {
    const home = await createHome("openai-explicit");
    const { providerOptions, openAiCredentials } =
      await loadCredentialModules();
    expect(
      openAiCredentials.saveOpenAiOauthCredentials(home, {
        apiKey: "stored-openai-platform-key",
      }).success,
    ).toBe(true);

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "openai",
      {
        apiKey: "explicit-openai-key",
        credentialHome: home,
        model: "gpt-5",
      },
      {
        OPENAI_API_KEY: "environment-openai-key",
        OPENAI_ORGANIZATION: "openai-org",
        OPENAI_PROJECT: "openai-project",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "explicit",
    });
    expect(resolved.factoryOptions.apiKey).toBe("explicit-openai-key");
    expect(resolved.factoryOptions.extra).toMatchObject({
      organization: "openai-org",
      project: "openai-project",
    });
  });

  test.each([
    {
      name: "Gemini API key",
      environment: {
        GEMINI_API_KEY: "gemini-environment-key",
      },
      mode: "api-key",
      plan: {
        kind: "api-key",
        credential: "gemini-environment-key",
        source: "GEMINI_API_KEY",
      },
    },
    {
      name: "Gemini access token",
      environment: {
        GEMINI_ACCESS_TOKEN: "gemini-access-token",
        GOOGLE_CLOUD_PROJECT: "gemini-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
      mode: "gemini-access-token",
      plan: {
        kind: "access-token",
        credential: "gemini-access-token",
        source: "GEMINI_ACCESS_TOKEN",
      },
    },
  ])(
    "recognizes $name environment credentials",
    async ({ environment, mode, plan }) => {
      const { providerOptions } = await loadCredentialModules();

      const resolved = providerOptions.resolveProviderCredentialAuthority(
        "gemini",
        { model: "gemini-2.5-pro" },
        environment,
      );

      expect(resolved.credential).toMatchObject({
        status: "ready",
        mode,
        source: "environment",
      });
      if (plan.kind === "api-key") {
        expect(resolved.credential).toMatchObject({
          provenance: {
            kind: "environment",
            fields: [{ role: "apiKey", envVar: plan.source }],
          },
        });
      }
      expect(resolved.factoryOptions.apiKey).toBeUndefined();
      expect(resolved.factoryOptions.extra).toMatchObject({
        gemini: { credentialPlan: plan },
      });
    },
  );

  test("recognizes a saved Gemini BYOK key", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      {},
      { savedApiKey: "saved-gemini-key" },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "saved-byok",
    });
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "api-key",
          credential: "saved-gemini-key",
          source: "saved-byok",
        },
      },
    });
  });

  test("resolves saved Gemini BYOK in explicit API-key mode without losing provenance", async () => {
    const { providerOptions } = await loadCredentialModules();
    const readSavedApiKey = vi.fn(async () => "saved-gemini-key");

    const resolved = await providerOptions.resolveProviderRuntimeAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      { GEMINI_AUTH_MODE: "api-key" },
      { readSavedApiKey },
    );

    expect(readSavedApiKey).toHaveBeenCalledExactlyOnceWith("gemini");
    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "saved-byok",
    });
    expect(resolved.managedCredential).toBe(false);
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "api-key",
          credential: "saved-gemini-key",
          source: "saved-byok",
        },
      },
    });
  });

  test.each(["access-token", "adc"] as const)("does not replace Gemini %s mode with saved BYOK", async (mode) => {
    const { providerOptions } = await loadCredentialModules();
    const readSavedApiKey = vi.fn(async () => "wrong-mode-saved-key");
    const resolved = await providerOptions.resolveProviderRuntimeAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      {
        GEMINI_AUTH_MODE: mode,
        GOOGLE_CLOUD_PROJECT: "gemini-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
      { readSavedApiKey },
    );

    expect(resolved.credential).toMatchObject({
      status: "missing",
      reason: "mode-required",
    });
    expect(resolved.managedCredential).toBe(false);
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: { credentialPlan: { kind: "none", mode } },
    });
  });

  test("recognizes Gemini ADC from the captured environment", async () => {
    const adcPath = join(testRoot, "adc.json");
    await writeFile(adcPath, "{}", "utf8");
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      { model: "gemini-2.5-pro" },
      {
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_APPLICATION_CREDENTIALS: adcPath,
        GOOGLE_CLOUD_PROJECT: "gemini-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "gemini-adc",
      source: "environment",
    });
    expect(resolved.factoryOptions.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "adc",
          credentialPath: adcPath,
          source: "GOOGLE_APPLICATION_CREDENTIALS",
        },
      },
    });
  });

  test("distinguishes well-known Gemini ADC from environment credentials", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "gemini",
      {
        model: "gemini-2.5-pro",
        extra: {
          gemini: {
            credentialPlan: {
              kind: "adc",
              credentialPath: join(testRoot, "well-known-adc.json"),
              source: "well-known-adc",
            },
            endpointPlan: {
              kind: "developer",
              nativeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
            },
          },
        },
      },
      {},
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "gemini-adc",
      source: "application-default",
      label: "Google application default credentials",
    });
  });

  test("distinguishes complete and partial Bedrock SigV4 credentials", async () => {
    const { providerOptions } = await loadCredentialModules();

    const complete = providerOptions.resolveProviderCredentialAuthority(
      "amazon-bedrock",
      { model: "amazon.nova-pro-v1:0" },
      {
        AWS_ACCESS_KEY_ID: "bedrock-access",
        AWS_SECRET_ACCESS_KEY: "bedrock-secret",
        AWS_SESSION_TOKEN: "bedrock-session",
        AWS_REGION: "us-west-2",
      },
    );
    expect(complete.credential).toMatchObject({
      status: "ready",
      mode: "aws-sigv4",
      source: "environment",
    });
    expect(complete.factoryOptions.extra).toMatchObject({
      accessKeyId: "bedrock-access",
      secretAccessKey: "bedrock-secret",
      sessionToken: "bedrock-session",
      region: "us-west-2",
    });

    const partial = providerOptions.resolveProviderCredentialAuthority(
      "amazon-bedrock",
      { model: "amazon.nova-pro-v1:0" },
      { AWS_ACCESS_KEY_ID: "bedrock-access" },
    );
    expect(partial.credential).toMatchObject({
      status: "missing",
      mode: "none",
      missingLabel: "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
      provenance: {
        kind: "environment",
        fields: [{ role: "accessKeyId", envVar: "AWS_ACCESS_KEY_ID" }],
      },
    });
  });

  test("marks Ollama as credential-free and local OpenAI servers as optional", async () => {
    const { providerOptions } = await loadCredentialModules();

    const ollama = providerOptions.resolveProviderCredentialAuthority(
      "ollama",
      { model: "llama3.3" },
      {},
    );
    expect(ollama.credential).toMatchObject({
      status: "not-required",
      mode: "none",
    });

    for (const [provider, model] of [
      ["lmstudio", "local-model"],
      ["openai-compatible", "local-model"],
    ] as const) {
      const resolved = providerOptions.resolveProviderCredentialAuthority(
        provider,
        { model },
        {},
      );
      expect(resolved.credential, provider).toMatchObject({
        status: "optional",
        mode: "none",
      });
      expect(resolved.factoryOptions.apiKey, provider).toBeUndefined();
    }
  });

  test("only borrows an OpenAI key for an explicitly configured compatible URL", async () => {
    const { providerOptions } = await loadCredentialModules();
    const env = { OPENAI_API_KEY: "hosted-openai-key" };
    const unconfigured = providerOptions.resolveProviderCredentialAuthority(
      "openai-compatible",
      { model: "local-model" },
      env,
    );
    expect(unconfigured.factoryOptions.apiKey).toBeUndefined();
    expect(unconfigured.credential.status).toBe("optional");

    const configured = providerOptions.resolveProviderCredentialAuthority(
      "openai-compatible",
      { model: "local-model", baseURL: "http://127.0.0.1:9000/v1" },
      env,
    );
    expect(configured.factoryOptions.apiKey).toBe("hosted-openai-key");

    const ollama = providerOptions.resolveProviderCredentialAuthority(
      "openai-compatible",
      { model: "local-model", baseURL: "http://127.0.0.1:11434/v1" },
      env,
    );
    expect(ollama.factoryOptions.apiKey).toBeUndefined();
  });

  test("reports the missing credential label for an ordinary API-key provider", async () => {
    const { providerOptions } = await loadCredentialModules();

    const missing = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      { model: "claude-opus-4-7" },
      {},
    );
    expect(missing.credential).toMatchObject({
      status: "missing",
      mode: "none",
      missingLabel: "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN",
    });

    const explicit = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      {
        apiKey: "explicit-anthropic-key",
        model: "claude-opus-4-7",
      },
      {},
    );
    expect(explicit.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "explicit",
    });
    expect(explicit.factoryOptions.apiKey).toBe("explicit-anthropic-key");
  });

  test("prepares Anthropic bearer tokens without retaining an API-key fallback", async () => {
    const { providerOptions } = await loadCredentialModules();

    const resolved = providerOptions.resolveProviderCredentialAuthority(
      "anthropic",
      { model: "claude-opus-4-7" },
      {
        ANTHROPIC_AUTH_TOKEN: "prepared-anthropic-token",
        ANTHROPIC_API_KEY: "stale-anthropic-key",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "anthropic-bearer-token",
      source: "environment",
    });
    expect(resolved.factoryOptions.authToken).toBe(
      "prepared-anthropic-token",
    );
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
  });

  test("reads saved BYOK only after higher-precedence credentials are absent", async () => {
    const { providerOptions } = await loadCredentialModules();
    const readSavedApiKey = vi.fn(async () => "saved-anthropic-key");

    const resolved = await providerOptions.resolveProviderRuntimeAuthority(
      "anthropic",
      { model: "claude-opus-4-7" },
      {},
      { readSavedApiKey },
    );

    expect(readSavedApiKey).toHaveBeenCalledOnce();
    expect(readSavedApiKey).toHaveBeenCalledWith("anthropic");
    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "saved-byok",
    });
    expect(resolved.factoryOptions.apiKey).toBe("saved-anthropic-key");
  });

  test("does not read saved BYOK for providers without one-field API-key access", async () => {
    const { providerOptions } = await loadCredentialModules();
    const readSavedApiKey = vi.fn(async () => "wrong-key");

    const resolved = await providerOptions.resolveProviderRuntimeAuthority(
      "amazon-bedrock",
      { model: "amazon.nova-pro-v1:0" },
      {},
      { readSavedApiKey },
    );

    expect(readSavedApiKey).not.toHaveBeenCalled();
    expect(resolved.credential.status).toBe("missing");
  });

  test("marks managed OpenRouter credentials for lazy vending", async () => {
    const { providerOptions } = await loadCredentialModules();
    const vendKey = vi.fn(() => {
      throw new Error("managed credentials must remain lazy");
    });
    const authBackend = {
      kind: "local" as const,
      login: vi.fn(),
      logout: vi.fn(),
      whoami: vi.fn(),
      vendKey,
      inferAgencModel: vi.fn(),
      getLlmUsage: vi.fn(),
      getSubscriptionTier: vi.fn(),
    };

    const resolved = await providerOptions.resolveProviderRuntimeAuthority(
      "openrouter",
      { model: "x-ai/grok-4.3" },
      {},
      {
        authBackend,
        managedKeysEnabled: true,
        sessionId: "managed-session",
        subscriptionTier: "pro",
      },
    );

    expect(vendKey).not.toHaveBeenCalled();
    expect(resolved.managedCredential).toBe(true);
    expect(resolved.factoryOptions).toMatchObject({
      model: "x-ai/grok-4.3",
      extra: {
        authBackend,
        managedCredential: true,
        maxTokens: 2_048,
        sessionId: "managed-session",
        subscriptionTier: "pro",
      },
    });
    expect(resolved.factoryOptions.apiKey).toBeUndefined();
    expect(resolved.factoryOptions.baseURL).toBeUndefined();
  });
});
