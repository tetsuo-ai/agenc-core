import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSecureStorage } from "../../utils/secureStorage/index.js";
import { readNativeSecureStorage } from "../../utils/secureStorage/native.js";
import { resolveSecureStorageHome } from "../../utils/secureStorage/home.js";
import { RemoteAuthBackend } from "./remote.js";

const REMOTE_AUTH_LOGIN_POLL_URL_ENV = "AGENC_REMOTE_AUTH_LOGIN_POLL_URL";
const REMOTE_AUTH_LOGIN_START_URL_ENV = "AGENC_REMOTE_AUTH_LOGIN_START_URL";
const REMOTE_AUTH_ME_URL_ENV = "AGENC_REMOTE_AUTH_ME_URL";
const REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS = 5_000;
const REMOTE_AUTH_MODEL_URL_ENV = "AGENC_REMOTE_AUTH_MODEL_URL";
const REMOTE_AUTH_TIER_URL_ENV = "AGENC_REMOTE_AUTH_TIER_URL";
const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN";
const REMOTE_AUTH_URL_ENV = "AGENC_REMOTE_AUTH_URL";
const REMOTE_AUTH_USAGE_URL_ENV = "AGENC_REMOTE_AUTH_USAGE_URL";

function invalidJsonResponse(): Response {
  return new Response("not-json", { status: 200 });
}

