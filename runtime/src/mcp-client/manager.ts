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
  MCPToolBridge,
} from "./types.js";
import type {
  ConnectedMCPServer,
  ScopedMcpServerConfig,
} from "../services/mcp/types.js";
import type { Tool, ToolResult } from "./_deps/tools-types.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import { hasLocalMcpAccess, attachmentLogger, redactMcpAttachmentText, redactMcpAttachmentValue } from "./local-control.js";
import { hasDesktopAuthority, isAuthenticatedDesktopToolName } from "./desktop-authority.js";
import { createMCPConnection } from "./connection.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import {
  EMPTY_MCP_REQUEST_ENVIRONMENT,
  snapshotMcpRequestEnvironment,
} from "./environment.js";
import {
  createToolBridge,
  withoutMcpExecutionOnlyArgs,
} from "./tools.js";
import {
  ResilientMCPBridge,
  toToolCatalogPolicyConfig,
} from "./resilient-client.js";
import type {
  MCPCallObserver,
  MCPProgressCallback,
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
import { MCPTransportCleanupError } from "./transports/connect-with-cleanup.js";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertValidMcpServerName } from "./server-name.js";
import { isMcpAuthenticationError } from "../services/mcp/auth-errors.js";
import { fingerprintPluginCatalogConfig, hashInstalledPlugin, primePluginCatalogSingleFlight, readPluginCatalog, writePluginCatalog, type PluginCatalog, type PluginCatalogIdentity } from "./plugin-catalog-cache.js";
import { reservePluginProcess, releasePluginProcess, touchPluginProcess, notifyPluginProcessIdle } from "./plugin-process-budget.js";

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
  /**
   * Internal config-publication handshake. `refreshServers()` invokes this at
   * most once, only after the previous connections are strictly stopped and
   * the replacement config is installed in the sandbox-resume deferred slot.
   * Ordinary startup callers must leave it unset.
   */
  readonly onSandboxRefreshDeferred?: () => void;
}

/**
 * Execution context propagated from an already-admitted internal caller.
 * `MCPManager.callTool` does not acquire session effect admission itself.
 */
export interface MCPManagerToolCallOptions {
  /** Cancel the physical MCP request; the call settles with the transport. */
  readonly signal?: AbortSignal;
  /** Trusted runtime call identity used by observers, persistence, and request metadata. */
  readonly callId?: string;
  /** Receives only the canonical bridge's bounded, sanitized progress events. */
  readonly onProgress?: MCPProgressCallback;
}

type MCPExecutionArgumentName =
  | "__abortSignal"
  | "__callId"
  | "__onProgress";

function defineMcpExecutionArgument(
  args: Record<string, unknown>,
  name: MCPExecutionArgumentName,
  value: unknown,
): void {
  if (value === undefined) return;
  Object.defineProperty(args, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function withoutStartSignal(
  opts: MCPManagerStartOpts,
): Omit<
  MCPManagerStartOpts,
  "signal" | "onSandboxRefreshDeferred"
> {
  return {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.requireOneReady !== undefined
      ? { requireOneReady: opts.requireOneReady }
      : {}),
    ...(opts.requiredServers !== undefined
      ? { requiredServers: [...opts.requiredServers] }
      : {}),
  };
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

interface RetainedCleanupOwner {
  readonly identity: unknown;
  readonly dispose: () => Promise<void>;
  error: unknown;
}

interface ServerCleanupOwner extends RetainedCleanupOwner {
  readonly serverName: string;
}

interface RetainedServerCleanup {
  readonly owners: Map<unknown, RetainedCleanupOwner>;
  readonly unownedErrors: unknown[];
  retryTask?: Promise<void>;
}

interface DeferredMcpRefresh {
  readonly promise: Promise<void>;
  readonly opts: MCPManagerStartOpts;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
  cancelled: boolean;
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
  | { readonly type: "connected" | "pending" | "disabled" | "needs-auth" | "stopped" }
  | { readonly type: "failed"; readonly error?: string };

function requireMcpConfigValue(
  serverName: string,
  label: "remote endpoint" | "stdio command",
  value: string | undefined,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`MCP server "${serverName}" is missing its ${label}`);
  }
  return value;
}

function immutableMcpServerConfig(config: MCPServerConfig): MCPServerConfig {
  assertValidMcpServerName(config.name);
  const tools =
    config.tools === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(config.tools).map(([name, policy]) => [
              name,
              Object.freeze({ ...policy }),
            ]),
          ),
        );
  return Object.freeze({
    ...config,
    ...(config.oauth === undefined ? {} : { oauth: Object.freeze({ ...config.oauth, ...(config.oauth.scopes ? { scopes: Object.freeze([...config.oauth.scopes]) } : {}) }) }),
    ...(config.args !== undefined
      ? { args: Object.freeze([...config.args]) }
      : {}),
    ...(config.headers !== undefined
      ? { headers: Object.freeze({ ...config.headers }) }
      : {}),
    ...(config.env !== undefined
      ? { env: Object.freeze({ ...config.env }) }
      : {}),
    ...(config.env_vars !== undefined
      ? { env_vars: Object.freeze([...config.env_vars]) }
      : {}),
    ...(config.enabled_tools !== undefined
      ? { enabled_tools: Object.freeze([...config.enabled_tools]) }
      : {}),
    ...(config.disabled_tools !== undefined
      ? { disabled_tools: Object.freeze([...config.disabled_tools]) }
      : {}),
    ...(config.virtual_no_fs_write_tools !== undefined
      ? {
          virtual_no_fs_write_tools: Object.freeze([
            ...config.virtual_no_fs_write_tools,
          ]),
        }
      : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(config.supplyChain !== undefined
      ? { supplyChain: Object.freeze({ ...config.supplyChain }) }
      : {}),
    ...(config.pluginSandbox !== undefined
      ? { pluginSandbox: Object.freeze({ ...config.pluginSandbox }) }
      : {}),
    ...(config.origin !== undefined
      ? {
          origin: Object.freeze({
            ...config.origin,
            ...(config.origin.pluginServer !== undefined
              ? {
                  pluginServer: Object.freeze({
                    ...config.origin.pluginServer,
                  }),
                }
              : {}),
          }),
        }
      : {}),
  });
}

