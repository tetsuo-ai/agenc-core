/**
 * Resilient MCP tool bridge with automatic reconnection.
 *
 * Wraps an inner MCPToolBridge, detecting connection errors on tool calls
 * and automatically reconnecting with exponential backoff.
 *
 * @module
 */

import type { Tool, ToolResult } from "./_deps/tools-types.js";
import type { MCPServerConfig, MCPToolBridge } from "./types.js";
import type {
  MCPCallObserver,
  MCPToolBridgePermissionOptions,
  MCPToolCatalogPolicyConfig,
} from "./tools.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { isValidPermissionDefaultMode } from "../config/schema.js";

/**
 * Derive the tool catalog policy (allow/deny filter, I-74 SHA-256 catalog
 * pin, per-tool + default approval modes) from a server config.
 *
 * This is the SINGLE source of truth shared by both connect paths: the
 * initial connect in `manager.ts` imports this same function (manager already
 * depends on this module for `ResilientMCPBridge`, so importing it here keeps
 * the dependency edge one-directional and avoids a cycle), and the reconnect
 * path below re-applies it so a dropped connection cannot bypass supply-chain
 * or access controls (#6). Keeping one implementation means a new security
 * field added to the policy derivation lands on both paths at once.
 *
 * The policy fields live alongside `MCPServerConfig` but are not part of its
 * public surface, so they are read through a widened cast.
 */
export function toToolCatalogPolicyConfig(
  config: MCPServerConfig,
): MCPToolCatalogPolicyConfig | undefined {
  const typed = config as MCPServerConfig & MCPToolCatalogPolicyConfig;
  const allowedTools = typed.allowedTools ?? config.enabled_tools;
  const deniedTools = typed.deniedTools ?? config.disabled_tools;
  const defaultToolsApprovalMode = isValidPermissionDefaultMode(
    config.default_tools_approval_mode,
  )
    ? config.default_tools_approval_mode
    : undefined;
  if (
    !typed.riskControls &&
    !typed.supplyChain &&
    !typed.pinnedCatalogSha256 &&
    allowedTools === undefined &&
    deniedTools === undefined &&
    defaultToolsApprovalMode === undefined &&
    config.tools === undefined
  ) {
    return undefined;
  }
  return {
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(deniedTools !== undefined ? { deniedTools } : {}),
    ...(typed.pinnedCatalogSha256 !== undefined
      ? { pinnedCatalogSha256: typed.pinnedCatalogSha256 }
      : {}),
    ...(defaultToolsApprovalMode !== undefined
      ? { defaultToolsApprovalMode }
      : {}),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
    riskControls: typed.riskControls,
    supplyChain: typed.supplyChain,
  };
}

/** Patterns that indicate the underlying MCP connection is dead. */
const CONNECTION_ERROR_PATTERNS = [
  "not connected",
  "disconnected",
  "epipe",
  "channel closed",
  "process exited",
  "connection refused",
  "broken pipe",
  "transport closed",
  "client closed",
  "econnreset",
  "econnrefused",
];

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

interface ResilientMCPBridgeOptions {
  readonly permissions?: MCPToolBridgePermissionOptions;
  /**
   * Telemetry plumbing forwarded to the inner bridge on reconnect so a
   * rebuilt bridge keeps emitting the same `mcp_tool_call_*` events and
   * span origin the initial connect set up. Telemetry-only (not a security
   * control); kept at parity with the initial-connect `createToolBridge`
   * call in `manager.ts`.
   */
  readonly callObserver?: MCPCallObserver;
  readonly serverOrigin?: string;
}

/**
 * Wraps an MCPToolBridge with automatic reconnection on connection failures.
 *
 * The outer `tools` array stays stable (same object references) — the inner
 * bridge is swapped transparently on reconnect.
 */
export class ResilientMCPBridge implements MCPToolBridge {
  readonly serverName: string;
  readonly tools: Tool[];

  private inner: MCPToolBridge;
  private readonly config: MCPServerConfig;
  /**
   * Catalog policy (allow/deny filter, I-74 SHA-256 pin, approval modes)
   * derived from `config` at construction and re-applied on every reconnect
   * so a reconnection cannot bypass supply-chain or access controls (#6).
   */
  private readonly catalogPolicy: MCPToolCatalogPolicyConfig | undefined;
  private readonly logger: Logger;
  private readonly options: ResilientMCPBridgeOptions;

  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 0;
  private disposed = false;

