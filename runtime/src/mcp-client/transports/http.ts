/**
 * MCP Streamable HTTP transport.
 *
 * Wraps `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport`
 * (the spec-sanctioned replacement for the compatibility SSE transport). The
 * transport multiplexes request/response pairs over a single long-
 * poll or streaming HTTP connection.
 *
 * @module
 */

import type { Logger } from "../_deps/logger.js";
import { silentLogger } from "../_deps/logger.js";
import type { MCPElicitationHandlers } from "../types.js";
import { configureMcpElicitationClient } from "../../elicitation/mcp.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from "../../services/mcp/hostCapabilities.js";

export interface MCPServerHttpConfig {
  readonly name: string;
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  /** Connection timeout in ms. Default 30000. */
  readonly timeout?: number;
}

/**
 * Create a live MCP client over Streamable HTTP transport.
 */
export async function createHttpMCPConnection(
  config: MCPServerHttpConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const timeout = config.timeout ?? 30_000;

  const url = new URL(config.endpoint);
  const transport = new StreamableHTTPClientTransport(url, {
    ...(config.headers !== undefined
      ? {
          requestInit: {
            headers: { ...config.headers },
          },
        }
      : {}),
  });

  const client = new Client(
    { name: "agenc-runtime", version: "0.2.0" },
    {
      capabilities: buildMcpHostClientCapabilities(
        elicitationHandlers === undefined ? "none" : "form-url",
      ),
    },
  );
  configureMcpHostRequestHandlers(
    client,
    config.name,
    samplingHandlers === undefined ? undefined : { samplingHandlers },
  );
  await configureMcpElicitationClient(
    client,
    config.name,
    elicitationHandlers,
  );

  logger.info(`Connecting to MCP HTTP server "${config.name}"...`, {
    endpoint: config.endpoint,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        client.close();
      } catch {
        // best-effort
      }
      reject(
        new Error(
          `MCP HTTP connect to "${config.name}" timed out after ${timeout}ms`,
        ),
      );
    }, timeout);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  logger.info(`Connected to MCP HTTP server "${config.name}"`);
  return client;
}
