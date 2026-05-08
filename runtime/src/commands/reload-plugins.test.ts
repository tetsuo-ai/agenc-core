import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPluginRefreshSummary,
  reloadPluginsCommand,
  reloadPluginSurfaces,
  setActivePluginRefresherForTesting,
  setRemoteSettingsSyncForTesting,
  type ActivePluginRefreshResult,
} from "./reload-plugins.js";

const ZERO_RESULT: ActivePluginRefreshResult = {
  enabled_count: 0,
  disabled_count: 0,
  command_count: 0,
  agent_count: 0,
  hook_count: 0,
  mcp_count: 0,
  lsp_count: 0,
  output_style_count: 0,
  error_count: 0,
};

function stubContext(refreshResult: ActivePluginRefreshResult) {
  setActivePluginRefresherForTesting(async () => refreshResult);
  setRemoteSettingsSyncForTesting({
    redownloadUserSettings: async () => false,
    notifySettingsChange: () => {},
  });
  return {
    cwd: "/tmp/ws",
    home: "/tmp/home",
    argsRaw: "",
    session: {
      services: {
        skillsManager: { clearSkillCaches: () => {} },
        mcpManager: {},
        lspManager: undefined,
        configStore: { current: () => undefined },
      },
    },
  } as never;
}

afterEach(() => {
  setActivePluginRefresherForTesting(undefined);
  setRemoteSettingsSyncForTesting(undefined);
  vi.restoreAllMocks();
});

describe("formatPluginRefreshSummary", () => {
  it("formats a zero-state result with the expected header and zero rows", () => {
    const text = formatPluginRefreshSummary(ZERO_RESULT);
    expect(text).toMatch(/^Reloaded plugin surfaces:/);
    expect(text).toContain("0 enabled plugins");
    expect(text).toContain("0 skill commands");
    expect(text).toContain("0 errors");
  });

  it("formats a populated result with pluralization", () => {
    const text = formatPluginRefreshSummary({
      ...ZERO_RESULT,
      enabled_count: 1,
      disabled_count: 2,
      command_count: 3,
      agent_count: 0,
      hook_count: 5,
      error_count: 1,
    });
    expect(text).toContain("1 enabled plugin");
    expect(text).not.toContain("1 enabled plugins");
    expect(text).toContain("2 disabled plugins");
    expect(text).toContain("3 skill commands");
    expect(text).toContain("0 agents");
    expect(text).toContain("5 hooks");
    expect(text).toContain("1 error");
  });
});

describe("reloadPluginSurfaces", () => {
  it("delegates to the injected refresher and returns the formatted summary", async () => {
    const ctx = stubContext({
      ...ZERO_RESULT,
      command_count: 7,
    });
    const text = await reloadPluginSurfaces(ctx);
    expect(text).toContain("7 skill commands");
  });

  it("propagates plugin MCP servers into refreshFromConfig when provided", async () => {
    const refreshFromConfig = vi.fn(async () => {});
    const ctx = stubContext({
      ...ZERO_RESULT,
      mcp_servers: { acme: { command: "acme", args: [], env: {} } as never },
    });
    ctx.session.services.mcpManager.refreshFromConfig = refreshFromConfig;
    await reloadPluginSurfaces(ctx);
    expect(refreshFromConfig).toHaveBeenCalled();
    const arg = refreshFromConfig.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.mcp_servers).toMatchObject({ acme: expect.any(Object) });
  });
});

describe("reloadPluginsCommand.execute", () => {
  it("returns a text result", async () => {
    const ctx = stubContext(ZERO_RESULT);
    const result = await reloadPluginsCommand.execute(ctx);
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Reloaded plugin surfaces");
    }
  });
});
