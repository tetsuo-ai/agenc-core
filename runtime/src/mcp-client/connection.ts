/**
 * MCP client connection management.
 *
 * Dispatches to the appropriate transport based on `config.transport`:
 *   - `"stdio"` (default): delegate to `./transports/stdio.ts`.
 *   - `"sse"`: delegate to `./transports/sse.ts`.
 *   - `"http"`: delegate to `./transports/http.ts` (Streamable HTTP).
 *   - `"websocket"` / `"ws"`: delegate to `./transports/websocket.ts`.
 *
 * @module
 */

import type { MCPElicitationHandlers, MCPServerConfig } from "./types.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { createStdioMCPConnection } from "./transports/stdio.js";
import { createSseMCPConnection } from "./transports/sse.js";
import { createHttpMCPConnection } from "./transports/http.js";
import { createWebSocketMCPConnection } from "./transports/websocket.js";
import type { McpSamplingHandlers } from "../services/mcp/hostCapabilities.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";

/**
 * Create an MCP client connection to an external server.
 *
 * For every transport, the call is delegated to the corresponding module
 * under `./transports/`.
 *
 * @returns MCP Client instance (typed as `any` to avoid ESM/CJS type conflicts)
 */
export async function createMCPConnection(
  config: MCPServerConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const transportKind = config.transport ?? "stdio";

  if (transportKind === "stdio") {
    if (!config.command || config.command.length === 0) {
      throw new Error(
        `MCP server "${config.name}" has transport="stdio" but no "command" was provided`,
      );
    }
    return createStdioMCPConnection(
      {
        name: config.name,
        command: config.command,
        ...(config.args !== undefined ? { args: config.args } : {}),
        ...(config.env !== undefined ? { env: config.env } : {}),
        ...(config.env_vars !== undefined ? { env_vars: config.env_vars } : {}),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      },
      logger,
      elicitationHandlers,
      samplingHandlers,
      sandboxExecutionBroker,
    );
  }

  if (
    transportKind === "sse" ||
    transportKind === "http" ||
    transportKind === "websocket" ||
    transportKind === "ws"
  ) {
    if (!config.endpoint || config.endpoint.length === 0) {
      throw new Error(
        `MCP server "${config.name}" has transport="${transportKind}" but no "endpoint" was provided`,
      );
    }
    const remoteConfig = {
      name: config.name,
      endpoint: config.endpoint,
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    };
    if (transportKind === "sse") {
      return createSseMCPConnection(
        remoteConfig,
        logger,
        elicitationHandlers,
        samplingHandlers,
      );
    }
    if (transportKind === "http") {
      return createHttpMCPConnection(
        remoteConfig,
        logger,
        elicitationHandlers,
        samplingHandlers,
      );
    }
    return createWebSocketMCPConnection(
      remoteConfig,
      logger,
      elicitationHandlers,
      samplingHandlers,
    );
  }

  throw new Error(
    `MCP server "${config.name}" has unknown transport "${String(transportKind)}"`,
  );
}
