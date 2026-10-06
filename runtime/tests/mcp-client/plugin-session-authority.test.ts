import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MCPManager } from "./manager.js";
import { loadPluginMcpServerRegistrations } from "../plugins/registration/mcp-plugin-integration.js";
import { setPluginEnabledOp, uninstallPluginOp } from "../plugins/cli/pluginOperations.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";
import type { MCPServerConfig } from "./types.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";
import { ConfigStore } from "../config/store.js";
import { createSessionMcpService } from "../session/mcp-startup.js";

vi.mock("./transports/stdio.js", () => ({ createStdioMCPConnection: vi.fn() }));
import { createStdioMCPConnection } from "./transports/stdio.js";
vi.mock("./plugin-catalog-cache.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./plugin-catalog-cache.js")>();
  return {
    ...actual,
    snapshotInstalledPluginOffThread: vi.fn(actual.snapshotInstalledPluginOffThread),
    removePluginCatalogs: vi.fn(actual.removePluginCatalogs),
  };
});
import { removePluginCatalogs, snapshotInstalledPluginOffThread } from "./plugin-catalog-cache.js";
vi.mock("../utils/debug.js", async importOriginal => ({
  ...await importOriginal<typeof import("../utils/debug.js")>(), logForDebugging: vi.fn(),
}));
import { logForDebugging } from "../utils/debug.js";

const spawn = vi.mocked(createStdioMCPConnection);
const roots: string[] = [];

async function catalogFiles(home: string): Promise<string[]> {
  try {
    const entries = await readdir(join(home, "cache", "plugin-mcp-catalogs"), { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  } catch { return []; }
}

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

it.each(["commit", "rollback"] as const)(
  "settles first lazy startup during sandbox quiescence with a held %s reload",
  async disposition => {
    const { home, workspace, storage, config } = await fixture();
    const store = await sessionStore(home, workspace);
    const manager = new MCPManager([{ ...config, timeout: 80 }]);
    manager.setPluginFirstLaunchContext(store, storage);
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: workspace });
    manager.setSandboxExecutionBroker(broker);
    await manager.start();
    const prepared = await store.prepareReload();
    let transition: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    let call: Promise<unknown> | undefined;
    try {
      call = manager.callTool(config.name, "ping", {});
      // Wait until the first-launch transition owns startup, then ask the
      // sandbox to quiesce while the daemon-style reload remains prepared.
      const lifecycles = (manager as unknown as {
        pluginLifecycles: Map<string, { transitions: number }>;
      }).pluginLifecycles;
      for (let i = 0; i < 100; i++) {
        if ((lifecycles.get(config.name)?.transitions ?? 0) > 0) break;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      expect(lifecycles.get(config.name)?.transitions).toBeGreaterThan(0);
      const nextWorkspace = join(home, "next-workspace");
      await mkdir(nextWorkspace);
      transition = transitionSandboxExecutionBroker(broker, nextWorkspace);
      shutdown = manager.stopStrict();
      const completed = Promise.allSettled([transition, shutdown]);
      const results = await Promise.race([
        completed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("quiescence and strict shutdown exceeded first-startup timeout")), 500)),
      ]);
      expect(results).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
      expect(prepared.state).toBe("prepared");
      expect(prepared.settled).toBe(false);
    } finally {
      if (prepared.state === "prepared") {
        if (disposition === "commit") {
          prepared.commit();
          prepared.publish();
        }
        else prepared.rollback();
      }
      if (!prepared.settled) prepared.settle();
      await Promise.allSettled([transition, shutdown, call].filter((task): task is Promise<unknown> => task !== undefined));
      await manager.stopStrict();
      manager.setSandboxExecutionBroker(undefined);
    }
  },
);

