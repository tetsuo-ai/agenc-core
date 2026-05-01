import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_AUTH_TOKEN_ENV,
  REMOTE_AUTH_URL_ENV,
  RemoteAuthBackend,
} from "./remote.js";

describe("RemoteAuthBackend", () => {
  it("requests and caches managed keys per session and provider in memory", async () => {
    let vendCount = 0;
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: ` managed-${++vendCount} `,
    }));
    const backend = new RemoteAuthBackend({ keyVendor });

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

  it("retries key vending after a failed remote request", async () => {
    let attempts = 0;
    const backend = new RemoteAuthBackend({
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

  it("uses the configured HTTP key vending endpoint by default", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          apiKey: " managed-http-key ",
          expiresAt: "2026-05-01T12:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    const backend = new RemoteAuthBackend({
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

  it("keeps non-vending remote auth surfaces explicit until their rows land", () => {
    const backend = new RemoteAuthBackend();

    expect(() => backend.login()).toThrow(/remote login flow/);
    expect(backend.whoami()).toEqual({
      authenticated: false,
      provider: "remote",
    });
    expect(backend.logout()).toEqual({ authenticated: false });
    expect(() => backend.inferAgencModel()).toThrow(/hosted model routing/);
    expect(backend.getSubscriptionTier()).toBe("free");
  });
});
