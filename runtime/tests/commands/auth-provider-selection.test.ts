import { describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";

const authMocks = vi.hoisted(() => ({
  applyProviderSwitch: vi.fn(async () => ({
    applied: true,
    model: "x-ai/grok-4.5",
    summary: "switched",
  })),
  createAuthBackend: vi.fn(),
}));

vi.mock("../../src/auth/selection.js", () => ({
  createAuthBackend: authMocks.createAuthBackend,
}));

vi.mock("../../src/commands/provider.js", () => ({
  applyProviderSwitch: authMocks.applyProviderSwitch,
}));

import { loginCommand } from "../../src/commands/auth.js";

describe("auth command provider selection", () => {
  const backend = () => ({
    login: vi.fn(async () => ({
      authenticated: true,
      identity: { displayName: "Test User" },
    })),
    getSubscriptionTier: vi.fn(async () => "pro"),
  });

  test("ignores an incomplete pending marker and keeps the live hosted route", async () => {
    authMocks.createAuthBackend.mockReturnValue(backend());
    const environment = Object.freeze({ AGENC_HOME: "/tmp/agenc-auth-pair" });
    const configStore = {
      current: () => ({
        model_provider: "grok",
        model: "grok-4.5",
        auth: { managedKeys: { enabled: true } },
      }),
      homeContext: resolveHomeContext(environment, { platformHome: "/tmp" }),
    };
    const result = await loginCommand.execute({
      session: {
        pendingProviderSwitch: { provider: "grok" },
        services: {
          configStore,
          providerService: {
            current: () => ({
              provider: "openrouter",
              model: "x-ai/grok-4.5",
            }),
            environment: () => environment,
          },
        },
        sessionConfiguration: {
          provider: { slug: "grok" },
          collaborationMode: { model: "grok-4.5" },
        },
      } as never,
      argsRaw: "",
      cwd: "/repo",
      home: "/tmp",
      configStore: configStore as never,
    });

    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).not.toContain("route selected");
      expect(result.text).not.toMatch(/hosted|model credits|managed/i);
    }
    expect(authMocks.applyProviderSwitch).not.toHaveBeenCalled();
  });

  test("keeps the current provider instead of selecting a hosted default after login", async () => {
    authMocks.createAuthBackend.mockReturnValue(backend());
    authMocks.applyProviderSwitch.mockClear();
    const environment = Object.freeze({ AGENC_HOME: "/tmp/agenc-auth-neutral" });
    const configStore = {
      current: () => ({
        model_provider: "grok",
        model: "grok-4.5",
        auth: { managedKeys: { enabled: true } },
      }),
      homeContext: resolveHomeContext(environment, { platformHome: "/tmp" }),
    };

    const result = await loginCommand.execute({
      session: {
        pendingProviderSwitch: null,
        services: {
          configStore,
          providerService: {
            current: () => ({ provider: "grok", model: "grok-4.5" }),
            environment: () => environment,
          },
        },
      } as never,
      argsRaw: "",
      cwd: "/repo",
      home: "/tmp",
      configStore: configStore as never,
    });

    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).toBe("Logged in as Test User · plan=pro");
      expect(result.text).not.toContain("route selected");
    }
    expect(authMocks.applyProviderSwitch).not.toHaveBeenCalled();
  });
});
