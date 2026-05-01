import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../auth/backend.js";
import { createAgenCDaemonRuntimeAuthBackend } from "./provider-key-vending.js";

function makeAuthBackend(vendKey: AuthBackend["vendKey"]): AuthBackend {
  return {
    login: vi.fn(() => ({ authenticated: true, provider: "local" })),
    logout: vi.fn(() => ({ authenticated: false })),
    whoami: vi.fn(() => ({ authenticated: true, provider: "local" })),
    vendKey,
    inferAgencModel: vi.fn(() => ({
      provider: "agenc",
      model: "agenc:grok",
    })),
    getSubscriptionTier: vi.fn(() => "pro"),
  };
}

describe("AgenC daemon provider-key vending", () => {
  it("vends one managed provider key per daemon runtime session and provider", async () => {
    const calls: string[] = [];
    const backend = makeAuthBackend((provider, sessionId) => {
      calls.push(`${provider}:${sessionId}`);
      return {
        provider: String(provider),
        sessionId,
        apiKey: `managed-key-${calls.length}`,
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend);

    const first = await wrapped.vendKey("grok", "session-1");
    const duplicate = await wrapped.vendKey("grok", "session-1");
    const secondSession = await wrapped.vendKey("grok", "session-2");
    const secondProvider = await wrapped.vendKey("openai", "session-1");

    expect(duplicate).toBe(first);
    expect(secondSession.apiKey).toBe("managed-key-2");
    expect(secondProvider.apiKey).toBe("managed-key-3");
    expect(calls).toEqual([
      "grok:session-1",
      "grok:session-2",
      "openai:session-1",
    ]);
  });

  it("retries a provider-key vend after the AuthBackend rejects", async () => {
    let attempts = 0;
    const backend = makeAuthBackend((provider, sessionId) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary vending failure");
      }
      return {
        provider: String(provider),
        sessionId,
        apiKey: "managed-key",
      };
    });
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend);

    await expect(wrapped.vendKey("grok", "session-1")).rejects.toThrow(
      "temporary vending failure",
    );
    await expect(wrapped.vendKey("grok", "session-1")).resolves.toMatchObject({
      apiKey: "managed-key",
    });
    expect(attempts).toBe(2);
  });
});
