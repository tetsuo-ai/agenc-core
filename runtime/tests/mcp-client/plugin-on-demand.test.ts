import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPManager } from "./manager.js";
import { writePluginCatalog } from "./plugin-catalog-cache.js";
import { fingerprintPluginCatalogConfig, hashInstalledPlugin, readPluginCatalog, snapshotInstalledPlugin, snapshotInstalledPluginOffThread } from "./plugin-catalog-cache.js";
import * as pluginCatalogCache from "./plugin-catalog-cache.js";
import { projectMcpManagerToConnections } from "./tui-connections.js";
import { readFile, writeFile } from "node:fs/promises";
import { loadPluginMcpServerRegistrations } from "../plugins/registration/mcp-plugin-integration.js";
import type { LoadedPlugin } from "../plugins/loader.js";
import { buildToolRegistry } from "../tool-registry.js";
import { validatePluginsConfig } from "../config/schema.js";
import type { MCPServerConfig } from "./types.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";

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

function catalogIdentity(cfg: MCPServerConfig) {
  const plugin = cfg.origin!.pluginServer!;
  return { pluginName: plugin.pluginName, serverName: plugin.serverName, version: plugin.version, digest: plugin.digest!, cacheHome: cfg.pluginCatalogHome!, configFingerprint: fingerprintPluginCatalogConfig({ transport: cfg.transport ?? "stdio", command: cfg.command, args: cfg.args, env: cfg.env, env_vars: cfg.env_vars, cwd: cfg.cwd, endpoint: cfg.endpoint, headers: cfg.headers, pluginSandbox: cfg.pluginSandbox, userConfigDigest: plugin.userConfigDigest, parentEnvironment: {} }) };
}

function warm(cfg: MCPServerConfig, tools = [descriptor()], extras: { prompts?: readonly unknown[]; resources?: readonly unknown[] } = {}): void {
  writePluginCatalog(catalogIdentity(cfg), { format: 1, tools, ...extras });
}

