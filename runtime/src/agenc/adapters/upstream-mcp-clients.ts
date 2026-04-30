/**
 * Upstream `MCPServerConnection[]` adapter for the AgenC TUI.
 *
 * The upstream-derived `<PromptInput>` consumes an `MCPServerConnection[]`
 * for the MCP server-list display and tool-inspection surface.
 * AgenC's runtime owns this state inside `runtime/src/mcp-client/manager.ts`
 * but the bridge does not expose it — so the composer never knows which
 * servers are configured.
 *
 * Coverage today: name only, type=`pending` for every configured server.
 *
 * Why all pending: upstream `ConnectedMCPServer.client` is a live SDK
 * `Client` instance and several upstream consumers (e.g.
 * `useIdeAtMentioned` calls `client.setNotificationHandler`,
 * `slackChannelSuggestions` calls `client.callTool`) invoke methods on
 * it as soon as a server with a matching name is connected. AgenC's
 * `MCPManager` does not expose the underlying SDK `Client` publicly
 * today, so a stub `client` would crash those consumers.
 * Emitting `type: 'pending'` keeps the picker UI lit up with the real
 * server names without exposing a stub that breaks live code paths.
 *
 * When the runtime gains a real `MCPManager.getClient(name)` accessor,
 * upgrade the projection to emit `type: 'connected'` for live servers
 * with the real client and capabilities.
 *
 * @module
 */
import type { MCPServerConnection } from "../upstream/services/mcp/types.js";

/**
 * Minimal surface this adapter needs from `MCPManager`. Declared as a
 * structural interface so unit tests can hand in a fake without
 * pulling the whole class graph.
 */
export interface McpManagerLike {
  getConfiguredServers(): ReadonlyArray<{ readonly name: string }>;
  isConnected(name: string): boolean;
}

/**
 * Walk every configured server in the manager and project it to an
 * upstream `MCPServerConnection`. All entries are emitted as
 * `type: 'pending'` regardless of connection state — see the module
 * header for why.
 */
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
