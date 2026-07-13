/**
 * Defines the stable protocol slice that browser-based AgenC portal clients
 * are allowed to rely on before the portal repository grows its own transport
 * implementation.
 *
 * WP-01 introduced this shared contract; WP-02 extends it with the browser
 * WebSocket connection defaults and initialize handshake used by the sibling
 * portal repository while the daemon protocol is still defined by agenc-core.
 * WP-03 adds auth read/mutation methods that must reuse the daemon
 * AuthBackend state instead of creating a portal-specific token store.
 * WP-04 adds the session/agent workspace controls for attaching, reading
 * agent transcripts, and sending messages through existing daemon methods.
 * WP-05 adds dashboard controls for listing, starting, and stopping
 * background agents through the same daemon JSON-RPC contract.
 * WP-06 adds a compact read-only mobile status projection for phone check-ins.
 */

import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  JSON_RPC_VERSION,
  type AgentCreateParams,
  type AgentListParams,
  type AgentStatus,
  type AgentAttachParams,
  type AgentLogsParams,
  type AgentStopParams,
  type AgenCDaemonMethod,
  type AgenCDaemonRequestWithParams,
  type InitializeParams,
  type JsonObject,
  type MessageContent,
  type MessageSendParams,
  type RequestId,
  type SessionAttachParams,
} from "../app-server/protocol/index.js";
import type { AuthBackendKind, AuthIdentity } from "../auth/backend.js";

export const AGENC_PORTAL_PROTOCOL_VERSION = "0.4.0" as const;
export const AGENC_PORTAL_CLIENT_ID = "agenc-portal" as const;
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
  "auth.login",
  "auth.logout",
  "session.list",
  "session.attach",
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "agent.logs",
  "message.send",
] as const satisfies readonly AgenCDaemonMethod[];

export type AgenCPortalMethod = (typeof AGENC_PORTAL_METHODS)[number];

export const AGENC_PORTAL_CLIENT_CAPABILITIES = [
  "portal.dashboard.read",
  "portal.mobile.status.read",
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  "portal.auth.read",
  "portal.auth.login",
  "portal.auth.logout",
  "portal.session.attach",
  "portal.agent.list",
  "portal.agent.start",
  "portal.agent.attach",
  "portal.agent.stop",
  "portal.transcript.read",
  "portal.message.send",
] as const;

export type AgenCPortalClientCapability =
  (typeof AGENC_PORTAL_CLIENT_CAPABILITIES)[number];

export const AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS = {
  "portal.dashboard.read": true,
  "portal.mobile.status.read": true,
  [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true,
  "portal.auth.read": true,
  "portal.auth.login": true,
  "portal.auth.logout": true,
  "portal.session.attach": true,
  "portal.agent.list": true,
  "portal.agent.start": true,
  "portal.agent.attach": true,
  "portal.agent.stop": true,
  "portal.transcript.read": true,
  "portal.message.send": true,
} as const satisfies Record<AgenCPortalClientCapability, true>;

export const AGENC_PORTAL_AUTH_METHODS = [
  "auth.whoami",
  "auth.login",
  "auth.logout",
] as const satisfies readonly AgenCPortalMethod[];

export type AgenCPortalAuthMethod =
  (typeof AGENC_PORTAL_AUTH_METHODS)[number];

export type AgenCPortalAgentCreateRequest = AgenCDaemonRequestWithParams<
  "agent.create",
  AgentCreateParams
>;

export type AgenCPortalAgentListRequest = AgenCDaemonRequestWithParams<
  "agent.list",
  AgentListParams
>;

export type AgenCPortalSessionAttachRequest = AgenCDaemonRequestWithParams<
  "session.attach",
  SessionAttachParams
>;

export type AgenCPortalAgentAttachRequest = AgenCDaemonRequestWithParams<
  "agent.attach",
  AgentAttachParams
>;

export type AgenCPortalAgentLogsRequest = AgenCDaemonRequestWithParams<
  "agent.logs",
  AgentLogsParams
>;

export type AgenCPortalAgentStopRequest = AgenCDaemonRequestWithParams<
  "agent.stop",
  AgentStopParams
>;

export type AgenCPortalMessageSendRequest = AgenCDaemonRequestWithParams<
  "message.send",
  MessageSendParams
>;

export interface AgenCPortalAgentStartOptions extends AgentCreateParams {
  readonly objective: string;
}

export interface AgenCPortalMessageSendOptions {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly clientMessageId?: string;
  readonly metadata?: JsonObject;
}

export interface AgenCPortalDaemonInitializeRequest {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: "initialize";
  readonly method: "initialize";
  readonly params: InitializeParams;
}

export function createAgenCPortalDaemonInitializeRequest(
  authCookie?: string | null,
): AgenCPortalDaemonInitializeRequest {
  const params: InitializeParams = {
    protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
    protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
    clientName: AGENC_PORTAL_CLIENT_ID,
    capabilities: AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
    ...(authCookie !== undefined && authCookie !== null
      ? { authCookie }
      : {}),
  };
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: "initialize",
    method: "initialize",
    params,
  };
}

