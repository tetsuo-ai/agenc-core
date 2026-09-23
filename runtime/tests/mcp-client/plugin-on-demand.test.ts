import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPManager } from "./manager.js";
import { writePluginCatalog } from "./plugin-catalog-cache.js";
import { hashInstalledPlugin, readPluginCatalog } from "./plugin-catalog-cache.js";
import { projectMcpManagerToConnections } from "./tui-connections.js";
import { writeFile } from "node:fs/promises";
import { loadPluginMcpServerRegistrations } from "../plugins/registration/mcp-plugin-integration.js";
import type { LoadedPlugin } from "../plugins/loader.js";
import { buildToolRegistry } from "../tool-registry.js";
import { validatePluginsConfig } from "../config/schema.js";
import type { MCPServerConfig } from "./types.js";

vi.mock("./transports/stdio.js", () => ({ createStdioMCPConnection: vi.fn() }));
import { createStdioMCPConnection } from "./transports/stdio.js";

const spawn = vi.mocked(createStdioMCPConnection);
const homes: string[] = [];
const clients: Array<{ close: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> }> = [];
const descriptor = (name = "ping") => ({ name, description: `Run ${name}`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agenc-lazy-mcp-"));
  homes.push(path);
  return path;
}

function config(cacheHome: string, name = "plugin:sample:main", overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name, command: "fixture", transport: "stdio", pluginCatalogHome: cacheHome,
    origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name, version: "1", digest: "a".repeat(64), idleTimeoutMs: 20, maxProcesses: 8 } },
    ...overrides,
  };
}

function warm(cfg: MCPServerConfig, tools = [descriptor()]): void {
  const plugin = cfg.origin!.pluginServer!;
  writePluginCatalog({ pluginName: plugin.pluginName, serverName: plugin.serverName, version: plugin.version, digest: plugin.digest!, cacheHome: cfg.pluginCatalogHome! }, { format: 1, tools });
}

