/**
 * MCP client types for @tetsuo-ai/runtime.
 *
 * Defines configuration and bridge interfaces for connecting to external
 * MCP servers (e.g. Peekaboo, macos-automator-mcp) via stdio transport.
 *
 * @module
 */

import type { PermissionDefaultMode, PerToolConfig } from "../config/schema.js";
import type { Tool } from "./_deps/tools-types.js";

/**
 * Configuration for an external MCP server.
 *
 * Supports transport modes selected by `transport`:
 *   - `"stdio"` (default): spawn a child process via `command` + `args`.
 *   - `"sse"`: connect to a remote server over legacy SSE at `endpoint`.
 *   - `"http"`: connect over the Streamable HTTP transport at `endpoint`.
 *   - `"websocket"` / `"ws"`: connect to a remote WebSocket endpoint.
 */
export interface MCPServerConfig {
  /** Human-readable server name (used for tool namespacing) */
  name: string;
  /** Transport kind. Default: "stdio". */
  transport?: "stdio" | "sse" | "http" | "websocket" | "ws";
  /** Executable command (e.g. "npx", "node"). Required for stdio transport. */
  command?: string;
  /** Command arguments (e.g. ["-y", "@nicholasareed/peekaboo-mcp@latest"]).
   *  Required for stdio transport. */
  args?: string[];
  /** Remote endpoint URL. Required when `transport` is `"sse"`, `"http"`, or WebSocket. */
  endpoint?: string;
  /** Optional headers to send on the initial request (SSE/HTTP/WebSocket). */
  headers?: Record<string, string>;
  /** Optional environment variables for the child process (stdio only). */
  env?: Record<string, string>;
  /** Optional parent environment variable names to copy into stdio process env. */
  env_vars?: readonly string[];
  /** Optional working directory for the stdio process. */
  cwd?: string;
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
  /** Default approval mode for tools exposed by this server. */
  default_tools_approval_mode?: PermissionDefaultMode;
  /** Explicit allow-list of raw MCP tool names exposed from this server. */
  enabled_tools?: readonly string[];
  /** Explicit deny-list of raw MCP tool names removed after the allow-list. */
  disabled_tools?: readonly string[];
  /** Per raw MCP tool approval settings. */
  tools?: Readonly<Record<string, PerToolConfig>>;
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

export interface MCPElicitationHandlers {
  handleRequest(params: {
    readonly serverName: string;
    readonly requestId: string | number;
    readonly request: unknown;
    readonly contextMeta?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  handleComplete?(params: {
    readonly serverName: string;
    readonly elicitationId: string;
    readonly notification: unknown;
  }): Promise<void> | void;
}
