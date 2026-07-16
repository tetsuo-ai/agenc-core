/**
 * MCP connection manager for @tetsuo-ai/runtime.
 *
 * Manages multiple MCP server connections, creating tool bridges
 * for each and exposing a unified tool list for the ToolRegistry.
 *
 * @module
 */

import type {
  MCPElicitationHandlers,
  MCPReconnectResult,
  MCPServerConfig,
  MCPServerMutationResult,
  MCPToolBridge,
} from "./types.js";
import type {
  ConnectedMCPServer,
  ScopedMcpServerConfig,
} from "../services/mcp/types.js";
import type { Tool } from "./_deps/tools-types.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tools.js";
import {
  ResilientMCPBridge,
  toToolCatalogPolicyConfig,
} from "./resilient-client.js";
import type {
  MCPCallObserver,
  MCPToolBridgePermissionOptions,
} from "./tools.js";
import {
  createResourceBridge,
  type MCPResourceBridge,
  type MCPResourceContent,
  type MCPResourceDescriptor,
} from "./resources.js";
import {
  createPromptBridge,
  type MCPPromptBridge,
  type MCPPromptDescriptor,
  type MCPPromptRendered,
} from "./prompts.js";
import type { McpSamplingHandlers } from "../services/mcp/hostCapabilities.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { registerSandboxExecutionLifecycleParticipant } from "../sandbox/execution-lifecycle.js";

/** I-50: cancellable MCP startup wait; 30s default. */
const MCP_STARTUP_TIMEOUT_MS = 30_000;

export interface MCPManagerStartOpts {
  /** Cancel the startup wait — fires I-50. Any in-flight connect that
   *  has not yet resolved is abandoned; connected bridges stay. */
  readonly signal?: AbortSignal;
  /** Override timeout for the initial listTools + connect RPC. */
  readonly timeoutMs?: number;
  /** I-20: require at least one server to come up — fail-hard
   *  otherwise. Default false (fail-soft). */
  readonly requireOneReady?: boolean;
  /** I-20: require THESE named servers to come up. Overrides
   *  `requireOneReady` when both set. */
  readonly requiredServers?: ReadonlyArray<string>;
}

interface StartupGate {
  cancel(reason: string): void;
  isCancelled(): boolean;
  reason(): string | undefined;
  waitForCancellation(): Promise<never>;
}

interface RefreshedCompanionBridges {
  readonly resourceBridge?: MCPResourceBridge;
  readonly promptBridge?: MCPPromptBridge;
}

interface ManagedConnectionAttempt {
  readonly serverName: string;
  readonly gate: StartupGate;
  readonly promise: Promise<MCPToolBridge>;
  isCurrent(): boolean;
}

interface ManagedReconnectOperation {
  readonly serverName: string;
  readonly promise: Promise<MCPReconnectResult>;
}

class MCPConnectionCleanupError extends AggregateError {
  readonly originalError: unknown;

  constructor(serverName: string, originalError: unknown, errors: unknown[]) {
    super(errors, `MCP server "${serverName}" connection cleanup failed`);
    this.name = "MCPConnectionCleanupError";
    this.originalError = originalError;
  }
}

export type MCPConnectionState =
  | { readonly type: "connected" | "pending" | "disabled" | "needs-auth" }
  | { readonly type: "failed"; readonly error?: string };

function toScopedMcpServerConfig(
  config: MCPServerConfig,
): ScopedMcpServerConfig {
  const scope = "dynamic" as const;
  const transport = config.transport ?? "stdio";

  if (transport === "sse") {
    return {
      type: "sse",
      url: config.endpoint ?? "",
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      scope,
    };
  }

  if (transport === "http") {
    return {
      type: "http",
      url: config.endpoint ?? "",
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      scope,
    };
  }

  if (transport === "websocket" || transport === "ws") {
    return {
      type: "ws",
      url: config.endpoint ?? "",
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      scope,
    };
  }

  return {
    type: "stdio",
    command: config.command ?? config.name,
    args: config.args ?? [],
    ...(config.env !== undefined ? { env: config.env } : {}),
    scope,
  };
}

function readClientCapabilities(
  client: unknown,
): ConnectedMCPServer["capabilities"] {
  try {
    return (
      (
        client as {
          getServerCapabilities?: () =>
            ConnectedMCPServer["capabilities"] | undefined;
        }
      ).getServerCapabilities?.() ?? {}
    );
  } catch {
    return {};
  }
}

function readClientServerInfo(
  client: unknown,
): ConnectedMCPServer["serverInfo"] {
  try {
    return (
      client as {
        getServerVersion?: () => ConnectedMCPServer["serverInfo"] | undefined;
      }
    ).getServerVersion?.();
  } catch {
    return undefined;
  }
}

