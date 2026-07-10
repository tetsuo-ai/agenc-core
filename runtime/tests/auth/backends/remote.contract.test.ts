import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RemoteAuthBackend } from "./remote.js";

const REMOTE_AUTH_LOGIN_POLL_URL_ENV = "AGENC_REMOTE_AUTH_LOGIN_POLL_URL";
const REMOTE_AUTH_LOGIN_START_URL_ENV = "AGENC_REMOTE_AUTH_LOGIN_START_URL";
const REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS = 5_000;
const REMOTE_AUTH_MODEL_URL_ENV = "AGENC_REMOTE_AUTH_MODEL_URL";
const REMOTE_AUTH_TIER_URL_ENV = "AGENC_REMOTE_AUTH_TIER_URL";
const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN";
const REMOTE_AUTH_URL_ENV = "AGENC_REMOTE_AUTH_URL";
const REMOTE_AUTH_USAGE_URL_ENV = "AGENC_REMOTE_AUTH_USAGE_URL";

function invalidJsonResponse(): Response {
  return new Response("not-json", { status: 200 });
}

describe("RemoteAuthBackend", () => {
  it("persists a long-lived token returned by the configured login flow", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
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
    const backend = new RemoteAuthBackend({ agencHome, loginFlow });

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
      await expect(readFile(join(agencHome, "auth.json"), "utf8")).resolves
        .toContain("\"provider\": \"remote\"");
      expect(loginFlow).toHaveBeenCalledWith({ sessionId: "cli" });
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("uses a persisted remote login token for later HTTP auth calls", async () => {
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

  it("whoami preserves the persisted subscription tier in the account snapshot", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-whoami-"));
    const backend = new RemoteAuthBackend({
      agencHome,
      loginFlow: () => ({
        token: "remote-token",
        identity: {
          accountId: "acct-linked",
          email: "linked@agenc.tech",
          displayName: "Linked User",
        },
        subscriptionTier: "pro",
      }),
    });

    try {
      await backend.login({ sessionId: "cli" });
      await expect(backend.whoami()).resolves.toMatchObject({
        authenticated: true,
        provider: "remote",
        subscriptionTier: "pro",
        identity: {
          accountId: "acct-linked",
          email: "linked@agenc.tech",
          displayName: "Linked User",
          plan: "pro",
        },
      });
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("uses a persisted remote login token for later HTTP LLM usage calls", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        managedModelsEnabled: true,
        modelAllowance: {
          allowedModelCount: 19,
          duration: "30d",
          includedUsd: 10,
          percentUsed: 12.3,
          remainingUsd: 8.7654,
          resetsAt: "2026-06-01T00:00:00.000Z",
          status: "active",
          usedUsd: 1.2346,
        },
        subscriptionTier: "pro",
      }), { status: 200 })
    );
    const backend = new RemoteAuthBackend({
      agencHome,
      env: {
        [REMOTE_AUTH_TOKEN_ENV]: "bootstrap-token",
        [REMOTE_AUTH_USAGE_URL_ENV]: "https://api.agenc.tech/test/llm-usage",
      },
      fetchImpl,
      loginFlow: () => ({
        token: "remote-token",
      }),
    });

    try {
      await backend.login({ sessionId: "cli" });
      await expect(
        backend.getLlmUsage({ sessionId: "session-1" }),
      ).resolves.toMatchObject({
        managedModelsEnabled: true,
        modelAllowance: {
          remainingUsd: 8.7654,
          status: "active",
          usedUsd: 1.2346,
        },
        subscriptionTier: "pro",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.agenc.tech/test/llm-usage",
        {
          method: "POST",
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "cli" }),
        },
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        "https://api.agenc.tech/test/login/poll",
        {
          method: "POST",
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

  it("clears managed-key cache across remote login state changes", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));
    let loginCount = 0;
    let vendCount = 0;
    const backend = new RemoteAuthBackend({
      agencHome,
      managedKeysEnabled: true,
      keyVendor: ({ provider, sessionId }) => ({
        provider,
        sessionId,
        apiKey: `managed-${++vendCount}`,
      }),
      loginFlow: () => ({
        token: `remote-token-${++loginCount}`,
      }),
    });

    try {
      await backend.login({ sessionId: "cli" });
      await expect(backend.vendKey("grok", "session-1")).resolves.toMatchObject({
        apiKey: "managed-1",
      });
      await backend.logout();
      await backend.login({ sessionId: "cli" });
      await expect(backend.vendKey("grok", "session-1")).resolves.toMatchObject({
        apiKey: "managed-2",
      });
      expect(vendCount).toBe(2);
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

  it("requests and caches managed keys per session and provider in memory", async () => {
    let vendCount = 0;
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: ` managed-${++vendCount} `,
    }));
    const backend = new RemoteAuthBackend({
      keyVendor,
      managedKeysEnabled: true,
    });

    const [first, duplicate] = await Promise.all([
      backend.vendKey("grok", "session-1"),
      backend.vendKey("grok", "session-1"),
    ]);
    const secondSession = await backend.vendKey("grok", "session-2");
    const secondProvider = await backend.vendKey("openai", "session-1");

    expect(first).toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-1",
    });
    expect(duplicate).toBe(first);
    expect(secondSession.apiKey).toBe("managed-2");
    expect(secondProvider.apiKey).toBe("managed-3");
    expect(keyVendor).toHaveBeenCalledTimes(3);
    expect(keyVendor.mock.calls.map(([request]) => request)).toEqual([
      { provider: "grok", sessionId: "session-1" },
      { provider: "grok", sessionId: "session-2" },
      { provider: "openai", sessionId: "session-1" },
    ]);
  });

  it("does not request managed keys unless config selection enables them", async () => {
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: "managed-key",
    }));
    const backend = new RemoteAuthBackend({
      keyVendor,
    });

    await expect(backend.vendKey("grok", "session-1")).rejects.toThrow(
      /auth\.managedKeys\.enabled/,
    );
    expect(keyVendor).not.toHaveBeenCalled();
  });

  it("expires cached managed keys after the configured in-memory TTL", async () => {
    let nowMs = 1_000;
    let vendCount = 0;
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: `managed-${++vendCount}`,
    }));
    const backend = new RemoteAuthBackend({
      keyVendor,
      managedKeysEnabled: true,
      keyCacheTtlMs: 100,
      nowMs: () => nowMs,
    });

    await expect(backend.vendKey("grok", "session-1")).resolves.toMatchObject({
      apiKey: "managed-1",
    });
    nowMs += 99;
    await expect(backend.vendKey("grok", "session-1")).resolves.toMatchObject({
      apiKey: "managed-1",
    });
    nowMs += 2;
    await expect(backend.vendKey("grok", "session-1")).resolves.toMatchObject({
      apiKey: "managed-2",
    });
    expect(keyVendor).toHaveBeenCalledTimes(2);
  });

  it("sweeps expired one-shot sessions when vending a different session", async () => {
    let nowMs = 1_000;
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: `managed-${sessionId}`,
    }));
    const backend = new RemoteAuthBackend({
      keyVendor,
      managedKeysEnabled: true,
      keyCacheTtlMs: 100,
      nowMs: () => nowMs,
    });

    await backend.vendKey("grok", "session-1");
    nowMs += 101;
    await backend.vendKey("grok", "session-2");

    expect(backend.pruneExpiredKeys()).toBe(0);
    expect(keyVendor.mock.calls.map(([request]) => request.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("retries key vending after a failed remote request", async () => {
    let attempts = 0;
    const backend = new RemoteAuthBackend({
      managedKeysEnabled: true,
      keyVendor: ({ provider, sessionId }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("remote key service unavailable");
        }
        return { provider, sessionId, apiKey: "managed-key" };
      },
    });

    await expect(backend.vendKey("grok", "session-1")).rejects.toThrow(
      "remote key service unavailable",
    );
    await expect(backend.vendKey("grok", "session-1")).resolves.toMatchObject({
      apiKey: "managed-key",
    });
    expect(attempts).toBe(2);
  });

  it("rejects injected key vendors that return a different identity", async () => {
    const backend = new RemoteAuthBackend({
      managedKeysEnabled: true,
      keyVendor: () => ({
        provider: "openai",
        sessionId: "session-2",
        apiKey: "managed-key",
      }),
    });

    await expect(backend.vendKey("grok", "session-1")).rejects.toThrow(
      /provider mismatch/,
    );
  });

  it("uses the configured HTTP key vending endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          provider: "grok",
          sessionId: "session-1",
          apiKey: " managed-http-key ",
          expiresAt: "2026-05-01T12:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    const backend = new RemoteAuthBackend({
      agencHome: "/tmp/agenc-remote-auth-test",
      managedKeysEnabled: true,
      env: {
        [REMOTE_AUTH_URL_ENV]: "https://api.agenc.tech/test/vend-key",
        [REMOTE_AUTH_TOKEN_ENV]: "remote-token",
      },
      fetchImpl,
    });

    await expect(backend.vendKey("grok", "session-1")).resolves.toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-http-key",
      expiresAt: "2026-05-01T12:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.agenc.tech/test/vend-key",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer remote-token",
        },
        body: JSON.stringify({
          provider: "grok",
          sessionId: "session-1",
        }),
      },
    );
  });

  it("accepts the current backend LiteLLM credential response shape", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          litellmKey: " hosted-litellm-key ",
          baseUrl: " https://llm.agenc.tech ",
          expiresAt: "2026-05-01T12:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    const backend = new RemoteAuthBackend({
      agencHome: "/tmp/agenc-remote-auth-test",
      managedKeysEnabled: true,
      env: { [REMOTE_AUTH_TOKEN_ENV]: "remote-token" },
      fetchImpl,
    });

    await expect(backend.vendKey("grok", "session-1")).resolves.toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "hosted-litellm-key",
      baseUrl: "https://llm.agenc.tech",
      expiresAt: "2026-05-01T12:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://id.agenc.ag/v1/auth/llm-credential",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer remote-token",
        },
        body: JSON.stringify({
          provider: "grok",
          sessionId: "session-1",
        }),
      },
    );
  });

  it("preserves Bedrock credential fields from HTTP key vending responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          provider: "amazon-bedrock",
          sessionId: "session-1",
          apiKey: " managed-aws-access ",
          secretAccessKey: " managed-aws-secret ",
          sessionToken: " managed-aws-session ",
          region: " us-west-2 ",
        }),
        { status: 200 },
      ),
    );
    const backend = new RemoteAuthBackend({
      agencHome: "/tmp/agenc-remote-auth-test",
      managedKeysEnabled: true,
      env: {
        [REMOTE_AUTH_URL_ENV]: "http://127.0.0.1:9010/vend-key",
        [REMOTE_AUTH_TOKEN_ENV]: "remote-token",
      },
      fetchImpl,
    });

    await expect(
      backend.vendKey("amazon-bedrock", "session-1"),
    ).resolves.toEqual({
      provider: "amazon-bedrock",
      sessionId: "session-1",
      apiKey: "managed-aws-access",
      secretAccessKey: "managed-aws-secret",
      sessionToken: "managed-aws-session",
      region: "us-west-2",
    });
  });

  it("rejects remote key responses for a different session or provider", async () => {
    const providerMismatch = new RemoteAuthBackend({
      managedKeysEnabled: true,
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            provider: "openai",
            sessionId: "session-1",
            apiKey: "managed-key",
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(providerMismatch.vendKey("grok", "session-1")).rejects.toThrow(
      /provider mismatch/,
    );

    const sessionMismatch = new RemoteAuthBackend({
      managedKeysEnabled: true,
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            provider: "grok",
            sessionId: "session-2",
            apiKey: "managed-key",
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(sessionMismatch.vendKey("grok", "session-1")).rejects.toThrow(
      /session mismatch/,
    );
  });

  it("rejects malformed successful HTTP JSON with remote auth errors", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-"));

    try {
      const keyBackend = new RemoteAuthBackend({
        agencHome,
        managedKeysEnabled: true,
        env: { [REMOTE_AUTH_TOKEN_ENV]: "remote-token" },
        fetchImpl: vi.fn(async () => invalidJsonResponse()),
      });
      await expect(keyBackend.vendKey("grok", "session-1")).rejects.toThrow(
        "RemoteAuthBackend key vending returned invalid JSON",
      );

      const loginStartBackend = new RemoteAuthBackend({
        agencHome,
        fetchImpl: vi.fn(async () => invalidJsonResponse()),
      });
      await expect(loginStartBackend.login({ sessionId: "cli" })).rejects.toThrow(
        "RemoteAuthBackend login start returned invalid JSON",
      );

      const loginPollBackend = new RemoteAuthBackend({
        agencHome,
        fetchImpl: vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ deviceCode: "device-1" }), {
              status: 200,
            }),
          )
          .mockResolvedValueOnce(invalidJsonResponse()),
      });
      await expect(loginPollBackend.login({ sessionId: "cli" })).rejects.toThrow(
        "RemoteAuthBackend login poll returned invalid JSON",
      );

      const modelBackend = new RemoteAuthBackend({
        agencHome,
        env: { [REMOTE_AUTH_TOKEN_ENV]: "remote-token" },
        fetchImpl: vi.fn(async () => invalidJsonResponse()),
      });
      await expect(
        modelBackend.inferAgencModel({
          provider: "agenc",
          requestedModel: "agenc",
          sessionId: "session-1",
        }),
      ).rejects.toThrow(
        "RemoteAuthBackend hosted model routing returned invalid JSON",
      );

      const tierBackend = new RemoteAuthBackend({
        agencHome,
        env: { [REMOTE_AUTH_TOKEN_ENV]: "remote-token" },
        fetchImpl: vi.fn(async () => invalidJsonResponse()),
      });
      await expect(tierBackend.getSubscriptionTier()).rejects.toThrow(
        "RemoteAuthBackend subscription tier lookup returned invalid JSON",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("infers hosted AgenC model aliases through the configured model inferer", async () => {
    const modelInferer = vi.fn(
      ({ subscriptionTier }) => ({
        provider: " grok ",
        model: " grok-4-fast ",
        ...(subscriptionTier ? { subscriptionTier } : {}),
        reason: " team route ",
      }),
    );
    const backend = new RemoteAuthBackend({ modelInferer });

    await expect(
      backend.inferAgencModel({
        provider: "agenc",
        requestedModel: "agenc",
        sessionId: "session-1",
        subscriptionTier: "team",
      }),
    ).resolves.toEqual({
      provider: "grok",
      model: "grok-4-fast",
      subscriptionTier: "team",
      reason: "team route",
    });
    expect(modelInferer).toHaveBeenCalledWith({
      provider: "agenc",
      requestedModel: "agenc",
      sessionId: "session-1",
      subscriptionTier: "team",
    });
  });

  it("uses the configured HTTP hosted model routing endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          provider: "grok",
          model: "grok-4-fast",
          subscriptionTier: "pro",
          reason: "hosted routing",
        }),
        { status: 200 },
      ),
    );
    const backend = new RemoteAuthBackend({
      agencHome: "/tmp/agenc-remote-auth-test",
      env: {
        [REMOTE_AUTH_MODEL_URL_ENV]: "https://api.agenc.tech/test/infer-model",
        [REMOTE_AUTH_TOKEN_ENV]: "remote-token",
      },
      fetchImpl,
    });

    await expect(
      backend.inferAgencModel({
        provider: "agenc",
        requestedModel: "agenc:fast",
        sessionId: "session-1",
        subscriptionTier: "pro",
      }),
    ).resolves.toEqual({
      provider: "grok",
      model: "grok-4-fast",
      subscriptionTier: "pro",
      reason: "hosted routing",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.agenc.tech/test/infer-model",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer remote-token",
        },
        body: JSON.stringify({
          provider: "agenc",
          requestedModel: "agenc:fast",
          sessionId: "session-1",
          subscriptionTier: "pro",
        }),
      },
    );
  });

  it("rejects hosted model routing responses without a concrete model", async () => {
    const backend = new RemoteAuthBackend({
      modelInferer: () => ({
        provider: "grok",
        model: " ",
      }),
    });

    await expect(backend.inferAgencModel({ requestedModel: "agenc" })).rejects.toThrow(
      /missing model/,
    );
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
    const backend = new RemoteAuthBackend({
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
      await expect(backend.whoami()).resolves.toEqual({
        authenticated: false,
        provider: "remote",
      });
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});
