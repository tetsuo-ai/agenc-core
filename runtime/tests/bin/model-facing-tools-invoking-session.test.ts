/**
 * A sub-agent runs its parent's tool objects, so a tool must take the
 * provider, credentials and admission for a call from the session that made
 * it (the runtime attaches it to every dispatched call), never from the
 * session the registry was built for.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setLiveWebFetchDnsAllLookupForTests,
  createModelFacingTools,
} from "../../src/bin/model-facing-tools.js";
import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import { createProvider, type ProviderFactoryOptions } from "../../src/llm/provider.js";
import type { LLMProvider, LLMResponse } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import {
  attachToolRuntimeContext,
  type ToolRuntimeAttemptContext,
} from "../../src/tools/runtimes/context.js";
import { createImagineEditTool } from "../../src/tools/system/imagine-edit.js";
import { createImagineImageTool } from "../../src/tools/system/imagine-image.js";
import { createImagineSpeechTool } from "../../src/tools/system/imagine-speech.js";
import { createImagineVideoTool } from "../../src/tools/system/imagine-video.js";
import { mediaTestHome, ownProviderState } from "../tools/system/media-test-helpers.js";

type FakeAdmission = ReturnType<typeof fakeAdmission>;

/** A structural admission client that records what it was asked to admit. */
function fakeAdmission(runId: string) {
  const acquire = vi.fn(async (input: {
    readonly stepId: string;
    readonly kind: string;
    readonly model?: string;
    readonly provider?: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxCostUsd: number | null;
  }) => ({
    decision: "allow" as const,
    reservation: {
      reservationId: `${runId}:${input.stepId}`,
      step: { runId, stepId: input.stepId },
      reservedCostUsd: input.maxCostUsd ?? 0,
      reservedTokens: input.maxInputTokens + input.maxOutputTokens,
      reservedAt: new Date(0).toISOString(),
    },
    request: {
      step: { runId, stepId: input.stepId },
      kind: input.kind,
      estimate: {
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        maxCostUsd: input.maxCostUsd,
      },
      workspaceId: "workspace-test",
      sessionId: runId,
      autonomous: false,
    },
    signal: new AbortController().signal,
  }));
  return {
    scope: { runId, workspaceId: "workspace-test", sessionId: runId, autonomous: false },
    acquire,
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}

interface FakeSession {
  readonly session: Session;
  readonly admission: FakeAdmission;
}

/** The credential home every session in these tests carries (empty: no stored sign-in). */
function testCredentialHome(): HomeContext {
  return resolveHomeContext({ AGENC_HOME: home });
}

/**
 * A session with its own provider, admission client, internal ids and live
 * provider state (an empty environment and the test home unless given), as
 * the runtime gives every session.
 */
function sessionOn(
  id: string,
  provider: LLMProvider,
  authority: { readonly providerEnvironment?: Readonly<Record<string, string>> } = {},
): FakeSession {
  const admission = fakeAdmission(id);
  let sub = 0;
  const session = {
    conversationId: id,
    abortController: new AbortController(),
    nextInternalSubId: () => `${id}-sub-${++sub}`,
    modelInfo: { slug: readModel(provider) },
    services: {
      provider,
      executionAdmission: admission,
      admissionRequired: true,
      providerService: ownProviderState(provider, authority.providerEnvironment ?? {}, testCredentialHome()),
    },
    emit: () => {},
  } as unknown as Session;
  return { session, admission };
}

function readModel(provider: LLMProvider): string {
  return String((provider as unknown as { config?: { model?: unknown } }).config?.model ?? "unknown");
}

function chatProvider(
  name: string,
  config: Record<string, unknown>,
  chat = vi.fn(),
): LLMProvider {
  return { name, config, chat, chatStream: vi.fn(), healthCheck: vi.fn() } as unknown as LLMProvider;
}

function textResponse(content: string, model: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
    model,
    finishReason: "stop",
  };
}