function readClientInstructions(client: unknown): string | undefined {
  try {
    const instructions = (
      client as { getInstructions?: () => string | undefined }
    ).getInstructions?.();
    return typeof instructions === "string" && instructions.length > 0
      ? instructions
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Manages multiple external MCP server connections.
 *
 * @example
 * ```typescript
 * const manager = new MCPManager([
 *   { name: 'peekaboo', command: 'npx', args: ['-y', '@steipete/peekaboo@latest'] },
 * ], logger);
 *
 * await manager.start();
 * registry.registerAll(manager.getTools());
 *
 * // Later...
 * await manager.stop();
 * ```
 */
export class MCPManager {
  private configs: MCPServerConfig[];
  private readonly logger: Logger;
  private readonly bridges: Map<string, MCPToolBridge> = new Map();
  private readonly resourceBridges: Map<string, MCPResourceBridge> = new Map();
  private readonly promptBridges: Map<string, MCPPromptBridge> = new Map();
  private readonly connectedConnections: Map<string, ConnectedMCPServer> =
    new Map();
  private readonly connectionStates: Map<string, MCPConnectionState> =
    new Map();
  /**
   * Per-server `InitializeResult.instructions` blob captured at connect
   * time. Consumed by the per-turn `mcp_instructions_delta` attachment
   * producer (`runtime/src/prompts/attachments/mcp-delta.ts`) to detect
   * mid-session server connect / disconnect / reconfigure events. Empty
   * map for servers that don't supply an instructions blob.
   */
  private readonly serverInstructions: Map<string, string> = new Map();
  /**
   * T6 gap #119: optional observer wired by the session layer so MCP
   * tool calls emit `mcp_tool_call_begin` / `mcp_tool_call_end` events
   * into the session event log. Manager stays session-free; the session
   * owner sets this to a shim that calls `session.emit(...)`.
   */
  private callObserver: MCPCallObserver | undefined;
  private permissionOptions: MCPToolBridgePermissionOptions | undefined;
  private elicitationHandlers: MCPElicitationHandlers | undefined;
  private samplingHandlers: McpSamplingHandlers | undefined;
  private sandboxExecutionBroker: SandboxExecutionBrokerLike | undefined;
  private unregisterSandboxLifecycle: (() => void) | undefined;
  private running = false;
  private restartAfterSandboxTransition = false;
  private lastStartOpts: Omit<MCPManagerStartOpts, "signal"> = {};
  private lifecycleGeneration = 0;
  private readonly startupGates = new Set<StartupGate>();
  private readonly connectionAttempts = new Set<ManagedConnectionAttempt>();
  private readonly serverEpochs = new Map<string, number>();
  private readonly companionEpochs = new Map<string, number>();
  private readonly reconnectOperations = new Set<ManagedReconnectOperation>();
  private readonly reconnectTails = new Map<string, Promise<void>>();
  private shutdownTask: Promise<ReadonlyArray<unknown>> | undefined;

  constructor(configs: MCPServerConfig[], logger: Logger = silentLogger) {
    this.configs = configs;
    this.logger = logger;
    this.resetConnectionStates();
  }

  /**
   * T6 gap #119: install the call-observer that the bridge factory
   * passes to each per-tool `execute()` wrapper. Safe to call before or
   * after `start()`; observer applies to bridges created after the
   * call.
   */
  setCallObserver(observer: MCPCallObserver | undefined): void {
    this.callObserver = observer;
  }

  setPermissionOptions(
    options: MCPToolBridgePermissionOptions | undefined,
  ): void {
    this.permissionOptions = options;
  }

  setElicitationHandlers(handlers: MCPElicitationHandlers | undefined): void {
    this.elicitationHandlers = handlers;
  }

  setSamplingHandlers(handlers: McpSamplingHandlers | undefined): void {
    this.samplingHandlers = handlers;
  }

  setSandboxExecutionBroker(
    broker: SandboxExecutionBrokerLike | undefined,
  ): void {
    if (this.sandboxExecutionBroker === broker) return;
    this.unregisterSandboxLifecycle?.();
    this.unregisterSandboxLifecycle = undefined;
    this.sandboxExecutionBroker = broker;
    if (broker !== undefined) {
      this.unregisterSandboxLifecycle =
        registerSandboxExecutionLifecycleParticipant(broker, {
          name: "mcp-manager",
          quiesce: async () => {
            this.restartAfterSandboxTransition = this.running;
            if (
              this.running ||
              this.bridges.size > 0 ||
              this.connectionAttempts.size > 0 ||
              this.reconnectOperations.size > 0 ||
              this.shutdownTask !== undefined
            ) {
              await this.stopInternal(true);
            }
          },
          resume: async () => {
            if (!this.restartAfterSandboxTransition) return;
            this.restartAfterSandboxTransition = false;
            await this.start(this.lastStartOpts);
          },
        });
    }
  }

  getConnectionState(name: string): MCPConnectionState | undefined {
    const config = this.getServerConfig(name);
    if (config?.enabled === false) return { type: "disabled" };
    if (this.bridges.has(name)) return { type: "connected" };
    return this.connectionStates.get(name);
  }

  private resetConnectionStates(): void {
    this.connectionStates.clear();
    for (const config of this.configs) {
      this.connectionStates.set(config.name, {
        type: config.enabled === false ? "disabled" : "pending",
      });
    }
  }

  /**
   * Connect to all enabled MCP servers and create tool bridges.
   * Failures on individual servers are logged but don't block others
   * (I-6 fail-soft) — unless `requireOneReady` / `requiredServers`
   * is set, in which case I-20 aggregate-failure trips.
   *
   * I-50: the caller may pass `signal` to abort the startup wait. Any
   * unfinished connection is revoked immediately; its owned client continues
   * only long enough to complete verified cleanup. Strict lifecycle quiesce
   * waits for that cleanup before rebasing sandbox authority.
   */
  async start(opts: MCPManagerStartOpts = {}): Promise<void> {
    if (
      this.running ||
      this.shutdownTask !== undefined ||
      this.connectionAttempts.size > 0 ||
      this.reconnectOperations.size > 0 ||
      this.bridges.size > 0
    ) {
      throw new Error(
        "MCP manager cannot start while another connection lifecycle is active; stop it before starting again",
      );
    }
    this.lastStartOpts = {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.requireOneReady !== undefined
        ? { requireOneReady: opts.requireOneReady }
        : {}),
      ...(opts.requiredServers !== undefined
        ? { requiredServers: [...opts.requiredServers] }
        : {}),
    };
    const signal = opts.signal;
    if (signal?.aborted) {
      throw new Error(
        `MCP startup cancelled before first connect (${signal.reason ?? "unspecified"})`,
      );
    }
    const generation = ++this.lifecycleGeneration;
    this.running = true;
    this.resetConnectionStates();
    const enabledConfigs = this.configs.filter((c) => c.enabled !== false);

    if (enabledConfigs.length === 0) {
      this.logger.info("No MCP servers configured");
      return;
    }

    const timeoutMs = opts.timeoutMs ?? MCP_STARTUP_TIMEOUT_MS;

    this.logger.info(`Starting ${enabledConfigs.length} MCP server(s)...`);

    // I-50: race each per-server connect against the external signal.
    const results = await Promise.all(
      enabledConfigs.map((config) => {
        const attempt = this.beginConnection(config);
        return raceWithSignal(
          attempt.promise,
          signal,
          timeoutMs,
          `MCP server "${config.name}" connect`,
          attempt.gate,
        )
          .then(
            (bridge) => ({ status: "fulfilled" as const, value: bridge }),
            (err: unknown) => ({ status: "rejected" as const, reason: err }),
          );
      }),
    );

    // A concurrent stop owns the current state. Late results are cleaned up by
    // connectServer's gate and must not republish status.
    if (!this.running || this.lifecycleGeneration !== generation) return;

    let successCount = 0;
    const failures: Array<{ name: string; reason: unknown }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const cfg = enabledConfigs[i];
      if (result.status === "fulfilled") {
        successCount++;
        this.connectionStates.set(cfg.name, { type: "connected" });
      } else {
        this.connectionStates.set(cfg.name, {
          type: "failed",
          error: errMessage(result.reason),
        });
        failures.push({ name: cfg.name, reason: result.reason });
        this.logger.error(
          `Failed to connect to MCP server "${cfg.name}":`,
          result.reason,
        );
      }
    }

    const totalTools = this.getTools().length;
    this.logger.info(
      `MCP: ${successCount}/${enabledConfigs.length} servers connected, ${totalTools} tools available`,
    );

    // I-20: aggregate-failure check.
    if (opts.requiredServers && opts.requiredServers.length > 0) {
      const missing = opts.requiredServers.filter(
        (name) => !this.bridges.has(name),
      );
      if (missing.length > 0) {
        const reason = failures
          .filter((f) => missing.includes(f.name))
          .map((f) => `${f.name}: ${errMessage(f.reason)}`)
          .join("; ");
        throw new Error(
          `MCP aggregate startup failure — required server(s) not ready: ${missing.join(", ")}${reason ? ` (${reason})` : ""}`,
        );
      }
    } else if (opts.requireOneReady && successCount === 0) {
      const detail = failures
        .map((f) => `${f.name}: ${errMessage(f.reason)}`)
        .join("; ");
      throw new Error(
        `MCP aggregate startup failure — zero servers ready${detail ? ` (${detail})` : ""}`,
      );
    }
  }

  /**
   * Disconnect from all MCP servers and clean up resources.
   */
  async stop(): Promise<void> {
    await this.stopInternal(false);
  }

  private async stopInternal(strict: boolean): Promise<void> {
    const errors = await this.beginShutdown();
    if (strict && errors.length > 0) {
      throw new AggregateError(errors, "MCP manager strict shutdown failed");
    }
  }

  private beginShutdown(): Promise<ReadonlyArray<unknown>> {
    if (this.shutdownTask !== undefined) return this.shutdownTask;

    this.running = false;
    this.lifecycleGeneration++;
    for (const gate of this.startupGates) {
      gate.cancel("MCP manager stopped during startup");
    }
    for (const name of this.allKnownServerNames()) {
      this.invalidateServerAuthority(name);
    }
    const bridges = Array.from(this.bridges.values());
    const resourceBridges = Array.from(this.resourceBridges.values());
    const promptBridges = Array.from(this.promptBridges.values());
    const attempts = Array.from(this.connectionAttempts);
    const reconnectOperations = Array.from(this.reconnectOperations);
    // Remove every published surface before awaiting teardown. An in-flight
    // caller can no longer discover a bridge once stop begins.
    this.bridges.clear();
    this.resourceBridges.clear();
    this.promptBridges.clear();
    this.connectedConnections.clear();
    this.serverInstructions.clear();
    this.resetConnectionStates();

    const disposalCount =
      bridges.length + resourceBridges.length + promptBridges.length;
    const task = Promise.allSettled([
      ...bridges.map(invokeDisposal),
      ...resourceBridges.map(invokeDisposal),
      ...promptBridges.map(invokeDisposal),
      ...attempts.map((attempt) => attempt.promise),
      ...reconnectOperations.map((operation) => operation.promise),
    ]).then((results): ReadonlyArray<unknown> => {
      const errors: unknown[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result?.status !== "rejected") continue;
        if (
          index < disposalCount ||
          result.reason instanceof MCPConnectionCleanupError
        ) {
          errors.push(result.reason);
        }
      }
      for (const error of errors) {
        this.logger.warn?.("Error disconnecting MCP server:", error);
      }
      this.logger.info("All MCP servers disconnected");
      return errors;
    });
    this.shutdownTask = task;
    void task.finally(() => {
      if (this.shutdownTask === task) this.shutdownTask = undefined;
    });
    return task;
  }

  /**
   * Replace the configured MCP server set without replacing this
   * manager instance. The registry holds a provider reference to this
   * object, so config reloads must refresh in place rather than
   * swapping in a new manager behind stale callers.
   */
  async refreshServers(
    configs: ReadonlyArray<MCPServerConfig>,
    opts: MCPManagerStartOpts = {},
  ): Promise<void> {
    await this.stop();
    this.configs = [...configs];
    await this.start(opts);
  }

  /**
   * Get all tools from all connected MCP servers.
   */
  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const bridge of this.bridges.values()) {
      tools.push(...bridge.tools);
    }
    return tools;
  }

  /**
   * Get tools from a specific MCP server.
   */
  getToolsByServer(name: string): Tool[] {
    return this.bridges.get(name)?.tools ?? [];
  }

  /**
   * Get the names of all connected servers.
   */
  getConnectedServers(): string[] {
    return Array.from(this.bridges.keys());
  }

  getConnectedConnection(name: string): ConnectedMCPServer | undefined {
    return this.connectedConnections.get(name);
  }

  /**
   * Return the `InitializeResult.instructions` blob the server reported
   * at connect time, or `undefined` if the server didn't supply one (or
   * the bridge isn't connected). Read by the per-turn
   * `mcp_instructions_delta` attachment producer to compute add/remove
   * deltas across turns.
   */
  getServerInstructions(name: string): string | undefined {
    return this.serverInstructions.get(name);
  }

  getConfiguredServers(): readonly MCPServerConfig[] {
    return [...this.configs];
  }

  getServerConfig(name: string): MCPServerConfig | undefined {
    return this.configs.find((config) => config.name === name);
  }

  isConnected(name: string): boolean {
    return this.bridges.has(name);
  }

  /**
   * Given a namespaced MCP tool name (`mcp.<server>.<tool>`), return
   * the owning server name if the tool is registered on a connected
   * bridge. Returns `undefined` otherwise.
   *
   * Router replacement for the brittle `namespace.startsWith("mcp")`
   * heuristic — the router now resolves MCP attribution through this
   * lookup instead of prefix-matching the stringified name.
   */
  getServerForTool(namespacedName: string): string | undefined {
    for (const [serverName, bridge] of this.bridges) {
      for (const tool of bridge.tools) {
        if (tool.name === namespacedName) return serverName;
      }
    }
    return undefined;
  }

  /**
   * Port of donor runtime `Session::resolve_mcp_tool_info` (session.rs). Given
   * a tool name the model emitted, either return `{ serverName,
   * toolName }` when the tool is MCP-backed, or `undefined`.
   *
   * Accepts both the namespaced `mcp.<server>.<tool>` form and a plain
   * tool name that matches a single registered MCP tool.
   */
  resolveMcpToolInfo(
    toolName: string,
  ): { readonly serverName: string; readonly toolName: string } | undefined {
    if (toolName.startsWith("mcp.")) {
      const server = this.getServerForTool(toolName);
      if (!server) return undefined;
      const prefix = `mcp.${server}.`;
      if (!toolName.startsWith(prefix)) return undefined;
      return { serverName: server, toolName: toolName.slice(prefix.length) };
    }
    for (const [serverName, bridge] of this.bridges) {
      for (const tool of bridge.tools) {
        if (tool.name === toolName) {
          return { serverName, toolName };
        }
      }
    }
    return undefined;
  }

  async reconnectServer(name: string): Promise<MCPReconnectResult> {
    const config = this.getServerConfig(name);
    if (!config) {
      return {
        serverName: name,
        success: false,
        toolCount: 0,
        error: `MCP server "${name}" is not configured.`,
      };
    }
    if (config.enabled === false) {
      this.connectionStates.set(name, { type: "disabled" });
      return {
        serverName: name,
        success: false,
        toolCount: 0,
        error: `MCP server "${name}" is disabled in config.`,
      };
    }

    return this.enqueueReconnect(config);
  }

  private enqueueReconnect(
    config: MCPServerConfig,
  ): Promise<MCPReconnectResult> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const running = this.running;
    const previous = this.reconnectTails.get(config.name) ?? Promise.resolve();
    const promise = previous.then(() =>
      this.performReconnect(config, lifecycleGeneration, running),
    );
    const operation: ManagedReconnectOperation = {
      serverName: config.name,
      promise,
    };
    this.reconnectOperations.add(operation);
    const tail = promise.then(
      () => undefined,
      () => undefined,
    );
    this.reconnectTails.set(config.name, tail);
    const remove = (): void => {
      this.reconnectOperations.delete(operation);
      if (this.reconnectTails.get(config.name) === tail) {
        this.reconnectTails.delete(config.name);
      }
    };
    void tail.then(remove);

    return promise.catch((error: unknown) => {
      if (this.isReconnectLifecycleCurrent(lifecycleGeneration, running)) {
        this.connectionStates.set(config.name, {
          type: "failed",
          error: errMessage(error),
        });
      }
      return reconnectFailure(config.name, error);
    });
  }

  private async performReconnect(
    config: MCPServerConfig,
    lifecycleGeneration: number,
    running: boolean,
  ): Promise<MCPReconnectResult> {
    if (!this.isReconnectLifecycleCurrent(lifecycleGeneration, running)) {
      return reconnectFailure(
        config.name,
        new Error(`MCP server "${config.name}" reconnect lifecycle expired`),
      );
    }
    this.connectionStates.set(config.name, { type: "pending" });
    await this.disconnectServer(config.name, "before reconnect", true);

    if (!this.isReconnectLifecycleCurrent(lifecycleGeneration, running)) {
      return reconnectFailure(
        config.name,
        new Error(`MCP server "${config.name}" reconnect cancelled by shutdown`),
      );
    }

    try {
      const attempt = this.beginConnection(config);
      const bridge = await attempt.promise;
      if (
        !attempt.isCurrent() ||
        !this.isReconnectLifecycleCurrent(lifecycleGeneration, running)
      ) {
        return reconnectFailure(
          config.name,
          new Error(`MCP server "${config.name}" reconnect cancelled by shutdown`),
        );
      }
      this.connectionStates.set(config.name, { type: "connected" });
      return {
        serverName: config.name,
        success: true,
        toolCount: bridge.tools.length,
      };
    } catch (error) {
      if (this.isReconnectLifecycleCurrent(lifecycleGeneration, running)) {
        this.connectionStates.set(config.name, {
          type: "failed",
          error: errMessage(error),
        });
      }
      return reconnectFailure(config.name, error);
    }
  }

  private isReconnectLifecycleCurrent(
    lifecycleGeneration: number,
    running: boolean,
  ): boolean {
    return (
      this.shutdownTask === undefined &&
      this.lifecycleGeneration === lifecycleGeneration &&
      this.running === running
    );
  }

  async enableServer(name: string): Promise<MCPServerMutationResult> {
    const config = this.getServerConfig(name);
    if (!config) {
      return {
        serverName: name,
        success: false,
        toolCount: 0,
        error: `MCP server "${name}" is not configured.`,
      };
    }
    config.enabled = true;
    if (this.bridges.has(name)) {
      return {
        serverName: name,
        success: true,
        toolCount: this.getToolsByServer(name).length,
      };
    }
    return this.reconnectServer(name);
  }

  async disableServer(name: string): Promise<MCPServerMutationResult> {
    const config = this.getServerConfig(name);
    if (!config) {
      return {
        serverName: name,
        success: false,
        toolCount: 0,
        error: `MCP server "${name}" is not configured.`,
      };
    }
    config.enabled = false;
    await this.disconnectServer(name, "after disable");
    this.connectionStates.set(name, { type: "disabled" });
    return {
      serverName: name,
      success: true,
      toolCount: 0,
    };
  }

  async addServer(config: MCPServerConfig): Promise<MCPServerMutationResult> {
    if (!isValidMcpServerName(config.name)) {
      return {
        serverName: config.name,
        success: false,
        toolCount: 0,
        error: `Invalid MCP server name "${config.name}". Names can only contain letters, numbers, hyphens, and underscores.`,
      };
    }
    if (this.getServerConfig(config.name)) {
      return {
        serverName: config.name,
        success: false,
        toolCount: 0,
        error: `MCP server "${config.name}" is already configured.`,
      };
    }
    const nextConfig: MCPServerConfig = {
      ...config,
      ...(config.args !== undefined ? { args: [...config.args] } : {}),
      ...(config.headers !== undefined
        ? { headers: { ...config.headers } }
        : {}),
      ...(config.env !== undefined ? { env: { ...config.env } } : {}),
    };
    const previousConfigs = this.configs;
    this.configs = [...previousConfigs, nextConfig];
    const result = await this.reconnectServer(nextConfig.name);
    if (!result.success) {
      await this.disconnectServer(nextConfig.name, "after failed add");
      this.configs = previousConfigs;
      this.connectionStates.delete(nextConfig.name);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // T9-D: MCP resource + prompt surface
  // ─────────────────────────────────────────────────────────────────

  /**
   * List resources exposed by every connected server (flattened).
   * Per-server failures are swallowed by the resource bridge itself,
   * so the aggregate result only contains servers that successfully
   * listed resources.
   */
  async getResources(): Promise<ReadonlyArray<MCPResourceDescriptor>> {
    const bridges = Array.from(this.resourceBridges.values());
    if (bridges.length === 0) return [];
    const results = await Promise.allSettled(
      bridges.map((bridge) => bridge.listResources()),
    );
    const flattened: MCPResourceDescriptor[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        flattened.push(...result.value);
      }
    }
    return flattened;
  }

  /**
   * List resources exposed by a specific connected server.
   * Returns `[]` if the server is unknown or has no resource bridge.
   */
  async getResourcesByServer(
    name: string,
  ): Promise<ReadonlyArray<MCPResourceDescriptor>> {
    const bridge = this.resourceBridges.get(name);
    if (!bridge) return [];
    return bridge.listResources();
  }

  /**
   * Read a resource by its namespaced name `mcp.<server>.<uri>`.
   * Returns `null` when the referenced server is not connected.
   */
  async readResource(
    namespacedName: string,
  ): Promise<MCPResourceContent | null> {
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) return null;
    const bridge = this.resourceBridges.get(parsed.serverName);
    if (!bridge) return null;
    return bridge.readResource(parsed.rest);
  }

  /**
   * List prompts exposed by every connected server (flattened).
   */
  async listPrompts(): Promise<ReadonlyArray<MCPPromptDescriptor>> {
    const bridges = Array.from(this.promptBridges.values());
    if (bridges.length === 0) return [];
    const results = await Promise.allSettled(
      bridges.map((bridge) => bridge.listPrompts()),
    );
    const flattened: MCPPromptDescriptor[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        flattened.push(...result.value);
      }
    }
    return flattened;
  }

  /**
   * List prompts exposed by a specific connected server.
   */
  async listPromptsByServer(
    name: string,
  ): Promise<ReadonlyArray<MCPPromptDescriptor>> {
    const bridge = this.promptBridges.get(name);
    if (!bridge) return [];
    return bridge.listPrompts();
  }

  /**
   * Render a prompt by namespaced name `mcp.<server>.<prompt>`.
   * Returns `null` when the referenced server is not connected.
   */
  async renderPrompt(
    namespacedName: string,
    args?: Record<string, unknown>,
  ): Promise<MCPPromptRendered | null> {
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) return null;
    const bridge = this.promptBridges.get(parsed.serverName);
    if (!bridge) return null;
    return bridge.renderPrompt(parsed.rest, args);
  }

  /**
   * (Re)build the resource + prompt bridges for `config` against `client`,
   * replacing any existing bridges for the server. Shared by the initial
   * connect and the resilient bridge's reconnect hook so a reconnected
   * server's resource/prompt surface tracks the live client instead of a
   * stale, closed one.
   *
   * T9-D: resource + prompt bridges are optional on many servers; a failure
   * to build either must not take down the server connection — log and move
   * on so the tool surface still works. Each refresh has a publication epoch:
   * only the latest owner may replace the maps, and a missing replacement
   * removes the old bridge because it points at a client that has already
   * closed. Companion `dispose()` only flips an internal flag; the tool bridge
   * owns the client lifecycle.
   */
  private async refreshResourceAndPromptBridges(
    config: MCPServerConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    startupGate?: StartupGate,
    isCurrent: () => boolean = () => true,
  ): Promise<RefreshedCompanionBridges> {
    let createdResourceBridge: MCPResourceBridge | undefined;
    let createdPromptBridge: MCPPromptBridge | undefined;
    const abandonCreatedBridges = async (): Promise<void> => {
      await Promise.allSettled([
        ...(createdResourceBridge !== undefined
          ? [invokeDisposal(createdResourceBridge)]
          : []),
        ...(createdPromptBridge !== undefined
          ? [invokeDisposal(createdPromptBridge)]
          : []),
      ]);
    };
    try {
      assertRefreshOpen(config.name, startupGate, isCurrent);
      createdResourceBridge = await createResourceBridge(
        client,
        config.name,
        this.logger,
        {
          ...(config.timeout !== undefined
            ? { rpcTimeoutMs: config.timeout }
            : {}),
        },
      );
      assertRefreshOpen(config.name, startupGate, isCurrent);
    } catch (error) {
      if (startupGate?.isCancelled() || !isCurrent()) {
        await abandonCreatedBridges();
        throw error;
      }
      this.logger.warn?.(
        `MCP server "${config.name}" resource bridge unavailable:`,
        error,
      );
    }

    try {
      assertRefreshOpen(config.name, startupGate, isCurrent);
      createdPromptBridge = await createPromptBridge(
        client,
        config.name,
        this.logger,
        {
          ...(config.timeout !== undefined
            ? { rpcTimeoutMs: config.timeout }
            : {}),
        },
      );
      assertRefreshOpen(config.name, startupGate, isCurrent);
    } catch (error) {
      if (startupGate?.isCancelled() || !isCurrent()) {
        await abandonCreatedBridges();
        throw error;
      }
      this.logger.warn?.(
        `MCP server "${config.name}" prompt bridge unavailable:`,
        error,
      );
    }

    assertRefreshOpen(config.name, startupGate, isCurrent);
    const previousResource = this.resourceBridges.get(config.name);
    const previousPrompt = this.promptBridges.get(config.name);
    if (createdResourceBridge !== undefined) {
      this.resourceBridges.set(config.name, createdResourceBridge);
    } else {
      this.resourceBridges.delete(config.name);
    }
    if (createdPromptBridge !== undefined) {
      this.promptBridges.set(config.name, createdPromptBridge);
    } else {
      this.promptBridges.delete(config.name);
    }
    await Promise.allSettled([
      ...(previousResource !== undefined
        ? [invokeDisposal(previousResource)]
        : []),
      ...(previousPrompt !== undefined ? [invokeDisposal(previousPrompt)] : []),
    ]);
    return {
      ...(createdResourceBridge !== undefined
        ? { resourceBridge: createdResourceBridge }
        : {}),
      ...(createdPromptBridge !== undefined
        ? { promptBridge: createdPromptBridge }
        : {}),
    };
  }

  private async connectServer(
    config: MCPServerConfig,
    startupGate: StartupGate,
    isCurrent: () => boolean,
  ): Promise<MCPToolBridge> {
    const client = await createMCPConnection(
      config,
      this.logger,
      this.elicitationHandlers,
      this.samplingHandlers,
      this.sandboxExecutionBroker,
    );
    let bridge: ResilientMCPBridge | undefined;
    let companions: RefreshedCompanionBridges | undefined;
    try {
      assertRefreshOpen(config.name, startupGate, isCurrent);
      // Capture the server's `InitializeResult.instructions` blob if any.
      // The MCP SDK stores it after `client.connect()` completes; the
      // value is immutable for the lifetime of the connection.
      const capabilities = readClientCapabilities(client);
      const serverInfo = readClientServerInfo(client);
      const instructions = readClientInstructions(client);
      const rawBridge = await createToolBridge(
        client,
        config.name,
        this.logger,
        {
          listToolsTimeoutMs: config.timeout,
          callToolTimeoutMs: config.timeout,
          serverConfig: toToolCatalogPolicyConfig(config),
          ...(this.callObserver !== undefined
            ? { callObserver: this.callObserver }
            : {}),
          ...(this.permissionOptions !== undefined
            ? { permissions: this.permissionOptions }
            : {}),
        },
      );
      assertRefreshOpen(config.name, startupGate, isCurrent);
      // I-73: reject MCP tools whose namespaced names collide with
      // already-registered tools (from earlier servers). Bail the
      // whole bridge — the caller can re-configure the namespace.
      this.assertNoNameShadowing(config.name, rawBridge);
      bridge = new ResilientMCPBridge(config, rawBridge, this.logger, {
        ...(this.permissionOptions !== undefined
          ? { permissions: this.permissionOptions }
          : {}),
        // Reconnect parity: forward the same call observer the initial
        // `createToolBridge` above received so reconnected bridges keep
        // emitting local `mcp_tool_call_*` events.
        ...(this.callObserver !== undefined
          ? { callObserver: this.callObserver }
          : {}),
        // gaphunt3 #14: forward the session's elicitation handlers so the
        // resilient bridge re-registers them on the fresh client it spawns
        // during reconnect — otherwise server-initiated elicitation breaks
        // silently after a transient drop.
        ...(this.elicitationHandlers !== undefined
          ? { elicitationHandlers: this.elicitationHandlers }
          : {}),
        ...(this.samplingHandlers !== undefined
          ? { samplingHandlers: this.samplingHandlers }
          : {}),
        ...(this.sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker: this.sandboxExecutionBroker }
          : {}),
        // On automatic reconnect the resilient bridge rebuilds only the
        // tool surface and spawns a fresh client. Rebuild the resource +
        // prompt bridges against that new client too — otherwise they keep
        // pointing at the OLD, closed client and `readResource` /
        // `renderPrompt` would talk to a dead connection.
        onReconnect: async (newClient: unknown) => {
          const reconnectIsCurrent = (): boolean =>
            isCurrent() && this.bridges.get(config.name) === bridge;
          if (!reconnectIsCurrent()) return;
          const companionIsCurrent = this.beginCompanionRefresh(
            config.name,
            reconnectIsCurrent,
          );
          await this.refreshResourceAndPromptBridges(
            config,
            newClient,
            undefined,
            companionIsCurrent,
          );
        },
      });
      // Publish before the optional companion bridges are constructed so
      // concurrently-starting servers observe this namespace for I-73 shadow
      // checks. The startup gate is checked immediately beforehand and stop
      // clears/disposes this identity while companion construction is pending.
      assertRefreshOpen(config.name, startupGate, isCurrent);
      this.bridges.set(config.name, bridge);

      // T9-D: resource + prompt bridges are optional on many servers.
      // Failures here must not take down the whole server connection —
      // log and continue so the tool surface still works.
      companions = await this.refreshResourceAndPromptBridges(
        config,
        client,
        startupGate,
        this.beginCompanionRefresh(config.name, isCurrent),
      );
      assertRefreshOpen(config.name, startupGate, isCurrent);

      if (instructions !== undefined) {
        this.serverInstructions.set(config.name, instructions);
      }

      this.connectedConnections.set(config.name, {
        type: "connected",
        name: config.name,
        client: client as never,
        capabilities,
        ...(serverInfo !== undefined ? { serverInfo } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        config: toScopedMcpServerConfig(config),
        cleanup: async () => {
          await this.disconnectServer(
            config.name,
            "via connected connection cleanup",
          );
        },
      });
      this.connectionStates.set(config.name, { type: "connected" });
      return bridge;
    } catch (error) {
      if (bridge !== undefined && this.bridges.get(config.name) === bridge) {
        this.bridges.delete(config.name);
      }
      if (
        companions?.resourceBridge !== undefined &&
        this.resourceBridges.get(config.name) === companions.resourceBridge
      ) {
        this.resourceBridges.delete(config.name);
      }
      if (
        companions?.promptBridge !== undefined &&
        this.promptBridges.get(config.name) === companions.promptBridge
      ) {
        this.promptBridges.delete(config.name);
      }
      const cleanupResults = await Promise.allSettled([
        ...(bridge !== undefined ? [invokeDisposal(bridge)] : []),
        ...(companions?.resourceBridge !== undefined
          ? [invokeDisposal(companions.resourceBridge)]
          : []),
        ...(companions?.promptBridge !== undefined
          ? [invokeDisposal(companions.promptBridge)]
          : []),
        ...(bridge === undefined ? [invokeClientClose(client)] : []),
      ]);
      const cleanupErrors = cleanupResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (cleanupErrors.length > 0) {
        throw new MCPConnectionCleanupError(
          config.name,
          error,
          cleanupErrors,
        );
      }
      throw error;
    }
  }

  private beginConnection(config: MCPServerConfig): ManagedConnectionAttempt {
    if (this.shutdownTask !== undefined) {
      throw new Error(
        `MCP server "${config.name}" cannot connect while shutdown is in progress`,
      );
    }
    const gate = createStartupGate();
    const lifecycleGeneration = this.lifecycleGeneration;
    const serverEpoch = this.nextServerEpoch(config.name);
    const isCurrent = (): boolean =>
      this.shutdownTask === undefined &&
      this.lifecycleGeneration === lifecycleGeneration &&
      this.serverEpochs.get(config.name) === serverEpoch;
    const promise = this.connectServer(config, gate, isCurrent);
    const attempt: ManagedConnectionAttempt = {
      serverName: config.name,
      gate,
      promise,
      isCurrent,
    };
    this.startupGates.add(gate);
    this.connectionAttempts.add(attempt);
    const remove = (): void => {
      this.startupGates.delete(gate);
      this.connectionAttempts.delete(attempt);
    };
    void promise.then(remove, remove);
    return attempt;
  }

  private beginCompanionRefresh(
    serverName: string,
    ownerIsCurrent: () => boolean,
  ): () => boolean {
    const epoch = (this.companionEpochs.get(serverName) ?? 0) + 1;
    this.companionEpochs.set(serverName, epoch);
    return () =>
      ownerIsCurrent() && this.companionEpochs.get(serverName) === epoch;
  }

  private nextServerEpoch(serverName: string): number {
    const epoch = (this.serverEpochs.get(serverName) ?? 0) + 1;
    this.serverEpochs.set(serverName, epoch);
    return epoch;
  }

  private invalidateServerAuthority(serverName: string): void {
    this.nextServerEpoch(serverName);
    this.companionEpochs.set(
      serverName,
      (this.companionEpochs.get(serverName) ?? 0) + 1,
    );
  }

  private allKnownServerNames(): Set<string> {
    return new Set([
      ...this.configs.map((config) => config.name),
      ...this.bridges.keys(),
      ...this.resourceBridges.keys(),
      ...this.promptBridges.keys(),
      ...Array.from(this.connectionAttempts, (attempt) => attempt.serverName),
      ...Array.from(
        this.reconnectOperations,
        (operation) => operation.serverName,
      ),
    ]);
  }

  private assertNoNameShadowing(
    serverName: string,
    bridge: MCPToolBridge,
  ): void {
    const existing = new Set<string>();
    for (const b of this.bridges.values()) {
      for (const t of b.tools) existing.add(t.name);
    }
    const collisions: string[] = [];
    for (const tool of bridge.tools) {
      if (existing.has(tool.name)) collisions.push(tool.name);
    }
    if (collisions.length > 0) {
      throw new Error(
        `MCP server "${serverName}" tools shadow already-registered tool names (I-73): ${collisions.join(", ")}`,
      );
    }
  }

  private async disconnectServer(
    name: string,
    reason: string,
    strictCleanup = false,
  ): Promise<void> {
    this.invalidateServerAuthority(name);
    const attempts = Array.from(this.connectionAttempts).filter(
      (attempt) => attempt.serverName === name,
    );
    for (const attempt of attempts) {
      attempt.gate.cancel(`MCP server "${name}" disconnected ${reason}`);
    }
    const existing = this.bridges.get(name);
    const existingResource = this.resourceBridges.get(name);
    const existingPrompt = this.promptBridges.get(name);
    this.connectedConnections.delete(name);
    this.bridges.delete(name);
    this.resourceBridges.delete(name);
    this.promptBridges.delete(name);
    this.serverInstructions.delete(name);

    const disposalCount =
      (existing === undefined ? 0 : 1) +
      (existingResource === undefined ? 0 : 1) +
      (existingPrompt === undefined ? 0 : 1);
    const results = await Promise.allSettled([
      ...(existing !== undefined ? [invokeDisposal(existing)] : []),
      ...(existingResource !== undefined
        ? [invokeDisposal(existingResource)]
        : []),
      ...(existingPrompt !== undefined ? [invokeDisposal(existingPrompt)] : []),
      ...attempts.map((attempt) => attempt.promise),
    ]);
    const cleanupErrors: unknown[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status !== "rejected") continue;
      if (
        index < disposalCount ||
        result.reason instanceof MCPConnectionCleanupError
      ) {
        cleanupErrors.push(result.reason);
        this.logger.warn?.(
          `Error disposing MCP server "${name}" ${reason}:`,
          result.reason,
        );
      }
    }
    if (strictCleanup && cleanupErrors.length > 0) {
      throw new MCPConnectionCleanupError(name, reason, cleanupErrors);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reconnectFailure(
  serverName: string,
  error: unknown,
): MCPReconnectResult {
  return {
    serverName,
    success: false,
    toolCount: 0,
    error: errMessage(error),
  };
}

function isValidMcpServerName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Parse a `mcp.<serverName>.<rest>` namespaced identifier.
 * Returns `null` when the input does not match the namespace prefix
 * or is missing the `rest` segment. `rest` can itself contain `.`
 * (resource URIs frequently do), so this only splits on the first
 * two separators.
 */
function parseNamespacedName(
  namespacedName: string,
): { serverName: string; rest: string } | null {
  if (!namespacedName.startsWith("mcp.")) return null;
  const afterPrefix = namespacedName.slice("mcp.".length);
  const firstDot = afterPrefix.indexOf(".");
  if (firstDot <= 0) return null;
  const serverName = afterPrefix.slice(0, firstDot);
  const rest = afterPrefix.slice(firstDot + 1);
  if (rest.length === 0) return null;
  return { serverName, rest };
}

/**
 * Race a promise against an abort signal and an absolute timeout.
 * I-50 uses this so an orchestrator can cancel MCP startup mid-wait
 * (e.g. when the user hits Ctrl+C before any server connects).
 */
function raceWithSignal<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  startupGate?: StartupGate,
): Promise<T> {
  const contenders: Promise<T>[] = [task];
  if (startupGate !== undefined) {
    contenders.push(startupGate.waitForCancellation());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  if (signal) {
    contenders.push(
      new Promise<T>((_, reject) => {
        if (signal.aborted) {
          const reason = `${label} aborted (${signal.reason ?? "signal"})`;
          startupGate?.cancel(reason);
          reject(new Error(reason));
          return;
        }
        onAbort = () => {
          const reason = `${label} aborted (${signal.reason ?? "signal"})`;
          startupGate?.cancel(reason);
          reject(new Error(reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  contenders.push(
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const reason = `${label} timed out after ${timeoutMs}ms`;
        startupGate?.cancel(reason);
        reject(new Error(reason));
      }, timeoutMs);
    }),
  );

  return Promise.race(contenders).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && signal) {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

function createStartupGate(): StartupGate {
  let cancelled = false;
  let cancelReason: string | undefined;
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  // Dynamic connection attempts use the same gate without racing the
  // cancellation promise directly. Keep cancellation observed here; callers
  // that do wait on it still receive the original rejection.
  void cancellation.catch(() => undefined);
  return {
    cancel(reason: string) {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
      rejectCancellation?.(new Error(reason));
    },
    isCancelled() {
      return cancelled;
    },
    reason() {
      return cancelReason;
    },
    waitForCancellation() {
      return cancellation;
    },
  };
}

function assertStartupGateOpen(
  serverName: string,
  startupGate: StartupGate | undefined,
): void {
  if (!startupGate?.isCancelled()) return;
  throw new Error(
    `MCP server "${serverName}" startup abandoned (${startupGate.reason() ?? "cancelled"})`,
  );
}

function assertRefreshOpen(
  serverName: string,
  startupGate: StartupGate | undefined,
  isCurrent: () => boolean,
): void {
  assertStartupGateOpen(serverName, startupGate);
  if (isCurrent()) return;
  throw new Error(`MCP server "${serverName}" bridge refresh abandoned`);
}

function invokeDisposal(disposable: {
  dispose(): Promise<void>;
}): Promise<void> {
  return Promise.resolve().then(() => disposable.dispose());
}

function invokeClientClose(client: unknown): Promise<void> {
  return Promise.resolve().then(() =>
    (client as { close(): Promise<void> }).close(),
  );
}
