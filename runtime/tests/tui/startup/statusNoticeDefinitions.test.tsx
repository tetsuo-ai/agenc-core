import * as React from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";

import type { StatusNoticeContext } from "./statusNoticeDefinitions.js";
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "../remoteAuthSessionContext.fixture.js";

const mocks = vi.hoisted(() => ({
  authTokenSource: { source: "none", hasToken: false } as {
    source:
      | "ANTHROPIC_AUTH_TOKEN"
      | "AGENC_OAUTH_TOKEN"
      | "AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR"
      | "native-secure-storage"
      | "agenc-cloud"
      | "none";
    hasToken: boolean;
  },
  apiKeySource: "none" as
    | "ANTHROPIC_API_KEY"
    | "/login managed key"
    | "none",
  apiKeyConfigured: false,
  credentialHomes: [] as unknown[],
  providerAuthContexts: [] as unknown[],
  agentTokens: 0,
  throwApiKeyLookup: false,
  subscriber: false,
  supportedIde: false,
  terminalIdeType: null as string | null,
  pluginInstalled: true,
}));

vi.mock("../ink.js", async () => {
  const React = await import("react");
  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-box", null, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-text", null, children),
  };
});

vi.mock("../../utils/cwd.js", () => ({
  getCwd: () => "/repo",
}));

vi.mock("../../utils/format.js", () => ({
  formatNumber: (value: number) => String(value),
}));

vi.mock("../../utils/auth.js", () => ({
  selectedProviderUsesExternalAuth: (provider: string) =>
    provider !== "anthropic" && provider !== "agenc",
  getAnthropicApiKeyWithSourceForContext: (context: unknown) => {
    mocks.providerAuthContexts.push(context);
    if (mocks.throwApiKeyLookup) {
      throw new Error("ANTHROPIC_API_KEY or AGENC_OAUTH_TOKEN env var is required");
    }
    return { key: null, source: mocks.apiKeySource };
  },
  getPrimaryApiKeyFromSecureStorage: (home: unknown) => {
    mocks.credentialHomes.push(home);
    return mocks.apiKeyConfigured
      ? { key: "configured-key", source: "/login managed key" }
      : null;
  },
  getAuthTokenSourceForContext: (context: unknown) => {
    mocks.providerAuthContexts.push(context);
    return mocks.authTokenSource;
  },
  isAgenCAISubscriberForContext: (context: unknown) => {
    mocks.providerAuthContexts.push(context);
    return mocks.subscriber;
  },
}));

vi.mock("../../utils/statusNoticeHelpers.js", () => ({
  AGENT_DESCRIPTIONS_THRESHOLD: 100,
  getAgentDescriptionsTotalTokens: () => mocks.agentTokens,
}));

vi.mock("../../utils/ide.js", () => ({
  getTerminalIdeType: () => mocks.terminalIdeType,
  isSupportedJetBrainsTerminal: () => mocks.supportedIde,
  toIDEDisplayName: (ideType: string | null) => ideType ?? "JetBrains IDE",
}));

vi.mock("../../utils/jetbrains.js", () => ({
  isJetBrainsPluginInstalledCachedSync: () => mocks.pluginInstalled,
}));

function baseContext(): StatusNoticeContext {
  return {
    config: { autoInstallIdeExtension: true } as StatusNoticeContext["config"],
    homeContext: TEST_REMOTE_AUTH_SESSION_CONTEXT.home,
    providerAuthContext: TEST_REMOTE_AUTH_SESSION_CONTEXT,
    memoryDiagnostics: [],
    daemonStatus: {
      autostartDisabled: false,
    },
  };
}

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