export function toScopedMcpServerConfig(
  config: MCPServerConfig,
): ScopedMcpServerConfig {
  const authoritySource = config.origin?.scope;
  const scope =
    authoritySource === "managed"
      ? "managed" as const
      : authoritySource === "user" ||
          authoritySource === "project" ||
          authoritySource === "local"
        ? authoritySource
        : "dynamic" as const;
  const provenance = {
    scope,
    ...(authoritySource !== undefined && authoritySource !== "session"
      ? { authoritySource }
      : {}),
    ...(config.origin?.pluginSource !== undefined
      ? { pluginSource: config.origin.pluginSource }
      : {}),
    ...(config.origin?.pluginServer !== undefined
      ? { pluginServer: config.origin.pluginServer }
      : {}),
  };
  const policy = {
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.required !== undefined ? { required: config.required } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    ...(config.default_tools_approval_mode !== undefined
      ? { default_tools_approval_mode: config.default_tools_approval_mode }
      : {}),
    ...(config.enabled_tools !== undefined
      ? { enabled_tools: [...config.enabled_tools] }
      : {}),
    ...(config.disabled_tools !== undefined
      ? { disabled_tools: [...config.disabled_tools] }
      : {}),
    ...(config.virtual_no_fs_write_tools !== undefined
      ? {
          virtual_no_fs_write_tools: [
            ...config.virtual_no_fs_write_tools,
          ],
        }
      : {}),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
    ...(config.pinnedCatalogSha256 !== undefined
      ? { pinnedCatalogSha256: config.pinnedCatalogSha256 }
      : {}),
    ...(config.supplyChain !== undefined
      ? { supplyChain: { ...config.supplyChain } }
      : {}),
  };
  const transport = config.transport ?? "stdio";

  if (transport === "sse") {
    return {
      type: "sse",
      url: requireMcpConfigValue(
        config.name,
        "remote endpoint",
        config.endpoint,
      ),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...(config.oauth === undefined ? {} : { oauth: { ...config.oauth, scopes: config.oauth.scopes ? [...config.oauth.scopes] : undefined } }),
      ...policy,
      ...provenance,
    };
  }

  if (transport === "http") {
    return {
      type: "http",
      url: requireMcpConfigValue(
        config.name,
        "remote endpoint",
        config.endpoint,
      ),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...(config.oauth === undefined ? {} : { oauth: { ...config.oauth, scopes: config.oauth.scopes ? [...config.oauth.scopes] : undefined } }),
      ...policy,
      ...provenance,
    };
  }

  if (transport === "websocket") {
    return {
      type: "ws",
      url: requireMcpConfigValue(
        config.name,
        "remote endpoint",
        config.endpoint,
      ),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...policy,
      ...provenance,
    };
  }

  return {
    type: "stdio",
    command: requireMcpConfigValue(
      config.name,
      "stdio command",
      config.command,
    ),
    args: [...(config.args ?? [])],
    ...(config.env !== undefined ? { env: config.env } : {}),
    ...(config.env_vars !== undefined ? { env_vars: [...config.env_vars] } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...policy,
    ...provenance,
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
  private configs: readonly MCPServerConfig[];
  private readonly logger: Logger;
  private readonly environment: ProviderEnvironment;
  private readonly bridges: Map<string, MCPToolBridge> = new Map();
  private readonly cachedTools = new Map<string, Tool[]>();
  private readonly cachedCatalogs = new Map<string, PluginCatalog>();
  private readonly lazyStartTasks = new Map<string, Promise<void>>();
  private readonly lazyStartControllers = new Map<string, AbortController>();
  private readonly closingTasks = new Map<string, Promise<void>>();
  private catalogPrimeTask: Promise<void> | undefined;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeCalls = new Map<string, number>();
  private readonly pendingCalls = new Map<string, number>();
  private readonly processOwners = new Map<string, object>();
  private readonly pluginClientOwners = new Map<string, unknown>();
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
  private sandboxQuiesced = false;
  private running = false;
  private restartAfterSandboxTransition = false;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private deferredRefresh: DeferredMcpRefresh | undefined;
  private lastStartOpts: Omit<MCPManagerStartOpts, "signal"> = {};
  private lifecycleGeneration = 0;
  private readonly startupGates = new Set<StartupGate>();
  private readonly connectionAttempts = new Set<ManagedConnectionAttempt>();
  private readonly serverEpochs = new Map<string, number>();
  private readonly companionEpochs = new Map<string, number>();
  private readonly reconnectOperations = new Set<ManagedReconnectOperation>();
  private readonly reconnectTails = new Map<string, Promise<void>>();
  private readonly retainedCleanup = new Map<string, RetainedServerCleanup>();
  private readonly surfaceChangeListeners = new Set<() => void>();
  private shutdownTask: Promise<ReadonlyArray<unknown>> | undefined;

  constructor(
    configs: ReadonlyArray<MCPServerConfig>,
    logger: Logger = silentLogger,
    environment: ProviderEnvironment = EMPTY_MCP_REQUEST_ENVIRONMENT,
  ) {
    this.configs = Object.freeze(configs.map(immutableMcpServerConfig));
    this.logger = logger;
    this.environment = snapshotMcpRequestEnvironment(environment);
    this.resetConnectionStates();
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private deferRefreshUntilSandboxResume(
    opts: MCPManagerStartOpts,
  ): DeferredMcpRefresh {
    this.rejectDeferredRefresh(
      new Error("MCP refresh was superseded before sandbox resume"),
    );
    const deferredOpts: MCPManagerStartOpts = {
      ...withoutStartSignal(opts),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    let resolveRefresh: (() => void) | undefined;
    let rejectRefresh: ((error: unknown) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
    // A signal can reject before refreshServers reaches its final await. Keep
    // that short window from becoming an unhandled rejection.
    void promise.catch(() => undefined);
    let record: DeferredMcpRefresh;
    const onAbort = (): void => {
      if (this.deferredRefresh !== record) return;
      record.cancelled = true;
      this.deferredRefresh = undefined;
      this.restartAfterSandboxTransition = false;
      record.removeAbortListener();
      record.reject(
        new Error(
          `MCP refresh cancelled before sandbox resume (${deferredOpts.signal?.reason ?? "unspecified"})`,
        ),
      );
    };
    record = {
      promise,
      opts: deferredOpts,
      resolve: () => resolveRefresh?.(),
      reject: (error) => rejectRefresh?.(error),
      removeAbortListener: () =>
        deferredOpts.signal?.removeEventListener("abort", onAbort),
      cancelled: false,
    };
    this.deferredRefresh = record;
    if (deferredOpts.signal?.aborted === true) {
      onAbort();
    } else {
      deferredOpts.signal?.addEventListener("abort", onAbort, { once: true });
    }
    return record;
  }

  private resolveDeferredRefresh(record: DeferredMcpRefresh): void {
    if (this.deferredRefresh !== record) return;
    this.deferredRefresh = undefined;
    record.removeAbortListener();
    record.resolve();
  }

  private rejectDeferredRefresh(error: unknown): void {
    const record = this.deferredRefresh;
    if (record === undefined) return;
    this.deferredRefresh = undefined;
    record.cancelled = true;
    record.removeAbortListener();
    record.reject(error);
  }

  private isSandboxExecutionAuthorityClosed(): boolean {
    return (
      this.sandboxExecutionBroker?.isClosedAfterLifecycleAuthorityFailure?.() ===
      true
    );
  }

  private sandboxExecutionAuthorityClosedError(action: string): Error {
    return new Error(
      `MCP ${action} is blocked because sandbox execution authority is permanently closed`,
    );
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
    this.sandboxQuiesced = false;
    this.restartAfterSandboxTransition = false;
    this.sandboxExecutionBroker = broker;
    if (broker !== undefined) {
      this.unregisterSandboxLifecycle =
        registerSandboxExecutionLifecycleParticipant(broker, {
          name: "mcp-manager",
          spawnSurfaces: ["mcp_stdio"],
          quiesce: async () => {
            this.sandboxQuiesced = true;
            this.restartAfterSandboxTransition ||= this.running;
            // Revoke connection authority synchronously. The queued strict
            // stop then proves every owner is gone after any earlier refresh
            // transaction has yielded.
            void this.beginShutdown();
            await this.enqueueLifecycle(async () => {
              await this.stopInternal(true);
            });
          },
          resume: async () => {
            await this.enqueueLifecycle(async () => {
              if (!this.sandboxQuiesced) return;
              this.sandboxQuiesced = false;
              if (!this.restartAfterSandboxTransition) return;
              this.restartAfterSandboxTransition = false;
              const deferred = this.deferredRefresh;
              try {
                await this.start(deferred?.opts ?? this.lastStartOpts);
                if (deferred !== undefined) {
                  if (deferred.cancelled) {
                    await this.stopInternal(true);
                    return;
                  }
                  this.resolveDeferredRefresh(deferred);
                }
              } catch (error) {
                if (deferred?.cancelled === true) return;
                if (deferred !== undefined) {
                  this.rejectDeferredRefresh(error);
                }
                throw error;
              }
            });
          },
          dispose: async () => {
            this.sandboxQuiesced = true;
            this.restartAfterSandboxTransition = false;
            this.rejectDeferredRefresh(
              new Error("MCP refresh cancelled by sandbox disposal"),
            );
            void this.beginShutdown();
            await this.enqueueLifecycle(async () => {
              await this.stopInternal(true);
            });
          },
        });
    }
  }

  /**
   * Subscribe to invalidations of the manager's published MCP surface.
   *
   * The callback is synchronous so fail-closed revocation is observable before
   * transport cleanup yields. It carries no revision or snapshot: callers own
   * projection, equality, and coalescing at their boundary.
   */
  subscribeSurfaceChanges(listener: () => void): () => void {
    this.surfaceChangeListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.surfaceChangeListeners.delete(listener);
    };
  }

  private commitSurfaceMutation(mutation: () => void): void {
    mutation();
    this.notifySurfaceChanged();
  }

  private notifySurfaceChanged(): void {
    for (const listener of Array.from(this.surfaceChangeListeners)) {
      try {
        listener();
      } catch (error) {
        // Surface observers are downstream projections. A broken observer must
        // never interrupt connection publication or fail-closed revocation.
        try {
          this.logger.warn?.("MCP surface change listener failed:", error);
        } catch {
          // Logging is best-effort on this isolation path.
        }
      }
    }
  }

  getConnectionState(name: string): MCPConnectionState | undefined {
    const config = this.getServerConfig(name);
    if (config !== undefined && this.isSandboxExecutionAuthorityClosed()) {
      return {
        type: "failed",
        error: this.sandboxExecutionAuthorityClosedError(
          `server ${JSON.stringify(name)}`,
        ).message,
      };
    }
    if (config?.enabled === false) return { type: "disabled" };
    if (config !== undefined && !this.installedSnapshotCurrent(config)) return this.connectionStates.get(name);
    if (this.connectedConnections.has(name)) return { type: "connected" };
    const state = this.connectionStates.get(name);
    if (state?.type === "failed") return state;
    if (config !== undefined && this.retainedCleanup.has(name)) {
      return {
        type: "failed",
        error: `MCP server "${name}" cleanup remains unproven`,
      };
    }
    return state;
  }

  private resetConnectionStates(): void {
    this.commitSurfaceMutation(() => {
      this.connectionStates.clear();
      for (const config of this.configs) {
        this.connectionStates.set(config.name, {
          type: config.enabled === false ? "disabled" : this.isLazyPlugin(config) ? "stopped" : "pending",
        });
      }
    });
  }

  private pluginIdentity(config: MCPServerConfig): PluginCatalogIdentity | undefined {
    const plugin = config.origin?.pluginServer;
    if (config.origin?.scope !== "plugin" || !plugin?.digest || !config.pluginCatalogHome) return undefined;
    return {
      pluginName: plugin.pluginName, serverName: plugin.serverName,
      ...(plugin.version !== undefined ? { version: plugin.version } : {}),
      digest: plugin.digest, cacheHome: config.pluginCatalogHome,
      configFingerprint: fingerprintPluginCatalogConfig({
        transport: config.transport ?? "stdio", command: config.command,
        args: config.args, env: config.env, env_vars: config.env_vars,
        cwd: config.cwd, endpoint: config.endpoint, headers: config.headers,
        pluginSandbox: config.pluginSandbox,
        userConfigDigest: plugin.userConfigDigest,
        parentEnvironment: this.environment,
      }),
      ...(plugin.eager !== undefined ? { eager: plugin.eager } : {}),
      ...(plugin.idleTimeoutMs !== undefined ? { idleTimeoutMs: plugin.idleTimeoutMs } : {}),
      ...(plugin.maxProcesses !== undefined ? { maxProcesses: plugin.maxProcesses } : {}),
    };
  }

  private configIsCurrent(config: MCPServerConfig): boolean {
    return this.running && this.configs.includes(config) && config.enabled !== false &&
      !this.isSandboxExecutionAuthorityClosed() && this.installedSnapshotCurrent(config);
  }

  private installedSnapshotCurrent(config: MCPServerConfig): boolean {
    const plugin = config.origin?.pluginServer;
    if (!plugin?.pluginRoot || !plugin.digest) return true;
    let current = false;
    try {
      current = hashInstalledPlugin(plugin.pluginRoot) === plugin.digest &&
        (!plugin.snapshotRoot || hashInstalledPlugin(plugin.snapshotRoot) === plugin.digest);
    }
    catch { /* A missing or unreadable install is revoked as well. */ }
    if (!current) {
      const changed = this.cachedCatalogs.has(config.name) || this.cachedTools.has(config.name) ||
        this.connectionStates.get(config.name)?.type !== "failed";
      this.cachedCatalogs.delete(config.name);
      this.cachedTools.delete(config.name);
      this.connectionStates.set(config.name, { type: "failed", error: `Installed plugin ${plugin.pluginName} changed; refresh MCP configuration` });
      if (changed) this.notifySurfaceChanged();
    }
    return current;
  }

  private pluginLaunchConfig(config: MCPServerConfig): MCPServerConfig {
    const plugin = config.origin?.pluginServer;
    if (!plugin?.pluginRoot || !plugin.snapshotRoot) return config;
    const remap = (value: string): string => {
      if (!isAbsolute(value)) return value;
      const path = relative(plugin.pluginRoot!, value);
      return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        ? join(plugin.snapshotRoot!, path) : value;
    };
    return {
      ...config,
      ...(config.command !== undefined ? { command: remap(config.command) } : {}),
      ...(config.args !== undefined ? { args: config.args.map(remap) } : {}),
      ...(config.cwd !== undefined ? { cwd: remap(config.cwd) } : {}),
      ...(config.env !== undefined ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, remap(value)])) } : {}),
      ...(config.pluginSandbox !== undefined ? { pluginSandbox: { ...config.pluginSandbox, pluginRoot: plugin.snapshotRoot } } : {}),
    };
  }

  private releaseOwner(name: string, owner: object): void {
    if (this.retainedCleanup.has(name)) return;
    releasePluginProcess(owner);
    if (this.processOwners.get(name) === owner) this.processOwners.delete(name);
  }

  private trackAbandonedAttempt(attempt: ManagedConnectionAttempt, owner?: object): void {
    const name = attempt.serverName;
    const task = (async (): Promise<void> => {
      try {
        await attempt.promise;
        if (this.bridges.has(name)) {
          await this.disconnectServer(name, "after cancelled startup", true);
        }
      } catch (error) {
        if (error instanceof MCPConnectionCleanupError) throw error;
      } finally {
        if (owner) this.releaseOwner(name, owner);
      }
    })();
    this.closingTasks.set(name, task);
    const remove = (): void => {
      if (this.closingTasks.get(name) === task) this.closingTasks.delete(name);
    };
    void task.then(remove, remove);
    void task.catch(() => undefined);
  }

  private isLazyPlugin(config: MCPServerConfig): boolean {
    const identity = this.pluginIdentity(config);
    return identity !== undefined && identity.eager !== true && config.required !== true;
  }

  private owner(name: string): object {
    let owner = this.processOwners.get(name);
    if (!owner) { owner = {}; this.processOwners.set(name, owner); }
    return owner;
  }

  private busy(name: string): boolean {
    const config = this.getServerConfig(name);
    return (config !== undefined && !this.isLazyPlugin(config)) ||
      (this.activeCalls.get(name) ?? 0) > 0 || (this.pendingCalls.get(name) ?? 0) > 0 ||
      this.lazyStartTasks.has(name) || this.closingTasks.has(name);
  }

  private async reserve(config: MCPServerConfig, signal?: AbortSignal): Promise<object | undefined> {
    const identity = this.pluginIdentity(config);
    if (!identity) return undefined;
    const closing = this.closingTasks.get(config.name);
    if (closing) await raceWithAbort(closing, signal);
    if (!this.configIsCurrent(config)) throw new Error(`MCP plugin ${config.name} configuration changed`);
    const owner = this.owner(config.name);
    const generation = this.lifecycleGeneration;
    await reservePluginProcess(owner, identity.maxProcesses ?? 8,
      () => this.busy(config.name), () => this.evictPlugin(config.name, owner, config, generation), signal);
    return owner;
  }

  private scheduleIdle(config: MCPServerConfig): void {
    if (!this.configs.includes(config) || config.enabled === false) return;
    const old = this.idleTimers.get(config.name);
    if (old) clearTimeout(old);
    this.idleTimers.delete(config.name);
    if (!this.isLazyPlugin(config) || !this.bridges.has(config.name) || this.busy(config.name)) return;
    touchPluginProcess(this.owner(config.name));
    notifyPluginProcessIdle();
    const ms = this.pluginIdentity(config)?.idleTimeoutMs ?? 600_000;
    if (ms === 0) return;
    const owner = this.processOwners.get(config.name);
    const generation = this.lifecycleGeneration;
    const timer = setTimeout(() => { void this.evictPlugin(config.name, owner, config, generation).catch(error => {
      this.logger.warn?.(`Could not retire idle plugin MCP server ${config.name}`, error);
      this.commitSurfaceMutation(() => this.connectionStates.set(config.name, { type: "failed", error: errMessage(error) }));
    }); }, ms);
    timer.unref?.();
    this.idleTimers.set(config.name, timer);
  }

  private async evictPlugin(
    name: string, expectedOwner?: object, expectedConfig?: MCPServerConfig,
    expectedGeneration?: number,
  ): Promise<void> {
    if (expectedGeneration !== undefined && this.lifecycleGeneration !== expectedGeneration) return;
    if (expectedConfig && !this.configs.includes(expectedConfig)) return;
    const closing = this.closingTasks.get(name);
    if (closing) return closing;
    if (expectedOwner && this.processOwners.get(name) !== expectedOwner) return;
    if (this.busy(name)) return;
    if (!this.bridges.has(name)) {
      const owner = this.processOwners.get(name);
      if (owner) this.releaseOwner(name, owner);
      return;
    }
    const timer = this.idleTimers.get(name);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(name);
    const task = this.disconnectServer(name, "after idle eviction", true).then(() => {
      if (this.running &&
        (expectedGeneration === undefined || this.lifecycleGeneration === expectedGeneration) &&
        (!expectedConfig || this.configs.includes(expectedConfig)) &&
        this.getServerConfig(name)?.enabled !== false) {
        this.commitSurfaceMutation(() => this.connectionStates.set(name, { type: "stopped" }));
      }
    });
    this.closingTasks.set(name, task);
    try { await task; }
    finally { if (this.closingTasks.get(name) === task) this.closingTasks.delete(name); }
  }

  private watchIdlePluginClient(config: MCPServerConfig, client: unknown): void {
    if (!this.isLazyPlugin(config) || typeof client !== "object" || client === null) return;
    const observed = client as { onclose?: () => void };
    const previous = observed.onclose;
    const generation = this.lifecycleGeneration;
    this.pluginClientOwners.set(config.name, client);
    observed.onclose = () => {
      previous?.();
      if (this.pluginClientOwners.get(config.name) === client && this.running && !this.busy(config.name)) {
        void this.evictPlugin(config.name, this.processOwners.get(config.name), config, generation).catch(error =>
          this.logger.warn?.(`Could not retire crashed plugin MCP server ${config.name}`, error));
      }
    };
  }

  private async loadCachedCatalogs(): Promise<void> {
    this.cachedTools.clear();
    this.cachedCatalogs.clear();
    for (const config of this.configs) {
      if (!this.isLazyPlugin(config) || config.enabled === false || !this.installedSnapshotCurrent(config)) continue;
      const identity = this.pluginIdentity(config)!;
      const catalog = readPluginCatalog(identity);
      if (!catalog) continue;
      try { await this.publishCachedCatalog(config, catalog, false); }
      catch (error) { this.logger.warn?.(`Ignoring invalid plugin MCP catalog for ${config.name}`, error); }
    }
  }

  /** Called by tool search when a newly installed plugin has no catalog yet. */
  async primeCatalogs(): Promise<void> {
    if (this.catalogPrimeTask) return this.catalogPrimeTask;
    const generation = this.lifecycleGeneration;
    const task = Promise.all(this.configs.filter(config =>
      config.enabled !== false && this.installedSnapshotCurrent(config) && this.isLazyPlugin(config) && !this.cachedCatalogs.has(config.name))
      .map(async config => {
        const identity = this.pluginIdentity(config)!;
        const existing = readPluginCatalog(identity);
        if (existing) {
          try { await this.publishCachedCatalog(config, existing, false); return; }
          catch { /* Re-discover a corrupt catalog. */ }
        }
        try {
          await primePluginCatalogSingleFlight(identity, async () => {
            await this.ensurePluginConnected(config);
            await this.evictPlugin(config.name, this.processOwners.get(config.name), config, generation);
          });
          if (this.configIsCurrent(config) && !this.cachedCatalogs.has(config.name)) {
            const discovered = readPluginCatalog(identity);
            if (discovered) await this.publishCachedCatalog(config, discovered, false);
          }
        } catch (error) {
          if (this.running && this.lifecycleGeneration === generation) {
            this.commitSurfaceMutation(() => this.connectionStates.set(config.name, { type: "failed", error: errMessage(error) }));
          }
          this.logger.warn?.(`Plugin MCP catalog discovery failed for ${config.name}`, error);
        }
      })).then(() => undefined);
    this.catalogPrimeTask = task;
    try { await task; } finally { if (this.catalogPrimeTask === task) this.catalogPrimeTask = undefined; }
  }

  private async publishCachedCatalog(
    config: MCPServerConfig, catalog: PluginCatalog, persist: boolean,
    canPublish: () => boolean = () => true,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    const client = { listTools: async () => ({ tools: catalog.tools }), close: async () => undefined };
    const bridge = await createToolBridge(client, config.name, this.logger, {
      environment: this.environment, serverConfig: toToolCatalogPolicyConfig(config),
    });
    const tools = bridge.tools.map(tool => ({
      ...tool,
      execute: (args: Record<string, unknown>): Promise<ToolResult> =>
        this.invokeTool(config.name, tool.mcpInfo.toolName, args),
    }));
    if (!this.running || this.lifecycleGeneration !== generation || !this.configIsCurrent(config) || !canPublish()) return;
    this.cachedCatalogs.set(config.name, catalog);
    this.cachedTools.set(config.name, tools);
    if (persist) {
      try { writePluginCatalog(this.pluginIdentity(config)!, catalog); }
      catch (error) { this.logger.warn?.(`Could not write plugin MCP catalog for ${config.name}`, error); }
    }
    this.notifySurfaceChanged();
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
    if (this.isSandboxExecutionAuthorityClosed()) {
      throw this.sandboxExecutionAuthorityClosedError("manager startup");
    }
    if (this.sandboxQuiesced) {
      throw new Error(
        "MCP manager cannot start while sandbox execution is quiesced",
      );
    }
    if (
      this.running ||
      this.shutdownTask !== undefined ||
      this.connectionAttempts.size > 0 ||
      this.lazyStartTasks.size > 0 ||
      this.closingTasks.size > 0 ||
      this.reconnectOperations.size > 0 ||
      this.retainedCleanup.size > 0 ||
      this.bridges.size > 0
    ) {
      throw new Error(
        "MCP manager cannot start while another connection lifecycle is active; stop it before starting again",
      );
    }
    this.lastStartOpts = withoutStartSignal(opts);
    const signal = opts.signal;
    if (signal?.aborted) {
      throw new Error(
        `MCP startup cancelled before first connect (${signal.reason ?? "unspecified"})`,
      );
    }
    const generation = ++this.lifecycleGeneration;
    this.running = true;
    this.resetConnectionStates();
    await this.loadCachedCatalogs();
    if (!this.running || this.lifecycleGeneration !== generation) return;
    const enabledConfigs = this.configs.filter((c) => c.enabled !== false && !this.isLazyPlugin(c));

    if (enabledConfigs.length === 0) {
      this.logger.info(this.configs.some(config => config.enabled !== false)
        ? "No eager MCP servers to start" : "No MCP servers configured");
      return;
    }

    const timeoutMs = opts.timeoutMs ?? MCP_STARTUP_TIMEOUT_MS;

    this.logger.info(`Starting ${enabledConfigs.length} MCP server(s)...`);

    // I-50: race each per-server connect against the external signal.
    const results = await Promise.all(
      enabledConfigs.map(async (config) => {
        const serverTimeout = this.isLazyPlugin(config) ? Math.min(config.timeout ?? 5_000, 10_000) : timeoutMs;
        const budgetSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(serverTimeout)]) : AbortSignal.timeout(serverTimeout);
        let attempt: ManagedConnectionAttempt | undefined;
        let owner: object | undefined;
        try {
          owner = await this.reserve(config, budgetSignal);
          budgetSignal.throwIfAborted();
          if (this.lifecycleGeneration !== generation || !this.configIsCurrent(config)) throw new Error(`MCP server "${config.name}" configuration changed`);
          attempt = this.beginConnection(config);
          const bridge = await raceWithSignal(attempt.promise, budgetSignal, serverTimeout,
            `MCP server "${config.name}" connect`, attempt.gate);
          return { status: "fulfilled" as const, value: bridge };
        } catch (reason) {
          if (attempt) this.trackAbandonedAttempt(attempt, owner);
          else if (owner) this.releaseOwner(config.name, owner);
          return { status: "rejected" as const, reason };
        }
      }),
    );

    // A concurrent stop owns the current state. Late results are cleaned up by
    // connectServer's gate and must not republish status.
    if (!this.running || this.lifecycleGeneration !== generation) return;

    let successCount = 0;
    const failures: Array<{ name: string; reason: unknown }> = [];
    this.commitSurfaceMutation(() => {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const cfg = enabledConfigs[i];
        if (result.status === "fulfilled") {
          successCount++;
          this.connectionStates.set(cfg.name, { type: "connected" });
        } else {
          this.connectionStates.set(cfg.name, isMcpAuthenticationError(result.reason) ? { type: "needs-auth" } : {
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
    });

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
    this.restartAfterSandboxTransition = false;
    this.rejectDeferredRefresh(new Error("MCP refresh cancelled by shutdown"));
    void this.beginShutdown();
    await this.enqueueLifecycle(async () => {
      await this.stopInternal(false);
    });
  }

  /** Stop and reject unless cleanup of every connection owner is proven. */
  async stopStrict(): Promise<void> {
    this.restartAfterSandboxTransition = false;
    this.rejectDeferredRefresh(new Error("MCP refresh cancelled by shutdown"));
    void this.beginShutdown();
    await this.enqueueLifecycle(async () => {
      await this.stopInternal(true);
    });
  }

  /**
   * Strictly revoke every connection owner and remove every configured server
   * without entering the startup/deferred-refresh path. This is the terminal
   * fail-closed primitive: callers must not use `refreshServers([])` while the
   * sandbox is quiesced because that operation intentionally waits for resume.
   */
  async clearServersStrict(): Promise<void> {
    this.restartAfterSandboxTransition = false;
    this.rejectDeferredRefresh(new Error("MCP refresh cancelled by shutdown"));
    void this.beginShutdown();
    // Authority revocation is synchronous and independent of transport
    // cleanup. Even if an owner cannot yet prove disposal, callers must never
    // rediscover the old configured names, connections, or tools.
    this.configs = Object.freeze([]);
    this.resetConnectionStates();
    await this.enqueueLifecycle(async () => {
      try {
        await this.stopInternal(true);
      } finally {
        // A lifecycle operation already in the queue may have written its
        // candidate configs after the synchronous revocation above. Reassert
        // the terminal projection at the serialized commit boundary.
        this.configs = Object.freeze([]);
        this.resetConnectionStates();
      }
    });
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
    this.pluginClientOwners.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.cachedTools.clear();
    this.cachedCatalogs.clear();
    this.lifecycleGeneration++;
    for (const gate of this.startupGates) {
      gate.cancel("MCP manager stopped during startup");
    }
    for (const controller of this.lazyStartControllers.values()) {
      controller.abort(new Error("MCP manager stopped during plugin startup"));
    }
    for (const name of this.allKnownServerNames()) {
      this.invalidateServerAuthority(name);
    }
    const bridges = Array.from(this.bridges.values());
    const resourceBridges = Array.from(this.resourceBridges.values());
    const promptBridges = Array.from(this.promptBridges.values());
    const attempts = Array.from(this.connectionAttempts);
    const lazyStarts = Array.from(this.lazyStartTasks.values());
    const closingTasks = Array.from(this.closingTasks.values());
    const catalogPrimeTask = this.catalogPrimeTask;
    const reconnectOperations = Array.from(this.reconnectOperations);
    const publishedOwners: ServerCleanupOwner[] = [
      ...bridges.map((bridge) =>
        cleanupOwner(bridge.serverName, bridge, () => invokeDisposal(bridge)),
      ),
      ...resourceBridges.map((bridge) =>
        cleanupOwner(bridge.serverName, bridge, () => invokeDisposal(bridge)),
      ),
      ...promptBridges.map((bridge) =>
        cleanupOwner(bridge.serverName, bridge, () => invokeDisposal(bridge)),
      ),
    ];
    const retainedRetries = Array.from(this.retainedCleanup.keys(), (name) =>
      this.retryRetainedCleanup(name, "during shutdown"),
    );
    // Remove every published surface before awaiting teardown. An in-flight
    // caller can no longer discover a bridge once stop begins.
    this.bridges.clear();
    this.resourceBridges.clear();
    this.promptBridges.clear();
    this.connectedConnections.clear();
    this.serverInstructions.clear();
    this.resetConnectionStates();

    const disposalCount = publishedOwners.length + retainedRetries.length;
    const task = Promise.allSettled([
      ...publishedOwners.map((owner) => owner.dispose()),
      ...retainedRetries,
      ...attempts.map((attempt) => attempt.promise),
      ...lazyStarts,
      ...closingTasks,
      ...(catalogPrimeTask ? [catalogPrimeTask] : []),
      ...reconnectOperations.map((operation) => operation.promise),
    ]).then((results): ReadonlyArray<unknown> => {
      const errors: unknown[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result?.status !== "rejected") continue;
        const publishedOwner = publishedOwners[index];
        if (publishedOwner !== undefined) {
          this.retainCleanupFailures(publishedOwner.serverName, [
            { owner: publishedOwner, error: result.reason },
          ]);
        }
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
      for (const [name, owner] of this.processOwners) {
        this.releaseOwner(name, owner);
      }
      if (errors.length > 0) {
        // Cleanup retention changes getConnectionState() from pending to the
        // fail-closed state after the synchronous unpublication above.
        this.notifySurfaceChanged();
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
    if (this.isSandboxExecutionAuthorityClosed()) {
      throw this.sandboxExecutionAuthorityClosedError("server refresh");
    }
    const nextConfigs = Object.freeze(configs.map(immutableMcpServerConfig));
    let deferred: DeferredMcpRefresh | undefined;
    let deferralNotified = false;
    const notifyDeferral = (): void => {
      if (deferralNotified) return;
      deferralNotified = true;
      opts.onSandboxRefreshDeferred?.();
    };
    await this.enqueueLifecycle(async () => {
      this.rejectDeferredRefresh(
        new Error("MCP refresh was superseded by a newer configuration"),
      );
      await this.stopInternal(true);
      this.configs = nextConfigs;
      this.resetConnectionStates();
      if (this.sandboxQuiesced) {
        this.restartAfterSandboxTransition = true;
        this.lastStartOpts = withoutStartSignal(opts);
        deferred = this.deferRefreshUntilSandboxResume(opts);
        if (!deferred.cancelled) notifyDeferral();
        return;
      }
      await this.start(opts);
      if (this.sandboxQuiesced) {
        this.restartAfterSandboxTransition = true;
        deferred = this.deferRefreshUntilSandboxResume(opts);
        if (!deferred.cancelled) notifyDeferral();
        return;
      }
      if (opts.signal?.aborted === true) {
        throw new Error(
          `MCP refresh cancelled during startup (${opts.signal.reason ?? "unspecified"})`,
        );
      }
    });
    await deferred?.promise;
  }

  /** Get live tools and cached definitions for stopped plugin servers. */
  getTools(): Tool[] {
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    const tools: Tool[] = [];
    for (const config of this.configs) {
      if (config.enabled === false || !this.installedSnapshotCurrent(config)) continue;
      if (config.localOnly === true && !hasLocalMcpAccess()) continue;
      const found = this.isLazyPlugin(config) ? this.cachedTools.get(config.name) :
        this.connectedConnections.has(config.name) ? this.bridges.get(config.name)?.tools : undefined;
      if (found) tools.push(...found);
    }
    return tools;
  }

  /** Get a server's live or cached tool definitions. */
  getToolsByServer(name: string): Tool[] {
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    const config = this.getServerConfig(name);
    if (!config || config.enabled === false || !this.installedSnapshotCurrent(config)) return [];
    return this.isLazyPlugin(config) ? this.cachedTools.get(name) ?? [] :
      this.connectedConnections.has(name) ? this.bridges.get(name)?.tools ?? [] : [];
  }

  private async ensurePluginConnected(config: MCPServerConfig): Promise<void> {
    if (!this.configIsCurrent(config)) throw new Error(`MCP plugin ${config.name} is disabled or its configuration changed`);
    if (this.bridges.has(config.name) && !this.closingTasks.has(config.name)) return;
    const existing = this.lazyStartTasks.get(config.name);
    if (existing) return existing;
    const timeoutMs = Math.min(config.timeout ?? 5_000, 10_000);
    const generation = this.lifecycleGeneration;
    const controller = new AbortController();
    this.lazyStartControllers.set(config.name, controller);
    const timeout = setTimeout(() => controller.abort(new Error(`MCP plugin ${config.name} startup timed out after ${timeoutMs} ms`)), timeoutMs);
    const task = (async (): Promise<void> => {
      let attempt: ManagedConnectionAttempt | undefined;
      let owner: object | undefined;
      try {
        this.commitSurfaceMutation(() => this.connectionStates.set(config.name, { type: "pending" }));
        owner = await this.reserve(config, controller.signal);
        controller.signal.throwIfAborted();
        if (this.lifecycleGeneration !== generation || !this.configIsCurrent(config) || this.shutdownTask) throw new Error(`MCP plugin ${config.name} configuration changed or session stopped`);
        attempt = this.beginConnection(config);
        await raceWithSignal(attempt.promise, controller.signal, timeoutMs,
          `MCP plugin ${config.name} startup`, attempt.gate);
        if (this.running && this.lifecycleGeneration === generation) {
          this.commitSurfaceMutation(() => this.connectionStates.set(config.name, { type: "connected" }));
        }
      } catch (error) {
        if (attempt) this.trackAbandonedAttempt(attempt, owner);
        else if (owner) this.releaseOwner(config.name, owner);
        if (this.running && this.lifecycleGeneration === generation) {
          this.commitSurfaceMutation(() => this.connectionStates.set(config.name, {
            type: "failed", error: errMessage(error),
          }));
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        if (this.lazyStartControllers.get(config.name) === controller) this.lazyStartControllers.delete(config.name);
      }
    })();
    this.lazyStartTasks.set(config.name, task);
    try { await task; }
    finally {
      if (this.lazyStartTasks.get(config.name) === task) this.lazyStartTasks.delete(config.name);
      if (this.configs.includes(config)) this.scheduleIdle(config);
    }
  }

  private cachedResources(name: string): readonly MCPResourceDescriptor[] {
    return (this.cachedCatalogs.get(name)?.resources ?? []).filter((value): value is MCPResourceDescriptor =>
      typeof value === "object" && value !== null &&
      (value as MCPResourceDescriptor).serverName === name &&
      typeof (value as MCPResourceDescriptor).uri === "string" &&
      typeof (value as MCPResourceDescriptor).namespacedName === "string");
  }

  private cachedPrompts(name: string): readonly MCPPromptDescriptor[] {
    return (this.cachedCatalogs.get(name)?.prompts ?? []).filter((value): value is MCPPromptDescriptor =>
      typeof value === "object" && value !== null &&
      (value as MCPPromptDescriptor).serverName === name &&
      typeof (value as MCPPromptDescriptor).name === "string" &&
      typeof (value as MCPPromptDescriptor).namespacedName === "string");
  }

  private async withPluginActivity<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const config = this.getServerConfig(name);
    if (!config || config.enabled === false || !this.configIsCurrent(config)) return null as T;
    if (!this.isLazyPlugin(config)) {
      const result = await operation();
      return this.configIsCurrent(config) ? result : null as T;
    }
    this.activeCalls.set(name, (this.activeCalls.get(name) ?? 0) + 1);
    try {
      await this.ensurePluginConnected(config);
      if (!this.configIsCurrent(config)) return null as T;
      const result = await operation();
      return this.configIsCurrent(config) ? result : null as T;
    } finally {
      this.activeCalls.set(name, Math.max(0, (this.activeCalls.get(name) ?? 1) - 1));
      this.scheduleIdle(config);
    }
  }

  /** Only the live, signed product overlay can extend a reduced model catalog.
   * This does not discover tools or authorize their execution. */
  getAuthenticatedDesktopToolNames(): readonly string[] {
    if (this.isSandboxExecutionAuthorityClosed() || !hasLocalMcpAccess()) return [];
    const name = "agenc-desktop-control";
    const config = this.getServerConfig(name);
    if (config?.localOnly !== true || config.origin?.scope !== "session" || !this.bridges.has(name)) return [];
    const prefix = `mcp.${name}.`;
    return this.getToolsByServer(name).filter(tool =>
      tool.name.startsWith(prefix) &&
      isAuthenticatedDesktopToolName(config.desktopAuthorityGrant, tool.name.slice(prefix.length)),
    ).map(tool => tool.name);
  }

  /**
   * Execute one raw MCP tool through the connected server's canonical bridge.
   *
   * This is the manager-owned RPC surface for internal callers that already
   * know the server and raw MCP tool name. It deliberately delegates to the
   * same resilient, permission-checked, output-normalizing Tool proxy exposed
   * to the runtime registry; callers never receive or retain an SDK client.
   * Production callers must already be inside the canonical admitted boundary
   * and propagate that boundary's call id and signal through `options`.
   * Expected MCP failures resolve with `isError`; aborts and unexpected bridge
   * failures may reject.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: MCPManagerToolCallOptions = {},
  ): Promise<ToolResult> {
    options.signal?.throwIfAborted();
    const executionArgs = withoutMcpExecutionOnlyArgs(args);
    defineMcpExecutionArgument(executionArgs, "__abortSignal", options.signal);
    defineMcpExecutionArgument(executionArgs, "__callId", options.callId);
    defineMcpExecutionArgument(executionArgs, "__onProgress", options.onProgress);
    return this.invokeTool(serverName, toolName, executionArgs);
  }

  /** Preserve the registry's trusted non-enumerable execution context. */
  private async invokeTool(
    serverName: string,
    toolName: string,
    executionArgs: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (executionArgs.__abortSignal instanceof AbortSignal) executionArgs.__abortSignal.throwIfAborted();
    if (this.isSandboxExecutionAuthorityClosed()) {
      return {
        content: this.sandboxExecutionAuthorityClosedError("tool execution")
          .message,
        isError: true,
      };
    }
    const config = this.getServerConfig(serverName);
    if (!config) {
      return { content: `MCP server ${JSON.stringify(serverName)} is not connected`, isError: true };
    }
    if (config.enabled === false || !this.configIsCurrent(config)) {
      return { content: `MCP server ${JSON.stringify(serverName)} is disabled or its configuration changed`, isError: true };
    }
    const generation = this.lifecycleGeneration;
    if (config && this.isLazyPlugin(config) && this.running) {
      this.pendingCalls.set(serverName, (this.pendingCalls.get(serverName) ?? 0) + 1);
      try {
        try { await this.ensurePluginConnected(config); }
        catch (error) {
          return {
            content: `MCP plugin startup failed for ${JSON.stringify(serverName)}: ${errMessage(error)}`,
            isError: true,
            metadata: { errorCode: "MCP_PLUGIN_STARTUP_FAILED" },
          };
        }
        if (generation !== this.lifecycleGeneration || !this.configIsCurrent(config)) {
          return { content: `MCP server ${JSON.stringify(serverName)} configuration changed`, isError: true };
        }
        return await this.invokeConnectedTool(serverName, toolName, executionArgs, config);
      } finally {
        this.pendingCalls.set(serverName, Math.max(0, (this.pendingCalls.get(serverName) ?? 1) - 1));
        this.scheduleIdle(config);
      }
    }
    return this.invokeConnectedTool(serverName, toolName, executionArgs, config);
  }

  private async invokeConnectedTool(
    serverName: string, toolName: string, executionArgs: Record<string, unknown>,
    config: MCPServerConfig,
  ): Promise<ToolResult> {
    if (!this.configIsCurrent(config)) return { content: `MCP server ${JSON.stringify(serverName)} configuration changed`, isError: true };
    const bridge = this.bridges.get(serverName);
    if (bridge === undefined || !this.connectedConnections.has(serverName)) {
      return {
        content: `MCP server ${JSON.stringify(serverName)} is not connected`,
        isError: true,
      };
    }

    const namespacedName = `mcp.${serverName}.${toolName}`;
    const tool = bridge.tools.find(
      (candidate) => candidate.name === namespacedName,
    );
    if (tool === undefined) {
      return {
        content: `MCP tool ${JSON.stringify(toolName)} is not available on server ${JSON.stringify(serverName)}`,
        isError: true,
      };
    }

    this.activeCalls.set(serverName, (this.activeCalls.get(serverName) ?? 0) + 1);
    touchPluginProcess(this.owner(serverName));
    try {
      const result = await tool.execute(executionArgs);
      return this.configIsCurrent(config)
        ? result
        : { content: `MCP server ${JSON.stringify(serverName)} configuration changed`, isError: true };
    }
    finally {
      this.activeCalls.set(serverName, Math.max(0, (this.activeCalls.get(serverName) ?? 1) - 1));
      this.scheduleIdle(config);
    }
  }

  /**
   * Get the names of all connected servers.
   */
  getConnectedServers(): string[] {
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    return Array.from(this.connectedConnections.keys()).filter(name => this.getConnectionState(name)?.type === "connected");
  }

  getConnectedConnection(name: string): ConnectedMCPServer | undefined {
    if (this.isSandboxExecutionAuthorityClosed()) return undefined;
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
    if (this.isSandboxExecutionAuthorityClosed()) return undefined;
    if (this.getServerConfig(name)?.localOnly === true) {
      if (!hasLocalMcpAccess() || !this.bridges.has(name)) return undefined;
      if (name !== "agenc-desktop-control" || !hasDesktopAuthority(this.getServerConfig(name)?.desktopAuthorityGrant)) return this.serverInstructions.get(name);
      const tools = this.getAuthenticatedDesktopToolNames().join(", ");
      const routineGuidance = tools.includes("mcp.agenc-desktop-control.desktop_routine_list")
        ? " For the user's AgenC Desktop Routines, discover desktop_routine_list/get/create/update/delete/run/runs/cancel and desktop_routines_open here. These operate the app's real Routine records. CronCreate/CronList/CronDelete are a separate conversation scheduler, not a substitute for Desktop Routines. Inspect current records before updating, deleting or running them; preserve revision checks. Routine changes require ordinary approval and are unavailable in read-only/plan mode. A routine you create runs with this session's current permission mode; request a narrower permissionMode only when the user asks for one, and Core refuses a wider one. Changing a routine's instructions, workspace, model or permissions needs a session whose mode is at least the routine's. Scheduled runs have nobody to approve anything: default and plan runs are read-only, acceptEdits runs may edit files in the routine's workspace, bypassPermissions runs skip approvals, and every run writes files only inside its workspace."
        : "";
      return `This is authenticated local AgenC Desktop app control, not a web page or the isolated Browser tool. Discover its tools with system.searchTools, then select the exact MCP tool name before calling it. Available tools: ${tools}. Use only for the user's requested app operation; this capability does not grant additional permissions.${routineGuidance} Native visible-terminal mutations require an explicitly full-access session. In restricted sessions use Core exec_command/system.bash for sandboxed commands; never loosen permissions just to control the visible terminal.\n\n${this.serverInstructions.get(name) ?? ""}`;
    }
    return this.serverInstructions.get(name);
  }

  getConfiguredServers(): readonly MCPServerConfig[] {
    return this.configs.map(config => {
      if (config.origin?.scope !== "session" || config.headers === undefined) return config;
      const { headers: _headers, desktopAuthority: _proof, desktopAuthorityGrant: _grant, ...publicConfig } = config;
      return publicConfig;
    });
  }

  getServerConfig(name: string): MCPServerConfig | undefined {
    return this.configs.find((config) => config.name === name);
  }

  isConnected(name: string): boolean {
    if (this.isSandboxExecutionAuthorityClosed()) return false;
    return this.connectedConnections.has(name) && this.getConnectionState(name)?.type === "connected";
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
    if (this.isSandboxExecutionAuthorityClosed()) return undefined;
    for (const [serverName, bridge] of this.bridges) {
      if (!this.connectedConnections.has(serverName)) continue;
      for (const tool of bridge.tools) {
        if (tool.name === namespacedName) return serverName;
      }
    }
    return undefined;
  }

  /**
   * Given a tool name the model emitted, either return `{ serverName,
   * toolName }` when the tool is MCP-backed, or `undefined`.
   *
   * Accepts both the namespaced `mcp.<server>.<tool>` form and a plain
   * tool name that matches a single registered MCP tool.
   */
  resolveMcpToolInfo(
    toolName: string,
  ): { readonly serverName: string; readonly toolName: string } | undefined {
    if (this.isSandboxExecutionAuthorityClosed()) return undefined;
    if (toolName.startsWith("mcp.")) {
      const server = this.getServerForTool(toolName);
      if (!server) return undefined;
      const prefix = `mcp.${server}.`;
      if (!toolName.startsWith(prefix)) return undefined;
      return { serverName: server, toolName: toolName.slice(prefix.length) };
    }
    for (const [serverName, bridge] of this.bridges) {
      if (!this.connectedConnections.has(serverName)) continue;
      for (const tool of bridge.tools) {
        if (tool.name === toolName) {
          return { serverName, toolName };
        }
      }
    }
    return undefined;
  }

  async reconnectServer(name: string): Promise<MCPReconnectResult> {
    if (this.isSandboxExecutionAuthorityClosed()) {
      return reconnectFailure(
        name,
        this.sandboxExecutionAuthorityClosedError(
          `server ${JSON.stringify(name)} reconnect`,
        ),
      );
    }
    if (this.sandboxQuiesced) {
      return reconnectFailure(
        name,
        new Error(
          `MCP server "${name}" cannot reconnect while sandbox execution is quiesced`,
        ),
      );
    }
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
      this.commitSurfaceMutation(() => {
        this.connectionStates.set(name, { type: "disabled" });
      });
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
        this.commitSurfaceMutation(() => {
          this.connectionStates.set(config.name, isMcpAuthenticationError(error) ? { type: "needs-auth" } : {
            type: "failed",
            error: errMessage(error),
          });
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
    const priorCleanup = this.closingTasks.get(config.name);
    if (priorCleanup) await priorCleanup;
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
      if (!this.configIsCurrent(config)) throw new Error(`MCP server "${config.name}" configuration changed`);
      const timeoutMs = Math.min(config.timeout ?? 5_000, 10_000);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`MCP server "${config.name}" reconnect timed out`)), timeoutMs);
      let owner: object | undefined;
      let attempt: ManagedConnectionAttempt | undefined;
      let bridge: MCPToolBridge;
      try {
        owner = await this.reserve(config, controller.signal);
        controller.signal.throwIfAborted();
        if (!this.configIsCurrent(config) || !this.isReconnectLifecycleCurrent(lifecycleGeneration, running)) {
          throw new Error(`MCP server "${config.name}" reconnect configuration changed`);
        }
        attempt = this.beginConnection(config);
        bridge = await raceWithSignal(attempt.promise, controller.signal, timeoutMs,
          `MCP server "${config.name}" reconnect`, attempt.gate);
      } catch (error) {
        if (attempt) this.trackAbandonedAttempt(attempt, owner);
        else if (owner) this.releaseOwner(config.name, owner);
        throw error;
      } finally { clearTimeout(timeout); }
      if (
        !attempt.isCurrent() ||
        !this.isReconnectLifecycleCurrent(lifecycleGeneration, running)
      ) {
        return reconnectFailure(
          config.name,
          new Error(`MCP server "${config.name}" reconnect cancelled by shutdown`),
        );
      }
      this.commitSurfaceMutation(() => {
        this.connectionStates.set(config.name, { type: "connected" });
      });
      this.scheduleIdle(config);
      return {
        serverName: config.name,
        success: true,
        toolCount: bridge.tools.length,
      };
    } catch (error) {
      if (this.isReconnectLifecycleCurrent(lifecycleGeneration, running)) {
        this.commitSurfaceMutation(() => {
          this.connectionStates.set(config.name, isMcpAuthenticationError(error) ? { type: "needs-auth" } : {
            type: "failed",
            error: errMessage(error),
          });
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

  // ─────────────────────────────────────────────────────────────────
  // T9-D: MCP resource + prompt surface
  // ─────────────────────────────────────────────────────────────────

  /**
   * List resources exposed by every connected server (flattened).
   * Per-server failures are swallowed by the resource bridge itself,
   * so the aggregate result only contains servers that successfully
   * listed resources.
   */
  async getResources(
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<MCPResourceDescriptor>> {
    signal?.throwIfAborted();
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    if (this.running) await this.primeCatalogs();
    const bridges = Array.from(this.resourceBridges.values()).filter(bridge => {
      const config = this.getServerConfig(bridge.serverName);
      return config && this.configIsCurrent(config);
    });
    const results = await Promise.allSettled(
      bridges.map((bridge) => bridge.listResources(signal)),
    );
    signal?.throwIfAborted();
    const flattened: MCPResourceDescriptor[] = [];
    for (const [index, result] of results.entries()) {
      const config = this.getServerConfig(bridges[index]!.serverName);
      if (result.status === "fulfilled" && config && this.configIsCurrent(config) && this.resourceBridges.get(config.name) === bridges[index]) {
        flattened.push(...result.value);
      }
    }
    for (const config of this.configs) {
      if (config.enabled !== false && this.installedSnapshotCurrent(config) && this.isLazyPlugin(config) && !this.resourceBridges.has(config.name)) flattened.push(...this.cachedResources(config.name));
    }
    return flattened;
  }

  /**
   * List resources exposed by a specific connected server.
   * Returns `[]` if the server is unknown or has no resource bridge.
   */
  async getResourcesByServer(
    name: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<MCPResourceDescriptor>> {
    signal?.throwIfAborted();
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    const config = this.getServerConfig(name);
    if (!config || config.enabled === false || !this.installedSnapshotCurrent(config)) return [];
    if (this.running && config && this.isLazyPlugin(config)) await this.primeCatalogs();
    if (!this.configIsCurrent(config)) return [];
    const bridge = this.resourceBridges.get(name);
    if (!bridge) return this.cachedResources(name);
    const result = await (signal === undefined
      ? bridge.listResources()
      : bridge.listResources(signal));
    return this.configIsCurrent(config) && this.resourceBridges.get(name) === bridge ? result : [];
  }

  /**
   * Read a resource by its namespaced name `mcp.<server>.<uri>`.
   * Returns `null` when the referenced server is not connected.
   */
  async readResource(
    namespacedName: string,
    signal?: AbortSignal,
  ): Promise<MCPResourceContent | null> {
    signal?.throwIfAborted();
    if (this.isSandboxExecutionAuthorityClosed()) return null;
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) return null;
    return this.withPluginActivity(parsed.serverName, async () => {
      const bridge = this.resourceBridges.get(parsed.serverName);
      if (!bridge) return null;
      return signal === undefined ? bridge.readResource(parsed.rest) : bridge.readResource(parsed.rest, signal);
    });
  }

  /**
   * List prompts exposed by every connected server (flattened).
   */
  async listPrompts(): Promise<ReadonlyArray<MCPPromptDescriptor>> {
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    if (this.running) await this.primeCatalogs();
    const bridges = Array.from(this.promptBridges.values()).filter(bridge => {
      const config = this.getServerConfig(bridge.serverName);
      return config && this.configIsCurrent(config);
    });
    const results = await Promise.allSettled(
      bridges.map((bridge) => bridge.listPrompts()),
    );
    const flattened: MCPPromptDescriptor[] = [];
    for (const [index, result] of results.entries()) {
      const config = this.getServerConfig(bridges[index]!.serverName);
      if (result.status === "fulfilled" && config && this.configIsCurrent(config) && this.promptBridges.get(config.name) === bridges[index]) {
        flattened.push(...result.value);
      }
    }
    for (const config of this.configs) {
      if (config.enabled !== false && this.installedSnapshotCurrent(config) && this.isLazyPlugin(config) && !this.promptBridges.has(config.name)) flattened.push(...this.cachedPrompts(config.name));
    }
    return flattened;
  }

  /**
   * List prompts exposed by a specific connected server.
   */
  async listPromptsByServer(
    name: string,
  ): Promise<ReadonlyArray<MCPPromptDescriptor>> {
    if (this.isSandboxExecutionAuthorityClosed()) return [];
    const config = this.getServerConfig(name);
    if (!config || config.enabled === false || !this.installedSnapshotCurrent(config)) return [];
    if (this.running && config && this.isLazyPlugin(config)) await this.primeCatalogs();
    if (!this.configIsCurrent(config)) return [];
    const bridge = this.promptBridges.get(name);
    if (!bridge) return this.cachedPrompts(name);
    const result = await bridge.listPrompts();
    return this.configIsCurrent(config) && this.promptBridges.get(name) === bridge ? result : [];
  }

  /**
   * Render a prompt by namespaced name `mcp.<server>.<prompt>`.
   * Returns `null` when the referenced server is not connected.
   */
  async renderPrompt(
    namespacedName: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPPromptRendered | null> {
    if (this.isSandboxExecutionAuthorityClosed()) return null;
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) return null;
    return this.withPluginActivity(parsed.serverName, async () => {
      const bridge = this.promptBridges.get(parsed.serverName);
      if (!bridge) return null;
      return signal === undefined ? bridge.renderPrompt(parsed.rest, args) : bridge.renderPrompt(parsed.rest, args, signal);
    });
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
    if (config.localOnly === true) {
      // Local app control is a tool-only surface: no server-initiated skill,
      // resource or prompt can escape the turn-scoped execution boundary.
      const previous = [this.resourceBridges.get(config.name), this.promptBridges.get(config.name)];
      this.resourceBridges.delete(config.name);
      this.promptBridges.delete(config.name);
      await Promise.all(previous.filter(value => value !== undefined).map(value => invokeDisposal(value)));
      return {};
    }
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
    const sensitiveHeaders = config.origin?.scope === "session" ? config.headers : undefined;
    const logger = attachmentLogger(this.logger, sensitiveHeaders);
    let client: Awaited<ReturnType<typeof createMCPConnection>>;
    try {
      client = await createMCPConnection(
        this.pluginLaunchConfig(config),
        logger,
        config.localOnly === true ? undefined : this.elicitationHandlers,
        config.localOnly === true ? undefined : this.samplingHandlers,
        this.sandboxExecutionBroker,
        this.environment,
      );
    } catch (error) {
      error = redactMcpAttachmentValue(error, sensitiveHeaders);
      if (isMCPTransportCleanupFailure(error)) {
        this.retainUnownedCleanupFailure(config.name, error);
        throw new MCPConnectionCleanupError(config.name, error, [error]);
      }
      throw error;
    }
    let bridge: ResilientMCPBridge | undefined;
    let companions: RefreshedCompanionBridges | undefined;
    try {
      assertRefreshOpen(config.name, startupGate, isCurrent);
      // Capture the server's `InitializeResult.instructions` blob if any.
      // The MCP SDK stores it after `client.connect()` completes; the
      // value is immutable for the lifetime of the connection.
      const capabilities = readClientCapabilities(client);
      const serverInfo = readClientServerInfo(client);
      const rawInstructions = readClientInstructions(client);
      const instructions = rawInstructions === undefined ? undefined : redactMcpAttachmentText(rawInstructions, sensitiveHeaders);
      let catalogTools: readonly Record<string, unknown>[] = [];
      const rawBridge = await createToolBridge(
        client,
        config.name,
        logger,
        {
          listToolsTimeoutMs: config.timeout,
          callToolTimeoutMs: config.timeout,
          serverConfig: toToolCatalogPolicyConfig(config),
          environment: this.environment,
          ...(this.isLazyPlugin(config) ? { onCatalog: (tools: readonly Record<string, unknown>[]) => { catalogTools = tools; } } : {}),
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
      let reconnectCatalogTools: readonly Record<string, unknown>[] | undefined;
      bridge = new ResilientMCPBridge(this.pluginLaunchConfig(config), rawBridge, logger, {
        beforeReconnect: () => {
          if (!isCurrent()) throw new Error(`MCP server "${config.name}" configuration changed`);
        },
        ...(this.isLazyPlugin(config) ? { onCatalog: (tools: readonly Record<string, unknown>[]) => { reconnectCatalogTools = tools; } } : {}),
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
        ...(config.localOnly !== true && this.elicitationHandlers !== undefined
          ? { elicitationHandlers: this.elicitationHandlers }
          : {}),
        ...(config.localOnly !== true && this.samplingHandlers !== undefined
          ? { samplingHandlers: this.samplingHandlers }
          : {}),
        ...(this.sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker: this.sandboxExecutionBroker }
          : {}),
        environment: this.environment,
        onCleanupFailure: (error) => {
          this.failClosedAutomaticReconnect(config.name, bridge, error);
        },
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
          const refreshed = await this.refreshResourceAndPromptBridges(
            config,
            newClient,
            undefined,
            companionIsCurrent,
          );
          if (reconnectIsCurrent() && this.isLazyPlugin(config) && reconnectCatalogTools) {
            const next: PluginCatalog = {
              format: 1,
              tools: reconnectCatalogTools,
              ...(readClientCapabilities(newClient).resources && refreshed.resourceBridge
                ? { resources: await refreshed.resourceBridge.listResources().catch(() => []) } : {}),
              ...(readClientCapabilities(newClient).prompts && refreshed.promptBridge
                ? { prompts: await refreshed.promptBridge.listPrompts().catch(() => []) } : {}),
            };
            if (JSON.stringify(next) !== JSON.stringify(this.cachedCatalogs.get(config.name))) {
              await this.publishCachedCatalog(config, next, true, reconnectIsCurrent);
            }
          }
          if (reconnectIsCurrent()) {
            this.watchIdlePluginClient(config, newClient);
            const connected = this.connectedConnections.get(config.name);
            if (connected) this.connectedConnections.set(config.name, { ...connected, client: newClient as never });
          }
          if (reconnectIsCurrent()) {
            // The resilient tool bridge and its optional companions now expose
            // one coherent replacement surface.
            this.notifySurfaceChanged();
          }
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

      if (this.isLazyPlugin(config)) {
        const resources = capabilities.resources && companions.resourceBridge ? await companions.resourceBridge.listResources().catch(() => []) : undefined;
        assertRefreshOpen(config.name, startupGate, isCurrent);
        const prompts = capabilities.prompts && companions.promptBridge ? await companions.promptBridge.listPrompts().catch(() => []) : undefined;
        assertRefreshOpen(config.name, startupGate, isCurrent);
        const catalog: PluginCatalog = {
          format: 1, tools: catalogTools,
          ...(resources !== undefined ? { resources } : {}),
          ...(prompts !== undefined ? { prompts } : {}),
        };
        if (JSON.stringify(catalog) !== JSON.stringify(this.cachedCatalogs.get(config.name))) {
          await this.publishCachedCatalog(config, catalog, true,
            () => !startupGate.isCancelled() && isCurrent());
          assertRefreshOpen(config.name, startupGate, isCurrent);
        }
      }

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
        config: toScopedMcpServerConfig(sensitiveHeaders === undefined ? config : { ...config, headers: undefined }),
        cleanup: async () => {
          await this.disconnectServer(
            config.name,
            "via connected connection cleanup",
          );
        },
      });
      this.watchIdlePluginClient(config, client);
      this.connectionStates.set(config.name, { type: "connected" });
      return bridge;
    } catch (error) {
      error = redactMcpAttachmentValue(error, sensitiveHeaders);
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
      const cleanupOwners: ServerCleanupOwner[] = [
        ...(bridge !== undefined
          ? [disposableCleanupOwner(config.name, bridge)]
          : []),
        ...(companions?.resourceBridge !== undefined
          ? [disposableCleanupOwner(config.name, companions.resourceBridge)]
          : []),
        ...(companions?.promptBridge !== undefined
          ? [disposableCleanupOwner(config.name, companions.promptBridge)]
          : []),
        ...(bridge === undefined
          ? [
              cleanupOwner(config.name, client, () =>
                invokeClientClose(client),
              ),
            ]
          : []),
      ];
      const cleanupResults = await Promise.allSettled(
        cleanupOwners.map((owner) => owner.dispose()),
      );
      const cleanupFailures = cleanupResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ owner: cleanupOwners[index]!, error: result.reason }]
          : [],
      );
      this.retainCleanupFailures(config.name, cleanupFailures);
      const cleanupErrors = cleanupFailures.map((failure) => failure.error);
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
    if (!this.configIsCurrent(config)) {
      throw new Error(`MCP server "${config.name}" configuration changed or was disabled`);
    }
    if (this.shutdownTask !== undefined) {
      throw new Error(
        `MCP server "${config.name}" cannot connect while shutdown is in progress`,
      );
    }
    if (this.retainedCleanup.has(config.name)) {
      throw new Error(
        `MCP server "${config.name}" cannot connect while prior cleanup remains unproven`,
      );
    }
    const gate = createStartupGate();
    const lifecycleGeneration = this.lifecycleGeneration;
    const serverEpoch = this.nextServerEpoch(config.name);
    const isCurrent = (): boolean =>
      this.shutdownTask === undefined &&
      this.lifecycleGeneration === lifecycleGeneration &&
      this.serverEpochs.get(config.name) === serverEpoch &&
      this.configIsCurrent(config);
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
      ...this.retainedCleanup.keys(),
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

  private failClosedAutomaticReconnect(
    serverName: string,
    bridge: ResilientMCPBridge | undefined,
    error: unknown,
  ): void {
    if (bridge === undefined) {
      this.commitSurfaceMutation(() => {
        this.retainUnownedCleanupFailure(serverName, error);
      });
      return;
    }
    if (this.bridges.get(serverName) !== bridge) {
      this.commitSurfaceMutation(() => {
        this.retainCleanupFailures(serverName, [
          {
            owner: cleanupOwner(serverName, bridge, () => invokeDisposal(bridge)),
            error,
          },
        ]);
      });
      return;
    }

    // This callback executes inside the reconnect task. Retain the outer
    // owner and unpublish synchronously, but never await bridge.dispose()
    // here: it waits that same reconnect task and would self-deadlock.
    const resourceBridge = this.resourceBridges.get(serverName);
    const promptBridge = this.promptBridges.get(serverName);
    this.commitSurfaceMutation(() => {
      this.retainCleanupFailures(serverName, [
        {
          owner: cleanupOwner(serverName, bridge, () => invokeDisposal(bridge)),
          error,
        },
      ]);
      this.invalidateServerAuthority(serverName);
      this.bridges.delete(serverName);
      this.resourceBridges.delete(serverName);
      this.promptBridges.delete(serverName);
      this.connectedConnections.delete(serverName);
      this.serverInstructions.delete(serverName);
      this.connectionStates.set(serverName, {
        type: "failed",
        error: `MCP server "${serverName}" cleanup remains unproven`,
      });
    });
    const companionDisposals = [resourceBridge, promptBridge].flatMap(
      (companion) =>
        companion === undefined ? [] : [invokeDisposal(companion)],
    );
    void Promise.allSettled(companionDisposals).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          this.logger.warn?.(
            `Error disposing poisoned MCP server "${serverName}" companion:`,
            result.reason,
          );
        }
      }
    });
  }

  private retainCleanupFailures(
    serverName: string,
    failures: ReadonlyArray<{
      readonly owner: RetainedCleanupOwner;
      readonly error: unknown;
    }>,
  ): void {
    if (failures.length === 0) return;
    let retained = this.retainedCleanup.get(serverName);
    if (retained === undefined) {
      retained = { owners: new Map(), unownedErrors: [] };
      this.retainedCleanup.set(serverName, retained);
    }
    for (const { owner, error } of failures) {
      retained.owners.set(owner.identity, { ...owner, error });
    }
  }

  private retainUnownedCleanupFailure(
    serverName: string,
    error: unknown,
  ): void {
    let retained = this.retainedCleanup.get(serverName);
    if (retained === undefined) {
      retained = { owners: new Map(), unownedErrors: [] };
      this.retainedCleanup.set(serverName, retained);
    }
    retained.unownedErrors.push(error);
  }

  private retryRetainedCleanup(
    serverName: string,
    reason: string,
  ): Promise<void> {
    const retained = this.retainedCleanup.get(serverName);
    if (retained === undefined) return Promise.resolve();
    if (retained.retryTask !== undefined) return retained.retryTask;

    const owners = Array.from(retained.owners.values());
    const task = Promise.allSettled(
      owners.map((owner) => Promise.resolve().then(owner.dispose)),
    ).then((results) => {
      for (let index = 0; index < results.length; index += 1) {
        const owner = owners[index]!;
        if (retained.owners.get(owner.identity) !== owner) continue;
        const result = results[index]!;
        if (result.status === "fulfilled") {
          retained.owners.delete(owner.identity);
        } else {
          owner.error = result.reason;
        }
      }
      if (
        retained.owners.size === 0 &&
        retained.unownedErrors.length === 0
      ) {
        if (this.retainedCleanup.get(serverName) === retained) {
          this.retainedCleanup.delete(serverName);
          this.notifySurfaceChanged();
        }
        return;
      }
      throw new MCPConnectionCleanupError(
        serverName,
        reason,
        [
          ...retained.unownedErrors,
          ...Array.from(retained.owners.values(), (owner) => owner.error),
        ],
      );
    });
    retained.retryTask = task;
    const clearRetryTask = (): void => {
      if (retained.retryTask === task) delete retained.retryTask;
    };
    void task.then(clearRetryTask, clearRetryTask);
    return task;
  }

  private async disconnectServer(
    name: string,
    reason: string,
    strictCleanup = false,
  ): Promise<void> {
    const processOwner = this.processOwners.get(name);
    const idleTimer = this.idleTimers.get(name);
    if (idleTimer) clearTimeout(idleTimer);
    this.idleTimers.delete(name);
    this.pluginClientOwners.delete(name);
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
    this.commitSurfaceMutation(() => {
      this.connectedConnections.delete(name);
      this.bridges.delete(name);
      this.resourceBridges.delete(name);
      this.promptBridges.delete(name);
      this.serverInstructions.delete(name);
      if (this.connectionStates.get(name)?.type === "connected") {
        this.connectionStates.set(name, { type: "pending" });
      }
    });

    const owners: ServerCleanupOwner[] = [
      ...(existing !== undefined
        ? [cleanupOwner(name, existing, () => invokeDisposal(existing))]
        : []),
      ...(existingResource !== undefined
        ? [
            cleanupOwner(name, existingResource, () =>
              invokeDisposal(existingResource),
            ),
          ]
        : []),
      ...(existingPrompt !== undefined
        ? [
            cleanupOwner(name, existingPrompt, () =>
              invokeDisposal(existingPrompt),
            ),
          ]
        : []),
    ];
    const retainedRetry = this.retainedCleanup.has(name)
      ? this.retryRetainedCleanup(name, `${reason} retained cleanup retry`)
      : undefined;
    const disposalCount = owners.length + (retainedRetry === undefined ? 0 : 1);
    const results = await Promise.allSettled([
      ...owners.map((owner) => owner.dispose()),
      ...(retainedRetry !== undefined ? [retainedRetry] : []),
      ...attempts.map((attempt) => attempt.promise),
    ]);
    const cleanupErrors: unknown[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status !== "rejected") continue;
      const owner = owners[index];
      if (owner !== undefined) {
        this.retainCleanupFailures(name, [
          { owner, error: result.reason },
        ]);
      }
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
    if (cleanupErrors.length > 0) {
      this.notifySurfaceChanged();
    } else if (processOwner) {
      this.releaseOwner(name, processOwner);
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

function isMCPTransportCleanupFailure(
  error: unknown,
): error is MCPTransportCleanupError {
  return error instanceof MCPTransportCleanupError;
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
function raceWithAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new Error("MCP operation cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

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

function cleanupOwner(
  serverName: string,
  identity: unknown,
  dispose: () => Promise<void>,
): ServerCleanupOwner {
  return { serverName, identity, dispose, error: undefined };
}

function disposableCleanupOwner(
  serverName: string,
  disposable: { dispose(): Promise<void> },
): ServerCleanupOwner {
  return cleanupOwner(serverName, disposable, () => invokeDisposal(disposable));
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
