import type { MCPServerConnection } from "../services/mcp/types.js";

export interface McpManagerLike {
  getConfiguredServers(): ReadonlyArray<{ readonly name: string }>;
  isConnected(name: string): boolean;
}

export function projectMcpManagerToConnections(
  manager: McpManagerLike,
): readonly MCPServerConnection[] {
  const result: MCPServerConnection[] = [];
  for (const config of manager.getConfiguredServers()) {
    result.push({
      type: "pending",
      name: config.name,
      config: config as never,
    } as MCPServerConnection);
  }
  return result;
}