describe("startup status notice definitions", () => {
  beforeEach(() => {
    mocks.authTokenSource = { source: "none", hasToken: false };
    mocks.apiKeySource = "none";
    mocks.apiKeyConfigured = false;
    mocks.credentialHomes = [];
    mocks.providerAuthContexts = [];
    mocks.agentTokens = 0;
    mocks.throwApiKeyLookup = false;
    mocks.subscriber = false;
    mocks.supportedIde = false;
    mocks.terminalIdeType = null;
    mocks.pluginInstalled = true;
  });

  it("uses an AgenC account notice id for subscriber token conflicts", async () => {
    mocks.subscriber = true;
    mocks.authTokenSource = {
      source: "ANTHROPIC_AUTH_TOKEN",
      hasToken: true,
    };

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const ids = getActiveNotices(baseContext()).map((notice) => notice.id);

    expect(ids).toContain("agenc-account-external-token");
    expect(ids.filter((id) => id.endsWith("-external-token"))).toEqual([
      "agenc-account-external-token",
    ]);
    expect(mocks.credentialHomes).toEqual([]);
    expect(mocks.providerAuthContexts.length).toBeGreaterThan(0);
    expect(
      mocks.providerAuthContexts.every(
        (context) => context === TEST_REMOTE_AUTH_SESSION_CONTEXT,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(TEST_REMOTE_AUTH_SESSION_CONTEXT.environment),
    ).toBe(true);
  });

  it("does not inspect Anthropic credentials for an external provider", async () => {
    const context = {
      ...baseContext(),
      providerAuthContext: {
        ...TEST_REMOTE_AUTH_SESSION_CONTEXT,
        provider: "openai-compatible",
      },
    };

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const ids = getActiveNotices(context).map((notice) => notice.id);

    expect(ids).not.toContain("agenc-account-external-token");
    expect(ids).not.toContain("api-key-conflict");
    expect(ids).not.toContain("both-auth-methods");
    expect(mocks.providerAuthContexts).toEqual([]);
    expect(mocks.credentialHomes).toEqual([]);
  });

  it("activates the API-key conflict notice for configured external keys", async () => {
    mocks.apiKeyConfigured = true;
    mocks.apiKeySource = "ANTHROPIC_API_KEY";

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const ids = getActiveNotices(baseContext()).map((notice) => notice.id);

    expect(ids).toContain("api-key-conflict");
    expect(mocks.credentialHomes).toEqual([
      TEST_REMOTE_AUTH_SESSION_CONTEXT.home,
    ]);
  });

  it("does not throw when auth notice API-key source lookup fails", async () => {
    mocks.throwApiKeyLookup = true;
    mocks.apiKeyConfigured = true;

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");

    expect(() => getActiveNotices(baseContext())).not.toThrow();
    expect(getActiveNotices(baseContext()).map((notice) => notice.id)).not.toContain(
      "api-key-conflict",
    );
  });

  it("renders both-auth-methods cleanup guidance with AgenC logout text", async () => {
    mocks.authTokenSource = {
      source: "AGENC_OAUTH_TOKEN",
      hasToken: true,
    };
    mocks.apiKeySource = "ANTHROPIC_API_KEY";

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const notice = getActiveNotices(baseContext()).find(
      (candidate) => candidate.id === "both-auth-methods",
    );

    expect(notice).toBeDefined();
    expect(collectText(notice?.render(baseContext()))).toContain("agenc /logout");
  });

  it("activates large memory and large agent-description notices", async () => {
    mocks.agentTokens = 101;
    const context = {
      ...baseContext(),
      memoryDiagnostics: ["Large AGENC.md will impact performance"],
    };

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const ids = getActiveNotices(context).map((notice) => notice.id);

    expect(ids).toContain("large-memory-files");
    expect(ids).toContain("large-agent-descriptions");
  });

  it("activates daemon autostart notice with daemon start guidance", async () => {
    const context = {
      ...baseContext(),
      daemonStatus: {
        autostartDisabled: true,
      },
    };

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const notice = getActiveNotices(context).find(
      (candidate) => candidate.id === "daemon-autostart-disabled",
    );

    expect(notice).toBeDefined();
    expect(collectText(notice?.render(context))).toContain("agenc daemon start");
  });

  it("keeps the JetBrains notice on marketplace text without a hard-coded docs URL", async () => {
    mocks.supportedIde = true;
    mocks.terminalIdeType = "IntelliJ IDEA";
    mocks.pluginInstalled = false;

    const { getActiveNotices } = await import("./statusNoticeDefinitions.js");
    const notice = getActiveNotices(baseContext()).find(
      (candidate) => candidate.id === "jetbrains-plugin-install",
    );

    expect(notice).toBeDefined();
    const text = collectText(notice?.render(baseContext()));
    expect(text).toContain("JetBrains Marketplace");
    expect(text).not.toContain("docs.");
  });
});
