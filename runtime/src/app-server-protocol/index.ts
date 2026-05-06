/**
 * Defines the stable protocol slice that browser-based AgenC portal clients
 * are allowed to rely on before the portal repository grows its own transport
 * implementation.
 *
 * WP-01 owns this shared contract because the web portal lives in a sibling
 * repository while the daemon protocol is still defined by agenc-core.
 */

import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type AgenCDaemonMethod,
  type InitializeParams,
} from "../app-server/protocol/index.js";

export const AGENC_PORTAL_PROTOCOL_VERSION = "0.1.0" as const;
export const AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT =
  "ws://127.0.0.1:7766/" as const;
export const AGENC_PORTAL_DEFAULT_REMOTE_DAEMON_ENDPOINT =
  "wss://agenc.tech/daemon" as const;
export const AGENC_PORTAL_DEFAULT_REQUEST_TIMEOUT_MS = 15_000 as const;

export const AGENC_PORTAL_METHODS = [
  "initialize",
  "health.ready",
  "health.stats",
  "auth.whoami",
  "session.list",
  "session.attach",
  "agent.list",
  "agent.attach",
] as const satisfies readonly AgenCDaemonMethod[];

export type AgenCPortalMethod = (typeof AGENC_PORTAL_METHODS)[number];

export const AGENC_PORTAL_CLIENT_CAPABILITIES = [
  "portal.dashboard.read",
  "portal.session.attach",
  "portal.agent.attach",
] as const;

export type AgenCPortalClientCapability =
  (typeof AGENC_PORTAL_CLIENT_CAPABILITIES)[number];

export const AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS = {
  "portal.dashboard.read": true,
  "portal.session.attach": true,
  "portal.agent.attach": true,
} as const satisfies Record<AgenCPortalClientCapability, true>;

export const AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST = {
  jsonrpc: JSON_RPC_VERSION,
  id: "initialize",
  method: "initialize",
  params: {
    protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
    protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
    clientName: "agenc-portal",
    capabilities: AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
  },
} as const satisfies {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: "initialize";
  readonly method: "initialize";
  readonly params: InitializeParams;
};

export const AGENC_PORTAL_CONNECTION_STATUSES = [
  "disconnected",
  "connecting",
  "connected",
  "failed",
] as const;

export type AgenCPortalConnectionStatus =
  (typeof AGENC_PORTAL_CONNECTION_STATUSES)[number];

export interface AgenCPortalConnectionTarget {
  readonly kind: "local-daemon" | "remote-daemon";
  readonly label: string;
  readonly endpoint: string;
}

export interface AgenCPortalConnectionState {
  readonly status: AgenCPortalConnectionStatus;
  readonly target: AgenCPortalConnectionTarget | null;
  readonly initialized: boolean;
  readonly error: string | null;
  readonly updatedAt: string | null;
}

export interface AgenCPortalSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly status: "idle" | "running" | "waiting" | "stopped";
  readonly updatedAt: string;
}

export interface AgenCPortalAgentSummary {
  readonly agentId: string;
  readonly objective: string;
  readonly status: "queued" | "running" | "paused" | "stopped" | "failed";
  readonly activeSessionId: string | null;
  readonly updatedAt: string;
}

export interface AgenCPortalDashboardSnapshot {
  readonly protocolVersion: typeof AGENC_PORTAL_PROTOCOL_VERSION;
  readonly connection: AgenCPortalConnectionTarget | null;
  readonly connectionState: AgenCPortalConnectionState;
  readonly sessions: readonly AgenCPortalSessionSummary[];
  readonly agents: readonly AgenCPortalAgentSummary[];
}

export function isAgenCPortalMethod(
  value: string,
): value is AgenCPortalMethod {
  return (AGENC_PORTAL_METHODS as readonly string[]).includes(value);
}