function setupTransport(
  tools: Array<ReturnType<typeof descriptor>> = [descriptor()],
  extras: { capabilities?: Record<string, unknown>; resources?: readonly Record<string, unknown>[]; prompts?: readonly Record<string, unknown>[] } = {},
): void {
  spawn.mockImplementation(async () => {
    const client = {
      getServerCapabilities: () => extras.capabilities ?? {},
      listTools: vi.fn().mockResolvedValue({ tools }),
      listResources: vi.fn().mockResolvedValue({ resources: extras.resources ?? [] }),
      listPrompts: vi.fn().mockResolvedValue({ prompts: extras.prompts ?? [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [{ uri: "fixture://item", text: "content" }] }),
      getPrompt: vi.fn().mockResolvedValue({ messages: [{ role: "user", content: { type: "text", text: "prompt" } }] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clients.push(client);
    return client as never;
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition did not settle");
}

beforeEach(() => { spawn.mockReset(); clients.length = 0; setupTransport(); });
afterEach(async () => { for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("plugin MCP on-demand lifecycle", () => {
  it("starts five sessions with four warm fixture plugins without spawning 20 processes and serves search from cache", async () => {
    const cacheHome = await home();
    const configs = Array.from({ length: 4 }, (_, i) => config(cacheHome, `plugin:sample:s${i}`));
    for (const cfg of configs) warm(cfg);
    const managers = Array.from({ length: 5 }, () => new MCPManager(configs));
    try {
      await Promise.all(managers.map(manager => manager.start()));
      expect(spawn).toHaveBeenCalledTimes(0);
      expect(managers.every(manager => manager.getTools().length === 4)).toBe(true);
      expect(managers[0]!.getConnectionState(configs[0]!.name)?.type).toBe("stopped");
      await managers[0]!.callTool(configs[0]!.name, "ping", {});
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await Promise.all(managers.map(manager => manager.stop())); }
  });

  it("single-flights cold discovery across five sessions and four plugins", async () => {
    const cacheHome = await home();
    const configs = Array.from({ length: 4 }, (_, i) => config(cacheHome, `plugin:sample:c${i}`));
    const managers = Array.from({ length: 5 }, () => new MCPManager(configs));
    try {
      await Promise.all(managers.map(manager => manager.start()));
      expect(spawn).toHaveBeenCalledTimes(0);
      await Promise.all(managers.map(manager => manager.primeCatalogs()));
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(managers.every(manager => manager.getTools().length === 4)).toBe(true);
    } finally { await Promise.all(managers.map(manager => manager.stop())); }
  });

  it("uses one spawn for five concurrent first calls and restarts after idle eviction", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome); warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const results = await Promise.all(Array.from({ length: 5 }, () => manager.callTool(cfg.name, "ping", {})));
      expect(results.every(result => result.isError !== true)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
      expect(clients[0]!.close).toHaveBeenCalledTimes(1);
      await manager.callTool(cfg.name, "ping", {});
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it("preserves trusted registry call metadata through the cached proxy", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const manager = new MCPManager([cfg]);
    const onBegin = vi.fn();
    manager.setCallObserver({ onBegin });
    try {
      await manager.start();
      const args: Record<string, unknown> = {};
      Object.defineProperty(args, "__callId", { value: "trusted-call", enumerable: false });
      await manager.getToolsByServer(cfg.name)[0]!.execute(args);
      expect(onBegin).toHaveBeenCalledWith(expect.objectContaining({ callId: "trusted-call" }));
    } finally { await manager.stop(); }
  });

  it("primes a missing catalog on first tool search and reuses it in a later session", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome);
    const first = new MCPManager([cfg]);
    await first.start();
    expect(spawn).toHaveBeenCalledTimes(0);
    const registry = buildToolRegistry({ workspaceRoot: cacheHome, mcpToolsProvider: first, requireAdmission: false });
    const search = await registry.dispatch({ id: "find-plugin", name: "system.searchTools", arguments: JSON.stringify({ query: "ping" }) });
    expect(search.content).toContain(`mcp.${cfg.name}.ping`);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(first.getConnectionState(cfg.name)?.type).toBe("stopped");
    expect(readPluginCatalog({ pluginName: "sample", serverName: cfg.name, version: "1", digest: "a".repeat(64), cacheHome })?.tools).toMatchObject([descriptor()]);
    await first.stop();
    spawn.mockClear();
    const second = new MCPManager([cfg]);
    try { await second.start(); expect(spawn).toHaveBeenCalledTimes(0); expect(second.getTools()).toHaveLength(1); }
    finally { await second.stop(); }
  });

  it("lists cached resources and prompts while stopped, then starts for live reads", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome);
    setupTransport([descriptor()], {
      capabilities: { resources: {}, prompts: {} },
      resources: [{ uri: "fixture://item", name: "item" }],
      prompts: [{ name: "hello", description: "hello" }],
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.primeCatalogs();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("stopped");
      expect(await manager.getResourcesByServer(cfg.name)).toHaveLength(1);
      expect(await manager.listPromptsByServer(cfg.name)).toHaveLength(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      const resources = await manager.getResourcesByServer(cfg.name);
      await manager.readResource(resources[0]!.namespacedName);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it("keeps a busy server connected during its idle deadline", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    setupTransport();
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.callTool(cfg.name, "ping", {});
      clients[0]!.callTool.mockImplementation(async () => { await held; return { content: [{ type: "text", text: "pong" }] }; });
      const call = manager.callTool(cfg.name, "ping", {});
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
      release(); await call;
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
    } finally { release(); await manager.stop(); }
  });

  it("marks a crashed idle plugin stopped and restarts on its next call", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome, "plugin:sample:crash", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "crash", digest: "a".repeat(64), idleTimeoutMs: 10_000 } } });
    warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.callTool(cfg.name, "ping", {});
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
      (clients[0] as unknown as { onclose?: () => void }).onclose?.();
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
      await manager.callTool(cfg.name, "ping", {});
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it("invalidates by version or digest and refreshes cached tools after a live mismatch", async () => {
    const cacheHome = await home(); const old = config(cacheHome); warm(old);
    for (const changed of [
      config(cacheHome, old.name, { origin: { scope: "plugin", pluginServer: { ...old.origin!.pluginServer!, version: "2" } } }),
      config(cacheHome, old.name, { origin: { scope: "plugin", pluginServer: { ...old.origin!.pluginServer!, digest: "b".repeat(64) } } }),
    ]) {
      const manager = new MCPManager([changed]);
      try { await manager.start(); expect(spawn).toHaveBeenCalledTimes(0); await manager.primeCatalogs(); expect(spawn).toHaveBeenCalledTimes(1); expect(manager.getTools()).toHaveLength(1); }
      finally { await manager.stop(); }
      spawn.mockClear();
    }
    setupTransport([descriptor("new_tool")]);
    const manager = new MCPManager([old]);
    try {
      await manager.start();
      const registry = buildToolRegistry({ workspaceRoot: cacheHome, mcpToolsProvider: manager, requireAdmission: false });
      expect(manager.getToolsByServer(old.name)[0]?.name).toContain("ping");
      await manager.callTool(old.name, "ping", {});
      expect(manager.getToolsByServer(old.name)[0]?.name).toContain("new_tool");
      const search = await registry.dispatch({ id: "changed-catalog", name: "system.searchTools", arguments: JSON.stringify({ query: "new_tool" }) });
      expect(search.content).toContain(`mcp.${old.name}.new_tool`);
    } finally { await manager.stop(); }
  });

  it("changes the installed-content digest when plugin bytes change", async () => {
    const root = await home();
    await writeFile(join(root, "plugin.json"), "one");
    const before = hashInstalledPlugin(root);
    await writeFile(join(root, "plugin.json"), "two");
    expect(hashInstalledPlugin(root)).not.toBe(before);
  });

  it("keeps eager and channel owned plugin servers connected at session startup", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome, "plugin:sample:channel", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "channel", digest: "a".repeat(64), eager: true } } });
    warm(cfg);
    const manager = new MCPManager([cfg]);
    try { await manager.start(); expect(spawn).toHaveBeenCalledTimes(1); expect(manager.getConnectionState(cfg.name)?.type).toBe("connected"); }
    finally { await manager.stop(); }
  });

  it("marks declared channels and notification listeners eager during plugin registration", async () => {
    const root = await home(); const pluginRoot = join(root, "plugin");
    await mkdir(pluginRoot);
    await writeFile(join(pluginRoot, "plugin.json"), "{}");
    const plugin = {
      id: "sample", name: "sample", root: pluginRoot, source: "sample", enabled: true,
      contentProvenance: "authority-controlled",
      manifest: { name: "sample", channels: [{ server: "channel" }], mcpEagerServers: ["listener"] },
      mcpServers: { channel: { command: "fixture" }, listener: { command: "fixture" }, ordinary: { command: "fixture" } },
    } as unknown as LoadedPlugin;
    const registrations = await loadPluginMcpServerRegistrations({
      plugins: [plugin], pluginStorageRoot: join(root, "storage"), workspaceRoot: root,
      config: { plugins: { mcp_idle_timeout_ms: 120_000, mcp_max_processes: 3,
        plugins: { sample: { mcp_servers: { ordinary: { idle_timeout_ms: 5_000 } } } } } },
    });
    expect(Object.fromEntries(registrations.map(registration => [registration.serverName, registration.eager]))).toEqual({ channel: true, listener: true, ordinary: false });
    expect(registrations.find(registration => registration.serverName === "ordinary")).toMatchObject({ idleTimeoutMs: 5_000, maxProcesses: 3 });
  });

  it("accepts global and per-plugin lifecycle settings from config.toml", () => {
    const settings = validatePluginsConfig({
      mcp_idle_timeout_ms: 120_000,
      mcp_max_processes: 3,
      plugins: { sample: { mcp_servers: { main: { eager: true, idle_timeout_ms: 5_000 } } } },
    });
    expect(settings?.mcp_idle_timeout_ms).toBe(120_000);
    expect(settings?.mcp_max_processes).toBe(3);
    expect(settings?.plugins?.sample?.mcp_servers?.main).toMatchObject({ eager: true, idle_timeout_ms: 5_000 });
  });

  it("evicts least recently used idle process under the shared budget", async () => {
    const cacheHome = await home();
    const configs = ["a", "b", "c"].map(name => config(cacheHome, `plugin:sample:${name}`, { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name, digest: "a".repeat(64), idleTimeoutMs: 10_000, maxProcesses: 2 } } }));
    for (const cfg of configs) warm(cfg);
    const manager = new MCPManager(configs);
    try {
      await manager.start();
      await manager.callTool(configs[0]!.name, "ping", {});
      await manager.callTool(configs[1]!.name, "ping", {});
      await manager.callTool(configs[2]!.name, "ping", {});
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(manager.getConnectionState(configs[0]!.name)?.type).toBe("stopped");
      expect(manager.getConnectionState(configs[1]!.name)?.type).toBe("connected");
    } finally { await manager.stop(); }
  });

  it("waits for a busy process before evicting it to satisfy the budget", async () => {
    const cacheHome = await home();
    const configs = ["busy", "next"].map(name => config(cacheHome, `plugin:sample:${name}`, { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name, digest: "a".repeat(64), idleTimeoutMs: 10_000, maxProcesses: 1 } } }));
    for (const cfg of configs) warm(cfg);
    const manager = new MCPManager(configs);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      await manager.start();
      await manager.callTool(configs[0]!.name, "ping", {});
      clients[0]!.callTool.mockImplementation(async () => { await held; return { content: [{ type: "text", text: "done" }] }; });
      const busy = manager.callTool(configs[0]!.name, "ping", {});
      await waitFor(() => clients[0]!.callTool.mock.calls.length >= 2);
      const next = manager.callTool(configs[1]!.name, "ping", {});
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getConnectionState(configs[0]!.name)?.type).toBe("connected");
      release(); await busy; await next;
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.getConnectionState(configs[0]!.name)?.type).toBe("stopped");
    } finally { release(); await manager.stop(); }
  });

  it("returns a typed error and failed status when startup rejects", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    spawn.mockRejectedValue(new Error("fixture startup failed"));
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const result = await manager.callTool(cfg.name, "ping", {});
      expect(result).toMatchObject({ isError: true, metadata: { errorCode: "MCP_PLUGIN_STARTUP_FAILED" } });
      expect(manager.getConnectionState(cfg.name)?.type).toBe("failed");
      expect(projectMcpManagerToConnections(manager).find(server => server.name === cfg.name)?.type).toBe("failed");
    } finally { await manager.stop(); }
  });

  it("bounds a slow startup and returns its typed error before transport cleanup finishes", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:slow", { timeout: 20 }); warm(cfg);
    spawn.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      throw new Error("late fixture failure");
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const started = Date.now();
      const result = await manager.callTool(cfg.name, "ping", {});
      expect(Date.now() - started).toBeLessThan(70);
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(manager.getConnectionState(cfg.name)?.type).toBe("failed");
      await new Promise(resolve => setTimeout(resolve, 90));
    } finally { await manager.stop(); }
  });

  it("projects an idle plugin as stopped rather than failed", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect(projectMcpManagerToConnections(manager).find(server => server.name === cfg.name)?.type).toBe("stopped");
      expect(spawn).toHaveBeenCalledTimes(0);
    } finally { await manager.stop(); }
  });
});