/** Args as the runtime dispatches them: carrying the invoking session. */
function dispatchedArgs(
  args: Record<string, unknown>,
  session: Session,
  callId: string,
  toolName = "web_fetch",
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

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agenc-invoking-session-"));
  __setLiveWebFetchDnsAllLookupForTests((_host, callback) => {
    callback(null, [{ address: "192.0.2.1", family: 4 }]);
  });
});

afterEach(async () => {
  __setLiveWebFetchDnsAllLookupForTests(undefined);
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

function modelFacingTools(
  parent: Session,
  extra: Partial<Parameters<typeof createModelFacingTools>[0]> = {},
) {
  return createModelFacingTools({
    workspaceRoot: process.cwd(),
    agencHome: home,
    getSession: () => parent,
    env: { AGENC_HOME: home },
    ...extra,
  });
}

describe("web_fetch prompt extraction", () => {
  const page = `<!doctype html><html><body><h1>Release notes</h1>${
    "<p>The current release is version 9.9.9 and it shipped today.</p>".repeat(200)
  }</body></html>`;

  it("runs a sub-agent's extraction on the sub-agent's provider and admission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(page, { status: 200, headers: { "content-type": "text/html" } })));
    const parentChat = vi.fn(async () => textResponse("parent extraction", "deepseek-flash"));
    const childChat = vi.fn(async () => textResponse("The release is 9.9.9.", "gpt-5.5"));
    const parent = sessionOn("parent-session", chatProvider("deepseek",
      { apiKey: "sk-parent", baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash" }, parentChat));
    const child = sessionOn("child-agent", chatProvider("openai",
      { apiKey: "sk-child", baseURL: "https://api.openai.com/v1", model: "gpt-5.5" }, childChat));
    const tool = modelFacingTools(parent.session).find((entry) => entry.name === "web_fetch")!;

    const result = await tool.execute(dispatchedArgs(
      { url: "https://agenc.tech/releases", prompt: "What is the current release?" },
      child.session,
      "child-call-1",
    ));

    expect(JSON.parse(result.content).extracted).toBe("The release is 9.9.9.");
    expect(childChat).toHaveBeenCalledOnce();
    expect(parentChat).not.toHaveBeenCalled();
    expect(child.admission.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "model_turn",
        stepId: "web_fetch_extraction:child-agent-sub-1",
        provider: "openai",
        model: "gpt-5.5",
      }),
      undefined,
    );
    expect(parent.admission.acquire).not.toHaveBeenCalled();
  });

  it("still runs the parent's own extraction on the parent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(page, { status: 200, headers: { "content-type": "text/html" } })));
    const parentChat = vi.fn(async () => textResponse("The release is 9.9.9.", "deepseek-flash"));
    const parent = sessionOn("parent-session", chatProvider("deepseek",
      { apiKey: "sk-parent", baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash" }, parentChat));
    const tool = modelFacingTools(parent.session).find((entry) => entry.name === "web_fetch")!;

    for (const args of [
      dispatchedArgs({ url: "https://agenc.tech/releases", prompt: "Release?" }, parent.session, "parent-call"),
      { url: "https://agenc.tech/releases", prompt: "Release?" },
    ]) {
      expect(JSON.parse((await tool.execute(args)).content).extracted).toBe("The release is 9.9.9.");
    }
    expect(parentChat).toHaveBeenCalledTimes(2);
    expect(parent.admission.acquire).toHaveBeenCalledTimes(2);
  });
});

describe("WebSearch through Grok's native search", () => {
  const nativeAnswer: LLMResponse = {
    content: "AgenC docs are current.",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22, webSearchRequests: 1 },
    model: "grok-4-fast",
    finishReason: "stop",
    providerEvidence: {
      serverSideToolCalls: [{
        type: "web_search_call",
        toolType: "web_search",
        raw: { type: "web_search_call", action: { sources: [
          { title: "Current AgenC docs", url: "https://agenc.tech/current", snippet: "Current reference" },
        ] } },
      }],
    },
  };

  function grokFactory() {
    const nativeChat = vi.fn(async () => nativeAnswer);
    const built: ProviderFactoryOptions[] = [];
    const providerFactory = vi.fn((_provider: string, options: ProviderFactoryOptions) => {
      built.push(options);
      return chatProvider("grok", { ...options }, nativeChat);
    });
    return { nativeChat, built, providerFactory };
  }

  const endpointSearch = () => vi.fn(async () => ({
    json: async () => ({ RelatedTopics: [{ Text: "Fallback - result", FirstURL: "https://agenc.tech/fallback" }] }),
  }));

  it("never searches with a Grok parent's key for a sub-agent on another provider", async () => {
    const fetch = endpointSearch();
    vi.stubGlobal("fetch", fetch);
    const { nativeChat, providerFactory } = grokFactory();
    const parent = sessionOn("grok-parent", chatProvider("grok", { apiKey: "xai-parent", model: "grok-4-fast" }));
    // The sub-agent's own copy of the parent's environment, as it gets one at creation.
    const child = sessionOn("openai-child", chatProvider("openai",
      { apiKey: "sk-child", baseURL: "https://api.openai.com/v1", model: "gpt-5.5" }),
      { providerEnvironment: { AGENC_WEB_SEARCH_ENDPOINT: "http://127.0.0.1/search" } });
    const tool = modelFacingTools(parent.session, {
      env: { AGENC_HOME: home, AGENC_WEB_SEARCH_ENDPOINT: "http://127.0.0.1/search" },
      providerFactory: providerFactory as never,
    }).find((entry) => entry.name === "WebSearch")!;

    const result = await tool.execute(dispatchedArgs({ query: "agenc docs" }, child.session, "child-search", "WebSearch"));

    expect(providerFactory).not.toHaveBeenCalled();
    expect(nativeChat).not.toHaveBeenCalled();
    expect(parent.admission.acquire).not.toHaveBeenCalled();
    expect(JSON.parse(result.content).source).toBe("http://127.0.0.1/search");
  });

  it("searches natively for a Grok sub-agent with its own key, admitted on its own run", async () => {
    const fetch = endpointSearch();
    vi.stubGlobal("fetch", fetch);
    const { built, providerFactory } = grokFactory();
    const parent = sessionOn("openai-parent", chatProvider("openai",
      { apiKey: "sk-parent", baseURL: "https://api.openai.com/v1", model: "gpt-5.5" }));
    const child = sessionOn("grok-child", chatProvider("grok", { apiKey: "xai-child", model: "grok-4-fast" }));
    const tool = modelFacingTools(parent.session, {
      env: { AGENC_HOME: home, AGENC_WEB_SEARCH_ENDPOINT: "http://127.0.0.1/search" },
      providerFactory: providerFactory as never,
    }).find((entry) => entry.name === "WebSearch")!;

    const result = await tool.execute(dispatchedArgs({ query: "agenc docs" }, child.session, "child-search", "WebSearch"));

    expect(JSON.parse(result.content).source).toBe("grok_web_search");
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ apiKey: "xai-child", model: "grok-4-fast" });
    expect(fetch).not.toHaveBeenCalled();
    expect(child.admission.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "model_turn", stepId: "web_search:grok-child-sub-1", provider: "grok" }),
      undefined,
    );
    expect(parent.admission.acquire).not.toHaveBeenCalled();
  });
});

