import { beforeEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../../../src/config/home.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn() }));

vi.mock("../../../../src/utils/openAiOauthCredentials.js", () => ({
  readOpenAiOauthCredentials: mocks.read,
  refreshOpenAiSubscriptionIfNeeded: mocks.refresh,
}));

const {
  chatGptAccountDefaultModel,
  clearChatGptAccountModelCache,
  openAiUsesChatGptSignIn,
  readChatGptAccountModels,
} = await import("../../../../src/llm/providers/openai/chatgpt-account-models.js");

const home = resolveHomeContext(
  { AGENC_HOME: "/tmp/agenc-chatgpt-account-models-test" },
  { platformHome: "/tmp" },
);
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
const SIGNED_IN = { authMode: "chatgpt", accessToken: "access-1", accountId: "acct-1", refreshToken: "refresh-1" };

const listing = (...slugs: string[]) =>
  new Response(JSON.stringify({ models: slugs.map((slug, priority) => ({ slug, priority, visibility: "list" })) }));

beforeEach(() => {
  mocks.read.mockReset();
  mocks.refresh.mockReset();
  clearChatGptAccountModelCache();
});

describe("OpenAI's ChatGPT sign-in", () => {
  test("is used unless auth is api-key or the sign-in holds a platform key", () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    expect(openAiUsesChatGptSignIn(home, {})).toBe(true);
    expect(openAiUsesChatGptSignIn(home, { OPENAI_AUTH_MODE: "oauth" })).toBe(true);
    expect(openAiUsesChatGptSignIn(home, { OPENAI_AUTH_MODE: "api-key" })).toBe(false);
    mocks.read.mockReturnValue({ authMode: "apiKey", apiKey: "sk-exchanged" });
    expect(openAiUsesChatGptSignIn(home, {})).toBe(false);
    mocks.read.mockReturnValue(undefined);
    expect(openAiUsesChatGptSignIn(home, {})).toBe(false);
  });
});

describe("the ChatGPT account's models", () => {
  test("are read from the ChatGPT backend with the sign-in, in the backend's order", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(listing("gpt-6-luna", "gpt-5.6-sol"));
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toEqual(["gpt-6-luna", "gpt-5.6-sol"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(MODELS_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-1");
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("acct-1");
  });

  test("refresh the sign-in once on a 401", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    mocks.refresh.mockResolvedValue({ refreshed: true, credentials: { ...SIGNED_IN, accessToken: "access-2" } });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(listing("gpt-6.2-astra"));
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toEqual(["gpt-6.2-astra"]);
    expect(mocks.refresh).toHaveBeenCalledWith(home, {}, { force: true, rejectedAccessToken: "access-1" });
    expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer access-2");
  });

  test("are not read without a ChatGPT sign-in, and a failed read gives none", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(listing("gpt-6.2-astra"));
    mocks.read.mockReturnValue(SIGNED_IN);
    expect(await readChatGptAccountModels({ home, environment: { OPENAI_AUTH_MODE: "api-key" }, fetchImpl })).toBeUndefined();
    mocks.read.mockReturnValue(undefined);
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    mocks.read.mockReturnValue(SIGNED_IN);
    for (const answer of [new Response("", { status: 403 }), new Response("{}"), new Response("not json")]) {
      fetchImpl.mockResolvedValueOnce(answer);
      expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toBeUndefined();
    }
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toBeUndefined();
  });

  test("leave out what the backend does not list for pickers", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ models: [
      { slug: "gpt-6-luna", visibility: "list" }, { slug: "gpt-6.2-astra", visibility: "hide" }, { slug: "gpt-5.6-sol" },
    ] })));
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toEqual(["gpt-6-luna", "gpt-5.6-sol"]);
  });

  test("are read once per home and account in ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T12:00:00.000Z") });
    try {
      mocks.read.mockReturnValue(SIGNED_IN);
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => listing("gpt-6-luna"));
      expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toEqual(["gpt-6-luna"]);
      expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl })).toEqual(["gpt-6-luna"]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Another account on the same home asks again.
      mocks.read.mockReturnValue({ ...SIGNED_IN, accountId: "acct-2" });
      await readChatGptAccountModels({ home, environment: {}, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      vi.setSystemTime(new Date("2026-11-20T12:10:00.001Z"));
      await readChatGptAccountModels({ home, environment: {}, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("give up at the deadline, a slow refresh included", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const hanging = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    let started = Date.now();
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl: hanging, timeoutMs: 50 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    mocks.refresh.mockImplementation(() => new Promise(() => {}));
    const refused = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
    started = Date.now();
    expect(await readChatGptAccountModels({ home, environment: {}, fetchImpl: refused, timeoutMs: 50 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  test("give the default: Astra when listed, else the best listed model", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(listing("gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"))
      .mockResolvedValueOnce(listing("gpt-6-luna", "gpt-6.2-astra"));
    expect(await chatGptAccountDefaultModel({ home, environment: {}, fetchImpl }))
      .toEqual({ model: "gpt-5.6-sol", listed: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] });
    // The plan changed: a new list is read once the old one is forgotten.
    clearChatGptAccountModelCache();
    expect((await chatGptAccountDefaultModel({ home, environment: {}, fetchImpl }))?.model).toBe("gpt-6.2-astra");
    // An account that lists only models Core does not know keeps the provider default.
    clearChatGptAccountModelCache();
    fetchImpl.mockResolvedValueOnce(listing("gpt-7-preview"));
    expect(await chatGptAccountDefaultModel({ home, environment: {}, fetchImpl })).toBeUndefined();
  });
});
