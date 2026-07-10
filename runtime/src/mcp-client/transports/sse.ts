/**
 * MCP SSE (Server-Sent Events) transport.
 *
 * Wraps the upstream `@modelcontextprotocol/sdk` `SSEClientTransport`
 * so AgenC callers never import the SDK directly. The SDK's SSE
 * transport is the "compatibility" MCP transport (pre-Streamable HTTP), but
 * plenty of deployed servers still speak it, so we keep it supported.
 *
 * Transport contract:
 *   - `endpoint` is the full URL to the MCP SSE endpoint (e.g.
 *     `https://mcp.example/sse`). Redirects followed by upstream SDK.
 *   - Optional `headers` applied to the initial GET; most commonly
 *     `Authorization: Bearer <token>`.
 *   - Returns a live `Client` ready for `listTools()`, `callTool()`,
 *     `listResources()`, `listPrompts()`.
 *
 * @module
 */

import { VERSION } from "../../version.js";
import type { Logger } from "../_deps/logger.js";
import { silentLogger } from "../_deps/logger.js";
import type { MCPElicitationHandlers } from "../types.js";
import { configureMcpElicitationClient } from "../../elicitation/mcp.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from "../../services/mcp/hostCapabilities.js";

export interface MCPServerSseConfig {
  readonly name: string;
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  /** Connection timeout in ms. Default 30000. */
  readonly timeout?: number;
}

/**
 * Create a live MCP client over SSE transport.
 *
 * Returns the raw SDK `Client` typed as `unknown`-like so the bridge
 * layer doesn't care which transport produced it.
 */
export async function createSseMCPConnection(
  config: MCPServerSseConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SSEClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/sse.js"
  );

  const timeout = config.timeout ?? 30_000;

  const url = new URL(config.endpoint);
  const transport = new SSEClientTransport(url, {
    ...(config.headers !== undefined
      ? {
          requestInit: {
            headers: { ...config.headers },
          },
        }
      : {}),
  });

  const client = new Client(
    { name: "agenc-runtime", version: VERSION },
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

  logger.info(`Connecting to MCP SSE server "${config.name}"...`, {
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
          `MCP SSE connect to "${config.name}" timed out after ${timeout}ms`,
        ),
      );
    }, timeout);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  logger.info(`Connected to MCP SSE server "${config.name}"`);
  return client;
}
