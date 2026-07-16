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
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import type {
  MCPCallObserver,
  MCPToolBridgePermissionOptions,
  MCPToolCatalogPolicyConfig,
} from "./tools.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { isValidPermissionDefaultMode } from "../config/schema.js";
import { MCPTransportCleanupError } from "./transports/connect-with-cleanup.js";

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

export interface MCPReconnectCleanupFailure {
  /** Exact resource whose cleanup could not be proven. */
  readonly owner: unknown;
  /** Retry the same owner's cleanup; success is the only proof of release. */
  readonly dispose: () => Promise<void>;
  readonly error: unknown;
}

export class MCPReconnectCleanupError extends AggregateError {
  constructor(
    serverName: string,
    readonly failures: readonly MCPReconnectCleanupFailure[],
    readonly unownedErrors: readonly unknown[] = [],
  ) {
    super(
      [
        ...failures.map((failure) => failure.error),
        ...unownedErrors,
      ],
      `MCP server "${serverName}" reconnect cleanup failed`,
    );
    this.name = "MCPReconnectCleanupError";
  }
}

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
   * Notifies the manager before a poisoned reconnect task settles. The outer
   * bridge retains the exact nested owners and remains their retry boundary.
   */
  readonly onCleanupFailure?: (error: MCPReconnectCleanupError) => void;
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
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
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
  private reconnectTask: Promise<void> | undefined;
  private reconnectEpoch = 0;
  private backoffMs = 0;
  private cleanupPoisoned = false;
  private readonly retainedCleanup = new Map<
    unknown,
    MCPReconnectCleanupFailure
  >();
  private readonly unownedCleanupErrors: unknown[] = [];
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private innerDisposal:
    | { readonly bridge: MCPToolBridge; readonly promise: Promise<void> }
    | undefined;

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

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    this.reconnectEpoch++;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const inner = this.inner;
    const reconnectTask = this.reconnectTask;
    const task = Promise.allSettled([
      this.disposeInnerBridge(inner),
      this.retryRetainedCleanup(),
      ...(reconnectTask !== undefined ? [reconnectTask] : []),
    ]).then((results) => {
      const errors = results.flatMap((result, index) => {
        if (result.status !== "rejected") return [];
        if (index < 2 || result.reason instanceof MCPReconnectCleanupError) {
          return [result.reason];
        }
        return [];
      });
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `MCP server "${this.serverName}" resilient bridge shutdown failed`,
        );
      }
    });
    this.disposal = task;
    void task.then(undefined, () => {
      if (this.disposal === task) this.disposal = undefined;
    });
    return task;
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

        if (this.cleanupPoisoned) {
          return {
            content: `MCP server "${this.serverName}" cleanup remains unproven`,
            isError: true,
          };
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
    if (this.disposed || this.reconnecting || this.cleanupPoisoned) return;

    this.reconnecting = true;
    const epoch = ++this.reconnectEpoch;
    this.backoffMs = this.backoffMs === 0
      ? INITIAL_BACKOFF_MS
      : Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

    this.logger.info(
      `MCP server "${this.serverName}" connection lost — reconnecting in ${this.backoffMs}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || epoch !== this.reconnectEpoch) {
        this.reconnecting = false;
        return;
      }
      const task = this.reconnect(epoch);
      this.reconnectTask = task;
      const clear = (): void => {
        if (this.reconnectTask === task) this.reconnectTask = undefined;
      };
      void task.then(clear, clear);
    }, this.backoffMs);
  }

  private async reconnect(epoch: number): Promise<void> {
    if (!this.isReconnectCurrent(epoch)) return;

    let client: unknown;
    let newBridge: MCPToolBridge | undefined;

    try {
      // Do not spawn a replacement until the old connection has actually
      // closed. A failed close is a fail-closed reconnect, not a reason to run
      // two server process trees concurrently.
      const previousBridge = this.inner;
      try {
        await this.disposeInnerBridge(previousBridge);
      } catch (error) {
        throw new MCPReconnectCleanupError(this.serverName, [
          reconnectCleanupFailure(
            previousBridge,
            () => this.disposeInnerBridge(previousBridge),
            error,
          ),
        ]);
      }
      if (!this.isReconnectCurrent(epoch)) {
        this.reconnecting = false;
        return;
      }

      const { createMCPConnection } = await import("./connection.js");
      const { createToolBridge } = await import("./tools.js");

      // gaphunt3 #14: re-supply the session's elicitation handlers so the
      // rebuilt client re-registers its ElicitRequest/ElicitationComplete
      // handlers — otherwise server-initiated elicitation breaks silently
      // after any reconnect.
      client = await createMCPConnection(
        this.config,
        this.logger,
        this.options.elicitationHandlers,
        this.options.samplingHandlers,
        this.options.sandboxExecutionBroker,
      );
      if (!this.isReconnectCurrent(epoch)) {
        await closeClientForAbandonedReconnect(client, this.serverName);
        client = undefined;
        this.reconnecting = false;
        return;
      }

      newBridge = await createToolBridge(
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

      if (!this.isReconnectCurrent(epoch)) {
        await disposeAbandonedReconnectBridge(newBridge, this.serverName);
        newBridge = undefined;
        client = undefined;
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
      if (error instanceof MCPReconnectCleanupError) {
        this.recordCleanupFailure(error);
        throw error;
      }
      if (error instanceof MCPTransportCleanupError) {
        const cleanupError = new MCPReconnectCleanupError(
          this.serverName,
          [],
          [error],
        );
        this.recordCleanupFailure(cleanupError);
        throw cleanupError;
      }
      const cleanupFailures: MCPReconnectCleanupFailure[] = [];
      if (newBridge !== undefined && this.inner !== newBridge) {
        const failedBridge = newBridge;
        const result = await Promise.allSettled([
          invokeBridgeDisposal(failedBridge),
        ]);
        if (result[0]?.status === "rejected") {
          cleanupFailures.push(
            reconnectCleanupFailure(
              failedBridge,
              () => invokeBridgeDisposal(failedBridge),
              result[0].reason,
            ),
          );
        }
        client = undefined;
      } else if (client !== undefined && this.inner !== newBridge) {
        const failedClient = client;
        const result = await Promise.allSettled([
          invokeClientClose(failedClient),
        ]);
        if (result[0]?.status === "rejected") {
          cleanupFailures.push(
            reconnectCleanupFailure(
              failedClient,
              () => invokeClientClose(failedClient),
              result[0].reason,
            ),
          );
        }
      }
      if (cleanupFailures.length > 0) {
        const cleanupError = new MCPReconnectCleanupError(
          this.serverName,
          cleanupFailures,
        );
        this.recordCleanupFailure(cleanupError);
        throw cleanupError;
      }
      this.logger.warn?.(
        `MCP server "${this.serverName}" reconnection failed: ${(error as Error).message}`,
      );
      this.reconnecting = false;
      if (!this.isReconnectCurrent(epoch)) return;
      // Schedule another attempt with increased backoff
      this.scheduleReconnect();
    }
  }

  private isReconnectCurrent(epoch: number): boolean {
    return !this.disposed && this.reconnectEpoch === epoch;
  }

  private recordCleanupFailure(error: MCPReconnectCleanupError): void {
    this.cleanupPoisoned = true;
    this.reconnecting = false;
    this.reconnectEpoch++;
    for (const failure of error.failures) {
      this.retainedCleanup.set(failure.owner, failure);
    }
    this.unownedCleanupErrors.push(...error.unownedErrors);
    try {
      this.options.onCleanupFailure?.(error);
    } catch (callbackError) {
      this.logger.error?.(
        `MCP server "${this.serverName}" cleanup failure callback failed:`,
        callbackError,
      );
    }
  }

  private async retryRetainedCleanup(): Promise<void> {
    const failures = Array.from(this.retainedCleanup.values());
    const results = await Promise.allSettled(
      failures.map((failure) => failure.dispose()),
    );
    for (let index = 0; index < results.length; index += 1) {
      const failure = failures[index]!;
      if (this.retainedCleanup.get(failure.owner) !== failure) continue;
      const result = results[index]!;
      if (result.status === "fulfilled") {
        this.retainedCleanup.delete(failure.owner);
      } else {
        this.retainedCleanup.set(failure.owner, {
          ...failure,
          error: result.reason,
        });
      }
    }
    if (
      this.retainedCleanup.size > 0 ||
      this.unownedCleanupErrors.length > 0
    ) {
      throw new MCPReconnectCleanupError(
        this.serverName,
        Array.from(this.retainedCleanup.values()),
        this.unownedCleanupErrors,
      );
    }
  }

  private disposeInnerBridge(bridge: MCPToolBridge): Promise<void> {
    if (this.innerDisposal?.bridge === bridge) {
      return this.innerDisposal.promise;
    }
    const promise = invokeBridgeDisposal(bridge);
    this.innerDisposal = { bridge, promise };
    void promise.then(undefined, () => {
      if (this.innerDisposal?.promise === promise) {
        this.innerDisposal = undefined;
      }
    });
    return promise;
  }
}

/**
 * Close a freshly-spawned MCP client that a newer lifecycle epoch abandoned.
 * A close failure is propagated as a cleanup failure so strict sandbox
 * quiesce cannot claim that the old execution authority is empty.
 */
function invokeBridgeDisposal(bridge: MCPToolBridge): Promise<void> {
  return Promise.resolve().then(() => bridge.dispose());
}

function invokeClientClose(client: unknown): Promise<void> {
  return Promise.resolve().then(() =>
    (client as { close?: () => Promise<void> }).close?.(),
  );
}

async function closeClientForAbandonedReconnect(
  client: unknown,
  serverName: string,
): Promise<void> {
  try {
    await invokeClientClose(client);
  } catch (error) {
    throw new MCPReconnectCleanupError(serverName, [
      reconnectCleanupFailure(
        client,
        () => invokeClientClose(client),
        error,
      ),
    ]);
  }
}

async function disposeAbandonedReconnectBridge(
  bridge: MCPToolBridge,
  serverName: string,
): Promise<void> {
  try {
    await invokeBridgeDisposal(bridge);
  } catch (error) {
    throw new MCPReconnectCleanupError(serverName, [
      reconnectCleanupFailure(
        bridge,
        () => invokeBridgeDisposal(bridge),
        error,
      ),
    ]);
  }
}

function reconnectCleanupFailure(
  owner: unknown,
  dispose: () => Promise<void>,
  error: unknown,
): MCPReconnectCleanupFailure {
  return { owner, dispose, error };
}

/** Check if an error message indicates a dead connection. */
function isConnectionError(content: string): boolean {
  const lower = content.toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}