  constructor(
    config: MCPServerConfig,
    initialBridge: MCPToolBridge,
    logger: Logger = silentLogger,
    options: ResilientMCPBridgeOptions = {},
  ) {
    this.config = config;
    this.catalogPolicy = toToolCatalogPolicyConfig(config);
    this.inner = initialBridge;
    this.logger = logger;
    this.options = options;
    this.serverName = initialBridge.serverName;

    // Build stable proxy tools that delegate to the current inner bridge
    this.tools = initialBridge.tools.map((outerTool) =>
      this.createProxyTool(outerTool.name, outerTool),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.inner.dispose();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private createProxyTool(namespacedName: string, templateTool: Tool): Tool {
    return {
      name: namespacedName,
      description: templateTool.description,
      inputSchema: templateTool.inputSchema,
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        if (this.disposed) {
          return { content: `MCP server "${this.serverName}" has been disposed`, isError: true };
        }

        if (this.reconnecting) {
          return { content: `MCP server "${this.serverName}" is reconnecting...`, isError: true };
        }

        // Find the matching inner tool by suffix (strip mcp.{server}. prefix)
        const toolSuffix = namespacedName.replace(`mcp.${this.serverName}.`, "");
        const innerTool = this.inner.tools.find((t) =>
          t.name === namespacedName || t.name.endsWith(`.${toolSuffix}`),
        );
        if (!innerTool) {
          return { content: `Tool "${namespacedName}" not found after reconnect`, isError: true };
        }

        const result = await innerTool.execute(args);

        if (result.isError && isConnectionError(result.content)) {
          this.scheduleReconnect();
          return { content: `MCP server "${this.serverName}" lost connection — reconnecting...`, isError: true };
        }

        return result;
      },
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnecting) return;

    this.reconnecting = true;
    this.backoffMs = this.backoffMs === 0
      ? INITIAL_BACKOFF_MS
      : Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

    this.logger.info(
      `MCP server "${this.serverName}" connection lost — reconnecting in ${this.backoffMs}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      void this.reconnect();
    }, this.backoffMs);
  }

  private async reconnect(): Promise<void> {
    if (this.disposed) return;

    try {
      // Dispose old bridge (best-effort)
      try { await this.inner.dispose(); } catch { /* ignore */ }

      const { createMCPConnection } = await import("./connection.js");
      const { createToolBridge } = await import("./tools.js");

      const client = await createMCPConnection(this.config, this.logger);
      const newBridge = await createToolBridge(
        client,
        this.serverName,
        this.logger,
        {
          listToolsTimeoutMs: this.config.timeout,
          callToolTimeoutMs: this.config.timeout,
          // #6: re-apply the allow/deny filter, I-74 catalog pin, and approval
          // modes on every reconnect — otherwise a dropped connection would
          // silently bypass supply-chain and access controls.
          ...(this.catalogPolicy !== undefined
            ? { serverConfig: this.catalogPolicy }
            : {}),
          ...(this.options.permissions !== undefined
            ? { permissions: this.options.permissions }
            : {}),
          // Telemetry parity with the initial connect (manager.ts): keep the
          // rebuilt bridge emitting the same call events / span origin.
          ...(this.options.callObserver !== undefined
            ? { callObserver: this.options.callObserver }
            : {}),
          ...(this.options.serverOrigin !== undefined
            ? { serverOrigin: this.options.serverOrigin }
            : {}),
        },
      );

      this.inner = newBridge;
      this.reconnecting = false;
      this.backoffMs = 0;

      this.logger.info(`MCP server "${this.serverName}" reconnected (${newBridge.tools.length} tools)`);
    } catch (error) {
      this.logger.warn?.(
        `MCP server "${this.serverName}" reconnection failed: ${(error as Error).message}`,
      );
      this.reconnecting = false;
      // Schedule another attempt with increased backoff
      this.scheduleReconnect();
    }
  }
}

/** Check if an error message indicates a dead connection. */
function isConnectionError(content: string): boolean {
  const lower = content.toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}