function readNativeFor(home: string) {
  return readNativeSecureStorage(resolveSecureStorageHome({}, home));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("RemoteAuthBackend", () => {
  beforeEach(() => {
    getSecureStorage(resolveSecureStorageHome(process.env)).delete();
  });

  afterEach(() => {
    getSecureStorage(resolveSecureStorageHome(process.env)).delete();
  });

  it("persists a long-lived token returned by the configured login flow", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const accountSnapshotResolver = vi.fn(() => ({
      authenticated: true as const,
      identity: {
        accountId: "acct-1",
        email: "user@agenc.tech",
        displayName: "Remote User",
      },
      subscriptionTier: "team" as const,
    }));
    const loginFlow = vi.fn(() => ({
      token: " remote-token ",
      identity: {
        accountId: "acct-1",
        email: "user@agenc.tech",
        displayName: "Remote User",
        plan: "team",
      },
      subscriptionTier: "team",
      expiresAt: "2026-06-01T00:00:00.000Z",
    }));
    const backend = new RemoteAuthBackend({
      accountSnapshotResolver,
      agencHome,
      loginFlow,
    });

    try {
      await expect(
        backend.login({ sessionId: "cli" }),
      ).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        sessionId: "cli",
        token: "remote-token",
        identity: {
          accountId: "acct-1",
          email: "user@agenc.tech",
          displayName: "Remote User",
          plan: "team",
        },
      });
      await expect(backend.whoami()).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        identity: {
          accountId: "acct-1",
        },
      });
      const authJson = await readFile(join(agencHome, "auth.json"), "utf8");
      expect(authJson).toContain("\"provider\": \"remote\"");
      expect(authJson).not.toContain("remote-token");
      expect(readNativeFor(agencHome).remoteAuth).toMatchObject({
        bearerToken: "remote-token",
      });
      expect(loginFlow).toHaveBeenCalledWith({ sessionId: "cli" });
      expect(accountSnapshotResolver).toHaveBeenCalledWith({}, "remote-token");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("rolls back the native bearer when metadata persistence fails", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    await mkdir(join(agencHome, "auth.json"));
    const backend = new RemoteAuthBackend({
      agencHome,
      loginFlow: () => ({ token: "rollback-token" }),
    });

    try {
      await expect(backend.login()).rejects.toMatchObject({
        code: expect.stringMatching(/EISDIR|ENOTDIR|ENOTEMPTY/u),
      });
      expect(readNativeFor(agencHome).remoteAuth).toBeUndefined();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("lets an explicit env token beat a persisted remote login token", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ subscriptionTier: "team" }), {
        status: 200,
      }),
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: {
        [REMOTE_AUTH_TOKEN_ENV]: "bootstrap-token",
        [REMOTE_AUTH_TIER_URL_ENV]:
          "https://api.agenc.tech/test/subscription-tier",
      },
      fetchImpl,
      loginFlow: () => ({
        token: "remote-token",
      }),
    });

    try {
      await backend.login({ sessionId: "cli" });
      await expect(
        backend.getSubscriptionTier({ sessionId: "session-1" }),
      ).resolves.toBe("team");
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.agenc.tech/test/subscription-tier",
        {
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer bootstrap-token",
          },
          body: JSON.stringify({ sessionId: "session-1" }),
        },
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("lets an explicit constructor token beat env and persisted tokens", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ subscriptionTier: "team" }), {
        status: 200,
      }),
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: {
        [REMOTE_AUTH_TOKEN_ENV]: "env-token",
        [REMOTE_AUTH_TIER_URL_ENV]:
          "https://api.agenc.tech/test/subscription-tier",
      },
      fetchImpl,
      loginFlow: () => ({ token: "persisted-token" }),
      token: "constructor-token",
    });

    try {
      await backend.login();
      await expect(backend.getSubscriptionTier()).resolves.toBe("team");
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.agenc.tech/test/subscription-tier",
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer constructor-token",
          }),
        }),
      );
      expect(readNativeFor(agencHome).remoteAuth?.bearerToken).toBe(
        "persisted-token",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("whoami refreshes and persists the canonical account snapshot", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-whoami-"));
    const accountSnapshotResolver = vi.fn(() => ({
      authenticated: true as const,
      identity: {
        accountId: "acct-canonical",
        email: "canonical@agenc.tech",
        displayName: "Canonical User",
      },
      subscriptionTier: "team" as const,
    }));
    const backend = new RemoteAuthBackend({
      accountSnapshotResolver,
      agencHome,
      loginFlow: () => ({
        token: "remote-token",
        identity: {
          accountId: "acct-stale",
          email: "stale@agenc.tech",
          displayName: "Stale User",
        },
        subscriptionTier: "pro",
      }),
    });

    try {
      await backend.login({ sessionId: "cli" });
      await expect(backend.whoami()).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        subscriptionTier: "team",
        identity: {
          accountId: "acct-canonical",
          email: "canonical@agenc.tech",
          displayName: "Canonical User",
          plan: "team",
        },
      });
      const persisted = JSON.parse(
        await readFile(join(agencHome, "auth.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        identity: {
          accountId: "acct-canonical",
          email: "canonical@agenc.tech",
          displayName: "Canonical User",
        },
        subscriptionTier: "team",
      });
      expect(persisted).not.toHaveProperty("token");
      expect(readNativeFor(agencHome).remoteAuth?.bearerToken).toBe(
        "remote-token",
      );
      expect(accountSnapshotResolver).toHaveBeenCalledWith({}, "remote-token");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("uses the configured HTTP account snapshot endpoint", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-me-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        authenticated: true,
        identity: {
          accountId: " acct-canonical ",
          email: " canonical@agenc.tech ",
          displayName: " Canonical User ",
          handle: "must-not-cross-the-contract",
          token: "must-not-cross-the-contract",
        },
        subscriptionTier: "pro",
      }), { status: 200 })
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: {
        [REMOTE_AUTH_ME_URL_ENV]: "https://api.agenc.tech/test/auth/me",
      },
      fetchImpl,
      loginFlow: () => ({ token: "remote-token" }),
    });

    try {
      await backend.login();
      await expect(
        backend.whoami({ sessionId: "session-1" }),
      ).resolves.toEqual({
        authenticated: true,
        provider: "remote",
        identity: {
          accountId: "acct-canonical",
          email: "canonical@agenc.tech",
          displayName: "Canonical User",
          plan: "pro",
        },
        subscriptionTier: "pro",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.agenc.tech/test/auth/me",
        {
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer remote-token",
          },
          body: JSON.stringify({ sessionId: "session-1" }),
        },
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("defaults account snapshot lookup to the canonical /v1/auth/me endpoint", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-me-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        authenticated: true,
        identity: { accountId: "acct-1" },
        subscriptionTier: "free",
      }), { status: 200 })
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginFlow: () => ({ token: "remote-token" }),
    });

    try {
      await backend.login();
      await backend.whoami();
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://id.agenc.ag/v1/auth/me",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it.each([401, 403])(
    "treats HTTP %i from account snapshot lookup as signed out",
    async (status) => {
      const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-me-"));
      const backend = new RemoteAuthBackend({
        agencHome,
        fetchImpl: vi.fn(async () => new Response(null, { status })),
        loginFlow: () => ({
          token: "rejected-token",
          identity: { accountId: "acct-stale" },
          subscriptionTier: "team",
        }),
        meEndpoint: "https://api.agenc.tech/test/auth/me",
      });

      try {
        await backend.login();
        await expect(backend.whoami()).resolves.toEqual({
          authenticated: false,
          provider: "remote",
        });
        await expect(
          readFile(join(agencHome, "auth.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(agencHome, { recursive: true, force: true });
      }
    },
  );

  it("propagates account snapshot network failures without returning stale identity", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-me-"));
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
      });
    });
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginFlow: () => ({
        token: "remote-token",
        identity: { accountId: "acct-stale" },
        subscriptionTier: "team",
      }),
      meEndpoint: "https://api.agenc.tech/test/auth/me",
    });

    try {
      await backend.login();
      await expect(backend.whoami()).rejects.toThrow(
        "RemoteAuthBackend account snapshot lookup network request failed: fetch failed (connect ECONNREFUSED 127.0.0.1:443)",
      );
      await expect(
        readFile(join(agencHome, "auth.json"), "utf8"),
      ).resolves.not.toContain("remote-token");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("does not let an in-flight account snapshot overwrite a newer login", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-race-"));
    const lookupStarted = deferred<void>();
    const releaseOldLookup = deferred<{
      readonly authenticated: true;
      readonly identity: { readonly accountId: string };
      readonly subscriptionTier: "free";
    }>();
    const oldBackend = new RemoteAuthBackend({
      accountSnapshotResolver: (_request, token) => {
        if (token === "token-a") {
          lookupStarted.resolve(undefined);
          return releaseOldLookup.promise;
        }
        return {
          authenticated: true,
          identity: { accountId: "acct-b" },
          subscriptionTier: "free",
        };
      },
      agencHome,
      loginFlow: () => ({ token: "token-a" }),
    });
    const newBackend = new RemoteAuthBackend({
      accountSnapshotResolver: (_request, token) => ({
        authenticated: true,
        identity: { accountId: token === "token-b" ? "acct-b" : "unexpected" },
        subscriptionTier: "free",
      }),
      agencHome,
      loginFlow: () => ({ token: "token-b" }),
    });

    try {
      await oldBackend.login();
      const pendingWhoami = oldBackend.whoami();
      await lookupStarted.promise;
      await newBackend.login();
      releaseOldLookup.resolve({
        authenticated: true,
        identity: { accountId: "acct-a" },
        subscriptionTier: "free",
      });

      await expect(pendingWhoami).resolves.toMatchObject({
        authenticated: true,
        identity: { accountId: "acct-b" },
      });
      const persisted = JSON.parse(
        await readFile(join(agencHome, "auth.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        identity: { accountId: "acct-b" },
      });
      expect(persisted).not.toHaveProperty("token");
      expect(readNativeFor(agencHome).remoteAuth?.bearerToken).toBe("token-b");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("does not resurrect auth state when logout wins an in-flight account lookup", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-race-"));
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<{
      readonly authenticated: true;
      readonly identity: { readonly accountId: string };
      readonly subscriptionTier: "free";
    }>();
    const lookupBackend = new RemoteAuthBackend({
      accountSnapshotResolver: () => {
        lookupStarted.resolve(undefined);
        return releaseLookup.promise;
      },
      agencHome,
      loginFlow: () => ({ token: "token-a" }),
    });
    const logoutBackend = new RemoteAuthBackend({ agencHome });

    try {
      await lookupBackend.login();
      const pendingWhoami = lookupBackend.whoami();
      await lookupStarted.promise;
      await logoutBackend.logout();
      releaseLookup.resolve({
        authenticated: true,
        identity: { accountId: "acct-a" },
        subscriptionTier: "free",
      });

      await expect(pendingWhoami).resolves.toEqual({
        authenticated: false,
        provider: "remote",
      });
      await expect(
        readFile(join(agencHome, "auth.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("does not delete a newer login after an old bearer is rejected", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-race-"));
    const lookupStarted = deferred<void>();
    const releaseRejectedLookup = deferred<{ readonly authenticated: false }>();
    const oldBackend = new RemoteAuthBackend({
      accountSnapshotResolver: (_request, token) => {
        if (token === "token-a") {
          lookupStarted.resolve(undefined);
          return releaseRejectedLookup.promise;
        }
        return {
          authenticated: true,
          identity: { accountId: "acct-b" },
          subscriptionTier: "free",
        };
      },
      agencHome,
      loginFlow: () => ({ token: "token-a" }),
    });
    const newBackend = new RemoteAuthBackend({
      accountSnapshotResolver: (_request, token) => ({
        authenticated: true,
        identity: { accountId: token === "token-b" ? "acct-b" : "unexpected" },
        subscriptionTier: "free",
      }),
      agencHome,
      loginFlow: () => ({ token: "token-b" }),
    });

    try {
      await oldBackend.login();
      const pendingWhoami = oldBackend.whoami();
      await lookupStarted.promise;
      await newBackend.login();
      releaseRejectedLookup.resolve({ authenticated: false });

      await expect(pendingWhoami).resolves.toMatchObject({
        authenticated: true,
        identity: { accountId: "acct-b" },
      });
      await expect(
        readFile(join(agencHome, "auth.json"), "utf8"),
      ).resolves.not.toContain("token-b");
      expect(readNativeFor(agencHome).remoteAuth?.bearerToken).toBe("token-b");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("serializes parallel account snapshot writes without leftover temp files", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-race-"));
    const backend = new RemoteAuthBackend({
      accountSnapshotResolver: async () => ({
        authenticated: true,
        identity: { accountId: "acct-1" },
        subscriptionTier: "free",
      }),
      agencHome,
      loginFlow: () => ({ token: "remote-token" }),
    });

    try {
      await backend.login();
      await Promise.all(
        Array.from({ length: 12 }, () => backend.whoami()),
      );
      await expect(
        readFile(join(agencHome, "auth.json"), "utf8").then(JSON.parse),
      ).resolves.toMatchObject({ provider: "remote" });
      expect(readNativeFor(agencHome).remoteAuth?.bearerToken).toBe(
        "remote-token",
      );
      const stateArtifacts = (await readdir(agencHome)).filter((name) =>
        name.endsWith(".lock") || name.endsWith(".tmp")
      );
      expect(stateArtifacts).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("uses the configured HTTP device login endpoints", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const onDeviceCode = vi.fn();
    const sleepMs = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            userCode: "USER-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "remote-token",
            identity: { accountId: "acct-1" },
            subscriptionTier: "pro",
          }),
          { status: 200 },
        ),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: {
        [REMOTE_AUTH_LOGIN_START_URL_ENV]:
          "https://api.agenc.tech/test/login/start",
        [REMOTE_AUTH_LOGIN_POLL_URL_ENV]:
          "https://api.agenc.tech/test/login/poll",
      },
      fetchImpl,
      onDeviceCode,
      sleepMs,
    });

    try {
      await expect(backend.login({ sessionId: "cli" })).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        token: "remote-token",
      });
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        "https://api.agenc.tech/test/login/start",
        {
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "cli" }),
        },
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        "https://api.agenc.tech/test/login/poll",
        {
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceCode: "device-1",
            sessionId: "cli",
          }),
        },
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        3,
        "https://api.agenc.tech/test/login/poll",
        {
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceCode: "device-1",
            sessionId: "cli",
          }),
        },
      );
      expect(onDeviceCode).toHaveBeenCalledWith({
        verificationUri: "https://agenc.tech/login",
        userCode: "USER-1",
        intervalSeconds: 0,
      });
      expect(sleepMs).toHaveBeenCalledWith(
        REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS,
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("reports login start network failures with operation context", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: new Error("getaddrinfo ENOTFOUND id.agenc.ag"),
        }),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginStartEndpoint: "https://id.agenc.ag/v1/auth/login/start",
    });

    try {
      await expect(backend.login({ sessionId: "tui" })).rejects.toThrow(
        "RemoteAuthBackend login start network request failed: fetch failed (getaddrinfo ENOTFOUND id.agenc.ag)",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("retries transient login poll network failures", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const sleepMs = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            userCode: "USER-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 0,
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "remote-token" }), {
          status: 200,
        }),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
      loginStartEndpoint: "https://api.agenc.tech/test/login/start",
      sleepMs,
    });

    try {
      await expect(backend.login({ sessionId: "tui" })).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        token: "remote-token",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleepMs).toHaveBeenCalledWith(
        REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS,
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("accepts standard OAuth device-code start fields", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const onDeviceCode = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: "device-1",
            user_code: "USER-1",
            verification_uri: "https://agenc.tech/login",
            interval: "1",
            expires_in: 600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "remote-token" }), {
          status: 200,
        }),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
      loginStartEndpoint: "https://api.agenc.tech/test/login/start",
      onDeviceCode,
    });

    try {
      await expect(backend.login({ sessionId: "cli" })).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        token: "remote-token",
      });
      expect(onDeviceCode).toHaveBeenCalledWith({
        verificationUri: "https://agenc.tech/login",
        userCode: "USER-1",
        intervalSeconds: 1,
      });
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        "https://api.agenc.tech/test/login/poll",
        {
          method: "POST",
          signal: expect.any(AbortSignal),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceCode: "device-1",
            sessionId: "cli",
          }),
        },
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("honors interval hints on pending device-code poll responses", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const sleepMs = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 1,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "pending",
            error: "authorization_pending",
            intervalSeconds: 4,
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "remote-token" }), {
          status: 200,
        }),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
      loginStartEndpoint: "https://api.agenc.tech/test/login/start",
      sleepMs,
    });

    try {
      await expect(backend.login({ sessionId: "cli" })).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        token: "remote-token",
      });
      expect(sleepMs).toHaveBeenCalledWith(REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("honors interval hints on slow_down device-code poll responses", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const sleepMs = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 1,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "slow_down",
            intervalSeconds: 7,
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "remote-token" }), {
          status: 200,
        }),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
      loginStartEndpoint: "https://api.agenc.tech/test/login/start",
      sleepMs,
    });

    try {
      await expect(backend.login({ sessionId: "cli" })).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        token: "remote-token",
      });
      expect(sleepMs).toHaveBeenCalledWith(7_000);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("rejects standard expired device-code polling responses", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            userCode: "USER-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "expired_token" }), {
          status: 400,
        }),
      );
    const backend = new RemoteAuthBackend({
      agencHome,
      fetchImpl,
      loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
      loginStartEndpoint: "https://api.agenc.tech/test/login/start",
    });

    try {
      await expect(backend.login({ sessionId: "cli" })).rejects.toThrow(
        /device code expired/,
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("returns subscription tiers through the configured resolver", async () => {
    const subscriptionTierResolver = vi.fn(({ sessionId }) => {
      expect(sessionId).toBe("session-1");
      return "team";
    });
    const backend = new RemoteAuthBackend({ subscriptionTierResolver });

    await expect(
      backend.getSubscriptionTier({ sessionId: "session-1" }),
    ).resolves.toBe("team");
    expect(subscriptionTierResolver).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
  });

  it("persists refreshed subscription tiers to the remote auth state", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const backend = new RemoteAuthBackend({
      agencHome,
      loginFlow: () => ({
        token: "remote-token",
        subscriptionTier: "free",
      }),
      subscriptionTierResolver: () => "pro",
    });

    try {
      await backend.login({ sessionId: "cli" });
      await expect(
        backend.getSubscriptionTier({ sessionId: "session-1" }),
      ).resolves.toBe("pro");
      await expect(readFile(join(agencHome, "auth.json"), "utf8")).resolves
        .toContain("\"subscriptionTier\": \"pro\"");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("does not persist an old account tier over a newer login", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-race-"));
    const lookupStarted = deferred<void>();
    const releaseOldTier = deferred<"pro">();
    let lookupCount = 0;
    const oldBackend = new RemoteAuthBackend({
      agencHome,
      loginFlow: () => ({ token: "token-a", subscriptionTier: "free" }),
      subscriptionTierResolver: () => {
        lookupCount += 1;
        if (lookupCount === 1) {
          lookupStarted.resolve(undefined);
          return releaseOldTier.promise;
        }
        return "free";
      },
    });
    const newBackend = new RemoteAuthBackend({
      agencHome,
      loginFlow: () => ({ token: "token-b", subscriptionTier: "team" }),
    });

    try {
      await oldBackend.login();
      const pendingTier = oldBackend.getSubscriptionTier();
      await lookupStarted.promise;
      await newBackend.login();
      releaseOldTier.resolve("pro");

      await expect(pendingTier).resolves.toBe("free");
      const persisted = JSON.parse(
        await readFile(join(agencHome, "auth.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        subscriptionTier: "free",
      });
      expect(persisted).not.toHaveProperty("token");
      expect(readNativeFor(agencHome).remoteAuth?.bearerToken).toBe("token-b");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("uses the configured HTTP subscription tier endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          subscriptionTier: "pro",
        }),
        { status: 200 },
      ),
    );
    const backend = new RemoteAuthBackend({
      agencHome: "/tmp/agenc-remote-auth-test",
      env: {
        [REMOTE_AUTH_TIER_URL_ENV]:
          "https://api.agenc.tech/test/subscription-tier",
        [REMOTE_AUTH_TOKEN_ENV]: "remote-token",
      },
      fetchImpl,
    });

    await expect(
      backend.getSubscriptionTier({ sessionId: "session-1" }),
    ).resolves.toBe("pro");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.agenc.tech/test/subscription-tier",
      {
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer remote-token",
        },
        body: JSON.stringify({
          sessionId: "session-1",
        }),
      },
    );
  });

  it("treats missing remote auth token as free subscription tier", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ subscriptionTier: "pro" }), { status: 200 }),
    );
    const backend = new RemoteAuthBackend({ agencHome, fetchImpl });

    try {
      await expect(backend.getSubscriptionTier()).resolves.toBe("free");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("treats rejected remote auth token as free subscription tier", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
          },
        }),
        { status: 401 },
      ),
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: { [REMOTE_AUTH_TOKEN_ENV]: "stale-token" },
      fetchImpl,
    });

    try {
      await expect(backend.getSubscriptionTier()).resolves.toBe("free");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("rejects invalid subscription tier responses", async () => {
    const backend = new RemoteAuthBackend({
      subscriptionTierResolver: () => "trial" as never,
    });

    await expect(backend.getSubscriptionTier()).rejects.toThrow(/invalid tier/);
  });

  it("normalizes C4E subscription responses to enterprise entitlement", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ subscriptionTier: "c4e" }), {
        status: 200,
      }),
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: { [REMOTE_AUTH_TOKEN_ENV]: "remote-token" },
      fetchImpl,
      tierEndpoint: "https://api.agenc.tech/test/subscription-tier",
    });

    try {
      await expect(backend.getSubscriptionTier()).resolves.toBe("enterprise");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("clears persisted remote auth state on logout", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const accountSnapshotResolver = vi.fn(() => ({
      authenticated: true as const,
      identity: { accountId: "acct-1" },
      subscriptionTier: "free" as const,
    }));
    const backend = new RemoteAuthBackend({
      accountSnapshotResolver,
      agencHome,
      loginFlow: () => ({
        token: "remote-token",
        identity: { accountId: "acct-1" },
      }),
    });

    try {
      await backend.login();
      await expect(backend.whoami()).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
      });
      await expect(backend.logout()).resolves.toEqual({ authenticated: false });
      expect(readNativeFor(agencHome).remoteAuth).toBeUndefined();
      await expect(backend.whoami()).resolves.toEqual({
        authenticated: false,
        provider: "remote",
      });
      expect(accountSnapshotResolver).toHaveBeenCalledOnce();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});