it("cancels a stalled first-launch source read during strict sandbox shutdown", async () => {
  const { home, workspace, storage, config } = await fixture();
  const store = await sessionStore(home, workspace);
  const manager = new MCPManager([{ ...config, timeout: 80 }]);
  manager.setPluginFirstLaunchContext(store, storage);
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: workspace });
  manager.setSandboxExecutionBroker(broker);
  await manager.start();
  let readStarted!: () => void;
  const enteredRead = new Promise<void>(resolve => { readStarted = resolve; });
  const read = vi.spyOn(store, "readSourceAuthority").mockImplementationOnce(async () => {
    readStarted();
    return new Promise<never>(() => {});
  });
  let transition: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let call: Promise<unknown> | undefined;
  try {
    call = manager.callTool(config.name, "ping", {});
    await Promise.race([
      enteredRead,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first-launch source read did not start")), 500)),
    ]);
    const nextWorkspace = join(home, "next-workspace");
    await mkdir(nextWorkspace);
    transition = transitionSandboxExecutionBroker(broker, nextWorkspace);
    shutdown = manager.stopStrict();
    const results = await Promise.race([
      Promise.allSettled([transition, shutdown]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stalled source read blocked shutdown")), 500)),
    ]);
    expect(results).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    // The cancelled check must not be reported as a changed plugin.
    const [outcome] = await Promise.allSettled([call]);
    const reported = outcome.status === "fulfilled" ? JSON.stringify(outcome.value) : String(outcome.reason);
    expect(reported).not.toContain("changed; reconnect this server");
  } finally {
    read.mockRestore();
    await Promise.allSettled([transition, shutdown, call].filter((task): task is Promise<unknown> => task !== undefined));
    await manager.stopStrict();
    manager.setSandboxExecutionBroker(undefined);
  }
});

it("rejects a changed installation snapshot before first launch", async () => {
  const { config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    await writeFile(join(config.origin!.pluginServer!.pluginRoot!, "entry.js"), "changed");
    const result = await manager.callTool(config.name, "ping", {});
    expect(result).toMatchObject({ isError: true });
    expect(String(result.content)).toMatch(/changed; reconnect this server or start a new session/);
    expect(spawn).not.toHaveBeenCalled();
  } finally { await manager.stopStrict(); }
});