export const AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST =
  createAgenCPortalDaemonInitializeRequest();

export function createAgenCPortalAgentListRequest(
  params: AgentListParams = {},
  id: RequestId = "agent.list",
): AgenCPortalAgentListRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "agent.list",
    params,
  };
}

export function createAgenCPortalAgentCreateRequest(
  options: AgenCPortalAgentStartOptions,
  id: RequestId = "agent.create",
): AgenCPortalAgentCreateRequest {
  const params: AgentCreateParams = {
    objective: options.objective,
    cwd: options.cwd,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {}),
    ...(options.initialContent !== undefined
      ? { initialContent: options.initialContent }
      : {}),
    ...(options.unattendedAllow !== undefined
      ? { unattendedAllow: options.unattendedAllow }
      : {}),
    ...(options.unattendedDeny !== undefined
      ? { unattendedDeny: options.unattendedDeny }
      : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "agent.create",
    params,
  };
}

export function createAgenCPortalSessionAttachRequest(
  sessionId: string,
  clientId: string = AGENC_PORTAL_CLIENT_ID,
  id: RequestId = "session.attach",
): AgenCPortalSessionAttachRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "session.attach",
    params: { sessionId, clientId },
  };
}

export function createAgenCPortalAgentAttachRequest(
  agentId: string,
  clientId: string = AGENC_PORTAL_CLIENT_ID,
  id: RequestId = "agent.attach",
): AgenCPortalAgentAttachRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "agent.attach",
    params: { agentId, clientId },
  };
}

export function createAgenCPortalAgentLogsRequest(
  agentId: string,
  id: RequestId = "agent.logs",
): AgenCPortalAgentLogsRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "agent.logs",
    params: { agentId },
  };
}

