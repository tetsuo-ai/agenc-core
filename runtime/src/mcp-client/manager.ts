/**
 * MCP connection manager for @tetsuo-ai/runtime.
 *
 * Manages multiple MCP server connections, creating tool bridges
 * for each and exposing a unified tool list for the ToolRegistry.
 *
 * @module
 */

import type {
  MCPReconnectResult,
  MCPServerConfig,
  MCPToolBridge,
} from "./types.js";
import type { Tool } from "../tools/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tool-bridge.js";
import { ResilientMCPBridge } from "./resilient-bridge.js";
import type { MCPToolCatalogPolicyConfig } from "./tool-bridge.js";
import {
  createResourceBridge,
  type MCPResourceBridge,
  type MCPResourceContent,
  type MCPResourceDescriptor,
} from "./resource-bridge.js";
import {
  createPromptBridge,
  type MCPPromptBridge,
  type MCPPromptDescriptor,
  type MCPPromptRendered,
} from "./prompt-bridge.js";

/** I-50: cancellable MCP startup wait; 30s default. */
export const MCP_STARTUP_TIMEOUT_MS = 30_000;

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

function toToolCatalogPolicyConfig(
  config: MCPServerConfig,
): MCPToolCatalogPolicyConfig | undefined {
  const typed = config as MCPServerConfig & MCPToolCatalogPolicyConfig;
  if (!typed.riskControls && !typed.supplyChain) {
    return undefined;
  }
  return {
    riskControls: typed.riskControls,
    supplyChain: typed.supplyChain,
  };
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
  private readonly configs: MCPServerConfig[];
  private readonly logger: Logger;
  private readonly bridges: Map<string, MCPToolBridge> = new Map();
  private readonly resourceBridges: Map<string, MCPResourceBridge> = new Map();
  private readonly promptBridges: Map<string, MCPPromptBridge> = new Map();

  constructor(configs: MCPServerConfig[], logger: Logger = silentLogger) {
    this.configs = configs;
    this.logger = logger;
  }

  /**
   * Connect to all enabled MCP servers and create tool bridges.
   * Failures on individual servers are logged but don't block others
   * (I-6 fail-soft) — unless `requireOneReady` / `requiredServers`
   * is set, in which case I-20 aggregate-failure trips.
   *
   * I-50: the caller may pass `signal` to abort the startup wait;
   * any servers that connected still stay connected, the rest are
   * left to resolve/reject in the background under their own
   * connect-timeout.
   */
  async start(opts: MCPManagerStartOpts = {}): Promise<void> {
    const enabledConfigs = this.configs.filter((c) => c.enabled !== false);

    if (enabledConfigs.length === 0) {
      this.logger.info("No MCP servers configured");
      return;
    }

    const signal = opts.signal;
    if (signal?.aborted) {
      throw new Error(
        `MCP startup cancelled before first connect (${signal.reason ?? "unspecified"})`,
      );
    }
    const timeoutMs = opts.timeoutMs ?? MCP_STARTUP_TIMEOUT_MS;

    this.logger.info(`Starting ${enabledConfigs.length} MCP server(s)...`);

    // I-50: race each per-server connect against the external signal.
    const results = await Promise.all(
      enabledConfigs.map((config) =>
        raceWithSignal(
          this.connectServer(config),
          signal,
          timeoutMs,
          `MCP server "${config.name}" connect`,
        ).then(
          (bridge) => ({ status: "fulfilled" as const, value: bridge }),
          (err: unknown) => ({ status: "rejected" as const, reason: err }),
        ),
      ),
    );

    let successCount = 0;
    const failures: Array<{ name: string; reason: unknown }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const cfg = enabledConfigs[i];
      if (result.status === "fulfilled") {
        successCount++;
      } else {
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
    const bridges = Array.from(this.bridges.values());
    const resourceBridges = Array.from(this.resourceBridges.values());
    const promptBridges = Array.from(this.promptBridges.values());
    // Dispose all bridges first, then clear the maps to avoid race conditions
    await Promise.allSettled([
      ...bridges.map((bridge) => bridge.dispose()),
      ...resourceBridges.map((bridge) => bridge.dispose()),
      ...promptBridges.map((bridge) => bridge.dispose()),
    ]);
    this.bridges.clear();
    this.resourceBridges.clear();
    this.promptBridges.clear();
    this.logger.info("All MCP servers disconnected");
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

  getConfiguredServers(): readonly MCPServerConfig[] {
    return [...this.configs];
  }

  getServerConfig(name: string): MCPServerConfig | undefined {
    return this.configs.find((config) => config.name === name);
  }

  isConnected(name: string): boolean {
    return this.bridges.has(name);
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
      return {
        serverName: name,
        success: false,
        toolCount: 0,
        error: `MCP server "${name}" is disabled in config.`,
      };
    }

    const existing = this.bridges.get(name);
    if (existing) {
      this.bridges.delete(name);
      try {
        await existing.dispose();
      } catch (error) {
        this.logger.warn?.(
          `Error disposing MCP server "${name}" before reconnect:`,
          error,
        );
      }
    }
    const existingResource = this.resourceBridges.get(name);
    if (existingResource) {
      this.resourceBridges.delete(name);
      try {
        await existingResource.dispose();
      } catch (error) {
        this.logger.warn?.(
          `Error disposing MCP resource bridge for "${name}" before reconnect:`,
          error,
        );
      }
    }
    const existingPrompt = this.promptBridges.get(name);
    if (existingPrompt) {
      this.promptBridges.delete(name);
      try {
        await existingPrompt.dispose();
      } catch (error) {
        this.logger.warn?.(
          `Error disposing MCP prompt bridge for "${name}" before reconnect:`,
          error,
        );
      }
    }

    try {
      const bridge = await this.connectServer(config);
      return {
        serverName: name,
        success: true,
        toolCount: bridge.tools.length,
      };
    } catch (error) {
      return {
        serverName: name,
        success: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

  private async connectServer(config: MCPServerConfig): Promise<MCPToolBridge> {
    const client = await createMCPConnection(config, this.logger);
    try {
      const rawBridge = await createToolBridge(
        client,
        config.name,
        this.logger,
        {
          listToolsTimeoutMs: config.timeout,
          callToolTimeoutMs: config.timeout,
          serverConfig: toToolCatalogPolicyConfig(config),
        },
      );
      // I-73: reject MCP tools whose namespaced names collide with
      // already-registered tools (from earlier servers). Bail the
      // whole bridge — the caller can re-configure the namespace.
      this.assertNoNameShadowing(config.name, rawBridge);
      const bridge = new ResilientMCPBridge(config, rawBridge, this.logger);
      this.bridges.set(config.name, bridge);

      // T9-D: resource + prompt bridges are optional on many servers.
      // Failures here must not take down the whole server connection —
      // log and continue so the tool surface still works.
      try {
        const resourceBridge = await createResourceBridge(
          client,
          config.name,
          this.logger,
          {
            ...(config.timeout !== undefined
              ? { rpcTimeoutMs: config.timeout }
              : {}),
          },
        );
        this.resourceBridges.set(config.name, resourceBridge);
      } catch (error) {
        this.logger.warn?.(
          `MCP server "${config.name}" resource bridge unavailable:`,
          error,
        );
      }

      try {
        const promptBridge = await createPromptBridge(
          client,
          config.name,
          this.logger,
          {
            ...(config.timeout !== undefined
              ? { rpcTimeoutMs: config.timeout }
              : {}),
          },
        );
        this.promptBridges.set(config.name, promptBridge);
      } catch (error) {
        this.logger.warn?.(
          `MCP server "${config.name}" prompt bridge unavailable:`,
          error,
        );
      }

      return bridge;
    } catch (error) {
      try {
        await client.close();
      } catch {
        // best effort
      }
      throw error;
    }
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
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
): Promise<T> {
  const contenders: Promise<T>[] = [task];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  if (signal) {
    contenders.push(
      new Promise<T>((_, reject) => {
        if (signal.aborted) {
          reject(new Error(`${label} aborted (${signal.reason ?? "signal"})`));
          return;
        }
        onAbort = () => {
          reject(new Error(`${label} aborted (${signal.reason ?? "signal"})`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  contenders.push(
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
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
