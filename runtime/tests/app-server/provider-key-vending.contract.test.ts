import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../src/auth/backend.js";
import { createAgenCDaemonRuntimeAuthBackend } from "../../src/app-server/provider-key-vending.js";

describe("daemon account authentication", () => {
  it("delegates identity operations but never delegates model access", async () => {
    const backend = { kind: "remote", login: vi.fn(), logout: vi.fn(), whoami: vi.fn(), getSubscriptionTier: vi.fn(), vendKey: vi.fn(), inferAgencModel: vi.fn(), getLlmUsage: vi.fn() } as unknown as AuthBackend;
    const wrapped = createAgenCDaemonRuntimeAuthBackend(backend);
    await wrapped.login(); await wrapped.whoami(); await wrapped.getSubscriptionTier(); await wrapped.logout();
    for (const method of [backend.login, backend.whoami, backend.getSubscriptionTier, backend.logout]) expect(method).toHaveBeenCalledOnce();
    await expect(wrapped.vendKey("openrouter", "offline")).rejects.toThrow("no longer provide models");
    await expect(wrapped.inferAgencModel()).rejects.toThrow("no longer provide models");
    await expect(wrapped.getLlmUsage()).rejects.toThrow("no longer provide models");
    expect(await wrapped.listAgencModels!()).toEqual([]);
    for (const method of [backend.vendKey, backend.inferAgencModel, backend.getLlmUsage]) expect(method).not.toHaveBeenCalled();
    const next = { ...backend, whoami: vi.fn() };
    wrapped.replaceBackend(next); await wrapped.whoami();
    expect(next.whoami).toHaveBeenCalledOnce();
  });
});
