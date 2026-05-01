import { describe, expect, it } from "vitest";
import type { AuthBackend, AuthSessionId } from "./backend.js";

function asPromise<T>(value: T | Promise<T>): Promise<T> {
  return Promise.resolve(value);
}

describe("AuthBackend contract", () => {
  it("defines the complete auth, key-vending, model, and tier surface", async () => {
    const calls: string[] = [];
    const backend: AuthBackend = {
      login: async ({ sessionId } = {}) => {
        calls.push(`login:${sessionId ?? ""}`);
        return {
          authenticated: true,
          provider: "local",
          ...(sessionId ? { sessionId } : {}),
        };
      },
      logout: ({ sessionId } = {}) => {
        calls.push(`logout:${sessionId ?? ""}`);
        return { authenticated: false };
      },
      whoami: ({ sessionId } = {}) => {
        calls.push(`whoami:${sessionId ?? ""}`);
        return {
          authenticated: true,
          provider: "local",
          identity: {
            accountId: sessionId ?? "local-user",
            plan: "free",
          },
        };
      },
      vendKey: (provider: string, sessionId: AuthSessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return {
          provider,
          sessionId,
          apiKey: "managed-key",
        };
      },
      inferAgencModel: ({ requestedModel, subscriptionTier } = {}) => {
        calls.push(`inferAgencModel:${requestedModel ?? ""}`);
        return {
          provider: "agenc",
          model: requestedModel ?? "agenc-small",
          ...(subscriptionTier ? { subscriptionTier } : {}),
        };
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "free";
      },
    };

    await expect(
      asPromise(backend.login({ sessionId: "session-1" })),
    ).resolves.toMatchObject({
      authenticated: true,
      provider: "local",
      sessionId: "session-1",
    });
    await expect(
      asPromise(backend.whoami({ sessionId: "session-1" })),
    ).resolves.toMatchObject({
      authenticated: true,
      provider: "local",
      identity: { accountId: "session-1", plan: "free" },
    });
    await expect(
      asPromise(backend.vendKey("grok", "session-1")),
    ).resolves.toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-key",
    });
    await expect(
      asPromise(
        backend.inferAgencModel({
          requestedModel: "agenc-small",
          subscriptionTier: "free",
        }),
      ),
    ).resolves.toEqual({
      provider: "agenc",
      model: "agenc-small",
      subscriptionTier: "free",
    });
    await expect(
      asPromise(backend.getSubscriptionTier({ sessionId: "session-1" })),
    ).resolves.toBe("free");
    await expect(
      asPromise(backend.logout({ sessionId: "session-1" })),
    ).resolves.toEqual({
      authenticated: false,
    });
    expect(calls).toEqual([
      "login:session-1",
      "whoami:session-1",
      "vendKey:grok:session-1",
      "inferAgencModel:agenc-small",
      "getSubscriptionTier:session-1",
      "logout:session-1",
    ]);
  });
});
