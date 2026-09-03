/**
 * MCP client types for @tetsuo-ai/runtime.
 *
 * Defines configuration and bridge interfaces for connecting to external
 * MCP servers (e.g. Peekaboo, macos-automator-mcp) via stdio transport.
 *
 * @module
 */

import type {
  PermissionDefaultMode,
  PerToolConfig,
} from "../config/schema.js";
import type { Tool } from "./_deps/tools-types.js";

/** Runtime-only metadata injected after canonical config validation. */
export interface PluginMcpSandboxMetadata {
  readonly mode: "stdio-child-process";
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly serverName: string;
  readonly scopedServerName: string;
}

/** Provenance retained after policy resolution and transport adaptation. */
export interface MCPServerOrigin {
  readonly scope:
    | "default"
    | "managed"
    | "user"
    | "project"
    | "local"
    | "flag"
    | "profile"
    | "environment"
    | "cli"
    | "plugin"
    | "session";
  readonly pluginSource?: string;
  readonly pluginServer?: {
    readonly pluginName: string;
    readonly serverName: string;
  };
}

/**
 * Configuration for an external MCP server.
 *
 * Supports transport modes selected by `transport`:
 *   - `"stdio"` (default): spawn a child process via `command` + `args`.
 *   - `"sse"`: connect to a remote server over compatibility SSE at `endpoint`.
 *   - `"http"`: connect over the Streamable HTTP transport at `endpoint`.
 *   - `"websocket"`: connect to a remote WebSocket endpoint.
 */
export interface MCPServerConfig {
  /** Human-readable server name (used for tool namespacing) */
  readonly name: string;
  /** Transport kind. Default: "stdio". */
  readonly transport?: "stdio" | "sse" | "http" | "websocket";
  /** Executable command (e.g. "npx", "node"). Required for stdio transport. */
  readonly command?: string;
  /** Command arguments (e.g. ["-y", "@nicholasareed/peekaboo-mcp@latest"]).
   *  Required for stdio transport. */
  readonly args?: readonly string[];
  /** Remote endpoint URL. Required when `transport` is `"sse"`, `"http"`, or WebSocket. */
  readonly endpoint?: string;
  /** Optional headers to send on the initial request (SSE/HTTP/WebSocket). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional environment variables for the child process (stdio only). */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional parent environment variable names to copy into stdio process env. */
  readonly env_vars?: readonly string[];
  /** Optional working directory for the stdio process. */
  readonly cwd?: string;
  /** Whether this server is enabled. Default: true */
  readonly enabled?: boolean;
  /** Whether startup/reload must fail if this server cannot connect. */
  readonly required?: boolean;
  /** Connection timeout in ms. Default: 30000 */
  readonly timeout?: number;
  /** Route this server into a container instead of running on the host.
   *  Currently only "desktop" is supported — the MCP server will be spawned
   *  via `docker exec` inside the desktop sandbox container. Stdio only. */
  readonly container?: string;
  /** Default approval mode for tools exposed by this server. */
  readonly default_tools_approval_mode?: PermissionDefaultMode;
  /** Explicit allow-list of raw MCP tool names exposed from this server. */
  readonly enabled_tools?: readonly string[];
  /** Explicit deny-list of raw MCP tool names removed after the allow-list. */
  readonly disabled_tools?: readonly string[];
  /**
   * Raw tool names explicitly audited by a trusted config authority as having
   * no model-directed filesystem writes. Untrusted config scopes are ignored.
   */
  readonly virtual_no_fs_write_tools?: readonly string[];
  /** Per raw MCP tool approval settings. */
  readonly tools?: Readonly<Record<string, PerToolConfig>>;
  /** Canonical SHA-256 digest pin for the server's exposed tool catalog. */
  readonly pinnedCatalogSha256?: string;
  /** Structured supply-chain policy for the server's tool catalog. */
  readonly supplyChain?: {
    readonly catalogSha256?: string;
  };
  /** Metadata for plugin-owned stdio servers isolated as child processes. */
  readonly pluginSandbox?: PluginMcpSandboxMetadata;
  /** Canonical source identity used by status and policy projections. */
  readonly origin?: MCPServerOrigin;
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
