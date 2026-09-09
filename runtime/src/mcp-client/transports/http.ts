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

import { VERSION } from "../../version.js";
import { Agent as UndiciAgent } from "undici";
import type { Logger } from "../_deps/logger.js";
import { silentLogger } from "../_deps/logger.js";
import type { MCPElicitationHandlers } from "../types.js";
import { configureMcpElicitationClient } from "../../elicitation/mcp.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from "../../services/mcp/hostCapabilities.js";
import { connectMCPClientWithCleanup } from "./connect-with-cleanup.js";
import { getProxyFetchOptions } from "../../utils/proxy.js";
import type { ProviderEnvironment } from "../../llm/provider-options.js";
import { EMPTY_MCP_REQUEST_ENVIRONMENT } from "../environment.js";
import type { McpOAuthConfig } from "../../config/mcp-oauth.js";
import { attestDesktopEndpoint, assertDesktopSocketBinding, type DesktopAuthorityGrant } from "../desktop-authority.js";
import { assertDesktopMcpDispatchGuard } from "../local-control.js";

export interface MCPServerHttpConfig {
  readonly desktopAuthorityGrant?: DesktopAuthorityGrant;
  readonly localOnly?: boolean;
  readonly oauth?: McpOAuthConfig;
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
  environment: ProviderEnvironment = EMPTY_MCP_REQUEST_ENVIRONMENT,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const timeout = config.timeout ?? 30_000;
  const socketAgent = config.desktopAuthorityGrant === undefined ? undefined :
    new UndiciAgent({ connect: { socketPath: config.desktopAuthorityGrant.socketPath } });
  const proxyOptions = socketAgent ? { dispatcher: socketAgent } : getProxyFetchOptions({
    // This supplies an explicit direct dispatcher, avoiding even a process-
    // global fetch proxy while retaining the existing owned agent lifecycle.
    environment: config.localOnly === true ? EMPTY_MCP_REQUEST_ENVIRONMENT : environment,
  });

  const url = new URL(config.endpoint);
  const privateFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (config.desktopAuthorityGrant) await assertDesktopSocketBinding(config.desktopAuthorityGrant);
    if (config.desktopAuthorityGrant) {
      // SDK tool-call bodies are JSON strings. Protocol initialization/listing
      // may run outside a user turn; actual execution requires its live guard.
      let toolCall = false;
      if (typeof init?.body === "string") {
        try { toolCall = JSON.parse(init.body)?.method === "tools/call"; } catch { /* SDK validates protocol bodies */ }
      }
      if (toolCall) assertDesktopMcpDispatchGuard(true);
    }
    return fetch(input, { ...init, ...proxyOptions, redirect: "error" });
  };
  try {
  await attestDesktopEndpoint(config, privateFetch);
  const oauth = config.oauth === undefined ? undefined : await import("../../services/mcp/interactive-auth.js");
  const transport = new StreamableHTTPClientTransport(url, {
    ...(config.localOnly === true ? {
      // A private loopback credential must never follow an endpoint redirect
      // or inherit an operator's outbound HTTP proxy.
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.href !== url.href) return Promise.reject(new Error("Local MCP endpoint changed"));
        return privateFetch(input, init);
      },
    } : {}),
    ...(oauth === undefined || config.oauth === undefined ? {} : {
      authProvider: oauth.runtimeMcpOAuthProvider(config.name, config.endpoint, "http", config.oauth, environment, config.headers),
      fetch: oauth.mcpOAuthTransportFetch(environment, fetch, config),
    }),
    requestInit: {
      ...proxyOptions,
      ...(config.headers !== undefined && config.oauth === undefined
        ? { headers: { ...config.headers } }
        : {}),
    },
  });

  const client = new Client(
    { name: "agenc-runtime", version: VERSION },
    {
      capabilities: buildMcpHostClientCapabilities(
        elicitationHandlers === undefined ? "none" : "form-url",
      ),
    },
  );
  if (socketAgent) {
    const closeClient = client.close.bind(client);
    let closing: Promise<void> | undefined;
    client.close = () => closing ??= (async () => {
      try { await closeClient(); } finally { await socketAgent.close(); }
    })();
  }
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

  await connectMCPClientWithCleanup(client, transport, {
    description: `MCP HTTP connect to "${config.name}"`,
    timeoutMs: timeout,
  });

  logger.info(`Connected to MCP HTTP server "${config.name}"`);
  return client;
  } catch (error) {
    await socketAgent?.destroy().catch(() => {});
    throw error;
  }
}
