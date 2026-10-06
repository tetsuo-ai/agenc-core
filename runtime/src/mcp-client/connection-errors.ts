import type { ToolResult } from "./_deps/tools-types.js";

const CONNECTION_ERROR_PATTERNS = [
  "not connected", "disconnected", "epipe", "channel closed", "process exited",
  "connection refused", "broken pipe", "transport closed", "client closed", "econnreset", "econnrefused",
];

export function isMcpConnectionError(message: string): boolean {
  const lower = message.toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some(pattern => lower.includes(pattern));
}

// The classification is bridge-private. It never joins a model-visible result.
const connectionFailureByResult = new WeakMap<ToolResult, boolean>();
export function markMcpConnectionFailure(result: ToolResult, failed: boolean): void {
  connectionFailureByResult.set(result, failed);
}
export function mcpConnectionFailure(result: ToolResult): boolean | undefined {
  return connectionFailureByResult.get(result);
}
