/**
 * MCP client types for @tetsuo-ai/runtime.
 *
 * Defines configuration and bridge interfaces for connecting to external
 * MCP servers (e.g. Peekaboo, macos-automator-mcp) via stdio transport.
 *
 * @module
 */

import type { Tool } from "./_deps/tools-types.js";

/**
 * Configuration for an external MCP server.
 *
 * Supports three transport modes selected by `transport`:
 *   - `"stdio"` (default): spawn a child process via `command` + `args`.
 *   - `"sse"`: connect to a remote server over legacy SSE at `endpoint`.
 *   - `"http"`: connect over the Streamable HTTP transport at `endpoint`.
 */
export interface MCPServerConfig {
  /** Human-readable server name (used for tool namespacing) */
  name: string;
  /** Transport kind. Default: "stdio". */
  transport?: "stdio" | "sse" | "http";
  /** Executable command (e.g. "npx", "node"). Required for stdio transport. */
  command?: string;
  /** Command arguments (e.g. ["-y", "@nicholasareed/peekaboo-mcp@latest"]).
   *  Required for stdio transport. */
  args?: string[];
  /** Remote endpoint URL. Required when `transport` is `"sse"` or `"http"`. */
  endpoint?: string;
  /** Optional HTTP headers to send on the initial request (SSE/HTTP). */
  headers?: Record<string, string>;
  /** Optional environment variables for the child process (stdio only). */
  env?: Record<string, string>;
  /** Whether this server is enabled. Default: true */
  enabled?: boolean;
  /** Whether startup/reload must fail if this server cannot connect. */
  required?: boolean;
  /** Connection timeout in ms. Default: 30000 */
  timeout?: number;
  /** Route this server into a container instead of running on the host.
   *  Currently only "desktop" is supported — the MCP server will be spawned
   *  via `docker exec` inside the desktop sandbox container. Stdio only. */
  container?: string;
}

/**
 * Bridge between an MCP server connection and the runtime Tool system.
 */
export interface MCPToolBridge {
  /** Name of the connected MCP server */
  readonly serverName: string;
  /** Tools exposed by this server, adapted to the runtime Tool interface */
  readonly tools: Tool[];
  /** Disconnect from the server and clean up resources */
  dispose(): Promise<void>;
}

export interface MCPReconnectResult {
  readonly serverName: string;
  readonly success: boolean;
  readonly toolCount: number;
  readonly error?: string;
}
