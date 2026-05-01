/**
 * Ports the donor app-server protocol's JSON-RPC envelope and method-registry
 * shape onto AgenC's daemon control surface.
 *
 * Why this lives here:
 *   - AgenC uses dot-separated daemon methods as the stable public protocol,
 *     while the donor app-server protocol uses a broader slash-separated API.
 *
 * Cross-cuts deliberately NOT carried:
 *   - account, plugin, marketplace, app, filesystem, and desktop endpoints
 *     from the donor app-server surface are outside AgenC's daemon protocol.
 */

export const JSON_RPC_VERSION = "2.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type RequestId = string | number;

export const AGENC_DAEMON_METHODS = [
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "session.create",
  "session.list",
  "message.send",
  "message.stream",
  "tool.approve",
  "tool.deny",
  "permission.list",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

export type AgenCDaemonMethod = (typeof AGENC_DAEMON_METHODS)[number];

export interface AgenCDaemonMethodSpec<
  Method extends AgenCDaemonMethod = AgenCDaemonMethod,
> {
  readonly method: Method;
  readonly direction: "client-to-server";
  readonly params: "required" | "optional";
  readonly result: "object";
  readonly description: string;
}

function defineMethodSpecs<const Spec extends {
  readonly [Method in AgenCDaemonMethod]: AgenCDaemonMethodSpec<Method>;
}>(spec: Spec): Spec {
  return spec;
}

export const AGENC_DAEMON_METHOD_SPECS = defineMethodSpecs({
  "agent.create": {
    method: "agent.create",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Create a long-lived daemon agent.",
  },
  "agent.list": {
    method: "agent.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List long-lived daemon agents.",
  },
  "agent.attach": {
    method: "agent.attach",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Attach a thin client to an existing daemon agent.",
  },
  "agent.stop": {
    method: "agent.stop",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Stop a daemon agent.",
  },
  "session.create": {
    method: "session.create",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Create a daemon-owned session.",
  },
  "session.list": {
    method: "session.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List daemon-owned sessions.",
  },
  "message.send": {
    method: "message.send",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Send a message into an existing session.",
  },
  "message.stream": {
    method: "message.stream",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Send a message and subscribe to streamed output.",
  },
  "tool.approve": {
    method: "tool.approve",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Approve a pending tool or permission request.",
  },
  "tool.deny": {
    method: "tool.deny",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Deny a pending tool or permission request.",
  },
  "permission.list": {
    method: "permission.list",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "List effective permissions for an agent or session.",
  },
  "auth.login": {
    method: "auth.login",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Start the AgenC-owned daemon login flow.",
  },
  "auth.whoami": {
    method: "auth.whoami",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Read the daemon's current AgenC authentication identity.",
  },
  "auth.logout": {
    method: "auth.logout",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Clear the daemon's current AgenC authentication identity.",
  },
});

export function isAgenCDaemonMethod(value: string): value is AgenCDaemonMethod {
  return Object.prototype.hasOwnProperty.call(AGENC_DAEMON_METHOD_SPECS, value);
}

export interface AgentCreateParams extends JsonObject {
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly instructions?: string;
  readonly metadata?: JsonObject;
}

export interface AgentListParams extends JsonObject {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AgentAttachParams extends JsonObject {
  readonly agentId: string;
  readonly clientId?: string;
}

export interface AgentStopParams extends JsonObject {
  readonly agentId: string;
  readonly reason?: string;
}

export interface SessionCreateParams extends JsonObject {
  readonly agentId?: string;
  readonly cwd?: string;
  readonly initialPrompt?: string;
  readonly metadata?: JsonObject;
}

export interface SessionListParams extends JsonObject {
  readonly agentId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MessageContentBlock extends JsonObject {
  readonly type: "text";
  readonly text: string;
}

export type MessageContent = string | readonly MessageContentBlock[];

export interface MessageSendParams extends JsonObject {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly clientMessageId?: string;
  readonly metadata?: JsonObject;
}

export interface MessageStreamParams extends MessageSendParams {
  readonly streamId?: string;
}

export interface ToolApproveParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly scope?: "once" | "session" | "agent";
}

export interface ToolDenyParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly reason?: string;
}

export interface PermissionListParams extends JsonObject {
  readonly agentId?: string;
  readonly sessionId?: string;
}

export type EmptyParams = Record<string, never>;

export interface AgenCDaemonRequestWithParams<
  Method extends AgenCDaemonMethod,
  Params extends JsonObject,
> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly method: Method;
  readonly params: Params;
}

export interface AgenCDaemonRequestWithoutParams<
  Method extends AgenCDaemonMethod,
> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly method: Method;
  readonly params?: EmptyParams;
}