describe("WebSearch with a configured search endpoint", () => {
  const search = (prefix: string) => ({
    AGENC_WEB_SEARCH_ENDPOINT: `https://${prefix}-search.example/search`,
    AGENC_WEB_SEARCH_KIND: "brave",
    AGENC_WEB_SEARCH_API_KEY: `${prefix}-search-key`,
  });

  it("searches with each session's own endpoint and key", async () => {
    const fetch = vi.fn(async () => ({
      json: async () => ({ web: { results: [{ title: "AgenC", url: "https://agenc.tech/", description: "Docs" }] } }),
    }));
    vi.stubGlobal("fetch", fetch);
    const openai = (key: string) => chatProvider("openai",
      { apiKey: key, baseURL: "https://api.openai.com/v1", model: "gpt-5.5" });
    const parent = sessionOn("parent-session", openai("sk-parent"), { providerEnvironment: search("parent") });
    const child = sessionOn("child-agent", openai("sk-child"), { providerEnvironment: search("child") });
    const tool = modelFacingTools(parent.session, { env: { AGENC_HOME: home, ...search("parent") } })
      .find((entry) => entry.name === "WebSearch")!;

    await tool.execute(dispatchedArgs({ query: "agenc" }, child.session, "child-search", "WebSearch"));
    await tool.execute(dispatchedArgs({ query: "agenc" }, parent.session, "parent-search", "WebSearch"));

    expect(fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      key: (init as { headers?: Record<string, string> } | undefined)?.headers?.["X-Subscription-Token"],
    }))).toEqual([
      { url: "https://child-search.example/search?q=agenc", key: "child-search-key" },
      { url: "https://parent-search.example/search?q=agenc", key: "parent-search-key" },
    ]);
  });
});

