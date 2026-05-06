/**
 * Defines the stable protocol slice that browser-based AgenC portal clients
 * are allowed to rely on before the portal repository grows its own transport
 * implementation.
 *
 * WP-01 owns this shared contract because the web portal lives in a sibling
 * repository while the daemon protocol is still defined by agenc-core.
 */

import type { AgenCDaemonMethod } from "../app-server/protocol/index.js";

export const AGENC_PORTAL_PROTOCOL_VERSION = "0.1.0" as const;

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

export interface AgenCPortalConnectionTarget {
  readonly kind: "local-daemon" | "remote-daemon";
  readonly label: string;
  readonly endpoint: string;
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
  readonly sessions: readonly AgenCPortalSessionSummary[];
  readonly agents: readonly AgenCPortalAgentSummary[];
}

export function isAgenCPortalMethod(
  value: string,
): value is AgenCPortalMethod {
  return (AGENC_PORTAL_METHODS as readonly string[]).includes(value);
}
