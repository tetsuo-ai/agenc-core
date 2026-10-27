import { describe, expect, it, vi } from "vitest";
import { createAuthBackend } from "../../src/auth/selection.js";
import { defaultConfig } from "../../src/config/schema.js";
import { LocalAuthBackend } from "../../src/auth/backends/local.js";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";

describe("auth backend selection", () => {
  it("defaults to account authentication without a model switch", () => {
    expect(defaultConfig().auth).toEqual({ backend: "remote" });
    expect(createAuthBackend(defaultConfig())).toBeInstanceOf(RemoteAuthBackend);
  });
  it("keeps local and environment backend selection", () => {
    expect(createAuthBackend({ auth: { backend: "local" } })).toBeInstanceOf(LocalAuthBackend);
    expect(createAuthBackend(defaultConfig(), { env: { AGENC_AUTH_BACKEND: "local" } })).toBeInstanceOf(LocalAuthBackend);
  });
  it.each([true, false, "invalid", null])("ignores retired managed config values: %s", async enabled => {
    const keyVendor = vi.fn();
    const config = { auth: { backend: "remote", managedKeys: { enabled } } } as never;
    const backend = createAuthBackend(config, { remote: { managedKeysEnabled: true, keyVendor } as never });
    await expect(backend.vendKey("openrouter", "test-session")).rejects.toThrow("AgenC accounts no longer provide models");
    expect(keyVendor).not.toHaveBeenCalled();
  });
  it("still rejects an invalid account backend", () => {
    expect(() => createAuthBackend({ auth: { backend: "invalid" } } as never)).toThrow("auth.backend");
  });
});