describe("XSearch", () => {
  const xAnswer: LLMResponse = {
    content: "Found a post https://x.com/xai/status/1",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "grok-4.6",
    finishReason: "stop",
    providerEvidence: {
      citations: ["https://x.com/xai/status/1"],
      serverSideToolCalls: [{ type: "x_search_call", toolType: "x_search", id: "c1" }],
    },
  };

  function xFactory() {
    const chat = vi.fn(async () => xAnswer);
    const built: ProviderFactoryOptions[] = [];
    const providerFactory = vi.fn((_provider: string, options: ProviderFactoryOptions) => {
      built.push(options);
      return chatProvider("grok", { ...options }, chat);
    });
    return { chat, built, providerFactory };
  }

  it("does not lend a Grok parent's key to a sub-agent on another provider", async () => {
    const { chat, providerFactory } = xFactory();
    const parent = sessionOn("grok-parent", chatProvider("grok",
      { apiKey: "xai-parent", baseURL: "https://api.x.ai/v1", model: "grok-4.6" }));
    const child = sessionOn("openai-child", chatProvider("openai",
      { apiKey: "sk-child", baseURL: "https://api.openai.com/v1", model: "gpt-5.5" }));
    const tool = modelFacingTools(parent.session, {
      grokCapabilities: { x_search: true },
      providerFactory: providerFactory as never,
    }).find((entry) => entry.name === "XSearch")!;

    const result = await tool.execute(dispatchedArgs({ query: "xAI" }, child.session, "child-x", "XSearch"));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/independent xAI backend/u);
    expect(providerFactory).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(parent.admission.acquire).not.toHaveBeenCalled();
  });

  it("uses a Grok sub-agent's own key and model, admitted on its own run", async () => {
    const { built, providerFactory } = xFactory();
    // The parent's own environment holds an independent xAI key.
    const parent = sessionOn("openai-parent", chatProvider("openai",
      { apiKey: "sk-parent", baseURL: "https://api.openai.com/v1", model: "gpt-5.5" }),
      { providerEnvironment: { XAI_API_KEY: "xai-independent" } });
    const child = sessionOn("grok-child", chatProvider("grok",
      { apiKey: "xai-child", baseURL: "https://api.x.ai/v1", model: "grok-4.6" }));
    const tool = modelFacingTools(parent.session, {
      env: { AGENC_HOME: home, XAI_API_KEY: "xai-independent" },
      grokCapabilities: { x_search: true },
      providerFactory: providerFactory as never,
    }).find((entry) => entry.name === "XSearch")!;

    const result = await tool.execute(dispatchedArgs({ query: "xAI" }, child.session, "child-x", "XSearch"));

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content).source).toBe("grok_x_search");
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ apiKey: "xai-child", model: "grok-4.6" });
    expect(child.admission.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "model_turn", stepId: "x_search:grok-child-sub-1" }),
      undefined,
    );
    expect(parent.admission.acquire).not.toHaveBeenCalled();
  });
});

