// Portal protocol: the JSON-RPC 2.0 surface the AgenC iOS app speaks, plus the gateway
// `{type,...}` message names it is translated to/from. The gateway names mirror
// `channels/webchat/protocol.ts` (the WebChat catalog) and are validated end-to-end against the
// running daemon by the existing relay translators. P4: import these directly from the WebChat
// protocol module / auto-generate, instead of re-declaring, to remove drift.

export const PORTAL_PROTOCOL_VERSION = "1.0.0" as const;

/** Default loopback bind for the portal's inbound JSON-RPC listener (matches the dev translator). */
export const PORTAL_DEFAULT_HOST = "127.0.0.1" as const;
export const PORTAL_DEFAULT_PORT = 7766 as const;

/** Default daemon gateway endpoint the portal dials out to as a loopback client. */
export const PORTAL_DEFAULT_DAEMON_URL = "ws://127.0.0.1:9101" as const;

/** Gateway WebChat `{type}` message names (inbound to / outbound from the daemon gateway). */
export const GW = {
  ping: "ping",
  pong: "pong",
  configGet: "config.get",
  chatMessage: "chat.message",
  chatStream: "chat.stream",
  chatResponse: "chat.response",
  chatTyping: "chat.typing",
  chatHistory: "chat.history",
  chatSession: "chat.session",
  chatSessionList: "chat.session.list",
  chatSessionResume: "chat.session.resume",
  chatUsage: "chat.usage",
  agentStatus: "agent.status",
  toolsExecuting: "tools.executing",
  toolsResult: "tools.result",
  approvalRequest: "approval.request",
  approvalRespond: "approval.respond",
  sessionCommandExecute: "session.command.execute",
  turnComplete: "turn.complete", // emitted by the daemon turn-wrapper finally (idempotent, turn-id-stamped)
  status: "status",
  error: "error",
} as const;

/** JSON-RPC methods the app may call. */
export const RPC = {
  initialize: "initialize",
  healthPing: "health.ping",
  sessionList: "session.list",
  sessionAttach: "session.attach",
  messageSend: "message.send",
  messageStream: "message.stream",
  toolApprove: "tool.approve",
  toolDeny: "tool.deny",
  setPermissionMode: "session.setPermissionMode",
  agentList: "agent.list",
  daemonInfo: "daemon.info",
} as const;

export const APP_METHODS: readonly string[] = [
  RPC.initialize,
  RPC.healthPing,
  RPC.sessionList,
  RPC.sessionAttach,
  RPC.messageStream,
  RPC.toolApprove,
  RPC.toolDeny,
  RPC.setPermissionMode,
  RPC.agentList,
  RPC.daemonInfo,
];

/** JSON-RPC notification methods the portal pushes to the app (the app's PortalEventAdapter shape). */
export const NOTIFY = {
  messageChunk: "event.message_chunk",
  sessionEvent: "event.session_event",
  toolRequest: "event.tool_request",
  permissionRequest: "event.permission_request",
} as const;

/** Structured JSON-RPC error codes (G8): a stable map instead of the gateway's free-form strings. */
export const PORTAL_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internal: -32603,
  gateway: -32000,
  unauthorized: -32001,
  gatewayClosed: -32002,
} as const;

/** Map a free-form gateway error string to a structured JSON-RPC error code (G8). */
export function mapGatewayError(message: string): number {
  const m = message.toLowerCase();
  if (m.includes("authentic") || m.includes("expired token") || m.includes("unauthorized")) {
    return PORTAL_ERROR.unauthorized;
  }
  if (m.includes("unknown message type") || m.includes("invalid")) {
    return PORTAL_ERROR.invalidRequest;
  }
  return PORTAL_ERROR.gateway;
}

// ---- JSON-RPC wire types ----

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** A gateway `{type, payload, id?}` envelope. */
export interface GatewayEnvelope {
  type?: string;
  id?: string | number;
  payload?: unknown;
  error?: unknown;
  sender?: string;
  content?: string;
}
