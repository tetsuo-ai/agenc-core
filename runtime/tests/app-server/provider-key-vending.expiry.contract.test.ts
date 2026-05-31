import { describe, expect, it, vi } from "vitest";
import type { AuthBackend, AuthVendedKey } from "../auth/backend.js";
import { createAgenCDaemonRuntimeAuthBackend } from "./provider-key-vending.js";

function makeAuthBackend(vendKey: AuthBackend["vendKey"]): AuthBackend {
  return {
    login: vi.fn(() => ({ authenticated: true, provider: "local" })),
    logout: vi.fn(() => ({ authenticated: false })),
    whoami: vi.fn(() => ({ authenticated: true, provider: "local" })),
    vendKey: vi.fn(vendKey),
    inferAgencModel: vi.fn(() => ({ provider: "agenc", model: "agenc:grok" })),
    getSubscriptionTier: vi.fn(() => "pro"),
  };
}

describe("AgenC daemon provider-key vending expiry", () => {
  it("keeps caching a key that is still within its expiresAt window", async () => {
    let now = 1_000_000;
    const expiresAt = new Date(now + 60_000).toISOString();
    let count = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      count += 1;
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${count}`,
        expiresAt,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend, {
      nowMs: () => now,
    });

    const first = await wrapped.vendKey("grok", "session-1");
    now += 30_000;
    const second = await wrapped.vendKey("grok", "session-1");

    expect(second).toBe(first);
    expect(backend.vendKey).toHaveBeenCalledTimes(1);
  });

  it("re-vends once the cached key passes its expiresAt", async () => {
    let now = 1_000_000;
    const expiresAt = new Date(now + 60_000).toISOString();
    let count = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      count += 1;
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${count}`,
        expiresAt,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend, {
      nowMs: () => now,
    });

    const first = await wrapped.vendKey("grok", "session-1");
    expect(first.apiKey).toBe("managed-key-1");

    now += 120_000;
    const second = await wrapped.vendKey("grok", "session-1");

    expect(second.apiKey).toBe("managed-key-2");
    expect(backend.vendKey).toHaveBeenCalledTimes(2);
  });

  it("re-vends within the clock-skew margin before the real expiry", async () => {
    let now = 0;
    const expiresAt = new Date(10_000).toISOString();
    let count = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      count += 1;
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${count}`,
        expiresAt,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend, {
      nowMs: () => now,
    });

    await wrapped.vendKey("grok", "session-1");
    // 4s before real expiry, but inside the 5s skew window → re-vend.
    now = 6_000;
    const second = await wrapped.vendKey("grok", "session-1");

    expect(second.apiKey).toBe("managed-key-2");
    expect(backend.vendKey).toHaveBeenCalledTimes(2);
  });

  it("caches indefinitely when the vended key carries no expiresAt", async () => {
    let now = 0;
    let count = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      count += 1;
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${count}`,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend, {
      nowMs: () => now,
    });

    const first = await wrapped.vendKey("grok", "session-1");
    now += 10_000_000;
    const second = await wrapped.vendKey("grok", "session-1");

    expect(second).toBe(first);
    expect(backend.vendKey).toHaveBeenCalledTimes(1);
  });

  it("shares the in-flight vend among concurrent callers", async () => {
    let now = 0;
    let resolveFirst: ((value: AuthVendedKey) => void) | undefined;
    let count = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      count += 1;
      if (count === 1) {
        return new Promise<AuthVendedKey>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { provider: String(provider), sessionId, apiKey: `managed-key-${count}` };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend, {
      nowMs: () => now,
    });

    const p1 = wrapped.vendKey("grok", "session-1");
    const p2 = wrapped.vendKey("grok", "session-1");
    expect(backend.vendKey).toHaveBeenCalledTimes(1);

    resolveFirst?.({ provider: "grok", sessionId: "session-1", apiKey: "managed-key-1" });
    expect((await p1).apiKey).toBe("managed-key-1");
    expect((await p2).apiKey).toBe("managed-key-1");
  });

  it("clearVendedKeyCache forces a fresh vend on the next call", async () => {
    let count = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      count += 1;
      return { provider: String(provider), sessionId, apiKey: `managed-key-${count}` };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend);

    await wrapped.vendKey("grok", "session-1");
    wrapped.clearVendedKeyCache();
    const second = await wrapped.vendKey("grok", "session-1");

    expect(second.apiKey).toBe("managed-key-2");
    expect(backend.vendKey).toHaveBeenCalledTimes(2);
  });
});
