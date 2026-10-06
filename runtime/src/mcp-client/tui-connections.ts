import type { MCPServerConnection } from "../services/mcp/types.js";
import { toScopedMcpServerConfig } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

export type McpConnectionProjection =
  | { readonly type: "connected" | "pending" | "disabled" | "needs-auth" | "stopped" }
  | { readonly type: "failed"; readonly error?: string };

export interface McpManagerLike {
  getConfiguredServers(): ReadonlyArray<MCPServerConfig>;
  isConnected(name: string): boolean;
  getConnectionState?(name: string): McpConnectionProjection | undefined;
  getConnectedConnection?(name: string): MCPServerConnection | undefined;
}

export function projectMcpManagerToConnections(
  manager: McpManagerLike,
  redact?: (value: string) => string,
): readonly MCPServerConnection[] {
  const redactConfig = (config: ReturnType<typeof toScopedMcpServerConfig>) => {
    if (redact === undefined) return config;
    const safe: Record<string, unknown> = { ...config };
    for (const key of ['command', 'cwd', 'url', 'endpoint', 'headersHelper', 'authToken', 'instructions']) {
      if (typeof safe[key] === 'string') safe[key] = redact(safe[key]);
    }
    if (Array.isArray(safe.args)) safe.args = safe.args.map((arg: unknown) => typeof arg === 'string' ? redact(arg) : arg);
    for (const key of ['env', 'headers']) {
      const record = safe[key];
      if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
        safe[key] = Object.fromEntries(Object.entries(record).map(([name, value]) =>
          [name, typeof value === 'string' ? redact(value) : value],
        ));
      }
    }
    if (typeof safe.oauth === 'object' && safe.oauth !== null && !Array.isArray(safe.oauth)) {
      safe.oauth = Object.fromEntries(Object.entries(safe.oauth).map(([key, value]) =>
        [key, typeof value === 'string' ? redact(value) : value],
      ));
    }
    return safe as ReturnType<typeof toScopedMcpServerConfig>;
  };
  const result: MCPServerConnection[] = [];
  for (const config of manager.getConfiguredServers()) {
    const projectedConfig = redactConfig(toScopedMcpServerConfig(config));
    const state = manager.getConnectionState?.(config.name);
    if (state?.type === "failed") {
      result.push({
        type: "failed",
        name: config.name,
        config: projectedConfig,
        ...(state.error !== undefined ? { error: redact?.(state.error) ?? state.error } : {}),
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
    if (state?.type === "stopped") {
      result.push({ type: "stopped", name: config.name, config: projectedConfig });
      continue;
    }
    if (state?.type === "connected" || manager.isConnected(config.name)) {
      const connected = manager.getConnectedConnection?.(config.name);
      if (connected?.type === "connected") {
        result.push(redact === undefined ? connected : { ...connected, config: redactConfig(connected.config),
          ...(connected.instructions !== undefined ? { instructions: redact(connected.instructions) } : {}),
        });
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