describe("media tools", () => {
  const authorization = (fetchImpl: ReturnType<typeof vi.fn>) =>
    (fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined)?.headers?.authorization;

  /** A parent session and a sub-agent with its own live provider state (empty environment, test home). */
  function sessions(parentProvider: LLMProvider, childProvider: LLMProvider) {
    const parent = { services: { provider: parentProvider } } as unknown as Session;
    const child = {
      services: {
        provider: childProvider,
        providerService: ownProviderState(childProvider, {}, testCredentialHome()),
      },
    } as unknown as Session;
    return { parent, child };
  }

  const grokParent = () => createProvider("grok",
    { apiKey: "xai-parent", model: "grok-4.5", baseURL: "https://api.x.ai/v1" });
  const grokChild = () => createProvider("grok",
    { apiKey: "xai-child", model: "grok-4.5", baseURL: "https://api.x.ai/v1" });
  const openAiSession = (apiKey: string, baseURL?: string) => createProvider("openai",
    { apiKey, model: "gpt-5", ...(baseURL !== undefined ? { baseURL } : {}) });
  // A provider with no media route of its own.
  const deepSeekSession = (apiKey: string) => createProvider("deepseek",
    { apiKey, model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com" });

  /** Every request the media fetch saw, as URL and bearer. */
  const requests = (fetchImpl: ReturnType<typeof vi.fn>) => fetchImpl.mock.calls.map(([url, init]) => ({
    url: String(url),
    authorization: (init as { headers?: Record<string, string> } | undefined)?.headers?.authorization,
  }));

  const mediaRoute = { image: "images/generations", video: "videos" } as const;

  function mediaTool(kind: "image" | "video", root: string, parent: Session, env: NodeJS.ProcessEnv,
    fetchImpl: ReturnType<typeof vi.fn>) {
    const options = {
      workspaceRoot: root,
      home: mediaTestHome(root),
      getSession: () => parent,
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    return kind === "image" ? createImagineImageTool(options) : createImagineVideoTool(options);
  }

  it.each(["image", "video"] as const)(
    "Imagine %s sends an OpenAI sub-agent's own key to its own endpoint, never the parent's OPENAI_API_KEY",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), `imagine-${kind}-openai-child-`));
      try {
        const { parent, child } = sessions(
          openAiSession("parent-key", "https://api.openai.com/v1"),
          openAiSession("child-key", "https://child-openai.example/v1"),
        );
        const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
        const tool = mediaTool(kind, root, parent, { OPENAI_API_KEY: "parent-key" }, fetchImpl);

        await tool.execute(dispatchedArgs({ prompt: "a cat" }, child, `${kind}-child`,
          kind === "image" ? "ImagineImage" : "ImagineVideo"));

        expect(requests(fetchImpl)).toEqual([{
          url: `https://child-openai.example/v1/${mediaRoute[kind]}`,
          authorization: "Bearer child-key",
        }]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["image", "video"] as const)(
    "Imagine %s never sends an OpenAI sub-agent's key to the parent's endpoint, nor the parent's key to the sub-agent's",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), `imagine-${kind}-openai-reverse-`));
      try {
        // The parent's endpoint is also the registry environment's
        // OPENAI_BASE_URL; the sub-agent runs on OpenAI's default endpoint.
        const { parent, child } = sessions(
          openAiSession("parent-key", "https://parent-openai.example/v1"),
          openAiSession("child-key"),
        );
        const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
        const tool = mediaTool(kind, root, parent, {
          OPENAI_API_KEY: "parent-key",
          OPENAI_BASE_URL: "https://parent-openai.example/v1",
        }, fetchImpl);
        const toolName = kind === "image" ? "ImagineImage" : "ImagineVideo";

        await tool.execute(dispatchedArgs({ prompt: "a cat" }, child, `${kind}-child`, toolName));
        await tool.execute(dispatchedArgs({ prompt: "a cat" }, parent, `${kind}-parent`, toolName));
        await tool.execute(dispatchedArgs({ prompt: "a cat" }, child, `${kind}-child-again`, toolName));

        const childRequest = { url: `https://api.openai.com/v1/${mediaRoute[kind]}`, authorization: "Bearer child-key" };
        expect(requests(fetchImpl)).toEqual([
          childRequest,
          { url: `https://parent-openai.example/v1/${mediaRoute[kind]}`, authorization: "Bearer parent-key" },
          childRequest,
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("ImagineImage never spends a Grok parent's key for a sub-agent, and uses a Grok sub-agent's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-invoking-"));
    try {
      const refused = sessions(grokParent(), deepSeekSession("sk-child"));
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
      const tool = createImagineImageTool({
        workspaceRoot: root,
        home: mediaTestHome(root),
        getSession: () => refused.parent,
        env: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const childCall = await tool.execute(dispatchedArgs({ prompt: "a cat" }, refused.child, "img-1", "ImagineImage"));
      expect(childCall.isError).toBe(true);
      expect(childCall.content).toMatch(/media backend credential/iu);
      expect(fetchImpl).not.toHaveBeenCalled();

      const own = sessions(openAiSession("sk-parent"), grokChild());
      const ownFetch = vi.fn(async () => new Response("{}", { status: 400 }));
      const ownTool = createImagineImageTool({
        workspaceRoot: root,
        home: mediaTestHome(root),
        getSession: () => own.parent,
        env: {},
        fetchImpl: ownFetch as unknown as typeof fetch,
      });
      await ownTool.execute(dispatchedArgs({ prompt: "a cat" }, own.child, "img-2", "ImagineImage"));
      expect(ownFetch).toHaveBeenCalledOnce();
      expect(String(ownFetch.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/images/generations");
      expect(authorization(ownFetch)).toBe("Bearer xai-child");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ImagineVideo never spends a Grok parent's key for a sub-agent, and uses a Grok sub-agent's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-video-invoking-"));
    try {
      const refused = sessions(grokParent(), deepSeekSession("sk-child"));
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
      const tool = createImagineVideoTool({
        workspaceRoot: root,
        home: mediaTestHome(root),
        getSession: () => refused.parent,
        env: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const childCall = await tool.execute(dispatchedArgs({ prompt: "waves" }, refused.child, "vid-1", "ImagineVideo"));
      expect(childCall.isError).toBe(true);
      expect(childCall.content).toMatch(/media credential/iu);
      expect(fetchImpl).not.toHaveBeenCalled();

      const own = sessions(openAiSession("sk-parent"), grokChild());
      const ownFetch = vi.fn(async () => new Response("{}", { status: 400 }));
      const ownTool = createImagineVideoTool({
        workspaceRoot: root,
        home: mediaTestHome(root),
        getSession: () => own.parent,
        env: {},
        fetchImpl: ownFetch as unknown as typeof fetch,
      });
      await ownTool.execute(dispatchedArgs({ prompt: "waves" }, own.child, "vid-2", "ImagineVideo"));
      expect(ownFetch).toHaveBeenCalled();
      expect(String(ownFetch.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.x\.ai\/v1\//u);
      expect(authorization(ownFetch)).toBe("Bearer xai-child");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ImagineSpeech and ImagineEdit use only the invoking session's own gateway key", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-gateway-invoking-"));
    try {
      const venice = createProvider("venice",
        { apiKey: "venice-parent", model: "venice-uncensored", baseURL: "https://api.venice.ai/api/v1" });
      const { parent, child } = sessions(venice, openAiSession("sk-child"));
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
      const speech = createImagineSpeechTool({
        workspaceRoot: root,
        getSession: () => parent,
        env: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const edit = createImagineEditTool({
        workspaceRoot: root,
        getSession: () => parent,
        env: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      fetchImpl.mockClear();
      const spoken = await speech.execute(dispatchedArgs({ text: "hello" }, child, "speech-1", "ImagineSpeech"));
      expect(spoken.isError).toBe(true);
      expect(spoken.content).toMatch(/OpenRouter or Venice session/u);
      expect(speech.admissionEstimate?.(dispatchedArgs({ text: "hello" }, child, "speech-2", "ImagineSpeech"))?.maxCostUsd)
        .toBeNull();
      const edited = await edit.execute(dispatchedArgs({ image: "in.png", prompt: "sunrise" }, child, "edit-1", "ImagineEdit"));
      expect(edited.isError).toBe(true);
      expect(edited.content).toMatch(/Venice session/u);
      expect(edit.admissionEstimate?.(dispatchedArgs({ image: "in.png", prompt: "x" }, child, "edit-2", "ImagineEdit"))?.maxCostUsd)
        .toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
