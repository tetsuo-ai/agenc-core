import { afterEach, beforeEach, expect, test, vi } from "vitest";

type MockStorageData = Record<string, unknown>;

const secureStorageModulePath = "../../src/utils/secureStorage/index.js";
const keychainHelpersModulePath =
  "../../src/utils/secureStorage/macOsKeychainHelpers.js";
const lockfileModulePath = "../../src/utils/lockfile.js";
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
let storageState: MockStorageData = {};
let testConfigDir: string | undefined;
const fetchMock = vi.fn<typeof fetch>();
const clearKeychainCacheMock = vi.fn();
const lockMock = vi.fn(async () => async () => {});

async function importFreshModule() {
  vi.resetModules();
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: () => ({
      name: "mock-secure-storage",
      read: () => storageState,
      readAsync: async () => storageState,
      update: (next: MockStorageData) => {
        storageState = next;
        return { success: true };
      },
      delete: () => {
        storageState = {};
        return true;
      },
    }),
  }));
  vi.doMock(keychainHelpersModulePath, () => ({
    clearKeychainCache: clearKeychainCacheMock,
  }));
  vi.doMock(lockfileModulePath, () => ({ lock: lockMock }));
  return import("../../src/utils/openAiOauthCredentials.ts");
}

function subscriptionBlob(overrides: Record<string, unknown> = {}) {
  return {
    authMode: "chatgpt" as const,
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accountId: "account-1",
    obtainedAt: Date.now() - 60_000,
    ...overrides,
  };
}

beforeEach(async () => {
  process.env = { ...originalEnv };
  delete process.env.AGENC_SIMPLE;
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  testConfigDir = await mkdtemp(
    join(tmpdir(), "openai-oauth-test-"),
  );
  process.env.AGENC_CONFIG_DIR = testConfigDir;
  process.argv = originalArgv.filter((arg) => arg !== "--bare");
  storageState = {};
  fetchMock.mockReset();
  clearKeychainCacheMock.mockReset();
  lockMock.mockReset();
  lockMock.mockImplementation(async () => async () => {});
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (testConfigDir !== undefined) {
    const { rm } = await import("node:fs/promises");
    await rm(testConfigDir, { recursive: true, force: true });
    testConfigDir = undefined;
  }
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
  storageState = {};
  vi.doUnmock(secureStorageModulePath);
  vi.doUnmock(keychainHelpersModulePath);
  vi.doUnmock(lockfileModulePath);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

test("concurrent subscription refreshes share one token exchange", async () => {
  const {
    readOpenAiOauthCredentials,
    refreshOpenAiSubscriptionIfNeeded,
    saveOpenAiOauthCredentials,
  } = await importFreshModule();
  saveOpenAiOauthCredentials(subscriptionBlob());

  let resolveFetch: (response: Response) => void = () => {};
  fetchMock.mockImplementation(
    async () =>
      await new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );

  const first = refreshOpenAiSubscriptionIfNeeded();
  const second = refreshOpenAiSubscriptionIfNeeded();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  resolveFetch(
    Response.json({
      access_token: "access-2",
      refresh_token: "refresh-2",
    }),
  );

  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readOpenAiOauthCredentials()).toMatchObject({
    accessToken: "access-2",
    refreshToken: "refresh-2",
    accountId: "account-1",
  });
});

test("refresh fails closed without consuming a token when the process lock fails", async () => {
  const {
    refreshOpenAiSubscriptionIfNeeded,
    saveOpenAiOauthCredentials,
  } = await importFreshModule();
  saveOpenAiOauthCredentials(subscriptionBlob());
  lockMock.mockRejectedValueOnce(new Error("lock unavailable"));

  await expect(refreshOpenAiSubscriptionIfNeeded()).resolves.toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a release error does not hide a successfully persisted rotation", async () => {
  const {
    readOpenAiOauthCredentials,
    refreshOpenAiSubscriptionIfNeeded,
    saveOpenAiOauthCredentials,
  } = await importFreshModule();
  saveOpenAiOauthCredentials(subscriptionBlob());
  lockMock.mockResolvedValueOnce(async () => {
    throw new Error("release failed");
  });
  fetchMock.mockResolvedValueOnce(
    Response.json({
      access_token: "access-2",
      refresh_token: "refresh-2",
    }),
  );

  await expect(refreshOpenAiSubscriptionIfNeeded()).resolves.toBe(true);
  expect(readOpenAiOauthCredentials()).toMatchObject({
    accessToken: "access-2",
    refreshToken: "refresh-2",
  });
});

test("refresh adopts a sibling rotation hidden behind the read cache", async () => {
  const {
    readOpenAiOauthCredentials,
    refreshOpenAiSubscriptionIfNeeded,
    saveOpenAiOauthCredentials,
  } = await importFreshModule();
  saveOpenAiOauthCredentials(subscriptionBlob());

  storageState = {
    openAiOauth: subscriptionBlob({
      accessToken: "access-sibling",
      refreshToken: "refresh-sibling",
    }),
  };

  await expect(refreshOpenAiSubscriptionIfNeeded()).resolves.toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(clearKeychainCacheMock).toHaveBeenCalled();
  expect(readOpenAiOauthCredentials()).toMatchObject({
    accessToken: "access-sibling",
    refreshToken: "refresh-sibling",
  });
});

test("a completed refresh cannot resurrect credentials cleared during POST", async () => {
  const {
    readOpenAiOauthCredentials,
    refreshOpenAiSubscriptionIfNeeded,
    saveOpenAiOauthCredentials,
  } = await importFreshModule();
  saveOpenAiOauthCredentials(subscriptionBlob());
  fetchMock.mockImplementation(async () => {
    storageState = {};
    return Response.json({
      access_token: "access-2",
      refresh_token: "refresh-2",
    });
  });

  await expect(refreshOpenAiSubscriptionIfNeeded()).resolves.toBe(false);
  expect(readOpenAiOauthCredentials()).toBeUndefined();
  expect(storageState).toEqual({});
});

test("a completed refresh adopts rather than overwrites a newer login", async () => {
  const {
    readOpenAiOauthCredentials,
    refreshOpenAiSubscriptionIfNeeded,
    saveOpenAiOauthCredentials,
  } = await importFreshModule();
  saveOpenAiOauthCredentials(subscriptionBlob());
  fetchMock.mockImplementation(async () => {
    storageState = {
      openAiOauth: subscriptionBlob({
        accessToken: "access-new-login",
        refreshToken: "refresh-new-login",
        accountId: "account-new-login",
      }),
    };
    return Response.json({
      access_token: "access-stale-response",
      refresh_token: "refresh-stale-response",
    });
  });

  await expect(refreshOpenAiSubscriptionIfNeeded()).resolves.toBe(true);
  expect(readOpenAiOauthCredentials()).toMatchObject({
    accessToken: "access-new-login",
    refreshToken: "refresh-new-login",
    accountId: "account-new-login",
  });
});
