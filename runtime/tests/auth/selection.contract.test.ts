import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfigs } from "../config/schema.js";
import { LocalAuthBackend } from "./backends/local.js";
import { RemoteAuthBackend } from "./backends/remote.js";
import {
  createAuthBackend,
  resolveAuthManagedKeysEnabled,
} from "./selection.js";

async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-auth-selection-"));
}

describe("auth backend selection", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it("defaults auth.backend to remote and creates RemoteAuthBackend", () => {
    const config = defaultConfig();

    const backend = createAuthBackend(config);

    expect(backend).toBeInstanceOf(RemoteAuthBackend);
    expect(resolveAuthManagedKeysEnabled(config)).toBe(true);
  });

  it("honors auth.backend = local and creates LocalAuthBackend", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "local", managedKeys: { enabled: false } },
    });

    const backend = createAuthBackend(config, { agencHome });

    expect(backend).toBeInstanceOf(LocalAuthBackend);
    expect((backend as LocalAuthBackend).authFile()).toBe(
      join(agencHome, "auth.json"),
    );
  });

  it("honors auth.backend = remote and creates RemoteAuthBackend", async () => {
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "remote", managedKeys: { enabled: true } },
    });

    expect(resolveAuthManagedKeysEnabled(config)).toBe(true);
    const backend = createAuthBackend(config, {
      remote: {
        keyVendor: ({ provider, sessionId }) => ({
          provider,
          sessionId,
          apiKey: "managed-key",
        }),
      },
    });

    expect(backend).toBeInstanceOf(RemoteAuthBackend);
    await expect(backend.vendKey("grok", "session-1")).resolves.toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-key",
    });
  });

  it("defaults auth.managedKeys.enabled to true for backend selection", () => {
    const config = defaultConfig();

    expect(resolveAuthManagedKeysEnabled(config)).toBe(true);
  });

  it("passes disabled managed-key config through remote backend selection", async () => {
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "remote", managedKeys: { enabled: false } },
    });
    const keyVendor = vi.fn(() => ({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-key",
    }));

    const backend = createAuthBackend(config, {
      remote: { keyVendor },
    });

    expect(backend).toBeInstanceOf(RemoteAuthBackend);
    await expect(backend.vendKey("grok", "session-1")).rejects.toThrow(
      /auth\.managedKeys\.enabled/,
    );
    expect(keyVendor).not.toHaveBeenCalled();
  });

  it("applies env managed-key overrides before remote backend construction", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "remote" },
    });
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: "managed-key",
    }));

    const backend = createAuthBackend(config, {
      agencHome,
      env: {
        AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
        AGENC_HOME: agencHome,
      },
      remote: { keyVendor },
    });

    await expect(backend.vendKey("grok", "session-1")).resolves.toEqual({
      provider: "grok",
      sessionId: "session-1",
      apiKey: "managed-key",
    });
    expect(keyVendor).toHaveBeenCalledOnce();
  });

  it("does not let remote options override config-disabled managed keys", async () => {
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "remote", managedKeys: { enabled: false } },
    });
    const keyVendor = vi.fn(({ provider, sessionId }) => ({
      provider,
      sessionId,
      apiKey: "managed-key",
    }));

    const backend = createAuthBackend(config, {
      remote: { keyVendor, managedKeysEnabled: true },
    });

    await expect(backend.vendKey("grok", "session-1")).rejects.toThrow(
      /auth\.managedKeys\.enabled/,
    );
    expect(keyVendor).not.toHaveBeenCalled();
  });

  it("passes remote login prompt options through non-CLI backend selection", async () => {
    const agencHome = await makeTempHome();
    homes.push(agencHome);
    const config = mergeConfigs(defaultConfig(), {
      auth: { backend: "remote" },
    });
    const onDeviceCode = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: "device-1",
            user_code: "USER-1",
            verification_uri: "https://agenc.tech/login",
            interval: 1,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "remote-token" }), {
          status: 200,
        }),
      );

    const backend = createAuthBackend(config, {
      agencHome,
      remote: {
        fetchImpl,
        loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
        loginStartEndpoint: "https://api.agenc.tech/test/login/start",
        onDeviceCode,
      },
    });

    await expect(backend.login({ sessionId: "daemon" })).resolves.toMatchObject({
      authenticated: true,
      provider: "remote",
      token: "remote-token",
    });
    expect(onDeviceCode).toHaveBeenCalledWith({
      verificationUri: "https://agenc.tech/login",
      userCode: "USER-1",
      intervalSeconds: 1,
    });
  });

  it("rejects invalid auth.backend values instead of falling back", () => {
    const config = {
      auth: { backend: "other" },
    } as unknown as ReturnType<typeof defaultConfig>;

    expect(() => createAuthBackend(config)).toThrow(
      /Invalid auth\.backend config/,
    );
    expect(() => createAuthBackend(config)).toThrow(
      expect.objectContaining({ name: "InvalidAuthBackendConfigError" }),
    );
  });

  it("rejects non-object auth config", () => {
    const config = {
      auth: "remote",
    } as unknown as ReturnType<typeof defaultConfig>;

    expect(() => createAuthBackend(config)).toThrow(
      expect.objectContaining({ name: "InvalidAuthBackendConfigError" }),
    );
  });

  it("rejects non-object managedKeys config", () => {
    const config = {
      auth: { backend: "remote", managedKeys: "enabled" },
    } as unknown as ReturnType<typeof defaultConfig>;

    expect(() => resolveAuthManagedKeysEnabled(config)).toThrow(
      expect.objectContaining({ name: "InvalidAuthManagedKeysConfigError" }),
    );
  });

  it("rejects invalid auth.managedKeys.enabled values instead of coercing", () => {
    const config = {
      auth: { backend: "remote", managedKeys: { enabled: "yes" } },
    } as unknown as ReturnType<typeof defaultConfig>;

    expect(() => resolveAuthManagedKeysEnabled(config)).toThrow(
      /Invalid auth\.managedKeys\.enabled config/,
    );
    expect(() => createAuthBackend(config)).toThrow(
      expect.objectContaining({ name: "InvalidAuthManagedKeysConfigError" }),
    );
  });
});
