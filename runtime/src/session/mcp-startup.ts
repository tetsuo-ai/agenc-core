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
 * This module also ships `getMcpConfigFromEnv()`, a minimal escape
 * hatch that lets ops inject MCP servers via the `AGENC_MCP_SERVERS`
 * env var until the full `~/.agenc/config.toml` plumbing lands (T10).
 * The env var must be a JSON array of `MCPServerConfig` objects.
 *
 * @module
 */

import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import { MCPManager as LiveMCPManager } from "../mcp-client/manager.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import type { Session } from "./session.js";
import type { SessionServices } from "./session.js";
import { createMCPCallObserverForSession } from "./observer-wiring.js";

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

/**
 * Minimal env-backed manager construction for the local runtime path.
 * This preserves the current `AGENC_MCP_SERVERS` escape hatch while
 * making the session bootstrap layer the owner of manager creation.
 */
export function createSessionMcpManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MCPManager {
  return createSessionMcpManager(getMcpConfigFromEnv(env));
}

/**
 * Session-facing MCP service surface. This is intentionally not the
 * old React/service MCP owner; it is a thin facade over the real live
 * manager so routing/provenance callers and subagent readiness checks
 * all observe the same runtime-owned connection state.
 */
export function createSessionMcpService(
  manager: MCPManager,
): SessionServices["mcpManager"] {
  const runtimeManager = manager as RuntimeMcpManagerWithMetadata;
  return {
    effectiveServers: async () => buildEffectiveServerMap(runtimeManager),
    toolPluginProvenance: async () => null,
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
  await manager.start(opts);
}

/**
 * Read `AGENC_MCP_SERVERS` and parse it as a JSON array of
 * `MCPServerConfig`. Returns `[]` when the env var is unset, empty,
 * or malformed — the caller can still construct an `MCPManager`
 * with an empty config so the observer-attach site remains live.
 *
 * T10 will replace this with a real `~/.agenc/config.toml` resolver.
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
