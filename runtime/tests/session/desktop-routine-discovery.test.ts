import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCPManager } from "../../src/mcp-client/manager.js";
import { verifyDesktopAuthority } from "../../src/mcp-client/desktop-authority.js";
import { withLocalMcpAccess } from "../../src/mcp-client/local-control.js";
import type { MCPServerConfig } from "../../src/mcp-client/types.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { builtTools } from "../../src/session/run-turn-sampling-request.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";

vi.mock("../../src/mcp-client/connection.js", () => ({ createMCPConnection: vi.fn() }));
vi.mock("../../src/mcp-client/resources.js", () => ({ createResourceBridge: vi.fn(async (_client, serverName) => ({ serverName, listResources: async () => [], dispose: async () => {} })) }));
vi.mock("../../src/mcp-client/prompts.js", () => ({ createPromptBridge: vi.fn(async (_client, serverName) => ({ serverName, listPrompts: async () => [], dispose: async () => {} })) }));
import { createMCPConnection } from "../../src/mcp-client/connection.js";

const roots: string[] = [];
const sockets: Server[] = [];
const managers: MCPManager[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map(manager => manager.stop()));
  await Promise.all(sockets.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

const nativeNames = [
  "desktop_state", "desktop_window_state", "desktop_settings_open", "desktop_settings_update", "desktop_window",
  "desktop_session_open", "desktop_session_update", "desktop_project_select", "browser_tabs", "browser_snapshot",
  "browser_read_text", "browser_screenshot", "browser_wait_for", "browser_downloads", "browser_console",
  "browser_open_tab", "browser_select_tab", "browser_close_tab", "browser_navigate", "browser_click", "browser_type",
  "browser_press_key", "browser_scroll", "browser_back", "browser_forward", "browser_reload", "browser_evaluate",
  "terminal_list", "terminal_read", "terminal_open", "terminal_run", "terminal_type", "terminal_close",
  "desktop_routine_list", "desktop_routine_get", "desktop_routine_runs", "desktop_routines_open",
  "desktop_routine_create", "desktop_routine_update", "desktop_routine_delete", "desktop_routine_run", "desktop_routine_cancel",
];
const qualified = (name: string) => `mcp.agenc-desktop-control.${name}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-routine-discovery-")); roots.push(root); await chmod(root, 0o700);
  const authorities = join(root, "desktop-control-authorities"); await mkdir(authorities, { mode: 0o700 });
  const socketRoot = await mkdtemp(join(await realpath("/tmp"), "agenc-dc-")); roots.push(socketRoot); await chmod(socketRoot, 0o700);
  const socketPath = join(socketRoot, "control.sock");
  const socket = createServer(); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(socketPath, resolve); }); await chmod(socketPath, 0o600);
  const keys = generateKeyPairSync("ed25519"); const id = randomUUID();
  const config = { name: "agenc-desktop-control", transport: "http" as const, endpoint: "http://127.0.0.1:43119/mcp", localOnly: true, headers: { Authorization: `Bearer ${"f".repeat(48)}` }, origin: { scope: "session" as const } };
  const material = JSON.stringify([2, config.name, config.endpoint, createHash("sha256").update(config.headers.Authorization).digest("hex"), 1, socketPath]);
  const proof = { id, signature: sign(null, Buffer.from(material), keys.privateKey).toString("base64") };
  const expiresAt = Date.now() + 600_000;
  await writeFile(join(authorities, `${id}.json`), JSON.stringify({ version: 2, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }), expiresAt, socketPath }), { mode: 0o600 });
  const signed = { ...config, desktopAuthority: proof };
  const grant = await verifyDesktopAuthority(signed, root);
  return { root, expiresAt, config: { ...signed, desktopAuthorityGrant: grant } };
}

async function start(config: MCPServerConfig) {
  vi.mocked(createMCPConnection).mockResolvedValue({
    listTools: async () => ({ tools: [...nativeNames, "desktop_routine_destroy"].map(name => ({ name, description: `Native ${name}`, inputSchema: { type: "object", properties: {} } })) }),
    callTool: async () => ({ content: [] }), getInstructions: () => "Host-specific instructions.", close: async () => {},
  } as never);
  const manager = new MCPManager([config]); managers.push(manager); await manager.start();
  expect(manager.isConnected(config.name)).toBe(true);
  return manager;
}

function sessionFor(manager: MCPManager, root: string) {
  const registry = buildToolRegistry({ workspaceRoot: root, agencHome: root, mcpToolsProvider: manager });
  return { services: { registry, mcpManager: manager } } as unknown as Session;
}

describe("authenticated Desktop Routine model discovery", () => {
  it("lists the complete known catalog beyond 32 tools and distinguishes Routines from Cron", async () => {
    const f = await fixture(); const manager = await start(f.config);
    expect(nativeNames.length).toBeGreaterThan(32);
    expect(manager.getAuthenticatedDesktopToolNames()).toEqual([]);
    expect(manager.getServerInstructions(f.config.name)).toBeUndefined();
    await withLocalMcpAccess(true, async () => {
      expect(manager.getAuthenticatedDesktopToolNames()).toEqual(nativeNames.map(qualified));
      const instructions = manager.getServerInstructions(f.config.name)!;
      expect(instructions).toContain(qualified("desktop_routine_cancel"));
      expect(instructions).toContain("separate conversation scheduler, not a substitute for Desktop Routines");
      expect(instructions).toContain("read-only/plan mode");
      expect(instructions).not.toContain("desktop_routine_destroy");
    });
    await manager.stop();
    await withLocalMcpAccess(true, async () => expect(manager.getAuthenticatedDesktopToolNames()).toEqual([]));
  });

  it.each(["lmstudio", "openai-compatible"])("preserves only discovered authenticated native schemas for %s", async modelProviderId => {
    const f = await fixture(); const manager = await start(f.config); const session = sessionFor(manager, f.root);
    const ctx = { modelProviderId } as TurnContext;
    const desktopNames = () => builtTools(session, ctx).map(tool => tool.function.name).filter(name => name.startsWith("mcp."));
    await withLocalMcpAccess(true, async () => {
      expect(desktopNames()).toEqual([]);
      session.services.registry.discoverToolNames?.([qualified("desktop_routine_list"), qualified("desktop_routine_create"), qualified("desktop_routine_destroy")]);
      expect(desktopNames().sort()).toEqual([qualified("desktop_routine_create"), qualified("desktop_routine_list")]);
      expect(desktopNames()).not.toContain(qualified("desktop_routine_run"));
    });
    await withLocalMcpAccess(false, async () => expect(desktopNames()).toEqual([]));
    expect(desktopNames()).toEqual([]); // Captured discovery cannot survive its local turn.
    vi.useFakeTimers(); vi.setSystemTime(f.expiresAt + 1);
    await withLocalMcpAccess(true, async () => expect(desktopNames()).toEqual([]));
  });

  it.each(["unsigned", "forged", "global", "not-session"])("never gives %s MCP an exception from the reduced profile", async kind => {
    const f = await fixture();
    const config = kind === "unsigned" ? { ...f.config, desktopAuthorityGrant: undefined }
      : kind === "forged" ? { ...f.config, desktopAuthorityGrant: { ...f.config.desktopAuthorityGrant! } }
      : kind === "global" ? { ...f.config, localOnly: false }
      : { ...f.config, origin: { scope: "user" as const } };
    const manager = await start(config); const session = sessionFor(manager, f.root);
    await withLocalMcpAccess(true, async () => {
      session.services.registry.discoverToolNames?.([qualified("desktop_routine_create")]);
      expect(manager.getAuthenticatedDesktopToolNames()).toEqual([]);
      expect(builtTools(session, { modelProviderId: "openai-compatible" } as TurnContext).some(tool => tool.function.name === qualified("desktop_routine_create"))).toBe(false);
      // Ordinary cloud-provider discovery remains unchanged.
      expect(builtTools(session, { modelProviderId: "openai" } as TurnContext).some(tool => tool.function.name === qualified("desktop_routine_create"))).toBe(true);
    });
  });
});
