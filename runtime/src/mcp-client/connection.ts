/**
 * MCP client connection management.
 *
 * Dispatches to the appropriate transport based on `config.transport`:
 *   - `"stdio"` (default): spawn a child process via `StdioClientTransport`.
 *   - `"sse"`: delegate to `./transports/sse.ts`.
 *   - `"http"`: delegate to `./transports/http.ts` (Streamable HTTP).
 *
 * @module
 */

import type { MCPElicitationHandlers, MCPServerConfig } from "./types.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { createSseMCPConnection } from "./transports/sse.js";
import { createHttpMCPConnection } from "./transports/http.js";
import { configureMcpElicitationClient } from "../elicitation/mcp.js";

/**
 * Create an MCP client connection to an external server.
 *
 * For `transport: "stdio"` (default) spawns the server as a child process
 * using `@modelcontextprotocol/sdk` StdioClientTransport. For `"sse"` and
 * `"http"` transports the call is delegated to the corresponding module
 * under `./transports/`.
 *
 * @returns MCP Client instance (typed as `any` to avoid ESM/CJS type conflicts)
 */
export async function createMCPConnection(
  config: MCPServerConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const transportKind = config.transport ?? "stdio";

  if (transportKind === "sse" || transportKind === "http") {
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
    return transportKind === "sse"
      ? createSseMCPConnection(remoteConfig, logger, elicitationHandlers)
      : createHttpMCPConnection(remoteConfig, logger, elicitationHandlers);
  }

  if (transportKind !== "stdio") {
    throw new Error(
      `MCP server "${config.name}" has unknown transport "${String(transportKind)}"`,
    );
  }

  if (!config.command || config.command.length === 0) {
    throw new Error(
      `MCP server "${config.name}" has transport="stdio" but no "command" was provided`,
    );
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );

  const timeout = config.timeout ?? 30_000;
  const args = config.args ?? [];

  // Build env: inherit process.env (filtering undefined values) + user overrides
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (config.env) {
    Object.assign(env, config.env);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args,
    env,
  });

  const client = new Client(
    { name: `agenc-runtime`, version: "0.2.0" },
    {
      capabilities: elicitationHandlers === undefined
        ? {}
        : { elicitation: { form: {}, url: {} } },
    },
  );
  await configureMcpElicitationClient(
    client,
    config.name,
    elicitationHandlers,
  );

  logger.info(`Connecting to MCP server "${config.name}"...`, {
    command: config.command,
    args,
  });

  // Connect with timeout — clean up timer on success, kill child on timeout
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Kill the child process to avoid orphans
      try { client.close(); } catch { /* best-effort */ }
      reject(new Error(`MCP connection to "${config.name}" timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  logger.info(`Connected to MCP server "${config.name}"`);
  return client;
}
