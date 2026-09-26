import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MCPManager } from "./manager.js";
import {
  fingerprintPluginCatalogConfig,
  readPluginCatalog,
  writePluginCatalog,
} from "./plugin-catalog-cache.js";
import type { MCPServerConfig } from "./types.js";
import { createToolBridge } from "./tools.js";

vi.mock("./connection.js", () => ({ createMCPConnection: vi.fn() }));
vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    createToolBridge: vi.fn(actual.createToolBridge),
  };
});

import { createMCPConnection } from "./connection.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const homes: string[] = [];

interface ListChangedHandlers {
  readonly onToolsListChanged: () => void;
  readonly onPromptsListChanged: () => void;
  readonly onResourcesListChanged: () => void;
}

function handlersFromConnect(): ListChangedHandlers {
  const handlers = mockCreateMCPConnection.mock.calls.at(-1)?.[6] as
    | ListChangedHandlers
    | undefined;
  if (handlers === undefined) {
    throw new Error("createMCPConnection was not given listChanged handlers");
  }
  return handlers;
}

function toolDescriptor(name: string): Record<string, unknown> {
  return {
    name,
    description: `Run ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}

function fakeClient(tools: Array<Record<string, unknown>>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn(async () => ({ tools })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    getServerCapabilities: () => ({}),
    getServerVersion: () => undefined,
    getInstructions: () => undefined,
  };
}

function pluginConfig(
  name: string,
  cacheHome: string | undefined,
  eager: boolean,
): MCPServerConfig {
  return {
    name,
    command: "fixture",
    transport: "stdio",
    ...(cacheHome !== undefined ? { pluginCatalogHome: cacheHome } : {}),
    origin: {
      scope: "plugin",
      pluginServer: {
        pluginName: "sample",
        serverName: name,
        version: "1",
        digest: "a".repeat(64),
        ...(eager ? { eager: true } : {}),
      },
    },
    pluginSecretValues: ["plugin-secret-value"],
  };
}

function catalogIdentity(config: MCPServerConfig) {
  const plugin = config.origin!.pluginServer!;
  return {
    pluginName: plugin.pluginName,
    serverName: plugin.serverName,
    version: plugin.version,
    digest: plugin.digest!,
    cacheHome: config.pluginCatalogHome!,
    configFingerprint: fingerprintPluginCatalogConfig({
      transport: config.transport ?? "stdio",
      command: config.command,
      args: config.args,
      env: config.env,
      env_vars: config.env_vars,
      cwd: config.cwd,
      endpoint: config.endpoint,
      headers: config.headers,
      pluginSandbox: config.pluginSandbox,
      userConfigDigest: plugin.userConfigDigest,
      parentEnvironment: {},
    }),
    ...(plugin.eager !== undefined ? { eager: plugin.eager } : {}),
  };
}

afterEach(async () => {
  mockCreateMCPConnection.mockReset();
  vi.mocked(createToolBridge).mockClear();
  for (const path of homes.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("plugin catalog refresh guards", () => {
  it("keeps revocation and the plugin wrapper after a tools refresh", async () => {
    const tools = [toolDescriptor("toolA")];
    const client = fakeClient(tools);
    mockCreateMCPConnection.mockResolvedValue(client as never);
    const manager = new MCPManager([
      pluginConfig("plug", undefined, true),
    ]);
    await manager.start();
    tools.splice(0, 1, toolDescriptor("toolB"));
    handlersFromConnect().onToolsListChanged();
    await vi.waitFor(() => {
      expect(manager.getTools().map((tool) => tool.name)).toEqual([
        "mcp.plug.toolB",
      ]);
    });
    const published = manager.getTools()[0]!;
    const refreshOptions = vi.mocked(createToolBridge).mock.calls.at(-1)?.[3] as {
      readonly revocationGuard?: () => boolean;
      readonly revocationSignal?: AbortSignal;
    };
    expect(refreshOptions.revocationGuard?.()).toBe(true);
    expect(refreshOptions.revocationSignal?.aborted).toBe(false);
    await manager.stop();
    expect(refreshOptions.revocationSignal?.aborted).toBe(true);
    expect(refreshOptions.revocationGuard?.()).toBe(false);
    await expect(published.execute({})).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("proxy configuration changed"),
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("updates a lazy plugin catalog and skips notification when it is unchanged", async () => {
    const cacheHome = await mkdtemp(join(tmpdir(), "agenc-lazy-refresh-"));
    homes.push(cacheHome);
    const config = pluginConfig("lazyplug", cacheHome, false);
    const tools = [toolDescriptor("toolA")];
    writePluginCatalog(catalogIdentity(config), { format: 1, tools });
    const client = fakeClient(tools);
    mockCreateMCPConnection.mockResolvedValue(client as never);
    const manager = new MCPManager([config]);
    const observations: string[][] = [];
    const unsubscribe = manager.subscribeSurfaceChanges(() => {
      observations.push(manager.getTools().map((tool) => tool.name));
    });
    try {
      await manager.start();
      expect(manager.getTools().map((tool) => tool.name)).toEqual([
        "mcp.lazyplug.toolA",
      ]);
      await manager.callTool("lazyplug", "toolA", {});
      const before = observations.length;
      const listsBefore = client.listTools.mock.calls.length;
      handlersFromConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(client.listTools.mock.calls.length).toBeGreaterThan(listsBefore);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(observations).toHaveLength(before);
      tools.splice(0, 1, toolDescriptor("toolB"));
      handlersFromConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(manager.getTools().map((tool) => tool.name)).toEqual([
          "mcp.lazyplug.toolB",
        ]);
      });
      expect(readPluginCatalog(catalogIdentity(config))?.tools).toEqual([
        toolDescriptor("toolB"),
      ]);
    } finally {
      unsubscribe();
      await manager.stop();
    }
  });
});
