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
 */

import {
  AGENC_DAEMON_PROTOCOL_VERSION,
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
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
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
