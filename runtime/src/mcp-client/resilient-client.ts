/**
 * Resilient MCP tool bridge with automatic reconnection.
 *
 * Wraps an inner MCPToolBridge, detecting connection errors on tool calls
 * and automatically reconnecting with exponential backoff.
 *
 * @module
 */

import type { Tool, ToolResult } from "./_deps/tools-types.js";
import type {
  MCPElicitationHandlers,
  MCPServerConfig,
  MCPToolBridge,
} from "./types.js";
import type { McpSamplingHandlers } from "../services/mcp/hostCapabilities.js";
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
   * Local event observer forwarded to the inner bridge on reconnect so a
   * rebuilt bridge keeps emitting the same `mcp_tool_call_*` events the
   * initial connect set up.
   */
  readonly callObserver?: MCPCallObserver;
  readonly serverOrigin?: string;
  /**
   * Invoked after a successful reconnect with the freshly-spawned MCP
   * `client`. The owning `MCPManager` wires this so it can rebuild the
   * resource + prompt bridges against the new client — otherwise those
   * bridges would keep their reference to the OLD (now-closed) client and
   * the manager's `readResource` / `renderPrompt` would talk to a dead
   * connection. The resilient bridge only rebuilds the *tool* bridge
   * itself; the resource/prompt surface lives on the manager, so it must
   * be refreshed through this hook. Rejections are swallowed by the caller
   * so a resource/prompt-bridge failure never aborts an otherwise-good
   * tool reconnect.
   */
  readonly onReconnect?: (client: unknown) => void | Promise<void>;
  /**
   * gaphunt3 #14: session-provided elicitation handlers, threaded into the
   * fresh client spawned on reconnect. The initial connect registers these
   * via `createMCPConnection(config, logger, elicitationHandlers)` in
   * `manager.ts`; without re-supplying them here the reconnected client has no
   * `ElicitRequest`/`ElicitationComplete` handler, so any server-initiated
   * elicitation after a transient drop goes silently unhandled. The owning
   * `MCPManager` must forward `this.elicitationHandlers` when constructing the
   * bridge for this to take effect.
   */
  readonly elicitationHandlers?: MCPElicitationHandlers;
  /** Session-provided MCP sampling handler, re-registered on reconnect. */
  readonly samplingHandlers?: McpSamplingHandlers;
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

        // gaphunt3 #38: match the inner tool by exact namespaced name only.
        // Inner names are always the canonical `mcp.<server>.<tool>` after
        // `createToolBridge`, so the prior `endsWith(".<suffix>")` fallback was
        // unnecessary and ambiguous: with dotted-suffix overlaps (e.g.
        // `mcp.s.add` vs `mcp.s.do.add`) `Array.find` short-circuits on the
        // first predicate-true element and could dispatch the wrong tool.
        const innerTool = this.inner.tools.find(
          (t) => t.name === namespacedName,
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
      // dispose() may have run while we awaited the old bridge teardown.
      if (this.disposed) { this.reconnecting = false; return; }

      const { createMCPConnection } = await import("./connection.js");
      const { createToolBridge } = await import("./tools.js");

      // gaphunt3 #14: re-supply the session's elicitation handlers so the
      // rebuilt client re-registers its ElicitRequest/ElicitationComplete
      // handlers — otherwise server-initiated elicitation breaks silently
      // after any reconnect.
      const client = await createMCPConnection(
        this.config,
        this.logger,
        this.options.elicitationHandlers,
        this.options.samplingHandlers,
      );
      // A `dispose()` racing this reconnect already cleared `reconnectTimer`
      // and disposed `this.inner`, but it cannot see the client we just
      // spawned. Without this re-check the fresh (detached stdio child)
      // client would be orphaned — a process leak. Close it ourselves.
      if (this.disposed) {
        await closeClientQuietly(client);
        this.reconnecting = false;
        return;
      }

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
          // Keep the rebuilt bridge emitting the same local call events.
          ...(this.options.callObserver !== undefined
            ? { callObserver: this.options.callObserver }
            : {}),
          ...(this.options.serverOrigin !== undefined
            ? { serverOrigin: this.options.serverOrigin }
            : {}),
        },
      );

      // Disposed while building the bridge: tear the new bridge down (its
      // dispose() closes the client + kills the child) so nothing leaks.
      if (this.disposed) {
        try { await newBridge.dispose(); } catch { /* ignore */ }
        this.reconnecting = false;
        return;
      }

      this.inner = newBridge;
      this.reconnecting = false;
      this.backoffMs = 0;

      // (a) Rebuild the manager's resource + prompt bridges against the new
      // client. The resilient bridge owns only the tool surface; without
      // this the manager's readResource / renderPrompt would keep calling
      // the OLD, closed client. Best-effort: a failure here must not undo an
      // otherwise-successful tool reconnect.
      if (this.options.onReconnect !== undefined) {
        try {
          await this.options.onReconnect(client);
        } catch (hookError) {
          this.logger.warn?.(
            `MCP server "${this.serverName}" reconnect resource/prompt refresh failed: ${(hookError as Error).message}`,
          );
        }
      }

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

/**
 * Best-effort close of a freshly-spawned MCP client that we have to abandon
 * because `dispose()` raced our reconnect. Mirrors the tool bridge's own
 * `client.close()` teardown (tools.ts) — for stdio this terminates the
 * detached child process, preventing a leak.
 */
async function closeClientQuietly(client: unknown): Promise<void> {
  try {
    await (client as { close?: () => Promise<void> }).close?.();
  } catch {
    /* ignore — abandoning anyway */
  }
}

/** Check if an error message indicates a dead connection. */
function isConnectionError(content: string): boolean {
  const lower = content.toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}
