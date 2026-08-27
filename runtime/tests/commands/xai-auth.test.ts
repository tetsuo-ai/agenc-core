import { afterEach, describe, expect, test, vi } from "vitest";

import type { EnvSnapshot } from "../../src/config/env.js";
import { resolveHomeContext } from "../../src/config/home.js";
import type { ConfigStore } from "../../src/config/store.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

const mocks = vi.hoisted(() => ({
  applyProviderSwitch: vi.fn(async () => ({
    applied: true,
    model: "grok-4.5",
    summary: "Provider switched to grok.",
  })),
  clearXaiOauthCredentials: vi.fn(() => ({ success: true })),
  openUrlInBrowser: vi.fn(async () => undefined),
  readXaiOauthCredentials: vi.fn(() => ({
    accessToken: "stored-token",
    accountLabel: "test@example.com",
  })),
  runXaiBrowserLogin: vi.fn(async () => ({
    identity: { sub: "xai-user" },
    tokenEndpoint: "https://example.test/token",
    tokens: { accessToken: "oauth-token" },
  })),
  runXaiDeviceLogin: vi.fn(),
  saveXaiOauthCredentials: vi.fn(() => ({ success: true })),
  xaiOauthTokensToBlob: vi.fn(() => ({
    accessToken: "oauth-token",
    accountLabel: "test@example.com",
  })),
}));

vi.mock("../../src/services/xai/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/services/xai/oauth.js")
  >();
  return {
    ...actual,
    runXaiBrowserLogin: mocks.runXaiBrowserLogin,
    runXaiDeviceLogin: mocks.runXaiDeviceLogin,
  };
});

vi.mock("../../src/utils/xaiOauthCredentials.js", () => ({
  clearXaiOauthCredentials: mocks.clearXaiOauthCredentials,
  readXaiOauthCredentials: mocks.readXaiOauthCredentials,
  saveXaiOauthCredentials: mocks.saveXaiOauthCredentials,
  xaiOauthTokensToBlob: mocks.xaiOauthTokensToBlob,
}));

vi.mock("../../src/commands/auth.js", () => ({
  openUrlInBrowser: mocks.openUrlInBrowser,
}));

vi.mock("../../src/commands/provider.js", () => ({
  applyProviderSwitch: mocks.applyProviderSwitch,
}));

import {
  grokLoginCommand,
  grokLogoutCommand,
} from "../../src/commands/xai-auth.js";

type CommandConfigStore = Pick<ConfigStore, "current" | "homeContext">;

function configStore(name: string): CommandConfigStore {
  return {
    current: () => ({}) as ReturnType<ConfigStore["current"]>,
    homeContext: resolveHomeContext(
      { AGENC_HOME: `/tmp/agenc-xai-auth-${name}` },
      { platformHome: "/tmp" },
    ),
  };
}

function commandContext(
  environment: EnvSnapshot,
  store: CommandConfigStore = configStore("canonical"),
): SlashCommandContext {
  return {
    session: {
      services: {
        configStore: store,
        providerService: { environment: () => environment },
      },
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/workspace",
    home: "/tmp",
    configStore: store as SlashCommandContext["configStore"],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("xAI auth command authority", () => {
  test.each([
    ["login", grokLoginCommand],
    ["logout", grokLogoutCommand],
  ])("rejects conflicting ConfigStores before %s credential mutation", async (_, command) => {
    const sessionStore = configStore("session");
    const contextStore = configStore("context");
    const ctx = commandContext(Object.freeze({}), sessionStore);
    ctx.configStore = contextStore as SlashCommandContext["configStore"];

    await expect(command.execute(ctx)).resolves.toEqual({
      kind: "error",
      message: "Slash command received conflicting ConfigStore authorities",
    });
    expect(mocks.runXaiBrowserLogin).not.toHaveBeenCalled();
    expect(mocks.readXaiOauthCredentials).not.toHaveBeenCalled();
    expect(mocks.saveXaiOauthCredentials).not.toHaveBeenCalled();
    expect(mocks.clearXaiOauthCredentials).not.toHaveBeenCalled();
  });

  test("does not report an ambient API key absent from the captured environment", async () => {
    vi.stubEnv("XAI_API_KEY", "ambient-key");

    const result = await grokLoginCommand.execute(
      commandContext(Object.freeze({})),
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).not.toContain("API key is also set");
    }
  });

  test("reports an API key present in the captured environment", async () => {
    vi.stubEnv("XAI_API_KEY", "");

    const result = await grokLoginCommand.execute(
      commandContext(Object.freeze({ XAI_API_KEY: "captured-key" })),
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("API key is also set");
    }
  });
});
