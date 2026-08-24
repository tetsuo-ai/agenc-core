import type { MCPServerConnection } from "../services/mcp/types.js";
import { toScopedMcpServerConfig } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

export type McpConnectionProjection =
  | { readonly type: "connected" | "pending" | "disabled" | "needs-auth" }
  | { readonly type: "failed"; readonly error?: string };

export interface McpManagerLike {
  getConfiguredServers(): ReadonlyArray<MCPServerConfig>;
  isConnected(name: string): boolean;
  getConnectionState?(name: string): McpConnectionProjection | undefined;
  getConnectedConnection?(name: string): MCPServerConnection | undefined;
}

export function projectMcpManagerToConnections(
  manager: McpManagerLike,
): readonly MCPServerConnection[] {
  const result: MCPServerConnection[] = [];
  for (const config of manager.getConfiguredServers()) {
    const projectedConfig = toScopedMcpServerConfig(config);
    const state = manager.getConnectionState?.(config.name);
    if (state?.type === "failed") {
      result.push({
        type: "failed",
        name: config.name,
        config: projectedConfig,
        ...(state.error !== undefined ? { error: state.error } : {}),
      });
      continue;
    }
    if (state?.type === "needs-auth") {
      result.push({
        type: "needs-auth",
        name: config.name,
        config: projectedConfig,
      });
      continue;
    }
    if (state?.type === "disabled" || config.enabled === false) {
      result.push({
        type: "disabled",
        name: config.name,
        config: projectedConfig,
      });
      continue;
    }
    if (state?.type === "connected" || manager.isConnected(config.name)) {
      const connected = manager.getConnectedConnection?.(config.name);
      if (connected?.type === "connected") {
        result.push(connected);
        continue;
      }
    }
    result.push({
      type: "pending",
      name: config.name,
      config: projectedConfig,
    } as MCPServerConnection);
  }
  return result;
}
