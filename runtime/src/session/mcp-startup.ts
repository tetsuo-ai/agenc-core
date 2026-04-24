/**
 * MCP manager startup helpers owned by the session boundary.
 *
 * `attachMcpManagerToSession` is the single canonical attach site so
 * every session owner (CLI, daemon, tests) wires the observer the same
 * way. Call this BEFORE `manager.start()`; the bridge factory bakes the
 * observer into every per-tool `execute()` closure at creation time, so
 * attaching after `start()` only covers bridges created afterwards.
 *
 * `startMcpManagerForSession` is the live contract used by bootstrap:
 * the caller may still construct the concrete `MCPManager`, but the
 * session boundary owns the attach/start ordering for the running
 * session.
 *
 * This module also ships `getMcpConfigFromEnv()` as an explicit
 * `AGENC_MCP_SERVERS` override. Normal startup reads the loaded
 * `~/.agenc/config.toml` snapshot (`mcp_servers`) first, then lets the
 * env override replace that list when set.
 *
 * @module
 */

import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import { MCPManager as LiveMCPManager } from "../mcp-client/manager.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import type {
  AgenCConfig,
  McpServerConfig as AgenCMcpServerConfig,
} from "../config/index.js";
import type { Session } from "./session.js";
import type { SessionServices } from "./session.js";
import { createMCPCallObserverForSession } from "./observer-wiring.js";

export interface McpStartupCancellationToken {
  readonly signal: AbortSignal;
  cancel(): void;
  isCancelled(): boolean;
}

export interface McpRefreshResult {
  readonly configuredServers: readonly string[];
  readonly requiredServers: readonly string[];
}

export interface CreateSessionMcpServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
}

type ConfiguredServerWithExtras = MCPServerConfig & {
  readonly required?: boolean;
  readonly instructions?: string;
};

type EffectiveServerWithInstructions = Awaited<
  ReturnType<SessionServices["mcpManager"]["effectiveServers"]>
> extends Map<string, infer Info>
  ? Info & { readonly instructions?: string }
  : never;

type RuntimeMcpManagerWithMetadata = MCPManager & {
  getConnectedServers?(): string[];
  getConfiguredServers?(): readonly ConfiguredServerWithExtras[];
  getServerConfig?(name: string): ConfiguredServerWithExtras | undefined;
  getServerInstructions?(name: string): string | undefined;
  getInstructionsForServer?(name: string): string | undefined;
};

function getServerInstructions(
  manager: RuntimeMcpManagerWithMetadata,
  config: ConfiguredServerWithExtras | undefined,
  name: string,
): string | undefined {
  const fromManager =
    manager.getServerInstructions?.(name) ??
    manager.getInstructionsForServer?.(name);
  if (typeof fromManager === "string" && fromManager.trim().length > 0) {
    return fromManager;
  }
  if (typeof config?.instructions === "string" && config.instructions.trim().length > 0) {
    return config.instructions;
  }
  return undefined;
}

