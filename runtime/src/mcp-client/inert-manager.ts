import type { McpManager } from "../session/session.js";

export function createInertMcpManager(): McpManager {
  return Object.freeze({
    effectiveServers: async () => new Map(),
    toolPluginProvenance: async () => null,
    getTools: () => [],
    getToolsByServer: () => [],
    getConfiguredServers: () => [],
    getConnectedServers: () => [],
    isConnected: () => false,
  });
}
