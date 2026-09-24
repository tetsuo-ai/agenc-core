import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MCPManager } from "./manager.js";
import { loadPluginMcpServerRegistrations } from "../plugins/registration/mcp-plugin-integration.js";
import { setPluginEnabledOp } from "../plugins/cli/pluginOperations.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";
import type { MCPServerConfig } from "./types.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";
import { ConfigStore } from "../config/store.js";
import { createSessionMcpService } from "../session/mcp-startup.js";

vi.mock("./transports/stdio.js", () => ({ createStdioMCPConnection: vi.fn() }));
import { createStdioMCPConnection } from "./transports/stdio.js";

const spawn = vi.mocked(createStdioMCPConnection);
const roots: string[] = [];

afterEach(async () => {
  spawn.mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(directory = "sample", manifestEnabled = true): Promise<{
  home: string; workspace: string; storage: string; config: MCPServerConfig;
}> {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-session-"));
  roots.push(home);
  const workspace = join(home, "workspace");
  const storage = join(home, "plugins");
  const installed = join(storage, directory);
  await mkdir(join(installed, ".agenc-plugin"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(installed, ".agenc-plugin", "plugin.json"), JSON.stringify({
    name: "sample", mcpServers: { main: {
      command: "fixture", ...(manifestEnabled ? {} : { enabled: false }),
    } },
  }));
  await writeFile(join(installed, "entry.js"), "same");
  await writeFile(join(home, "config.toml"), "config_version = 2\n[plugins]\nenabled = true\n");
  const registrations = await loadPluginMcpServerRegistrations({
    pluginStorageRoot: storage, workspaceRoot: workspace,
    config: { plugins: { enabled: true } }, fresh: true,
  });
  expect(registrations).toHaveLength(1);
  const registration = registrations[0]!;
  const config: MCPServerConfig = {
    ...registration.server,
    name: registration.name,
    pluginCatalogHome: home,
    pluginWorkspaceRoot: workspace,
    origin: { scope: "plugin", pluginServer: {
      pluginName: registration.pluginName, serverName: registration.serverName,
      digest: registration.digest, pluginRoot: registration.pluginRoot,
      snapshotRoot: registration.snapshotRoot,
      userConfigDigest: registration.userConfigDigest,
      eager: false,
    } },
  };
  spawn.mockResolvedValue({
    getServerCapabilities: () => ({}),
    listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => undefined,
  } as never);
  return { home, workspace, storage, config };
}

async function sessionStore(home: string, workspace: string, flagConfigPath?: string): Promise<ConfigStore> {
  const store = new ConfigStore({
    home, cwd: workspace, projectRoot: workspace,
    env: { HOME: home, AGENC_HOME: home },
    ...(flagConfigPath === undefined ? {} : { flagConfigPath }),
  });
  await store.reload();
  return store;
}

function directManager(config: MCPServerConfig): MCPManager {
  const home = config.pluginCatalogHome!;
  const workspace = config.pluginWorkspaceRoot!;
  const storage = dirname(dirname(dirname(config.origin!.pluginServer!.snapshotRoot!)));
  const store = new ConfigStore({
    home, cwd: workspace, projectRoot: workspace,
    env: { HOME: home, AGENC_HOME: home },
  });
  const manager = new MCPManager([config]);
  manager.setPluginFirstLaunchContext(store, storage);
  return manager;
}

it("first launches a manifest-disabled server enabled by the session overlay", async () => {
  const { home, workspace, storage, config } = await fixture("sample", false);
  const store = await sessionStore(home, workspace);
  const manager = new MCPManager([]);
  const service = createSessionMcpService(manager, { authority: store, environment: {}, pluginStorageRoot: storage });
  try {
    await service.refreshFromAuthority?.();
    expect(manager.getServerConfig(config.name)?.enabled).toBe(false);
    expect(await service.enableServer?.(config.name)).toMatchObject({ success: true });
    expect(manager.getServerConfig(config.name)?.enabled).toBe(true);
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("first launches with explicit --config tool policy and lifecycle settings across same-argument sessions", async () => {
  const { home, workspace, storage, config } = await fixture();
  const flagConfigPath = join(home, "flag-config.toml");
  await writeFile(flagConfigPath, [
    "config_version = 2",
    "[plugins]",
    "enabled = true",
    "mcp_max_processes = 3",
    "[plugins.plugins.sample.mcp_servers.main]",
    "disabled_tools = [\"unused\"]",
    "idle_timeout_ms = 120000",
    "eager = false",
    "",
  ].join("\n"));
  for (let session = 0; session < 2; session++) {
    const store = await sessionStore(home, workspace, flagConfigPath);
    const manager = new MCPManager([]);
    const service = createSessionMcpService(manager, { authority: store, environment: {}, pluginStorageRoot: storage });
    try {
      await service.refreshFromAuthority?.();
      expect(manager.getServerConfig(config.name)).toMatchObject({
        disabled_tools: ["unused"],
        origin: { pluginServer: { idleTimeoutMs: 120000, maxProcesses: 3 } },
      });
      expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    } finally { await manager.stopStrict(); }
  }
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("launches an unchanged plugin on first use", async () => {
  const { config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("rejects a changed installation snapshot before first launch", async () => {
  const { config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    await writeFile(join(config.origin!.pluginServer!.pluginRoot!, "entry.js"), "changed");
    const result = await manager.callTool(config.name, "ping", {});
    expect(result).toMatchObject({ isError: true });
    expect(String(result.content)).toMatch(/changed; restart this session/);
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.stopStrict(); }
});

it("rejects CLI disable before a lazy plugin's first use", async () => {
  const { home, workspace, storage, config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
      pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
    await expect(stat(join(home, "cache", "plugin-lifecycle-revisions")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const result = await manager.callTool(config.name, "ping", {});
    expect(result).toMatchObject({ isError: true });
    expect(String(result.content)).toMatch(/changed; restart this session/);
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.stopStrict(); }
});

it("rejects both first use and explicit reconnect after canonical disable", async () => {
  const { home, workspace, storage, config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
      pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
    expect(await manager.callTool(config.name, "ping", {})).toMatchObject({ isError: true });
    await expect(manager.reconnectServer(config.name)).resolves.toMatchObject({ success: false });
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.stopStrict(); }
});

it("rejects explicit reconnect as the first route after canonical disable", async () => {
  const { home, workspace, storage, config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
      pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
    await expect(manager.reconnectServer(config.name)).resolves.toMatchObject({ success: false });
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.stopStrict(); }
});

it("rejects disable through the installation directory alias before first use", async () => {
  const { home, config } = await fixture("directory-alias");
  const manager = directManager(config);
  try {
    await manager.start();
    mutateCanonicalUserConfigSync(join(home, "config.toml"), raw => {
      raw.plugins = { enabled: true, plugins: { "directory-alias": { enabled: false } } };
    });
    const result = await manager.callTool(config.name, "ping", {});
    expect(result).toMatchObject({ isError: true });
    expect(String(result.content)).toMatch(/changed; restart this session/);
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.stopStrict(); }
});

it("keeps the session's tool policy when it changes on disk before first use", async () => {
  const { home, config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    mutateCanonicalUserConfigSync(join(home, "config.toml"), raw => {
      raw.plugins = { enabled: true, plugins: { sample: { enabled: true,
        mcp_servers: { main: { disabled_tools: ["ping"] } } } } };
    });
    const result = await manager.callTool(config.name, "ping", {});
    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("restarts a lazy server that already ran after CLI disable", async () => {
  const { home, workspace, storage, config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
      pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
    await manager.stopStrict();
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally { await manager.stopStrict(); }
});

it("resumes a launched lazy server from its retained snapshot after installation changes", async () => {
  const { config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    await manager.stopStrict();
    await writeFile(join(config.origin!.pluginServer!.pluginRoot!, "entry.js"), "updated");
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally { await manager.stopStrict(); }
});

it("resumes a launched lazy server through sandbox transition after installation changes", async () => {
  const { home, workspace, config } = await fixture();
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: workspace });
  const manager = directManager(config);
  manager.setSandboxExecutionBroker(broker);
  try {
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    await writeFile(join(config.origin!.pluginServer!.pluginRoot!, "entry.js"), "updated");
    const nextWorkspace = join(home, "next-workspace");
    await mkdir(nextWorkspace);
    await transitionSandboxExecutionBroker(broker, nextWorkspace);
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally { await manager.stopStrict(); manager.setSandboxExecutionBroker(undefined); }
});

it("first launches unchanged effective config after session disable and re-enable", async () => {
  const { config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    await manager.refreshServers([{ ...config, enabled: false }]);
    await manager.refreshServers([{ ...config, enabled: true }]);
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("registration uses the loader's installation-directory alias for lifecycle settings", async () => {
  const { workspace, storage } = await fixture("directory-alias");
  const registrations = await loadPluginMcpServerRegistrations({
    pluginStorageRoot: storage, workspaceRoot: workspace, fresh: true,
    config: { plugins: { enabled: true, mcp_idle_timeout_ms: 120_000, plugins: {
      "directory-alias": { mcp_servers: { main: { eager: true, idle_timeout_ms: 0 } } },
    } } },
  });
  expect(registrations).toHaveLength(1);
  expect(registrations[0]).toMatchObject({ eager: true, idleTimeoutMs: 0 });
  const manifestPrecedence = await loadPluginMcpServerRegistrations({
    pluginStorageRoot: storage, workspaceRoot: workspace, fresh: true,
    config: { plugins: { enabled: true, plugins: {
      sample: { mcp_servers: { main: { eager: false, idle_timeout_ms: 9_000 } } },
      "directory-alias": { mcp_servers: { main: { eager: true, idle_timeout_ms: 0 } } },
    } } },
  });
  expect(manifestPrecedence[0]).toMatchObject({ eager: false, idleTimeoutMs: 9_000 });
});

it("keeps a running plugin across CLI disable and stop/resume, as eager servers do", async () => {
  const { home, workspace, storage, config } = await fixture();
  const eager: MCPServerConfig = { ...config, origin: { scope: "plugin", pluginServer: {
    ...config.origin!.pluginServer!, eager: true,
  } } };
  const manager = directManager(eager);
  try {
    await manager.start();
    await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
      pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
    expect((await manager.callTool(eager.name, "ping", {})).isError).not.toBe(true);
    await manager.stopStrict();
    await manager.start();
    expect((await manager.callTool(eager.name, "ping", {})).isError).not.toBe(true);
  } finally { await manager.stopStrict(); }
});

it("starts an eager plugin from its resolved configuration after CLI disable", async () => {
  const { home, workspace, storage, config } = await fixture();
  const eager: MCPServerConfig = { ...config, origin: { scope: "plugin", pluginServer: {
    ...config.origin!.pluginServer!, eager: true,
  } } };
  await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
    pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
  const manager = directManager(eager);
  try {
    await manager.start();
    expect((await manager.callTool(eager.name, "ping", {})).isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("resumes an eager plugin after CLI disable through the sandbox lifecycle", async () => {
  const { home, workspace, storage, config } = await fixture();
  const eager: MCPServerConfig = { ...config, origin: { scope: "plugin", pluginServer: {
    ...config.origin!.pluginServer!, eager: true,
  } } };
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: workspace });
  const manager = directManager(eager);
  manager.setSandboxExecutionBroker(broker);
  try {
    await manager.start();
    await setPluginEnabledOp({ pluginId: "sample", enabled: false, agencHome: home,
      pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
    const nextWorkspace = join(home, "next-workspace");
    await mkdir(nextWorkspace);
    await transitionSandboxExecutionBroker(broker, nextWorkspace);
    expect((await manager.callTool(eager.name, "ping", {})).isError).not.toBe(true);
    expect(manager.getConnectionState(eager.name)?.type).toBe("connected");
  } finally { await manager.stopStrict(); manager.setSandboxExecutionBroker(undefined); }
});

it("retains an eager session's tool policy on stop and resume", async () => {
  const { home, config } = await fixture();
  const eager: MCPServerConfig = { ...config, origin: { scope: "plugin", pluginServer: {
    ...config.origin!.pluginServer!, eager: true,
  } } };
  const manager = directManager(eager);
  try {
    await manager.start();
    mutateCanonicalUserConfigSync(join(home, "config.toml"), raw => {
      raw.plugins = { enabled: true, plugins: { sample: { enabled: true,
        mcp_servers: { main: { disabled_tools: ["ping"] } } } } };
    });
    await manager.stopStrict();
    await manager.start();
    expect((await manager.callTool(eager.name, "ping", {})).isError).not.toBe(true);
  } finally { await manager.stopStrict(); }
});

it("applies a session's own policy refresh by restarting its eager server", async () => {
  const { config } = await fixture();
  const eager: MCPServerConfig = { ...config, origin: { scope: "plugin", pluginServer: {
    ...config.origin!.pluginServer!, eager: true,
  } } };
  const manager = directManager(eager);
  try {
    await manager.start();
    expect(manager.getToolsByServer(eager.name)).toHaveLength(1);
    await manager.refreshServers([{ ...eager, disabled_tools: ["ping"] }]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(manager.getToolsByServer(eager.name)).toHaveLength(0);
  } finally { await manager.stopStrict(); }
});

it("retires only the refreshing session's superseded generation", async () => {
  const { config } = await fixture();
  const eager = { ...config, origin: { scope: "plugin" as const, pluginServer: {
    ...config.origin!.pluginServer!, eager: true,
  } } };
  const older = directManager(eager);
  const newer = directManager(eager);
  try {
    await older.start(); await newer.start();
    await older.refreshServers([{ ...eager, env: { UPDATED: "1" } }]);
    expect(spawn.mock.calls.at(-1)?.[0]).toMatchObject({ env: { UPDATED: "1" } });
    expect((await newer.callTool(eager.name, "ping", {})).isError).not.toBe(true);
    expect(newer.getConnectionState(eager.name)?.type).toBe("connected");
  } finally { await older.stopStrict(); await newer.stopStrict(); }
});