async function catalogText(cacheHome: string): Promise<string> {
  const directory = join(cacheHome, "cache", "plugin-mcp-catalogs");
  let entries;
  try { entries = await readdir(directory, { recursive: true, withFileTypes: true }); }
  catch { return ""; }
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  return (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
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

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition did not settle");
}

beforeEach(() => { spawn.mockReset(); clients.length = 0; setupTransport(); });
async function unlockDirectories(path: string): Promise<void> {
  let status; try { status = await lstat(path); } catch { return; }
  if (!status.isDirectory()) return;
  await chmod(path, 0o700);
  for (const child of await readdir(path)) await unlockDirectories(join(path, child));
}
afterEach(async () => { for (const path of homes.splice(0)) { await unlockDirectories(path); await rm(path, { recursive: true, force: true }); } });

describe("plugin MCP on-demand lifecycle", () => {
  it("keeps A's replacement after B refreshes to the same environment", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:two-refreshes", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "main", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const a = new MCPManager([cfg]); const b = new MCPManager([cfg]);
    try {
      await Promise.all([a.start(), b.start()]);
      const replacement = { ...cfg, env: { NEW_VALUE: "1" } };
      await a.refreshServers([replacement]);
      await b.refreshServers([replacement]);
      expect((await a.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
    } finally { await Promise.all([a.stopStrict(), b.stopStrict()]); }
  });

  it("keeps another session running when one session disables its plugin", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:local-override", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "main", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const a = new MCPManager([cfg]); const b = new MCPManager([cfg]);
    try {
      await Promise.all([a.start(), b.start()]);
      await b.refreshServers([{ ...cfg, enabled: false }]);
      expect((await a.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
      await b.refreshServers([{ ...cfg, enabled: true }]);
      expect((await a.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
    } finally { await Promise.all([a.stopStrict(), b.stopStrict()]); }
  });
  it("checks revocation after onBegin before stdio dispatch", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:begin", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "begin", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const manager = new MCPManager([cfg]);
    let shutdown: Promise<void> | undefined;
    manager.setCallObserver({ onBegin: () => { shutdown = manager.stopStrict(); } });
    await manager.start();
    const result = await manager.getToolsByServer(cfg.name)[0]!.execute({});
    expect(result.isError).toBe(true);
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(clients[0]!.callTool).not.toHaveBeenCalled();
    await shutdown;
  });

  it("keeps a second manager's generation leased while the first stops during verification", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "x".repeat(8 * 1024 * 1024));
    const cfg = config(cacheHome, "plugin:sample:concurrent", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "concurrent", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const first = new MCPManager([cfg]); const second = new MCPManager([cfg]);
    const firstStart = first.start(); const secondStart = second.start();
    const stopping = first.stopStrict();
    try {
      await Promise.all([firstStart, secondStart, stopping]);
      expect(second.getConnectionState(cfg.name)?.type).toBe("connected");
      const held = (second as unknown as { installationGenerations: Map<MCPServerConfig, { state: { release?: () => void } }> }).installationGenerations.values().next().value;
      expect(typeof held?.state.release).toBe("function");
      expect((await second.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
    } finally { await first.stopStrict(); await second.stopStrict(); }
  });

  it("gives a restarted plugin fresh revocation authority while retained tools stay revoked", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:restart", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "restart", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const manager = new MCPManager([cfg]);
    await manager.start();
    const retained = manager.getToolsByServer(cfg.name)[0]!;
    expect((await retained.execute({})).isError).not.toBe(true);
    await manager.stopStrict();
    await manager.start();
    try {
      expect((await retained.execute({})).isError).toBe(true);
      expect((await manager.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
    } finally { await manager.stopStrict(); }
  });

  it("renews plugin authority on sandbox resume", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:sandbox-resume", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "sandbox-resume", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: cacheHome });
    const nextCwd = join(cacheHome, "next-workspace");
    await mkdir(nextCwd);
    const manager = new MCPManager([cfg]);
    manager.setSandboxExecutionBroker(broker);
    try {
      await manager.start();
      const retained = manager.getToolsByServer(cfg.name)[0]!;
      await transitionSandboxExecutionBroker(broker, nextCwd);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
      expect((await retained.execute({})).isError).toBe(true);
      expect((await manager.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
    } finally { await manager.stopStrict(); manager.setSandboxExecutionBroker(undefined); }
  });

  it("does not scan installed trees during a warm plugin call", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:scan", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "scan", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } } });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const scan = vi.spyOn(pluginCatalogCache, "hashInstalledPlugin");
      try { await manager.callTool(cfg.name, "ping", {}); expect(scan).toHaveBeenCalledTimes(0); }
      finally { scan.mockRestore(); }
    } finally { await manager.stop(); }
  });

  it("does not revoke a verified plugin when status is read before startup", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, "plugin:sample:prestart", {
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "prestart", digest: hashInstalledPlugin(root), pluginRoot: root, eager: true } },
    });
    const manager = new MCPManager([cfg]);
    try {
      expect(manager.getConnectionState(cfg.name)?.type).toBe("pending");
      const starting = manager.start();
      expect(manager.getConnectionState(cfg.name)?.type).toBe("pending");
      await starting;
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
    } finally { await manager.stop(); }
  });

  it("excludes filesystem bookkeeping from the digest and published snapshot", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const digest = hashInstalledPlugin(root);
    await writeFile(join(root, ".DS_Store"), "metadata");
    await writeFile(join(root, "Thumbs.db"), "metadata");
    await writeFile(join(root, ".entry.js.swp"), "metadata");
    expect(hashInstalledPlugin(root)).toBe(digest);
    const snapshot = snapshotInstalledPlugin(root, cacheHome, digest);
    expect(hashInstalledPlugin(snapshot)).toBe(digest);
    expect(await (await import("node:fs/promises")).readdir(snapshot)).toEqual(["entry.js"]);
    expect(((await (await import("node:fs/promises")).stat(join(snapshot, "entry.js"))).mode & 0o222)).toBe(0);
    // Files are sealed; the directory stays writable so the cache can be removed.
    expect((await stat(snapshot)).mode & 0o200).toBe(0o200);
    const workerSnapshot = await snapshotInstalledPluginOffThread(root, join(cacheHome, "worker-storage"));
    expect(workerSnapshot.digest).toBe(digest);
    expect(await (await import("node:fs/promises")).readdir(workerSnapshot.snapshotRoot)).toEqual(["entry.js"]);
    expect(((await stat(join(workerSnapshot.snapshotRoot, "entry.js"))).mode & 0o222)).toBe(0);
    expect((await stat(workerSnapshot.snapshotRoot)).mode & 0o200).toBe(0o200);
    await rm(workerSnapshot.snapshotRoot, { recursive: true });
  });

  it.each(["eager", "lazy"])("keeps a live %s plugin authorized when .DS_Store is added and removed", async kind => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const cfg = config(cacheHome, `plugin:sample:${kind}-metadata`, {
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: `${kind}-metadata`, digest: hashInstalledPlugin(root), pluginRoot: root, eager: kind === "eager", idleTimeoutMs: 10_000 } },
    });
    warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect((await manager.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
      await writeFile(join(root, ".DS_Store"), "metadata");
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
      expect((await manager.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
      await rm(join(root, ".DS_Store"));
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
      expect((await manager.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await manager.stop(); }
  });

  it("verifies snapshot creation on a worker while the event loop advances", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "x".repeat(16 * 1024 * 1024));
    let timerFired = false;
    const timer = new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 0));
    const result = await snapshotInstalledPluginOffThread(root, cacheHome);
    expect(timerFired).toBe(true);
    await timer;
    expect(hashInstalledPlugin(result.snapshotRoot)).toBe(result.digest);
  });
  it("serializes a call queued behind eviction before a later reconnect", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome, "plugin:sample:evict-reconnect", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "evict-reconnect", digest: "a".repeat(64), maxProcesses: 1, idleTimeoutMs: 0 } } });
    warm(cfg);
    const manager = new MCPManager([cfg]); const close = deferred();
    const discovery = deferred<{ tools: ReturnType<typeof descriptor>[] }>();
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const original = spawn.getMockImplementation()!;
      spawn.mockImplementation(async (...args) => {
        const client = await original(...args);
        if (clients.length === 2) (client as never as { listTools: ReturnType<typeof vi.fn> }).listTools.mockImplementation(() => discovery.promise);
        return client;
      });
      const eviction = (manager as never as { evictPlugin: (name: string) => Promise<void> }).evictPlugin(cfg.name);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const call = manager.callTool(cfg.name, "ping", {});
      const reconnect = manager.reconnectServer(cfg.name);
      close.resolve();
      await waitFor(() => spawn.mock.calls.length >= 2);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(spawn).toHaveBeenCalledTimes(2);
      discovery.resolve({ tools: [descriptor()] });
      await Promise.all([eviction, call, reconnect]);
      expect(clients.filter(client => client.close.mock.calls.length === 0)).toHaveLength(1);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
    } finally { close.resolve(); discovery.resolve({ tools: [descriptor()] }); await manager.stop(); }
  });

  it("rejects a retained cached proxy after its plugin configuration is replaced", async () => {
    const cacheHome = await home(); const old = config(cacheHome, "plugin:sample:retained", { command: "old-binary" }); warm(old);
    const replacement = config(cacheHome, old.name, { command: "new-binary", origin: { scope: "plugin", pluginServer: { ...old.origin!.pluginServer!, version: "2", digest: "b".repeat(64) } } });
    warm(replacement);
    const manager = new MCPManager([old]);
    try {
      await manager.start();
      const retained = manager.getToolsByServer(old.name)[0]!;
      await manager.refreshServers([replacement]);
      expect((await retained.execute({})).isError).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await manager.stop(); }
  });

  it("bounds a call waiting for existing disposal by its timeout and abort", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:closing-wait", { timeout: 30, origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "closing-wait", digest: "a".repeat(64), idleTimeoutMs: 0 } } });
    warm(cfg); const manager = new MCPManager([cfg]); const close = deferred();
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const eviction = (manager as never as { evictPlugin: (name: string) => Promise<void> }).evictPlugin(cfg.name);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const controller = new AbortController();
      const call = manager.callTool(cfg.name, "ping", {}, { signal: controller.signal });
      controller.abort(new Error("cancelled while closing"));
      const result = await Promise.race([call, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("call stayed pending during close")), 100))]);
      expect(result.isError).toBe(true);
      const timedOut = await Promise.race([
        manager.callTool(cfg.name, "ping", {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("call exceeded cleanup deadline")), 100)),
      ]);
      expect(timedOut.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(spawn).toHaveBeenCalledTimes(1);
      close.resolve(); await eviction;
    } finally { close.resolve(); await manager.stop(); }
  });

  it("cancels a reconnect waiter without releasing disposal ownership", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:reconnect-wait", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "reconnect-wait", digest: "a".repeat(64), idleTimeoutMs: 0 } } });
    warm(cfg); const manager = new MCPManager([cfg]); const close = deferred();
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const eviction = (manager as never as { evictPlugin: (name: string) => Promise<void> }).evictPlugin(cfg.name);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const controller = new AbortController();
      const reconnect = manager.reconnectServer(cfg.name, { signal: controller.signal });
      controller.abort(new Error("reconnect cancelled"));
      const result = await Promise.race([reconnect, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reconnect wait was not cancelled")), 100))]);
      expect(result.success).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
      close.resolve(); await eviction;
    } finally { close.resolve(); await manager.stop(); }
  });

  it("invalidates a connection that closes during resource discovery", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:discovery-close", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "discovery-close", digest: "a".repeat(64), idleTimeoutMs: 0 } } });
    warm(cfg); setupTransport([descriptor()], { capabilities: { resources: {} } });
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      const client = await original(...args);
      if (clients.length === 1) (client as never as { listResources: ReturnType<typeof vi.fn>; onclose?: () => void }).listResources.mockImplementation(async () => {
        (client as never as { onclose?: () => void }).onclose?.();
        throw new Error("transport closed during discovery");
      });
      return client;
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.callTool(cfg.name, "ping", {});
      expect(manager.getConnectionState(cfg.name)?.type).not.toBe("connected");
      expect(manager.getConnectedServers()).toHaveLength(0);
      await manager.callTool(cfg.name, "ping", {});
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it("preserves an eager server's configured timeout during reconnect", async () => {
    const cfg: MCPServerConfig = { name: "ordinary-reconnect-timeout", command: "fixture", transport: "stdio", timeout: 11_000 };
    const manager = new MCPManager([cfg]);
    const original = spawn.getMockImplementation()!;
    const delayed = deferred<never>();
    try {
      await manager.start();
      spawn.mockImplementation(async (...args) => args[0].name === cfg.name ? delayed.promise : original(...args));
      vi.useFakeTimers();
      const reconnect = manager.reconnectServer(cfg.name);
      let settled = false;
      void reconnect.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(settled).toBe(false);
      delayed.reject(new Error("test complete"));
      await reconnect;
    } finally { delayed.reject(new Error("test complete")); vi.useRealTimers(); await manager.stop(); }
  });

  it("starts an explicitly required lazy plugin and checks readiness", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:required"); warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start({ requiredServers: [cfg.name], requireOneReady: true });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
    } finally { await manager.stop(); }
  });

  it("rejects startup when an explicitly required lazy plugin cannot connect", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:required-failure"); warm(cfg);
    spawn.mockRejectedValueOnce(new Error("required plugin unavailable"));
    const manager = new MCPManager([cfg]);
    try {
      await expect(manager.start({ requiredServers: [cfg.name], requireOneReady: true }))
        .rejects.toThrow(/required server\(s\) not ready/);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await manager.stop(); }
  });
  it("serializes reconnect disposal with a concurrent call and keeps a starting reconnect budgeted", async () => {
    const cacheHome = await home();
    const a = config(cacheHome, "plugin:sample:reconnect-race", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "reconnect-race", digest: "a".repeat(64), maxProcesses: 1, idleTimeoutMs: 0 } } });
    const b = config(cacheHome, "plugin:sample:budget-race", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "budget-race", digest: "a".repeat(64), maxProcesses: 1, idleTimeoutMs: 0 } } });
    warm(a); warm(b);
    const close = deferred(); const connect = deferred<never>();
    void connect.promise.catch(() => undefined);
    const manager = new MCPManager([a, b]);
    try {
      await manager.start(); await manager.callTool(a.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const reconnect = manager.reconnectServer(a.name);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const concurrent = manager.callTool(a.name, "ping", {});
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(spawn).toHaveBeenCalledTimes(1);
      close.resolve(); await reconnect; await concurrent;
      const original = spawn.getMockImplementation()!;
      spawn.mockImplementation(async (...args) => args[0].name === a.name ? connect.promise : original(...args));
      const restarting = manager.reconnectServer(a.name);
      await waitFor(() => spawn.mock.calls.length >= 3);
      const competing = manager.callTool(b.name, "ping", {});
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(spawn.mock.calls.filter(call => call[0].name === b.name)).toHaveLength(0);
      connect.reject(new Error("fixture cancelled"));
      await restarting; await competing;
    } finally { close.resolve(); connect.reject(new Error("fixture cancelled")); await manager.stop(); }
  });

  it("never launches a shell argument against the mutable plugin root", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const digest = hashInstalledPlugin(root); const snapshotRoot = snapshotInstalledPlugin(root, cacheHome, digest);
    const cfg = config(cacheHome, "plugin:sample:shell", { command: "sh", args: ["-c", `exec node ${root}/entry.js`], cwd: root,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "shell", digest, pluginRoot: root, snapshotRoot,
        snapshotLaunch: { command: "sh", args: ["-c", `exec node ${snapshotRoot}/entry.js`], cwd: snapshotRoot } } } });
    warm(cfg); const manager = new MCPManager([cfg]);
    try { await manager.start(); await manager.callTool(cfg.name, "ping", {});
      expect(spawn.mock.calls[0]?.[0].args?.[1]).toBe(`exec node ${snapshotRoot}/entry.js`);
    } finally { await manager.stop(); }
  });

  it("resolves plugin root templates against the snapshot and rejects unresolved executable references", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const plugin = { id: "sample", name: "sample", root, source: "sample", enabled: true,
      contentProvenance: "authority-controlled", manifest: { name: "sample" },
      mcpServers: { main: { command: "sh", args: ["-c", "exec node ${AGENC_PLUGIN_ROOT}/entry.js"] } },
    } as unknown as LoadedPlugin;
    const registrations = await loadPluginMcpServerRegistrations({
      plugins: [plugin], pluginStorageRoot: cacheHome, workspaceRoot: cacheHome,
    });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.server.args?.[1]).toBe(`exec node ${registrations[0]!.snapshotRoot}/entry.js`);
    const cfg = config(cacheHome, "plugin:sample:unresolved", {
      args: [`--file=${root}/entry.js`],
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "unresolved",
        digest: registrations[0]!.digest, pluginRoot: root, snapshotRoot: registrations[0]!.snapshotRoot } },
    });
    warm(cfg); const manager = new MCPManager([cfg]);
    try { await manager.start();
      expect((await manager.callTool(cfg.name, "ping", {})).isError).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await manager.stop(); }
  });

  it("snapshots a valid relative link without changing its target text", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "plugin");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    await symlink("entry.js", join(root, "bin.js"));
    const snapshotRoot = snapshotInstalledPlugin(root, cacheHome, hashInstalledPlugin(root));
    expect(await readlink(join(snapshotRoot, "bin.js"))).toBe("entry.js");
  });

  it("waits for discovery after a bridge is published before serving a second call", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:half-ready"); warm(cfg);
    const discovery = deferred<{ resources: readonly Record<string, unknown>[] }>();
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => { const client = await original(...args);
      (client as never as { listResources: ReturnType<typeof vi.fn> }).listResources.mockImplementation(() => discovery.promise); return client; });
    const manager = new MCPManager([cfg]);
    try { await manager.start(); const first = manager.callTool(cfg.name, "ping", {});
      await waitFor(() => clients[0]?.listResources.mock.calls.length > 0);
      const second = manager.callTool(cfg.name, "ping", {});
      let settled = false; void second.then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
      discovery.resolve({ resources: [] });
      expect((await first).isError).not.toBe(true); expect((await second).isError).not.toBe(true);
    } finally { discovery.resolve({ resources: [] }); await manager.stop(); }
  });

  it("keeps a live listing active through the idle deadline", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const manager = new MCPManager([cfg]); const listing = deferred<{ resources: readonly Record<string, unknown>[] }>();
    try { await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.listResources.mockImplementation(() => listing.promise);
      const pending = manager.getResourcesByServer(cfg.name);
      await waitFor(() => clients[0]!.listResources.mock.calls.length >= 2);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(clients[0]!.close).not.toHaveBeenCalled();
      listing.resolve({ resources: [] }); await pending;
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
    } finally { listing.resolve({ resources: [] }); await manager.stop(); }
  });

  it.each(["getResources", "getResourcesByServer", "listPrompts", "listPromptsByServer"] as const)(
    "keeps %s active through the idle deadline", async method => {
      const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
      setupTransport([descriptor()], { capabilities: { resources: {}, prompts: {} } });
      const held = deferred<{ resources?: readonly Record<string, unknown>[]; prompts?: readonly Record<string, unknown>[] }>();
      const manager = new MCPManager([cfg]);
      try { await manager.start(); await manager.callTool(cfg.name, "ping", {});
        const client = clients[0] as unknown as { close: ReturnType<typeof vi.fn>; listResources: ReturnType<typeof vi.fn>; listPrompts: ReturnType<typeof vi.fn> };
        const listing = method.includes("Prompts") ? client.listPrompts : client.listResources;
        listing.mockImplementation(() => held.promise);
        const pending = method === "getResources" ? manager.getResources() :
          method === "getResourcesByServer" ? manager.getResourcesByServer(cfg.name) :
          method === "listPrompts" ? manager.listPrompts() : manager.listPromptsByServer(cfg.name);
        await waitFor(() => listing.mock.calls.length >= 2);
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(client.close).not.toHaveBeenCalled();
        held.resolve({ resources: [], prompts: [] }); await pending;
        await waitFor(() => client.close.mock.calls.length > 0);
      } finally { held.resolve({ resources: [], prompts: [] }); await manager.stop(); }
    },
  );

  it("retires a crash during a resource read before the next read", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:busy-crash", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "busy-crash", digest: "a".repeat(64), idleTimeoutMs: 0 } } }); warm(cfg);
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const read = deferred<{ contents: readonly Record<string, unknown>[] }>();
    const manager = new MCPManager([cfg]);
    try { await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.readResource.mockImplementation(() => read.promise);
      const first = manager.readResource(`mcp.${cfg.name}.fixture://item`);
      await waitFor(() => clients[0]!.readResource.mock.calls.length > 0);
      (clients[0] as unknown as { onclose?: () => void }).onclose?.();
      expect(manager.getConnectionState(cfg.name)?.type).not.toBe("connected");
      read.resolve({ contents: [{ uri: "fixture://item", text: "old" }] }); await first;
      await manager.readResource(`mcp.${cfg.name}.fixture://item`);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { read.resolve({ contents: [] }); await manager.stop(); }
  });

  it("returns cold tool search after discovery while close remains pending", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:cold-close", { timeout: 20,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "cold-close", digest: "a".repeat(64), maxProcesses: 1 } } });
    const other = config(cacheHome, "plugin:sample:after-cold-close", {
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "after-cold-close", digest: "a".repeat(64), maxProcesses: 1 } } }); warm(other);
    const close = deferred(); const manager = new MCPManager([cfg]); const competitor = new MCPManager([other]);
    try {
      setupTransport([descriptor()], { capabilities: { resources: {}, prompts: {} },
        resources: [{ uri: "fixture://item", name: "item" }], prompts: [{ name: "hello" }] });
      await manager.start();
      const original = spawn.getMockImplementation()!;
      spawn.mockImplementation(async (...args) => { const client = await original(...args); client.close.mockImplementation(() => close.promise); return client; });
      const registry = buildToolRegistry({ workspaceRoot: cacheHome, mcpToolsProvider: manager, requireAdmission: false });
      const search = registry.dispatch({ id: "cold-close", name: "system.searchTools", arguments: JSON.stringify({ query: "ping" }) });
      await waitFor(() => clients[0]?.close.mock.calls.length > 0);
      const result = await Promise.race([search.then(value => ({ done: true, value })), new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), 65))]);
      expect(result.done).toBe(true);
      if (result.done) expect(result.value.content).toContain(`mcp.${cfg.name}.ping`);
      expect(await manager.getResourcesByServer(cfg.name)).toHaveLength(1);
      expect(await manager.listPromptsByServer(cfg.name)).toHaveLength(1);
      await competitor.start();
      const competing = competitor.callTool(other.name, "ping", {});
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(spawn).toHaveBeenCalledTimes(1);
      close.resolve(); await search;
      await competing;
    } finally { close.resolve(); await Promise.all([manager.stop(), competitor.stop()]); }
  });
  it("keeps an evicted generation owned until disposal and waits for it at shutdown", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const close = deferred();
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const next = manager.callTool(cfg.name, "ping", {});
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(spawn).toHaveBeenCalledTimes(1);
      const stopped = manager.stop();
      let settled = false;
      void stopped.then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      close.resolve();
      await Promise.all([next, stopped]);
    } finally { close.resolve(); await manager.stop(); }
  });

  it("reports an eviction cleanup failure that settles during strict shutdown", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:strict-eviction", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "strict-eviction", digest: "a".repeat(64), idleTimeoutMs: 0 } } }); warm(cfg);
    const close = deferred(); const manager = new MCPManager([cfg]);
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const eviction = (manager as never as { evictPlugin: (name: string) => Promise<void> }).evictPlugin(cfg.name);
      void eviction.catch(() => undefined);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const shutdown = manager.stopStrict();
      close.reject(new Error("eviction disposal failed"));
      await expect(eviction).rejects.toThrow(/connection cleanup failed/);
      await expect(shutdown).rejects.toThrow(/strict shutdown failed/);
    } finally {
      clients[0]?.close.mockResolvedValue(undefined);
      await manager.stopStrict();
    }
  });

  it("does not complete shutdown while an idle timer is closing a process", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const close = deferred(); const manager = new MCPManager([cfg]);
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      let stopped = false;
      const task = manager.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(stopped).toBe(false);
      close.resolve(); await task;
    } finally { close.resolve(); await manager.stop(); }
  });

  it("does not let an old eviction callback close a replacement generation", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const replacement = { ...cfg, command: "replacement" }; warm(replacement);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      const oldConfig = manager.getServerConfig(cfg.name)!;
      const oldOwner = (manager as never as { pluginLifecycles: Map<string, { reservation: object }> }).pluginLifecycles.get(cfg.name)!.reservation;
      const oldGeneration = (manager as never as { lifecycleGeneration: number }).lifecycleGeneration;
      await manager.refreshServers([replacement]);
      await manager.callTool(cfg.name, "ping", {});
      await (manager as never as { evictPlugin: (name: string, owner: object, config: MCPServerConfig, generation: number) => Promise<void> })
        .evictPlugin(cfg.name, oldOwner, oldConfig, oldGeneration);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
      expect(clients[1]!.close).not.toHaveBeenCalled();
    } finally { await manager.stop(); }
  });

  it("does not launch a superseded config after a budget wait", async () => {
    const cacheHome = await home();
    const blocker = config(cacheHome, "plugin:sample:blocker", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "blocker", digest: "a".repeat(64), maxProcesses: 1 } } });
    const old = config(cacheHome, "plugin:sample:target", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "target", digest: "a".repeat(64), maxProcesses: 1 } } });
    const replacement = { ...old, command: "replacement" };
    warm(blocker); warm(old);
    const first = new MCPManager([blocker]); const second = new MCPManager([old]);
    const close = deferred();
    try {
      await Promise.all([first.start(), second.start()]);
      await first.callTool(blocker.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const pending = second.callTool(old.name, "ping", {});
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      const refresh = second.refreshServers([replacement]);
      await waitFor(() => second.getServerConfig(old.name)?.command === "replacement");
      close.resolve();
      await Promise.all([pending, refresh]);
      expect(spawn.mock.calls.filter(call => call[0].name === old.name).map(call => call[0].command)).not.toContain("fixture");
    } finally { close.resolve(); await Promise.all([first.stop(), second.stop()]); }
  });

  it("launches a pinned plugin tree even if installation changes at the transport boundary", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const digest = hashInstalledPlugin(root);
    const snapshotRoot = snapshotInstalledPlugin(root, cacheHome, digest);
    const cfg = config(cacheHome, "plugin:sample:pinned", {
      command: join(root, "entry.js"), args: [join(root, "entry.js")], cwd: root,
      env: { AGENC_PLUGIN_ROOT: root },
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "pinned", digest, pluginRoot: root, snapshotRoot,
        snapshotLaunch: { command: join(snapshotRoot, "entry.js"), args: [join(snapshotRoot, "entry.js")], cwd: snapshotRoot,
          env: { AGENC_PLUGIN_ROOT: snapshotRoot } } } },
    });
    warm(cfg);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      await writeFile(join(root, "entry.js"), "replacement");
      return original(...args);
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.callTool(cfg.name, "ping", {});
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        command: join(snapshotRoot, "entry.js"), args: [join(snapshotRoot, "entry.js")],
        cwd: snapshotRoot, env: { AGENC_PLUGIN_ROOT: snapshotRoot },
      });
      expect(await (await import("node:fs/promises")).readFile(join(snapshotRoot, "entry.js"), "utf8")).toBe("old");
    } finally { await manager.stop(); }
  });

  it("uses snapshot fields for a Windows-spelled installed root and forward-slash argument", async () => {
    const cacheHome = await home();
    const root = win32.join("C:\\plugins", "sample");
    const snapshotRoot = win32.join("D:\\snapshots", "sample");
    const cfg = config(cacheHome, "plugin:sample:windows-launch", {
      command: "node", args: [root.replaceAll("\\", "/") + "/server.mjs"], cwd: root,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "windows-launch",
        pluginRoot: root, snapshotRoot, snapshotLaunch: {
          command: "node", args: [snapshotRoot.replaceAll("\\", "/") + "/server.mjs"], cwd: snapshotRoot,
        } } },
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start({ requireOneReady: true });
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        args: [snapshotRoot.replaceAll("\\", "/") + "/server.mjs"], cwd: snapshotRoot,
      });
    } finally { await manager.stop(); }
  });

  it("launches a file URL import from the snapshot", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    const snapshotRoot = join(cacheHome, "snapshot");
    const cfg = config(cacheHome, "plugin:sample:file-url", {
      command: "node", args: ["--import", `file://${root}/bootstrap.mjs`, "server.mjs"], cwd: root,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "file-url",
        pluginRoot: root, snapshotRoot, snapshotLaunch: {
          command: "node", args: ["--import", `file://${snapshotRoot}/bootstrap.mjs`, "server.mjs"], cwd: snapshotRoot,
        } } },
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start({ requireOneReady: true });
      expect(spawn.mock.calls[0]?.[0].args).toEqual(["--import", `file://${snapshotRoot}/bootstrap.mjs`, "server.mjs"]);
    } finally { await manager.stop(); }
  });

  it("refuses inherited PATH and requested env_vars that point into the installation", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "sample-server"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "sample-server"), 0o755);
    const snapshotRoot = join(cacheHome, "snapshot");
    for (const [name, environment, env_vars] of [
      ["path", { PATH: `${bin}:${process.env.PATH ?? "/usr/bin"}` }, undefined],
      ["requested", { REQUESTED_PATH: join(root, "config.json") }, ["REQUESTED_PATH"]],
    ] as const) {
      const cfg = config(cacheHome, `plugin:sample:${name}`, {
        command: name === "path" ? "sample-server" : "node", env_vars,
        origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name,
          pluginRoot: root, snapshotRoot, snapshotLaunch: { command: name === "path" ? "sample-server" : "node", cwd: snapshotRoot },
        } },
      });
      const manager = new MCPManager([cfg], undefined, environment);
      try {
        await manager.start();
        expect(spawn).not.toHaveBeenCalled();
        expect(manager.getConnectionState(cfg.name)).toMatchObject({ type: "failed", error: expect.stringContaining("launch references its mutable installation") });
      } finally { await manager.stop(); }
    }
  });

  it("rejects punctuation-named installed entrypoints at startup and restart", async () => {
    const cacheHome = await home();
    const root = join(cacheHome, "sample");
    const snapshotRoot = join(cacheHome, "cache", "mcp-install-snapshots", "digest");
    await mkdir(root); await mkdir(snapshotRoot, { recursive: true });
    for (const [index, name] of ["server(1).mjs", "server,1.mjs", "server's.mjs"].entries()) {
      const installedEntry = join(root, name);
      await writeFile(installedEntry, "original");
      const cfg = config(cacheHome, `plugin:sample:punctuation-${index}`, {
        command: "node",
        origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name,
          pluginRoot: root, snapshotRoot, snapshotLaunch: {
            command: "node", args: [relative(snapshotRoot, installedEntry)], cwd: snapshotRoot,
          } } },
      });
      const manager = new MCPManager([cfg]);
      try {
        await manager.start();
        expect(manager.getConnectionState(cfg.name)).toMatchObject({
          type: "failed", error: expect.stringContaining("launch references its mutable installation"),
        });
        await manager.stop();
        await writeFile(installedEntry, "changed installed bytes");
        await manager.start();
        expect(manager.getConnectionState(cfg.name)).toMatchObject({
          type: "failed", error: expect.stringContaining("launch references its mutable installation"),
        });
        expect(spawn).not.toHaveBeenCalled();
      } finally { await manager.stop(); }
    }
  });

  it("rejects a symlink then dot-dot route into installed bytes at startup and restart", async () => {
    const cacheHome = await home();
    const root = join(cacheHome, "sample");
    const sibling = join(cacheHome, "sibling");
    const aliases = join(cacheHome, "aliases");
    const snapshotRoot = join(cacheHome, "snapshot");
    await mkdir(root); await mkdir(sibling); await mkdir(aliases); await mkdir(snapshotRoot);
    await symlink(sibling, join(aliases, "alias"), "dir");
    const installedEntry = join(root, "server.py");
    await writeFile(installedEntry, "original");
    const operand = `${aliases}/alias/../sample/server.py`;
    const cfg = config(cacheHome, "plugin:sample:symlink-parent", {
      command: "python3",
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "symlink-parent",
        pluginRoot: root, snapshotRoot, snapshotLaunch: {
          command: "python3", args: [operand], cwd: snapshotRoot,
        } } },
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect(manager.getConnectionState(cfg.name)).toMatchObject({
        type: "failed", error: expect.stringContaining("launch references its mutable installation"),
      });
      await manager.stop();
      await writeFile(installedEntry, "changed installed bytes");
      await manager.start();
      expect(manager.getConnectionState(cfg.name)).toMatchObject({
        type: "failed", error: expect.stringContaining("launch references its mutable installation"),
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally { await manager.stop(); }
  });

  it("skips stdio launch checks for remote plugin transports", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    const snapshotRoot = join(cacheHome, "snapshot");
    for (const transport of ["http", "sse", "websocket"] as const) {
      const cfg = config(cacheHome, `plugin:sample:${transport}`, {
        transport, endpoint: "https://example.test/mcp",
        origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: transport,
          pluginRoot: root, snapshotRoot } },
      });
      const manager = new MCPManager([cfg], undefined, { PATH: join(root, "bin") });
      const launchConfig = manager as unknown as { pluginLaunchConfig(config: MCPServerConfig): MCPServerConfig };
      expect(launchConfig.pluginLaunchConfig(cfg).transport).toBe(transport);
    }
  });

  it("still launches an ordinary server with the system node", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    const manager = new MCPManager([{ name: "ordinary", command: process.execPath }], undefined,
      { PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin"}` });
    try {
      await manager.start({ requireOneReady: true });
      expect(spawn.mock.calls[0]?.[0].command).toBe(process.execPath);
    } finally { await manager.stop(); }
  });

  it("uses the snapshot launch fields again on automatic reconnect", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "installed");
    const snapshotRoot = join(cacheHome, "snapshot");
    const cfg = config(cacheHome, "plugin:sample:auto-reconnect-snapshot", {
      command: "node", args: [join(root, "server.mjs")], cwd: root,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "auto-reconnect-snapshot",
        pluginRoot: root, snapshotRoot, snapshotLaunch: { command: "node", args: [join(snapshotRoot, "server.mjs")], cwd: snapshotRoot },
      } },
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start({ requireOneReady: true });
      vi.useFakeTimers();
      const bridge = (manager as unknown as { bridges: Map<string, { notifyTransportClosed(): void }> }).bridges.get(cfg.name)!;
      bridge.notifyTransportClosed();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawn.mock.calls.map(call => call[0].args)).toEqual([
        [join(snapshotRoot, "server.mjs")], [join(snapshotRoot, "server.mjs")],
      ]);
    } finally { await manager.stop(); vi.useRealTimers(); }
  });

  it("separates trees whose raw concatenations collide", async () => {
    const root = await home(); const single = join(root, "single"); const split = join(root, "split");
    await mkdir(single); await mkdir(split);
    await writeFile(join(single, "a"), "A./b\0file\0B");
    await writeFile(join(split, "a"), "A"); await writeFile(join(split, "b"), "B");
    await writeFile(join(single, "plugin.json"), "{}");
    await writeFile(join(split, "plugin.json"), "{}");
    expect(hashInstalledPlugin(single)).not.toBe(hashInstalledPlugin(split));
  });

  it("rejects a snapshot with a link to mutable bytes outside the install", async () => {
    const cacheHome = await home(); const root = join(cacheHome, "plugin");
    await mkdir(root); await writeFile(join(cacheHome, "outside.js"), "mutable");
    await symlink(join(cacheHome, "outside.js"), join(root, "entry.js"));
    expect(() => snapshotInstalledPlugin(root, cacheHome, hashInstalledPlugin(root)))
      .toThrow(/symbolic link/);
  });

  it("revokes retained cached proxies and resource access when disabled", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const retained = manager.getToolsByServer(cfg.name)[0]!;
      await manager.refreshServers([{ ...cfg, enabled: false }]);
      expect((await retained.execute({})).isError).toBe(true);
      expect(await manager.readResource(`mcp.${cfg.name}.fixture://item`)).toBeNull();
      expect(spawn).toHaveBeenCalledTimes(0);
    } finally { await manager.stop(); }
  });

  it("retains failed idle disposal without an unhandled rejection", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start(); await manager.callTool(cfg.name, "ping", {});
      clients[0]!.close.mockRejectedValueOnce(new Error("close failed"));
      await waitFor(() => clients[0]!.close.mock.calls.length > 0);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("failed");
    } finally { await manager.stop(); }
  });

  it("does not publish a connection after resource discovery outlives startup timeout", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:discovery", { timeout: 20 }); warm(cfg);
    const resources = deferred<{ resources: readonly Record<string, unknown>[] }>();
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      const client = await original(...args);
      (client as never as { listResources: ReturnType<typeof vi.fn> }).listResources.mockImplementation(() => resources.promise);
      return client;
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const result = await manager.callTool(cfg.name, "ping", {});
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(manager.getConnectionState(cfg.name)?.type).toBe("failed");
      expect(manager.getConnectedServers()).toHaveLength(0);
      resources.resolve({ resources: [] });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(manager.getConnectionState(cfg.name)?.type).not.toBe("connected");
      expect(manager.getConnectedServers()).toHaveLength(0);
      expect(clients[0]!.close).toHaveBeenCalled();
    } finally { resources.resolve({ resources: [] }); await manager.stop(); }
  });

  it("does not spawn a second generation while timed-out discovery still owns its process", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:held-discovery", { timeout: 20 }); warm(cfg);
    const resources = deferred<{ resources: readonly Record<string, unknown>[] }>();
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      const client = await original(...args);
      if (clients.length === 1) (client as never as { listResources: ReturnType<typeof vi.fn> }).listResources.mockImplementation(() => resources.promise);
      return client;
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect((await manager.callTool(cfg.name, "ping", {})).isError).toBe(true);
      const next = manager.callTool(cfg.name, "ping", {});
      let settled = false;
      void next.then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
      resources.resolve({ resources: [] });
      await next;
      expect(clients[0]!.close).toHaveBeenCalled();
    } finally { resources.resolve({ resources: [] }); await manager.stop(); }
  });

  it("keeps catalogs separate for resolved environment variants", async () => {
    const cacheHome = await home();
    const firstCfg = config(cacheHome, "plugin:sample:env", { env: { MODE: "first" } });
    const secondCfg = config(cacheHome, "plugin:sample:env", { env: { MODE: "second" } });
    spawn.mockImplementation(async (server) => {
      const name = server.env?.MODE ?? "missing";
      const client = { listTools: vi.fn().mockResolvedValue({ tools: [descriptor(name)] }), callTool: vi.fn().mockResolvedValue({ content: [] }), close: vi.fn().mockResolvedValue(undefined) };
      clients.push(client); return client as never;
    });
    const first = new MCPManager([firstCfg]); const second = new MCPManager([secondCfg]);
    try {
      await first.start(); await first.primeCatalogs();
      await second.start(); await second.primeCatalogs();
      expect(second.getToolsByServer(secondCfg.name)[0]?.name).toContain("second");
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await Promise.all([first.stop(), second.stop()]); }
  });

  it("keeps catalogs separate for user configuration variants", async () => {
    const cacheHome = await home(); const base = config(cacheHome, "plugin:sample:user-config");
    const firstCfg = config(cacheHome, base.name, { origin: { scope: "plugin", pluginServer: { ...base.origin!.pluginServer!, userConfigDigest: "first" } } });
    const secondCfg = config(cacheHome, base.name, { origin: { scope: "plugin", pluginServer: { ...base.origin!.pluginServer!, userConfigDigest: "second" } } });
    setupTransport([descriptor("first")]);
    const first = new MCPManager([firstCfg]); const second = new MCPManager([secondCfg]);
    try {
      await first.start(); await first.primeCatalogs();
      setupTransport([descriptor("second")]);
      await second.start(); await second.primeCatalogs();
      expect(second.getToolsByServer(base.name)[0]?.name).toContain("second");
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await Promise.all([first.stop(), second.stop()]); }
  });

  it("bounds a budget eviction wait by the caller startup timeout", async () => {
    const cacheHome = await home();
    const firstCfg = config(cacheHome, "plugin:sample:budget-a", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "budget-a", digest: "a".repeat(64), maxProcesses: 1 } } });
    const nextCfg = config(cacheHome, "plugin:sample:budget-b", { timeout: 20, origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "budget-b", digest: "a".repeat(64), maxProcesses: 1 } } });
    warm(firstCfg); warm(nextCfg);
    const manager = new MCPManager([firstCfg, nextCfg]); const close = deferred();
    try {
      await manager.start(); await manager.callTool(firstCfg.name, "ping", {});
      clients[0]!.close.mockImplementation(() => close.promise);
      const result = await Promise.race([
        manager.callTool(nextCfg.name, "ping", {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("budget wait exceeded timeout")), 80)),
      ]);
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { close.resolve(); await manager.stop(); }
  });

  it("bounds a new startup after the only owner's eviction leaves cleanup unproven", async () => {
    const cacheHome = await home();
    const a = config(cacheHome, "plugin:sample:failed-eviction-a", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "failed-eviction-a", digest: "a".repeat(64), maxProcesses: 1, idleTimeoutMs: 10_000 } } });
    const b = config(cacheHome, "plugin:sample:failed-eviction-b", { timeout: 25, origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "failed-eviction-b", digest: "a".repeat(64), maxProcesses: 1, idleTimeoutMs: 10_000 } } });
    warm(a); warm(b);
    const manager = new MCPManager([a, b]);
    const lifecycle = manager as never as { evictPlugin: (name: string) => Promise<void> };
    const originalEvict = lifecycle.evictPlugin.bind(manager);
    let attempts = 0;
    const guard = vi.spyOn(lifecycle, "evictPlugin").mockImplementation((name: string) => {
      if (++attempts > 8) throw new Error("budget retried an unreleasable slot");
      return originalEvict(name);
    });
    try {
      await manager.start();
      await manager.callTool(a.name, "ping", {});
      clients[0]!.close.mockRejectedValue(new Error("disposal failed"));
      await expect(lifecycle.evictPlugin(a.name)).rejects.toThrow(/connection cleanup failed/);
      await expect(lifecycle.evictPlugin(a.name)).rejects.toThrow(/connection cleanup failed/);
      attempts = 0;
      let timerFired = false;
      const timer = new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 60));
      const result = await manager.callTool(b.name, "ping", {});
      await timer;
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(timerFired).toBe(true);
      expect(attempts).toBeLessThanOrEqual(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      guard.mockRestore();
      clients[0]?.close.mockResolvedValue(undefined);
      await manager.stop();
    }
  });

  it("reserves the budget and schedules idle cleanup on explicit reconnect", async () => {
    const cacheHome = await home();
    const configs = ["reconnect-a", "reconnect-b"].map(name => config(cacheHome, `plugin:sample:${name}`, { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name, digest: "a".repeat(64), maxProcesses: 1, idleTimeoutMs: 20 } } }));
    configs.forEach(cfg => warm(cfg));
    const manager = new MCPManager(configs);
    try {
      await manager.start(); await manager.callTool(configs[0]!.name, "ping", {});
      expect((await manager.reconnectServer(configs[1]!.name)).success).toBe(true);
      expect(clients[0]!.close).toHaveBeenCalled();
      await waitFor(() => manager.getConnectionState(configs[1]!.name)?.type === "stopped");
    } finally { await manager.stop(); }
  });

  it("schedules idle cleanup when live discovery drops the requested cached tool", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg, [descriptor("old")]);
    setupTransport([descriptor("new")]);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect((await manager.callTool(cfg.name, "old", {})).isError).toBe(true);
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
    } finally { await manager.stop(); }
  });
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

  it("shares a failed startup across concurrent first calls", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:failed-flight", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "failed-flight", digest: "a".repeat(64), idleTimeoutMs: 10_000 } } }); warm(cfg);
    const discovery = deferred<{ tools: ReturnType<typeof descriptor>[] }>();
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      const client = await original(...args);
      (client as never as { listTools: ReturnType<typeof vi.fn> }).listTools.mockImplementation(() => discovery.promise);
      return client;
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const calls = Array.from({ length: 5 }, () => manager.callTool(cfg.name, "ping", {}));
      await waitFor(() => spawn.mock.calls.length === 1);
      discovery.reject(new Error("catalog discovery failed"));
      const results = await Promise.all(calls);
      expect(results.every(result => result.metadata?.errorCode === "MCP_PLUGIN_STARTUP_FAILED")).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(clients[0]!.close).toHaveBeenCalledTimes(1);
    } finally { discovery.reject(new Error("test cleanup")); await manager.stop(); }
  });

  it("keeps a shared startup alive when one caller cancels its wait", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:cancelled-joiner", { origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "cancelled-joiner", digest: "a".repeat(64), idleTimeoutMs: 10_000 } } }); warm(cfg);
    const discovery = deferred<{ tools: ReturnType<typeof descriptor>[] }>();
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      const client = await original(...args);
      (client as never as { listTools: ReturnType<typeof vi.fn> }).listTools.mockImplementation(() => discovery.promise);
      return client;
    });
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      const controller = new AbortController();
      const cancelled = manager.callTool(cfg.name, "ping", {}, { signal: controller.signal });
      const joined = manager.callTool(cfg.name, "ping", {});
      await waitFor(() => spawn.mock.calls.length === 1);
      controller.abort(new Error("caller left"));
      expect((await cancelled).isError).toBe(true);
      discovery.resolve({ tools: [descriptor()] });
      expect((await joined).isError).not.toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getConnectionState(cfg.name)?.type).toBe("connected");
    } finally { discovery.resolve({ tools: [descriptor()] }); await manager.stop(); }
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
    await waitFor(() => first.getConnectionState(cfg.name)?.type === "stopped");
    expect(readPluginCatalog({ pluginName: "sample", serverName: cfg.name, version: "1", digest: "a".repeat(64), cacheHome, configFingerprint: fingerprintPluginCatalogConfig({ transport: cfg.transport ?? "stdio", command: cfg.command, args: cfg.args, env: cfg.env, env_vars: cfg.env_vars, cwd: cfg.cwd, endpoint: cfg.endpoint, headers: cfg.headers, pluginSandbox: cfg.pluginSandbox, userConfigDigest: cfg.origin?.pluginServer?.userConfigDigest, parentEnvironment: {} }) })?.tools).toMatchObject([descriptor()]);
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
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
      expect(await manager.getResourcesByServer(cfg.name)).toHaveLength(1);
      expect(await manager.listPromptsByServer(cfg.name)).toHaveLength(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      const resources = await manager.getResourcesByServer(cfg.name);
      await manager.readResource(resources[0]!.namespacedName);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it("fills the catalog cache from every tools and prompts page", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:pages");
    spawn.mockImplementation(async () => ({
      getServerCapabilities: () => ({ prompts: {} }),
      listTools: vi.fn(async (params?: { cursor?: string }) => {
        const page = Number(params?.cursor ?? 0);
        return { tools: [descriptor(`tool${page}`)], ...(page < 2 ? { nextCursor: String(page + 1) } : {}) };
      }),
      listPrompts: vi.fn(async (params?: { cursor?: string }) => {
        const page = Number(params?.cursor ?? 0);
        return { prompts: [{ name: `prompt${page}` }], ...(page < 1 ? { nextCursor: String(page + 1) } : {}) };
      }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] }),
      close: vi.fn().mockResolvedValue(undefined),
    }) as never);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.primeCatalogs();
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
      const names = ["tool0", "tool1", "tool2"];
      expect(manager.getToolsByServer(cfg.name).map(tool => tool.name)).toEqual(names.map(name => `mcp.${cfg.name}.${name}`));
      expect((await manager.listPromptsByServer(cfg.name)).map(prompt => prompt.name)).toEqual(["prompt0", "prompt1"]);
      const persisted = readPluginCatalog(catalogIdentity(cfg));
      expect(persisted?.tools.map(tool => tool.name)).toEqual(names);
      expect(persisted?.prompts).toHaveLength(2);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await manager.stop(); }
  });

  it("keeps the cached prompts when a later prompt listing fails", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome, "plugin:sample:prompts");
    const hello = { serverName: cfg.name, name: "hello", namespacedName: `mcp.${cfg.name}.hello`, description: "hello" };
    warm(cfg, [descriptor()], { prompts: [hello] });
    spawn.mockImplementation(async () => ({
      getServerCapabilities: () => ({ prompts: {} }),
      listTools: vi.fn().mockResolvedValue({ tools: [descriptor()] }),
      // A repeated cursor fails the whole listing.
      listPrompts: vi.fn().mockResolvedValue({ prompts: [{ name: "hello" }], nextCursor: "again" }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] }),
      close: vi.fn().mockResolvedValue(undefined),
    }) as never);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect(await manager.listPromptsByServer(cfg.name)).toMatchObject([{ name: "hello" }]);
      expect((await manager.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
      expect(await manager.listPromptsByServer(cfg.name)).toMatchObject([{ name: "hello" }]);
      expect(readPluginCatalog(catalogIdentity(cfg))?.prompts).toMatchObject([{ name: "hello" }]);
    } finally { await manager.stop(); }
  });

  it("keeps a discovered catalog that echoes a saved secret out of the disk cache", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome, "plugin:sample:echo", { pluginSecretValues: ["echo-private-phrase"] });
    setupTransport([{ ...descriptor(), description: "Uses echo-private-phrase" }]);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await manager.primeCatalogs();
      await waitFor(() => manager.getConnectionState(cfg.name)?.type === "stopped");
      expect(manager.getToolsByServer(cfg.name).map(tool => tool.name)).toEqual([`mcp.${cfg.name}.ping`]);
      expect(JSON.stringify(manager.getToolsByServer(cfg.name))).not.toContain("echo-private-phrase");
      expect(readPluginCatalog(catalogIdentity(cfg))).toBeUndefined();
      expect(await catalogText(cacheHome)).not.toContain("echo-private-phrase");
    } finally { await manager.stop(); }
  });

  it("gives a session that joins another's discovery the catalog kept out of the disk cache", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome, "plugin:sample:joined", { pluginSecretValues: ["joined-private-phrase"] });
    setupTransport([{ ...descriptor(), description: "Uses joined-private-phrase" }]);
    const a = new MCPManager([cfg]); const b = new MCPManager([cfg]);
    try {
      await Promise.all([a.start(), b.start()]);
      await Promise.all([a.primeCatalogs(), b.primeCatalogs()]);
      await waitFor(() => a.getConnectionState(cfg.name)?.type === "stopped");
      expect(spawn).toHaveBeenCalledTimes(1);
      for (const manager of [a, b]) {
        expect(manager.getToolsByServer(cfg.name).map(tool => tool.name)).toEqual([`mcp.${cfg.name}.ping`]);
        expect(JSON.stringify(manager.getToolsByServer(cfg.name))).not.toContain("joined-private-phrase");
      }
      expect(readPluginCatalog(catalogIdentity(cfg))).toBeUndefined();
      expect(await catalogText(cacheHome)).not.toContain("joined-private-phrase");
    } finally { await Promise.all([a.stop(), b.stop()]); }
  });

  it("removes the older disk catalog when a newer one carries a saved secret", async () => {
    const cacheHome = await home();
    const cfg = config(cacheHome, "plugin:sample:grown", { pluginSecretValues: ["grown-private-phrase"] });
    warm(cfg, [descriptor("ping")]);
    setupTransport([descriptor("ping"), { ...descriptor("added"), description: "Uses grown-private-phrase" }]);
    const first = new MCPManager([cfg]);
    try {
      await first.start();
      expect((await first.callTool(cfg.name, "ping", {})).isError).not.toBe(true);
      expect(readPluginCatalog(catalogIdentity(cfg))).toBeUndefined();
    } finally { await first.stop(); }
    const next = new MCPManager([cfg]);
    try {
      await next.start();
      expect(next.getToolsByServer(cfg.name)).toEqual([]);
      await next.primeCatalogs();
      expect(next.getToolsByServer(cfg.name).map(tool => tool.name))
        .toEqual([`mcp.${cfg.name}.ping`, `mcp.${cfg.name}.added`]);
      expect(await catalogText(cacheHome)).not.toContain("grown-private-phrase");
    } finally { await next.stop(); }
  });

  it("removes catalogs of the earlier flat layout when a session starts", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const flat = join(cacheHome, "cache", "plugin-mcp-catalogs", `${"f".repeat(64)}.json`);
    await writeFile(flat, JSON.stringify({ format: 1, tools: [{ ...descriptor(), description: "Uses flat-private-phrase" }] }));
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      await expect(stat(flat)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await catalogText(cacheHome)).not.toContain("flat-private-phrase");
      expect(manager.getToolsByServer(cfg.name)).toHaveLength(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally { await manager.stop(); }
  });

  it.skipIf(process.platform === "win32")("starts when a flat-layout catalog cannot be removed", async () => {
    const cacheHome = await home(); const cfg = config(cacheHome); warm(cfg);
    const root = join(cacheHome, "cache", "plugin-mcp-catalogs");
    await writeFile(join(root, `${"f".repeat(64)}.json`), "{}");
    await chmod(root, 0o500);
    const manager = new MCPManager([cfg]);
    try {
      await manager.start();
      expect(manager.getToolsByServer(cfg.name)).toHaveLength(1);
    } finally { await manager.stop(); await chmod(root, 0o700); }
  });

  it("redacts every plugin's saved values from a lazy startup failure", async () => {
    const cacheHome = await home();
    const alpha = config(cacheHome, "plugin:sample:alpha", { pluginSecretValues: ["alpha-private-phrase"] }); warm(alpha);
    const beta = config(cacheHome, "plugin:sample:beta", { pluginSecretValues: ["beta-private-phrase"] });
    spawn.mockRejectedValue(new Error("spawn failed: alpha-private-phrase beta-private-phrase"));
    const manager = new MCPManager([alpha, beta]);
    try {
      await manager.start();
      const result = await manager.callTool(alpha.name, "ping", {});
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(String(result.content)).toContain("spawn failed");
      for (const secret of ["alpha-private-phrase", "beta-private-phrase"]) {
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(manager.getConnectionState(alpha.name))).not.toContain(secret);
      }
    } finally { await manager.stop(); }
  });

  it.each(["readResource", "renderPrompt"] as const)("redacts every plugin's saved values from a lazy startup failure in %s", async operation => {
    const cacheHome = await home();
    const alpha = config(cacheHome, "plugin:sample:alpha", { pluginSecretValues: ["alpha-private-phrase"] }); warm(alpha);
    const beta = config(cacheHome, "plugin:sample:beta", { pluginSecretValues: ["beta-private-phrase"] });
    spawn.mockRejectedValue(new Error("spawn failed: alpha-private-phrase beta-private-phrase"));
    const manager = new MCPManager([alpha, beta]);
    try {
      await manager.start();
      const request = operation === "readResource"
        ? manager.readResource(`mcp.${alpha.name}.fixture://item`)
        : manager.renderPrompt(`mcp.${alpha.name}.hello`);
      const message = await request.then(() => "resolved", (error: unknown) => String((error as Error).message));
      expect(message).toContain("spawn failed");
      for (const secret of ["alpha-private-phrase", "beta-private-phrase"]) expect(message).not.toContain(secret);
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
    expect(registrations[0]?.snapshotRoot).toContain(join(root, "storage", "cache", "mcp-install-snapshots"));
    expect(hashInstalledPlugin(registrations[0]!.snapshotRoot)).toBe(registrations[0]!.digest);
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

  it("retries budget eviction after a listing finishes during the queued eviction", async () => {
    const cacheHome = await home();
    const [a, b] = ["listing-a", "listing-b"].map(name => config(cacheHome, `plugin:sample:${name}`, {
      timeout: 300,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name,
        digest: "a".repeat(64), idleTimeoutMs: 10_000, maxProcesses: 1 } },
    }));
    warm(a!); warm(b!);
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const manager = new MCPManager([a!, b!]);
    const evictionRequested = deferred();
    const listingStarted = deferred();
    const listing = deferred<{ resources: readonly Record<string, unknown>[] }>();
    const lifecycle = manager as never as { evictPlugin: (...args: unknown[]) => Promise<"busy" | void> };
    const originalEvict = lifecycle.evictPlugin.bind(manager);
    const guard = vi.spyOn(lifecycle, "evictPlugin").mockImplementation(async (...args) => {
      // The budget chose idle A. Hold its real queued transition until A's
      // live listing starts, then finish that listing before the waiter resumes.
      evictionRequested.resolve();
      await listingStarted.promise;
      const result = await originalEvict(...args);
      listing.resolve({ resources: [] });
      await listed;
      return result;
    });
    let listed: Promise<ReadonlyArray<unknown>> = Promise.resolve([]);
    try {
      await manager.start();
      expect((await manager.callTool(a!.name, "ping", {})).isError).not.toBe(true);
      clients[0]!.listResources.mockImplementation(() => {
        listingStarted.resolve();
        return listing.promise;
      });
      const next = manager.callTool(b!.name, "ping", {});
      await evictionRequested.promise;
      listed = manager.getResourcesByServer(a!.name);
      const result = await next;
      expect(result.isError).not.toBe(true);
      expect(clients[0]!.close).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.getConnectionState(a!.name)?.type).toBe("stopped");
    } finally {
      listing.resolve({ resources: [] });
      await listed;
      guard.mockRestore();
      await manager.stop();
    }
  });

  it.each([2, 3])("retries budget eviction after %i successive listing overlaps", async overlaps => {
    const cacheHome = await home();
    const [a, b] = ["overlap-a", "overlap-b"].map(name => config(cacheHome, `plugin:sample:${name}`, {
      timeout: 600,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name,
        digest: "a".repeat(64), idleTimeoutMs: 10_000, maxProcesses: 1 } },
    }));
    warm(a!); warm(b!);
    setupTransport([descriptor()], { capabilities: { resources: {} } });
    const manager = new MCPManager([a!, b!]);
    const requested = Array.from({ length: overlaps }, () => deferred());
    const started = Array.from({ length: overlaps }, () => deferred());
    const listings = Array.from({ length: overlaps }, () => deferred<{ resources: readonly Record<string, unknown>[] }>());
    const listed: Array<Promise<ReadonlyArray<unknown>>> = [];
    const lifecycle = manager as never as { evictPlugin: (...args: unknown[]) => Promise<"busy" | void> };
    const originalEvict = lifecycle.evictPlugin.bind(manager);
    let attempts = 0;
    const guard = vi.spyOn(lifecycle, "evictPlugin").mockImplementation(async (...args) => {
      const index = attempts++;
      if (index >= overlaps) return originalEvict(...args);
      requested[index]!.resolve();
      await started[index]!.promise;
      const result = await originalEvict(...args);
      expect(result).toBe("busy");
      listings[index]!.resolve({ resources: [] });
      await listed[index];
      return result;
    });
    try {
      await manager.start();
      expect((await manager.callTool(a!.name, "ping", {})).isError).not.toBe(true);
      let listingIndex = 0;
      clients[0]!.listResources.mockImplementation(() => {
        const index = listingIndex++;
        started[index]!.resolve();
        return listings[index]!.promise;
      });
      const next = manager.callTool(b!.name, "ping", {});
      for (let index = 0; index < overlaps; index++) {
        await Promise.race([
          requested[index]!.promise,
          next.then(() => { throw new Error(`B settled before eviction attempt ${index + 1}`); }),
        ]);
        listed[index] = manager.getResourcesByServer(a!.name);
        await started[index]!.promise;
      }
      const result = await next;
      expect(result.isError).not.toBe(true);
      expect(attempts).toBe(overlaps + 1);
      expect(clients[0]!.close).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.getConnectionState(a!.name)?.type).toBe("stopped");
    } finally {
      for (const listing of listings) listing.resolve({ resources: [] });
      await Promise.allSettled(listed);
      guard.mockRestore();
      await manager.stop();
    }
  });

  it("ends a budget wait promptly after a permanent eviction refusal", async () => {
    const cacheHome = await home();
    const [a, b] = ["refusal-a", "refusal-b"].map(name => config(cacheHome, `plugin:sample:${name}`, {
      timeout: 500,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: name,
        digest: "a".repeat(64), idleTimeoutMs: 10_000, maxProcesses: 1 } },
    }));
    warm(a!); warm(b!);
    const manager = new MCPManager([a!, b!]);
    const lifecycle = manager as never as { evictPlugin: (...args: unknown[]) => Promise<"busy" | void> };
    const guard = vi.spyOn(lifecycle, "evictPlugin").mockResolvedValue(undefined);
    try {
      await manager.start();
      expect((await manager.callTool(a!.name, "ping", {})).isError).not.toBe(true);
      const result = await Promise.race([
        manager.callTool(b!.name, "ping", {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("permanent refusal did not end promptly")), 100)),
      ]);
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(guard).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      guard.mockRestore();
      await manager.stop();
    }
  });

  it("ends a budget wait promptly when the only process is pinned", async () => {
    const cacheHome = await home();
    const a = config(cacheHome, "plugin:sample:pinned-budget-a", {
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "pinned-budget-a",
        digest: "a".repeat(64), eager: true, maxProcesses: 1 } },
    });
    const b = config(cacheHome, "plugin:sample:pinned-budget-b", {
      timeout: 500,
      origin: { scope: "plugin", pluginServer: { pluginName: "sample", serverName: "pinned-budget-b",
        digest: "a".repeat(64), maxProcesses: 1 } },
    });
    warm(a); warm(b);
    const manager = new MCPManager([a, b]);
    try {
      await manager.start();
      const result = await Promise.race([
        manager.callTool(b.name, "ping", {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pinned budget wait did not end promptly")), 100)),
      ]);
      expect(result.metadata?.errorCode).toBe("MCP_PLUGIN_STARTUP_FAILED");
      expect(manager.getConnectionState(a.name)?.type).toBe("connected");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await manager.stop(); }
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