it("keeps cached tools listed when a changed installation refuses the first launch", async () => {
  const { config } = await fixture();
  const earlier = directManager(config);
  try {
    await earlier.start();
    expect((await earlier.callTool(config.name, "ping", {})).isError).not.toBe(true);
  } finally { await earlier.stopStrict(); }
  const manager = directManager(config);
  try {
    await manager.start();
    expect(manager.getToolsByServer(config.name)).toHaveLength(1);
    await writeFile(join(config.origin!.pluginServer!.pluginRoot!, "entry.js"), "changed");
    const result = await manager.callTool(config.name, "ping", {});
    expect(manager.getToolsByServer(config.name)).toHaveLength(1);
    expect(String(result.content)).toMatch(/changed; reconnect this server or start a new session/);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("hashes only the target plugin before a first launch", async () => {
  const { storage, config } = await fixture();
  const other = join(storage, "other");
  await mkdir(join(other, ".agenc-plugin"), { recursive: true });
  await writeFile(join(other, ".agenc-plugin", "plugin.json"), JSON.stringify({
    name: "other", mcpServers: { aux: { command: "fixture" } },
  }));
  const manager = directManager(config);
  try {
    await manager.start();
    const snapshot = vi.mocked(snapshotInstalledPluginOffThread);
    snapshot.mockClear();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
    expect(snapshot.mock.calls.map(([root]) => root)).toEqual([config.origin!.pluginServer!.pluginRoot]);
  } finally { await manager.stopStrict(); }
});

it("refuses a changed first launch without taking a process slot from an idle server", async () => {
  const { config } = await fixture();
  const limited: MCPServerConfig = { ...config, origin: { ...config.origin!, pluginServer: {
    ...config.origin!.pluginServer!, maxProcesses: 1,
  } } };
  const other: MCPServerConfig = {
    name: "plugin:other:idle", command: "fixture", transport: "stdio", pluginCatalogHome: config.pluginCatalogHome,
    origin: { scope: "plugin", pluginServer: {
      pluginName: "other", serverName: "idle", version: "1", digest: "b".repeat(64), idleTimeoutMs: 600_000, maxProcesses: 1,
    } },
  };
  const manager = directManager(limited);
  const otherManager = new MCPManager([other]);
  try {
    await manager.start();
    await otherManager.start();
    expect((await otherManager.callTool(other.name, "ping", {})).isError).not.toBe(true);
    await writeFile(join(limited.origin!.pluginServer!.pluginRoot!, "entry.js"), "changed");
    const result = await manager.callTool(limited.name, "ping", {});
    expect(String(result.content)).toMatch(/changed; reconnect this server or start a new session/);
    expect(otherManager.getConnectionState(other.name)?.type).toBe("connected");
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); await otherManager.stopStrict(); }
});

it("checks a refused first launch once per configuration rather than on every tool search", async () => {
  const { config } = await fixture();
  const entry = join(config.origin!.pluginServer!.pluginRoot!, "entry.js");
  const manager = directManager(config);
  try {
    await manager.start();
    await writeFile(entry, "changed");
    const snapshot = vi.mocked(snapshotInstalledPluginOffThread);
    snapshot.mockClear();
    for (let search = 0; search < 3; search++) await manager.primeCatalogs();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(manager.getConnectionState(config.name)).toMatchObject({
      type: "failed", error: expect.stringMatching(/changed; reconnect this server or start a new session/),
    });
    // A refresh replaces the refused configuration, so the next search checks it again.
    await writeFile(entry, "same");
    await manager.refreshServers([config]);
    await manager.primeCatalogs();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(manager.getToolsByServer(config.name)).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await manager.stopStrict(); }
});

it("removes the plugin's discovered catalogs on uninstall", async () => {
  const { home, workspace, storage, config } = await fixture();
  const manager = directManager(config);
  try {
    await manager.start();
    expect((await manager.callTool(config.name, "ping", {})).isError).not.toBe(true);
  } finally { await manager.stopStrict(); }
  expect(await catalogFiles(home)).toHaveLength(1);
  await uninstallPluginOp({ pluginId: "sample", agencHome: home, env: { HOME: home, AGENC_HOME: home },
    pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace });
  expect(await catalogFiles(home)).toEqual([]);
});

it("completes an uninstall and reloads its config store when catalog cleanup fails", async () => {
  const { home, workspace, storage, config } = await fixture();
  const store = await sessionStore(home, workspace);
  const reload = vi.spyOn(store, "reload");
  const catalogs = join(home, "cache", "plugin-mcp-catalogs");
  vi.mocked(removePluginCatalogs).mockImplementationOnce(() => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${catalogs}'`), { code: "EBUSY" });
  });
  vi.mocked(logForDebugging).mockClear();
  await expect(uninstallPluginOp({ pluginId: "sample", agencHome: home, env: { HOME: home, AGENC_HOME: home },
    pluginStorageRoot: storage, sessionTempRoot: home, workspaceRoot: workspace, configStore: store }))
    .resolves.toMatchObject({ pluginId: "sample", removedRoots: [expect.any(String)] });
  await expect(stat(config.origin!.pluginServer!.pluginRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(reload).toHaveBeenCalled();
  const warnings = vi.mocked(logForDebugging).mock.calls
    .filter(([, options]) => options?.level === "warn").map(([message]) => message).join("\n");
  expect(warnings).toContain("sample");
  expect(warnings).toContain("EBUSY");
  expect(warnings).not.toContain(catalogs);
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
    expect(String(result.content)).toMatch(/changed; reconnect this server or start a new session/);
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
    expect(String(result.content)).toMatch(/changed; reconnect this server or start a new session/);
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