export type AgenCDaemonRequest =
  | AgenCDaemonRequestWithParams<"agent.create", AgentCreateParams>
  | AgenCDaemonRequestWithParams<"agent.list", AgentListParams>
  | AgenCDaemonRequestWithParams<"agent.attach", AgentAttachParams>
  | AgenCDaemonRequestWithParams<"agent.stop", AgentStopParams>
  | AgenCDaemonRequestWithParams<"session.create", SessionCreateParams>
  | AgenCDaemonRequestWithParams<"session.list", SessionListParams>
  | AgenCDaemonRequestWithParams<"message.send", MessageSendParams>
  | AgenCDaemonRequestWithParams<"message.stream", MessageStreamParams>
  | AgenCDaemonRequestWithParams<"tool.approve", ToolApproveParams>
  | AgenCDaemonRequestWithParams<"tool.deny", ToolDenyParams>
  | AgenCDaemonRequestWithParams<"permission.list", PermissionListParams>
  | AgenCDaemonRequestWithoutParams<"auth.login">
  | AgenCDaemonRequestWithoutParams<"auth.whoami">
  | AgenCDaemonRequestWithoutParams<"auth.logout">;

export type AgentStatus = "idle" | "running" | "stopping" | "stopped" | "error";
export type SessionStatus = "idle" | "running" | "waiting" | "closed" | "error";

export interface AgentSummary extends JsonObject {
  readonly agentId: string;
  readonly status: AgentStatus;
  readonly createdAt: string;
  readonly cwd?: string;
  readonly activeSessionIds?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface SessionSummary extends JsonObject {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly cwd?: string;
  readonly metadata?: JsonObject;
}

export interface AgentCreateResult extends AgentSummary {
  readonly sessionId?: string;
}

export interface AgentListResult extends JsonObject {
  readonly agents: readonly AgentSummary[];
  readonly nextCursor?: string;
}

export interface AgentAttachResult extends JsonObject {
  readonly agentId: string;
  readonly attachmentId: string;
  readonly sessionIds: readonly string[];
}

export interface AgentStopResult extends JsonObject {
  readonly agentId: string;
  readonly stopped: boolean;
}

export interface SessionCreateResult extends SessionSummary {}

export interface SessionListResult extends JsonObject {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
}

export interface MessageSendResult extends JsonObject {
  readonly messageId: string;
  readonly acceptedAt: string;
}

export interface MessageStreamResult extends MessageSendResult {
  readonly streamId: string;
}

export interface ToolDecisionResult extends JsonObject {
  readonly requestId: string;
  readonly decision: "approved" | "denied";
}

export interface PermissionGrant extends JsonObject {
  readonly permissionId: string;
  readonly subject: string;
  readonly action: string;
  readonly scope?: string;
  readonly grantedAt?: string;
  readonly expiresAt?: string;
}

export interface PermissionListResult extends JsonObject {
  readonly permissions: readonly PermissionGrant[];
}

export interface AuthIdentity extends JsonObject {
  readonly accountId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly plan?: string;
}

export interface AuthWhoamiResult extends JsonObject {
  readonly authenticated: boolean;
  readonly provider?: string;
  readonly identity?: AuthIdentity;
}

export interface AuthLoginResult extends JsonObject {
  readonly authenticated: true;
  readonly provider?: string;
  readonly identity?: AuthIdentity;
}

export interface AuthLogoutResult extends JsonObject {
  readonly authenticated: false;
}

export interface AgenCDaemonResultByMethod {
  readonly "agent.create": AgentCreateResult;
  readonly "agent.list": AgentListResult;
  readonly "agent.attach": AgentAttachResult;
  readonly "agent.stop": AgentStopResult;
  readonly "session.create": SessionCreateResult;
  readonly "session.list": SessionListResult;
  readonly "message.send": MessageSendResult;
  readonly "message.stream": MessageStreamResult;
  readonly "tool.approve": ToolDecisionResult;
  readonly "tool.deny": ToolDecisionResult;
  readonly "permission.list": PermissionListResult;
  readonly "auth.login": AuthLoginResult;
  readonly "auth.whoami": AuthWhoamiResult;
  readonly "auth.logout": AuthLogoutResult;
}

export type AgenCDaemonSuccessResponse<
  Method extends AgenCDaemonMethod = AgenCDaemonMethod,
> = {
  readonly [M in Method]: {
    readonly jsonrpc: typeof JSON_RPC_VERSION;
    readonly id: RequestId;
    readonly result: AgenCDaemonResultByMethod[M];
  };
}[Method];

export type AgenCDaemonErrorCode =
  | -32700
  | -32600
  | -32601
  | -32602
  | -32603
  | -32000;

export interface AgenCDaemonErrorObject extends JsonObject {
  readonly code: AgenCDaemonErrorCode;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface AgenCDaemonErrorResponse extends JsonObject {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: RequestId | null;
  readonly error: AgenCDaemonErrorObject;
}

export type AgenCDaemonResponse =
  | AgenCDaemonSuccessResponse
  | AgenCDaemonErrorResponse;