export function createAgenCPortalAgentStopRequest(
  agentId: string,
  reason?: string,
  id: RequestId = "agent.stop",
): AgenCPortalAgentStopRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "agent.stop",
    params: {
      agentId,
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

export function createAgenCPortalMessageSendRequest(
  options: AgenCPortalMessageSendOptions,
  id: RequestId = "message.send",
): AgenCPortalMessageSendRequest {
  const params: MessageSendParams = {
    sessionId: options.sessionId,
    content: options.content,
    ...(options.clientMessageId !== undefined
      ? { clientMessageId: options.clientMessageId }
      : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: "message.send",
    params,
  };
}

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

export interface AgenCPortalAuthState {
  readonly authenticated: boolean;
  readonly provider: AuthBackendKind | null;
  readonly identity: AuthIdentity | null;
  readonly error: string | null;
  readonly updatedAt: string | null;
}

export interface AgenCPortalSessionSummary {
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly title: string;
  readonly cwd: string | null;
  readonly status: "idle" | "running" | "waiting" | "stopped";
  readonly updatedAt: string;
}

export interface AgenCPortalAgentSummary {
  readonly agentId: string;
  readonly objective: string;
  readonly status: AgentStatus;
  readonly activeSessionId: string | null;
  readonly updatedAt: string;
}

export interface AgenCPortalTranscriptSession {
  readonly sessionId: string;
  readonly itemCount: number;
  readonly transcript: string;
  readonly rolloutPath?: string;
  readonly source?: string;
}

export interface AgenCPortalTranscriptSnapshot {
  readonly agentId: string;
  readonly transcript: string;
  readonly sessions: readonly AgenCPortalTranscriptSession[];
  readonly updatedAt: string;
}

export interface AgenCPortalComposerState {
  readonly sessionId: string | null;
  readonly draft: string;
  readonly sending: boolean;
  readonly lastMessageId: string | null;
  readonly error: string | null;
}

export interface AgenCPortalBackgroundAgentDashboardState {
  readonly agents: readonly AgenCPortalAgentSummary[];
  readonly nextCursor: string | null;
  readonly starting: boolean;
  readonly stoppingAgentIds: readonly string[];
  readonly error: string | null;
  readonly updatedAt: string | null;
}

export interface AgenCPortalDashboardSnapshot {
  readonly protocolVersion: typeof AGENC_PORTAL_PROTOCOL_VERSION;
  readonly connection: AgenCPortalConnectionTarget | null;
  readonly connectionState: AgenCPortalConnectionState;
  readonly auth: AgenCPortalAuthState;
  readonly sessions: readonly AgenCPortalSessionSummary[];
  readonly agents: readonly AgenCPortalAgentSummary[];
  readonly backgroundAgents: AgenCPortalBackgroundAgentDashboardState;
  readonly transcript: AgenCPortalTranscriptSnapshot | null;
  readonly composer: AgenCPortalComposerState;
}

export type AgenCPortalAgentStatus = AgenCPortalAgentSummary["status"];
export type AgenCPortalSessionStatus = AgenCPortalSessionSummary["status"];

export interface AgenCPortalMobileStatusCounts {
  readonly totalAgents: number;
  readonly totalSessions: number;
  readonly attentionAgents: number;
  readonly attentionSessions: number;
  readonly agents: Readonly<Record<AgenCPortalAgentStatus, number>>;
  readonly sessions: Readonly<Record<AgenCPortalSessionStatus, number>>;
}

export interface AgenCPortalMobileAgentCheckIn {
  readonly agentId: string;
  readonly objective: string;
  readonly status: AgenCPortalAgentStatus;
  readonly activeSessionId: string | null;
  readonly sessionTitle: string | null;
  readonly needsAttention: boolean;
  readonly updatedAt: string;
}

export interface AgenCPortalMobileSessionCheckIn {
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly title: string;
  readonly status: AgenCPortalSessionStatus;
  readonly needsAttention: boolean;
  readonly updatedAt: string;
}

export interface AgenCPortalMobileConnectionState {
  readonly status: AgenCPortalConnectionStatus;
  readonly initialized: boolean;
}

export interface AgenCPortalMobileAuthState {
  readonly authenticated: boolean;
}

export interface AgenCPortalMobileStatusTruncation {
  readonly agents: boolean;
  readonly sessions: boolean;
}

export interface AgenCPortalMobileStatusSnapshot {
  readonly protocolVersion: typeof AGENC_PORTAL_PROTOCOL_VERSION;
  readonly generatedAt: string;
  readonly connection: AgenCPortalMobileConnectionState;
  readonly auth: AgenCPortalMobileAuthState;
  readonly counts: AgenCPortalMobileStatusCounts;
  readonly agents: readonly AgenCPortalMobileAgentCheckIn[];
  readonly sessions: readonly AgenCPortalMobileSessionCheckIn[];
  readonly truncated: AgenCPortalMobileStatusTruncation;
}

export interface AgenCPortalMobileStatusOptions {
  readonly now?: string;
  readonly maxAgents?: number;
  readonly maxSessions?: number;
}

const AGENC_PORTAL_MOBILE_DEFAULT_LIMIT = 5;
const AGENC_PORTAL_MOBILE_GENERATED_AT_FALLBACK =
  "1970-01-01T00:00:00.000Z";

function createAgentStatusCounts(): Record<AgenCPortalAgentStatus, number> {
  return {
    idle: 0,
    running: 0,
    stopping: 0,
    stopped: 0,
    error: 0,
  };
}

function createSessionStatusCounts(): Record<AgenCPortalSessionStatus, number> {
  return {
    idle: 0,
    running: 0,
    waiting: 0,
    stopped: 0,
  };
}

function normalizeMobileLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return AGENC_PORTAL_MOBILE_DEFAULT_LIMIT;
  }
  return Math.max(0, Math.floor(value));
}

function compareUpdatedAtDescThenId(
  leftUpdatedAt: string,
  leftId: string,
  rightUpdatedAt: string,
  rightId: string,
): number {
  const leftTime = Date.parse(leftUpdatedAt);
  const rightTime = Date.parse(rightUpdatedAt);
  const normalizedLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRightTime = Number.isFinite(rightTime) ? rightTime : 0;
  if (normalizedLeftTime !== normalizedRightTime) {
    return normalizedRightTime - normalizedLeftTime;
  }
  return leftId.localeCompare(rightId);
}

