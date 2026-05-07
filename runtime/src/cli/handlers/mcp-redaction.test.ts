import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));

const mcpState = vi.hoisted(() => ({
  server: undefined as unknown,
}));

vi.mock("../../services/analytics/index.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../services/mcp/auth.js", () => ({
  clearMcpClientConfig: vi.fn(),
  clearServerTokensFromSecureStorage: vi.fn(),
  readClientSecret: vi.fn(),
  saveMcpClientSecret: vi.fn(),
}));
vi.mock("../../services/mcp/client.js", () => ({
  connectToServer: vi.fn(async () => ({ type: "failed" })),
  getMcpServerConnectionBatchSize: vi.fn(() => 1),
}));
vi.mock("../../services/mcp/config.js", () => ({
  addMcpConfig: vi.fn(),
  getAllMcpConfigs: vi.fn(async () => ({ servers: {} })),
  getMcpConfigByName: vi.fn(() => mcpState.server),
  getMcpConfigsByScope: vi.fn(() => ({ servers: {} })),
  removeMcpConfig: vi.fn(),
}));
vi.mock("../../services/mcp/doctor.js", () => ({
  doctorAllServers: vi.fn(),
  doctorServer: vi.fn(),
}));
vi.mock("../../services/mcp/utils.js", () => ({
  describeMcpConfigFilePath: vi.fn(() => "/tmp/agenc/config.toml"),
  ensureConfigScope: vi.fn((scope?: string) => scope ?? "user"),
  getScopeLabel: vi.fn((scope: string) => `${scope} config`),
}));
vi.mock("../../tui/components/MCPServerDesktopImportDialog.js", () => ({
  MCPServerDesktopImportDialog: vi.fn(() => null),
}));
vi.mock("../../tui/ink.js", () => ({ render: vi.fn() }));
vi.mock("../../tui/keybindings/KeybindingProviderSetup.js", () => ({
  KeybindingSetup: vi.fn(({ children }) => children),
}));
vi.mock("../../tui/state/AppState.js", () => ({
  AppStateProvider: vi.fn(({ children }) => children),
}));
vi.mock("../../utils/config.js", () => ({
  getCurrentProjectConfig: vi.fn(() => ({})),
  saveCurrentProjectConfig: vi.fn(),
}));
vi.mock("../../utils/errors.js", () => ({ isFsInaccessible: vi.fn(() => false) }));
vi.mock("../../utils/gracefulShutdown.js", () => ({
  gracefulShutdown: vi.fn(async () => {}),
}));
vi.mock("../../utils/json.js", () => ({
  safeParseJSON: vi.fn((value: string) => JSON.parse(value)),
}));
vi.mock("../../utils/platform.js", () => ({ getPlatform: vi.fn(() => "linux") }));
vi.mock("../exit.js", () => ({
  cliError: vi.fn((message?: string) => {
    throw new Error(message ?? "cliError");
  }),
  cliOk: vi.fn(),
}));

import { mcpGetHandler } from "./mcp.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mcpState.server = undefined;
});

function captureConsole(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

describe("MCP CLI redaction", () => {
  test("mcp get redacts remote headers", async () => {
    const lines = captureConsole();
    mcpState.server = {
      type: "http",
      scope: "user",
      url: "https://agenc.tech/mcp",
      headers: {
        Authorization: "Bearer secret-token",
        "X-API-Key": "api-secret",
      },
    };

    await mcpGetHandler("docs");

    const output = lines.join("\n");
    expect(output).toContain("Authorization: <redacted>");
    expect(output).toContain("X-API-Key: <redacted>");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("api-secret");
  });

  test("mcp get redacts stdio environment values", async () => {
    const lines = captureConsole();
    mcpState.server = {
      type: "stdio",
      scope: "user",
      command: "gh-mcp",
      args: [],
      env: {
        API_KEY: "api-secret",
        DEBUG: "true",
      },
    };

    await mcpGetHandler("github");

    const output = lines.join("\n");
    expect(output).toContain("API_KEY=<redacted>");
    expect(output).toContain("DEBUG=<redacted>");
    expect(output).not.toContain("api-secret");
    expect(output).not.toContain("DEBUG=true");
  });
});
