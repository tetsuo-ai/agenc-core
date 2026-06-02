import { describe, expect, it, vi } from "vitest";

import { createAgenCDaemonRuntimeAuthBackend } from "src/app-server/provider-key-vending";
import type { AuthBackend } from "src/auth/backend";

// gaphunt3 #48: the daemon vended-key cache (keyed by `${sessionId}\0${provider}`)
// only evicts on vend error, re-vend after expiry, or wholesale clear. A key that
// "never expires" (expiresAt undefined) is retained forever, so a long-lived
// daemon that serves many short sessions leaks one entry per
// (terminated session, provider). The fix adds clearVendedKeysForSession so the
// session-termination path can drop exactly that session's entries.

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

describe("gaphunt3 #48 daemon vended-key per-session eviction", () => {
  it("drops a terminated session's non-expiring vended key, forcing a re-vend", async () => {
    let calls = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      calls += 1;
      // No expiresAt -> parseExpiresAtMs returns null -> never expires.
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${calls}`,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend);

    // Vend a non-expiring key for sessionA; a second vend is served from cache.
    const first = await wrapped.vendKey("grok", "session-a");
    const cached = await wrapped.vendKey("grok", "session-a");
    expect(cached).toBe(first);
    expect(backend.vendKey).toHaveBeenCalledTimes(1);

    // Terminate sessionA: its cache entry must be evicted.
    wrapped.clearVendedKeysForSession("session-a");

    // The next vend for sessionA must hit the backend again (cache no longer
    // holds the entry). Before the fix the stale entry persisted and was reused,
    // so vendKey would NOT have been re-invoked.
    const revended = await wrapped.vendKey("grok", "session-a");
    expect(revended).not.toBe(first);
    expect(revended.apiKey).toBe("managed-key-2");
    expect(backend.vendKey).toHaveBeenCalledTimes(2);
  });

  it("evicts only the terminated session, leaving other sessions cached", async () => {
    let calls = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      calls += 1;
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${calls}`,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend);

    const aGrok = await wrapped.vendKey("grok", "session-a");
    const aOpenai = await wrapped.vendKey("openai", "session-a");
    const bGrok = await wrapped.vendKey("grok", "session-b");
    expect(backend.vendKey).toHaveBeenCalledTimes(3);

    wrapped.clearVendedKeysForSession("session-a");

    // session-b's cached key is untouched (no re-vend).
    await expect(wrapped.vendKey("grok", "session-b")).resolves.toBe(bGrok);
    expect(backend.vendKey).toHaveBeenCalledTimes(3);

    // Every provider entry for session-a was dropped: each re-vends once.
    const aGrok2 = await wrapped.vendKey("grok", "session-a");
    const aOpenai2 = await wrapped.vendKey("openai", "session-a");
    expect(aGrok2).not.toBe(aGrok);
    expect(aOpenai2).not.toBe(aOpenai);
    expect(backend.vendKey).toHaveBeenCalledTimes(5);
  });
});