function buildEffectiveServerMap(
  manager: RuntimeMcpManagerWithMetadata,
): Map<string, EffectiveServerWithInstructions> {
  const connectedNames = new Set(manager.getConnectedServers?.() ?? []);
  const configs = manager.getConfiguredServers?.() ?? [];
  const map = new Map<string, EffectiveServerWithInstructions>();

  for (const rawConfig of configs) {
    const config = rawConfig as ConfiguredServerWithExtras;
    const connected = connectedNames.has(config.name);
    const instructions = connected
      ? getServerInstructions(manager, config, config.name)
      : undefined;
    map.set(config.name, {
      enabled: connected,
      required: config.required ?? false,
      ...(config.endpoint !== undefined ? { url: config.endpoint } : {}),
      ...(config.command !== undefined ? { command: config.command } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    } as EffectiveServerWithInstructions);
  }

  for (const name of connectedNames) {
    if (map.has(name)) {
      continue;
    }
    const config = manager.getServerConfig?.(name) as
      | ConfiguredServerWithExtras
      | undefined;
    const instructions = getServerInstructions(manager, config, name);
    map.set(name, {
      enabled: true,
      required: config?.required ?? false,
      ...(config?.endpoint !== undefined ? { url: config.endpoint } : {}),
      ...(config?.command !== undefined ? { command: config.command } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    } as EffectiveServerWithInstructions);
  }

  return map;
}

/**
 * Construct the real runtime `MCPManager` for a session boundary.
 * Bootstrap/CLI own env/config discovery, but the concrete manager
 * type comes from the session MCP startup module so the live lifecycle
 * stays anchored at the runtime boundary instead of legacy service/UI
 * surfaces.
 */
export function createSessionMcpManager(
  configs: ReadonlyArray<MCPServerConfig>,
): MCPManager {
  return new LiveMCPManager([...configs]);
}

function cloneRecord<T>(
  value: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  return value ? { ...value } : undefined;
}

function toRuntimeMcpServerConfig(
  name: string,
  config: AgenCMcpServerConfig,
): MCPServerConfig {
  const raw = config as AgenCMcpServerConfig & Record<string, unknown>;
  return {
    ...raw,
    name,
    ...(config.args !== undefined ? { args: [...config.args] } : {}),
    ...(config.env !== undefined ? { env: cloneRecord(config.env) } : {}),
    ...(config.headers !== undefined
      ? { headers: cloneRecord(config.headers) }
      : {}),
  } as MCPServerConfig;
}

/**
 * Read `mcp_servers` from the loaded AgenC config snapshot and convert
 * keyed TOML tables (`[mcp_servers.github]`) into the runtime manager's
 * named config array (`{ name: "github", ... }`).
 */
export function getMcpConfigFromConfig(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
): MCPServerConfig[] {
  const servers = config?.mcp_servers;
  if (!servers) return [];
  return Object.entries(servers)
    .filter((entry): entry is [string, AgenCMcpServerConfig] => {
      const [name, value] = entry;
      return (
        typeof name === "string" &&
        name.trim().length > 0 &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      );
    })
    .map(([name, value]) => toRuntimeMcpServerConfig(name, value));
}

function hasMcpEnvOverride(env: NodeJS.ProcessEnv): boolean {
  return (
    typeof env.AGENC_MCP_SERVERS === "string" &&
    env.AGENC_MCP_SERVERS.trim().length > 0
  );
}

/**
 * Resolve the effective MCP server list for session startup. Config is
 * the default source; `AGENC_MCP_SERVERS` remains a complete override
 * so ops/tests can replace the list without editing config.toml.
 */
export function resolveSessionMcpConfig(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MCPServerConfig[] {
  if (hasMcpEnvOverride(env)) {
    return getMcpConfigFromEnv(env);
  }
  return getMcpConfigFromConfig(config);
}

/**
 * Config-backed manager construction for the local runtime path. The
 * env parameter is only the explicit `AGENC_MCP_SERVERS` override.
 */
export function createSessionMcpManagerFromConfig(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MCPManager {
  return createSessionMcpManager(resolveSessionMcpConfig(config, env));
}

/**
 * Back-compat env-backed manager construction for callers/tests that
 * have not yet threaded a ConfigStore snapshot. Prefer
 * `createSessionMcpManagerFromConfig` in live bootstrap paths.
 */
export function createSessionMcpManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<AgenCConfig, "mcp_servers">,
): MCPManager {
  return createSessionMcpManager(resolveSessionMcpConfig(config, env));
}

export function requiredMcpServerNames(
  configs: ReadonlyArray<MCPServerConfig>,
): string[] {
  return configs
    .filter(
      (config): config is ConfiguredServerWithExtras =>
        (config as ConfiguredServerWithExtras).required === true,
    )
    .map((config) => config.name);
}

function withConfiguredRequiredServers(
  configs: ReadonlyArray<MCPServerConfig>,
  opts: MCPManagerStartOpts = {},
): MCPManagerStartOpts {
  if (opts.requiredServers !== undefined) {
    return opts;
  }
  const requiredServers = requiredMcpServerNames(configs);
  if (requiredServers.length === 0) {
    return opts;
  }
  return {
    ...opts,
    requiredServers,
  };
}

export async function refreshMcpManagerFromConfig(params: {
  readonly manager: MCPManager;
  readonly config: Pick<AgenCConfig, "mcp_servers"> | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly opts?: MCPManagerStartOpts;
}): Promise<McpRefreshResult> {
  const configs = resolveSessionMcpConfig(params.config, params.env);
  const requiredServers = requiredMcpServerNames(configs);
  await params.manager.refreshServers(
    configs,
    withConfiguredRequiredServers(configs, params.opts ?? {}),
  );
  return {
    configuredServers: configs.map((config) => config.name),
    requiredServers,
  };
}

export function createMcpStartupCancellationToken(): McpStartupCancellationToken {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel: () => {
      if (!controller.signal.aborted) {
        controller.abort("mcp_startup_cancelled");
      }
    },
    isCancelled: () => controller.signal.aborted,
  };
}

/**
 * Session-facing MCP service surface. This is intentionally not the
 * old React/service MCP owner; it is a thin facade over the real live
 * manager so routing/provenance callers and subagent readiness checks
 * all observe the same runtime-owned connection state.
 */
export function createSessionMcpService(
  manager: MCPManager,
  options: CreateSessionMcpServiceOptions = {},
): SessionServices["mcpManager"] {
  const runtimeManager = manager as RuntimeMcpManagerWithMetadata;
  return {
    effectiveServers: async () => buildEffectiveServerMap(runtimeManager),
    toolPluginProvenance: async () => null,
    refreshFromConfig: (config) =>
      refreshMcpManagerFromConfig({
        manager,
        config: config as Pick<AgenCConfig, "mcp_servers"> | undefined,
        env: options.env,
      }),
    isConnected:
      typeof manager.isConnected === "function"
        ? manager.isConnected.bind(manager)
        : undefined,
    resolveMcpToolInfo:
      typeof manager.resolveMcpToolInfo === "function"
        ? manager.resolveMcpToolInfo.bind(manager)
        : undefined,
    getServerForTool:
      typeof manager.getServerForTool === "function"
        ? manager.getServerForTool.bind(manager)
        : undefined,
  };
}

/**
 * Attach a session's MCP call observer to an `MCPManager`. Must run
 * BEFORE `manager.start()` so `mcp_tool_call_begin` /
 * `mcp_tool_call_end` events are captured from the very first bridge.
 *
 * The helper tolerates `sessionSlot.current === null` (the slot may
 * still be unfilled at wiring time) — the slot-bound observer silently
 * drops events until the slot is populated.
 */
export function attachMcpManagerToSession(
  manager: MCPManager,
  session: Session,
): void {
  const observer = createMCPCallObserverForSession(session);
  try {
    manager.setCallObserver(observer);
  } catch (err) {
    // Surface the failure through the session's event log so ops
    // can see that MCP telemetry is missing rather than silently
    // dropping events.
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "error",
        payload: {
          cause: "mcp_observer_attach_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      },
    });
    throw err;
  }
}

/**
 * Canonical live startup ordering for a session-owned MCP manager.
 * Attaches the observer first, then starts the manager.
 */
export async function startMcpManagerForSession(
  manager: MCPManager,
  session: Session,
  opts: MCPManagerStartOpts = {},
): Promise<void> {
  attachMcpManagerToSession(manager, session);
  const metadataManager = manager as MCPManager & {
    getConfiguredServers?(): readonly MCPServerConfig[];
  };
  const configs = metadataManager.getConfiguredServers?.() ?? [];
  await manager.start(withConfiguredRequiredServers(configs, opts));
}

/**
 * Read `AGENC_MCP_SERVERS` and parse it as a JSON array of runtime
 * `MCPServerConfig` objects. Returns `[]` when the env var is unset,
 * empty, or malformed — the caller can still construct an
 * `MCPManager` with an empty config so the observer-attach site
 * remains live.
 */
export function getMcpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MCPServerConfig[] {
  const raw = env.AGENC_MCP_SERVERS;
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is MCPServerConfig =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string",
    );
  } catch {
    return [];
  }
}
