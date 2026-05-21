import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";

const mocks = vi.hoisted(() => ({
  apiKeyConfigured: false,
  apiKeySource: "none" as "ANTHROPIC_API_KEY" | "apiKeyHelper" | "none",
  authTokenSource: {
    source: "none",
    hasToken: false,
  } as {
    source:
      | "ANTHROPIC_AUTH_TOKEN"
      | "AGENC_OAUTH_TOKEN"
      | "AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR"
      | "CCR_OAUTH_TOKEN_FILE"
      | "apiKeyHelper"
      | "none";
    hasToken: boolean;
  },
  buildMemoryDiagnostics: vi.fn(async () => [
    "Large AGENC.md will impact startup",
  ]),
  subscriber: false,
}));

const previousDaemonAutostart = process.env.AGENC_DAEMON_AUTOSTART;

vi.mock("../../utils/auth.js", () => ({
  getApiKeyFromConfigOrMacOSKeychain: () =>
    mocks.apiKeyConfigured ? "configured-key" : null,
  getAuthTokenSource: () => mocks.authTokenSource,
  getproviderApiKeyWithSource: () => ({ source: mocks.apiKeySource }),
  isAgenCAISubscriber: () => mocks.subscriber,
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => ({ autoInstallIdeExtension: true }),
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

vi.mock("../../utils/status.js", () => ({
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

  afterEach(() => {
    if (previousDaemonAutostart === undefined) {
      delete process.env.AGENC_DAEMON_AUTOSTART;
    } else {
      process.env.AGENC_DAEMON_AUTOSTART = previousDaemonAutostart;
    }
  });

  it("renders daemon startup guidance and then reuses loaded memory diagnostics", async () => {
    process.env.AGENC_DAEMON_AUTOSTART = "off";
    const { StatusNotices } = await import("./StatusNotices.js");

    const daemonOutput = await renderToString(<StatusNotices />, 100);
    expect(daemonOutput).toContain("AgenC daemon autostart is disabled");
    expect(daemonOutput).toContain("agenc daemon start");

    await vi.waitFor(() => {
      expect(mocks.buildMemoryDiagnostics).toHaveBeenCalledTimes(1);
    });

    process.env.AGENC_DAEMON_AUTOSTART = "true";
    const memoryOutput = await renderToString(<StatusNotices />, 100);

    expect(mocks.buildMemoryDiagnostics).toHaveBeenCalledTimes(1);
    expect(memoryOutput).toContain("Large AGENC.md will impact startup");
    expect(memoryOutput).toContain("/memory · open");
    expect(memoryOutput).not.toContain("AgenC daemon autostart is disabled");
  });
});
