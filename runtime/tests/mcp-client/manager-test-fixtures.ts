import { vi } from "vitest";
import type { MCPServerConfig } from "./types.js";

export function makeConfig(
  name: string,
  overrides?: Partial<MCPServerConfig>,
): MCPServerConfig {
  return { name, command: "npx", args: ["-y", `@test/${name}`], ...overrides };
}

export function makeMockBridge(serverName: string, toolNames: string[]) {
  return {
    serverName,
    tools: toolNames.map((n) => ({
      name: `mcp.${serverName}.${n}`,
      description: `Tool ${n}`,
      inputSchema: { type: "object" as const, properties: {} },
      execute: vi.fn().mockResolvedValue({ content: "ok" }),
    })),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function mutableCatalog<TItem, TProjected>(
  initial: TItem[],
  project: (item: TItem) => TProjected,
) {
  let current = initial;
  const snapshot = () => current.map(project);
  return {
    list: vi.fn().mockImplementation(async () => snapshot()),
    refresh: vi.fn().mockImplementation(async () => snapshot()),
    replace(next: TItem[]) {
      current = next;
    },
  };
}

export function makeMockResourceBridge(
  serverName: string,
  resources: Array<{ uri: string; name?: string }> = [],
) {
  const catalog = mutableCatalog(resources, (resource) => ({
    serverName,
    uri: resource.uri,
    namespacedName: `mcp.${serverName}.${resource.uri}`,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
  }));
  return {
    serverName,
    listResources: catalog.list,
    refreshResources: catalog.refresh,
    readResource: vi.fn().mockResolvedValue({
      uri: "",
      truncated: false,
      bytesReturned: 0,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    setResources: catalog.replace,
  };
}

export function installEmptyCompanionBridgeDefaults(
  resourceFactory: {
    mockImplementation: (
      impl: (client: unknown, serverName: string) => Promise<unknown>,
    ) => unknown;
  },
  promptFactory: {
    mockImplementation: (
      impl: (client: unknown, serverName: string) => Promise<unknown>,
    ) => unknown;
  },
): void {
  resourceFactory.mockImplementation((_client, serverName) =>
    Promise.resolve(makeMockResourceBridge(serverName)),
  );
  promptFactory.mockImplementation((_client, serverName) =>
    Promise.resolve(makeMockPromptBridge(serverName)),
  );
}

export function makeMockPromptBridge(
  serverName: string,
  prompts: Array<{ name: string }> = [],
) {
  const catalog = mutableCatalog(prompts, (prompt) => ({
    serverName,
    name: prompt.name,
    namespacedName: `mcp.${serverName}.${prompt.name}`,
  }));
  return {
    serverName,
    listPrompts: catalog.list,
    refreshPrompts: catalog.refresh,
    renderPrompt: vi.fn().mockResolvedValue({
      promptName: "",
      messages: [],
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    setPrompts: catalog.replace,
  };
}
