import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderAuthReadContext } from "../../utils/auth.js";
import { renderToString } from "../../utils/staticRender.js";
import {
  TEST_REMOTE_AUTH_ENVIRONMENT,
  TEST_REMOTE_AUTH_SESSION_CONTEXT,
  TEST_RUNTIME_STATE_REPOSITORY,
} from "../remoteAuthSessionContext.fixture.js";

function providerAuthContextWithEnvironment(
  overrides: Partial<ProviderAuthReadContext["environment"]>,
): ProviderAuthReadContext {
  return Object.freeze({
    ...TEST_REMOTE_AUTH_SESSION_CONTEXT,
    environment: Object.freeze({
      ...TEST_REMOTE_AUTH_ENVIRONMENT,
      ...overrides,
    }),
  });
}

const mocks = vi.hoisted(() => ({
  apiKeyConfigured: false,
  apiKeySource: "none" as
    | "ANTHROPIC_API_KEY"
    | "/login managed key"
    | "none",
  authTokenSource: {
    source: "none",
    hasToken: false,
  } as {
    source:
      | "ANTHROPIC_AUTH_TOKEN"
      | "AGENC_OAUTH_TOKEN"
      | "AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR"
      | "native-secure-storage"
      | "agenc-cloud"
      | "none";
    hasToken: boolean;
  },
  buildMemoryDiagnostics: vi.fn(async () => [
    "Large AGENC.md will impact startup",
  ]),
  subscriber: false,
}));

vi.mock("../../utils/auth.js", () => ({
  selectedProviderUsesExternalAuth: (provider: string) =>
    provider !== "anthropic" && provider !== "agenc",
  getPrimaryApiKeyFromSecureStorage: () =>
    mocks.apiKeyConfigured
      ? { key: "configured-key", source: "/login managed key" }
      : null,
  getAuthTokenSourceForContext: () => mocks.authTokenSource,
  getAnthropicApiKeyWithSourceForContext: () => ({
    key: null,
    source: mocks.apiKeySource,
  }),
  isAgenCAISubscriberForContext: () => mocks.subscriber,
}));

vi.mock("../../utils/config.js", () => ({
  getRuntimeState: () => ({ autoInstallIdeExtension: true }),
}));

vi.mock("../../utils/format.js", () => ({
  formatNumber: (value: number) => String(value),
}));

vi.mock("../../utils/ide.js", () => ({
  getTerminalIdeType: () => null,
  isSupportedJetBrainsTerminal: () => false,
  toIDEDisplayName: (ideType: string | null) => ideType ?? "JetBrains IDE",
}));

vi.mock("../../utils/jetbrains.js", () => ({
  isJetBrainsPluginInstalledCachedSync: () => true,
}));

vi.mock("./memoryDiagnostics.js", () => ({
  buildMemoryDiagnostics: mocks.buildMemoryDiagnostics,
}));

vi.mock("../../utils/statusNoticeHelpers.js", () => ({
  AGENT_DESCRIPTIONS_THRESHOLD: 100,
  getAgentDescriptionsTotalTokens: () => 0,
}));

describe("StatusNotices coverage", () => {
  beforeEach(() => {
    mocks.apiKeyConfigured = false;
    mocks.apiKeySource = "none";
    mocks.authTokenSource = { source: "none", hasToken: false };
    mocks.buildMemoryDiagnostics.mockClear();
    mocks.subscriber = false;
  });

  it("renders daemon startup guidance and then reuses loaded memory diagnostics", async () => {
    const { StatusNotices } = await import("./StatusNotices.js");
    const daemonDisabledAuthContext = providerAuthContextWithEnvironment({
      AGENC_DAEMON_AUTOSTART: "off",
    });

    const daemonOutput = await renderToString(
      <StatusNotices
        homeContext={daemonDisabledAuthContext.home}
        providerAuthContext={daemonDisabledAuthContext}
        stateRepository={TEST_RUNTIME_STATE_REPOSITORY}
      />,
      100,
    );
    expect(daemonOutput).toContain("AgenC daemon autostart is disabled");
    expect(daemonOutput).toContain("agenc daemon start");

    await vi.waitFor(() => {
      expect(mocks.buildMemoryDiagnostics).toHaveBeenCalledTimes(1);
    });

    const daemonEnabledAuthContext = providerAuthContextWithEnvironment({
      AGENC_DAEMON_AUTOSTART: "true",
    });
    const memoryOutput = await renderToString(
      <StatusNotices
        homeContext={daemonEnabledAuthContext.home}
        providerAuthContext={daemonEnabledAuthContext}
        stateRepository={TEST_RUNTIME_STATE_REPOSITORY}
      />,
      100,
    );

    expect(mocks.buildMemoryDiagnostics).toHaveBeenCalledTimes(1);
    expect(memoryOutput).toContain("Large AGENC.md will impact startup");
    expect(memoryOutput).toContain("/memory · open");
    expect(memoryOutput).not.toContain("AgenC daemon autostart is disabled");
  });
});
