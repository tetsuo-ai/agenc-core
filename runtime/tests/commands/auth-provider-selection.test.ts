import { describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";

const authMocks = vi.hoisted(() => ({
  applyProviderSwitch: vi.fn(),
  createAuthBackend: vi.fn(),
}));

vi.mock("../../src/auth/selection.js", () => ({
  createAuthBackend: authMocks.createAuthBackend,
}));

vi.mock("../../src/commands/provider.js", () => ({
  applyProviderSwitch: authMocks.applyProviderSwitch,
}));

vi.mock(
  "../../src/commands/subscription-managed-models.js",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../src/commands/subscription-managed-models.js")
    >();
    return {
      ...actual,
      hasHostedManagedAccess: () => true,
    };
  },
);

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
    }
    expect(authMocks.applyProviderSwitch).not.toHaveBeenCalled();
  });

  test("keeps OpenRouter BYOK instead of forcing a managed model after login", async () => {
    authMocks.createAuthBackend.mockReturnValue(backend());
    authMocks.applyProviderSwitch.mockClear();
    const environment = Object.freeze({
      AGENC_HOME: "/tmp/agenc-auth-byok",
      OPENROUTER_API_KEY: "openrouter-test-key",
    });
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
      expect(result.text).toContain("OpenRouter BYOK was kept");
    }
    expect(authMocks.applyProviderSwitch).not.toHaveBeenCalled();
  });
});