function mobileSessionNeedsAttention(
  session: AgenCPortalSessionSummary | null,
): boolean {
  return session?.status === "waiting";
}

function mobileAgentNeedsAttention(
  agent: AgenCPortalAgentSummary,
  activeSession: AgenCPortalSessionSummary | null,
): boolean {
  return (
    agent.status === "error" ||
    mobileSessionNeedsAttention(activeSession)
  );
}

function collectMobileAgents(
  snapshot: AgenCPortalDashboardSnapshot,
): AgenCPortalAgentSummary[] {
  const agentsById = new Map<string, AgenCPortalAgentSummary>();
  for (const agent of snapshot.agents) {
    agentsById.set(agent.agentId, agent);
  }
  for (const agent of snapshot.backgroundAgents.agents) {
    if (!agentsById.has(agent.agentId)) {
      agentsById.set(agent.agentId, agent);
    }
  }
  return [...agentsById.values()];
}

export function createAgenCPortalMobileStatusSnapshot(
  snapshot: AgenCPortalDashboardSnapshot,
  options: AgenCPortalMobileStatusOptions = {},
): AgenCPortalMobileStatusSnapshot {
  const maxAgents = normalizeMobileLimit(options.maxAgents);
  const maxSessions = normalizeMobileLimit(options.maxSessions);
  const sessionsById = new Map(
    snapshot.sessions.map((session) => [session.sessionId, session]),
  );
  const agentStatusCounts = createAgentStatusCounts();
  const sessionStatusCounts = createSessionStatusCounts();
  const sourceAgents = collectMobileAgents(snapshot);

  let attentionAgents = 0;
  const agents = sourceAgents
    .map((agent): AgenCPortalMobileAgentCheckIn => {
      const activeSession =
        agent.activeSessionId !== null
          ? sessionsById.get(agent.activeSessionId) ?? null
          : null;
      const needsAttention = mobileAgentNeedsAttention(agent, activeSession);
      agentStatusCounts[agent.status] += 1;
      if (needsAttention) {
        attentionAgents += 1;
      }
      return {
        agentId: agent.agentId,
        objective: agent.objective,
        status: agent.status,
        activeSessionId: agent.activeSessionId,
        sessionTitle: activeSession?.title ?? null,
        needsAttention,
        updatedAt: agent.updatedAt,
      };
    })
    .sort((left, right) =>
      compareUpdatedAtDescThenId(
        left.updatedAt,
        left.agentId,
        right.updatedAt,
        right.agentId,
      ),
    );

  let attentionSessions = 0;
  const sessions = snapshot.sessions
    .map((session): AgenCPortalMobileSessionCheckIn => {
      const needsAttention = mobileSessionNeedsAttention(session);
      sessionStatusCounts[session.status] += 1;
      if (needsAttention) {
        attentionSessions += 1;
      }
      return {
        sessionId: session.sessionId,
        agentId: session.agentId,
        title: session.title,
        status: session.status,
        needsAttention,
        updatedAt: session.updatedAt,
      };
    })
    .sort((left, right) =>
      compareUpdatedAtDescThenId(
        left.updatedAt,
        left.sessionId,
        right.updatedAt,
        right.sessionId,
      ),
    );

  return {
    protocolVersion: AGENC_PORTAL_PROTOCOL_VERSION,
    generatedAt:
      options.now ??
      snapshot.connectionState.updatedAt ??
      AGENC_PORTAL_MOBILE_GENERATED_AT_FALLBACK,
    connection: {
      status: snapshot.connectionState.status,
      initialized: snapshot.connectionState.initialized,
    },
    auth: {
      authenticated: snapshot.auth.authenticated,
    },
    counts: {
      totalAgents: sourceAgents.length,
      totalSessions: snapshot.sessions.length,
      attentionAgents,
      attentionSessions,
      agents: agentStatusCounts,
      sessions: sessionStatusCounts,
    },
    agents: agents.slice(0, maxAgents),
    sessions: sessions.slice(0, maxSessions),
    truncated: {
      agents: agents.length > maxAgents,
      sessions: sessions.length > maxSessions,
    },
  };
}

export function isAgenCPortalMethod(
  value: string,
): value is AgenCPortalMethod {
  return (AGENC_PORTAL_METHODS as readonly string[]).includes(value);
}

export function isAgenCPortalAuthMethod(
  value: string,
): value is AgenCPortalAuthMethod {
  return (AGENC_PORTAL_AUTH_METHODS as readonly string[]).includes(value);
}
