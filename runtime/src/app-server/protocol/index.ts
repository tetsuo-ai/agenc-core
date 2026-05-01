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
export const AGENC_DAEMON_PROTOCOL_VERSION = "1.0.0" as const;
export const AGENC_DAEMON_PROTOCOL_SCHEMA_ID =
  "urn:agenc:app-server:protocol" as const;
export const AGENC_DAEMON_PROTOCOL_PACKAGE_NAME =
  "@tetsuo-ai/protocol" as const;
export const AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT =
  "./daemon-json-rpc.schema.json" as const;
export const AGENC_DAEMON_PROTOCOL_PUBLISH_TARGET = {
  packageName: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  schemaExport: AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT,
  schemaId: AGENC_DAEMON_PROTOCOL_SCHEMA_ID,
} as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type RequestId = string | number;

export const AGENC_DAEMON_METHODS = [
  "initialize",
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.terminate",
  "message.send",
  "message.stream",
  "tool.approve",
  "tool.deny",
  "permission.list",
  "fs.fuzzy_search",
  "commandExec.start",
  "commandExec.write",
  "commandExec.resize",
  "commandExec.terminate",
  "health.ping",
  "health.ready",
  "health.stats",
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
  initialize: {
    method: "initialize",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Initialize a daemon JSON-RPC connection.",
  },
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
  "session.attach": {
    method: "session.attach",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Attach a client to a daemon-owned session.",
  },
  "session.detach": {
    method: "session.detach",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Detach a client from a daemon-owned session.",
  },
  "session.terminate": {
    method: "session.terminate",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Terminate a daemon-owned session.",
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
  "fs.fuzzy_search": {
    method: "fs.fuzzy_search",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Search workspace files and directories with fuzzy matching.",
  },
  "commandExec.start": {
    method: "commandExec.start",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Start a standalone command process for daemon clients.",
  },
  "commandExec.write": {
    method: "commandExec.write",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Write stdin bytes to a running daemon command process.",
  },
  "commandExec.resize": {
    method: "commandExec.resize",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Resize a PTY-backed daemon command process.",
  },
  "commandExec.terminate": {
    method: "commandExec.terminate",
    direction: "client-to-server",
    params: "required",
    result: "object",
    description: "Terminate a running daemon command process.",
  },
  "health.ping": {
    method: "health.ping",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Check whether the daemon process can answer requests.",
  },
  "health.ready": {
    method: "health.ready",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Check whether the daemon process is ready for session work.",
  },
  "health.stats": {
    method: "health.stats",
    direction: "client-to-server",
    params: "optional",
    result: "object",
    description: "Read daemon uptime, session counts, and memory usage.",
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
  readonly objective?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly instructions?: string;
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface InitializeParams extends JsonObject {
  readonly protocolVersion?: string;
  readonly clientName?: string;
  readonly authCookie?: string;
  readonly capabilities?: JsonObject;
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

export interface SessionAttachParams extends JsonObject {
  readonly sessionId: string;
  readonly clientId?: string;
}

export interface SessionDetachParams extends JsonObject {
  readonly sessionId: string;
  readonly attachmentId?: string;
  readonly clientId?: string;
}

export interface SessionTerminateParams extends JsonObject {
  readonly sessionId: string;
  readonly reason?: string;
}

export type MessageContentBlock =
  | (JsonObject & {
      readonly type: "text";
      readonly text: string;
    })
  | (JsonObject & {
      readonly type: "image_url";
      readonly image_url: JsonObject & { readonly url: string };
    });

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

export interface FuzzyFileSearchParams extends JsonObject {
  readonly query: string;
  readonly roots: readonly string[];
  readonly cancellationToken?: string | null;
}

export interface CommandExecTerminalSize extends JsonObject {
  readonly rows: number;
  readonly cols: number;
}

export type CommandExecEnv = Readonly<Record<string, string | null>>;

export interface CommandExecStartParams extends JsonObject {
  readonly command: readonly string[];
  readonly processId?: string | null;
  readonly tty?: boolean;
  readonly streamStdin?: boolean;
  readonly streamStdoutStderr?: boolean;
  readonly outputBytesCap?: number | null;
  readonly disableOutputCap?: boolean;
  readonly disableTimeout?: boolean;
  readonly timeoutMs?: number | null;
  readonly cwd?: string | null;
  readonly env?: CommandExecEnv | null;
  readonly size?: CommandExecTerminalSize | null;
  readonly sandboxPolicy?: JsonObject | null;
  readonly permissionProfile?: JsonObject | null;
}

export interface CommandExecResponse extends JsonObject {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandExecWriteParams extends JsonObject {
  readonly processId: string;
  readonly deltaBase64?: string | null;
  readonly closeStdin?: boolean;
}

export interface CommandExecWriteResponse extends JsonObject {}

export interface CommandExecTerminateParams extends JsonObject {
  readonly processId: string;
}

export interface CommandExecTerminateResponse extends JsonObject {}

export interface CommandExecResizeParams extends JsonObject {
  readonly processId: string;
  readonly size: CommandExecTerminalSize;
}

export interface CommandExecResizeResponse extends JsonObject {}

export type CommandExecOutputStream = "stdout" | "stderr";

export interface CommandExecOutputDeltaParams extends JsonObject {
  readonly processId: string;
  readonly stream: CommandExecOutputStream;
  readonly deltaBase64: string;
  readonly capReached: boolean;
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
  | AgenCDaemonRequestWithParams<"initialize", InitializeParams>
  | AgenCDaemonRequestWithParams<"agent.create", AgentCreateParams>
  | AgenCDaemonRequestWithParams<"agent.list", AgentListParams>
  | AgenCDaemonRequestWithParams<"agent.attach", AgentAttachParams>
  | AgenCDaemonRequestWithParams<"agent.stop", AgentStopParams>
  | AgenCDaemonRequestWithParams<"session.create", SessionCreateParams>
  | AgenCDaemonRequestWithParams<"session.list", SessionListParams>
  | AgenCDaemonRequestWithParams<"session.attach", SessionAttachParams>
  | AgenCDaemonRequestWithParams<"session.detach", SessionDetachParams>
  | AgenCDaemonRequestWithParams<
      "session.terminate",
      SessionTerminateParams
    >
  | AgenCDaemonRequestWithParams<"message.send", MessageSendParams>
  | AgenCDaemonRequestWithParams<"message.stream", MessageStreamParams>
  | AgenCDaemonRequestWithParams<"tool.approve", ToolApproveParams>
  | AgenCDaemonRequestWithParams<"tool.deny", ToolDenyParams>
  | AgenCDaemonRequestWithParams<"permission.list", PermissionListParams>
  | AgenCDaemonRequestWithParams<"fs.fuzzy_search", FuzzyFileSearchParams>
  | AgenCDaemonRequestWithParams<"commandExec.start", CommandExecStartParams>
  | AgenCDaemonRequestWithParams<"commandExec.write", CommandExecWriteParams>
  | AgenCDaemonRequestWithParams<"commandExec.resize", CommandExecResizeParams>
  | AgenCDaemonRequestWithParams<
      "commandExec.terminate",
      CommandExecTerminateParams
    >
  | AgenCDaemonRequestWithoutParams<"health.ping">
  | AgenCDaemonRequestWithoutParams<"health.ready">
  | AgenCDaemonRequestWithoutParams<"health.stats">
  | AgenCDaemonRequestWithoutParams<"auth.login">
  | AgenCDaemonRequestWithoutParams<"auth.whoami">
  | AgenCDaemonRequestWithoutParams<"auth.logout">;

export type AgentStatus = "idle" | "running" | "stopping" | "stopped" | "error";
export type SessionStatus = "idle" | "running" | "waiting" | "closed" | "error";

export interface AgentSummary extends JsonObject {
  readonly agentId: string;
  readonly agentPath?: string;
  readonly objective?: string;
  readonly status: AgentStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly lastActiveAt?: string;
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
  readonly activeAttachmentIds?: readonly string[];
  readonly closedAt?: string;
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
  readonly runtimeSessionId?: string;
  readonly sessions?: readonly SessionSummary[];
}

export interface AgentStopResult extends JsonObject {
  readonly agentId: string;
  readonly stopped: boolean;
}

export interface InitializeResult extends JsonObject {
  readonly type: "initialized";
  readonly protocolVersion: string;
  readonly capabilities: JsonObject;
}

export interface SessionCreateResult extends SessionSummary {}

export interface SessionListResult extends JsonObject {
  readonly sessions: readonly SessionSummary[];
  readonly nextCursor?: string;
}

export interface SessionAttachResult extends JsonObject {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly attachedAt: string;
  readonly clientId?: string;
  readonly activeAttachmentIds: readonly string[];
}

export interface SessionDetachResult extends JsonObject {
  readonly sessionId: string;
  readonly detached: boolean;
  readonly attachmentId?: string;
  readonly remainingAttachmentIds: readonly string[];
}

export interface SessionTerminateResult extends JsonObject {
  readonly sessionId: string;
  readonly terminated: boolean;
  readonly status: "closed";
  readonly closedAt: string;
  readonly reason?: string;
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

export interface FuzzyFileSearchResult extends JsonObject {
  readonly root: string;
  readonly path: string;
  readonly match_type: "file" | "directory";
  readonly file_name: string;
  readonly score: number;
  readonly indices?: readonly number[];
}

export interface FuzzyFileSearchResponse extends JsonObject {
  readonly files: readonly FuzzyFileSearchResult[];
}

export interface HealthPingResult extends JsonObject {
  readonly ok: true;
  readonly now: string;
}

export interface HealthReadyResult extends JsonObject {
  readonly ready: boolean;
  readonly uptimeMs: number;
  readonly now: string;
}

export interface HealthMemoryStats extends JsonObject {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface HealthSessionStats extends JsonObject {
  readonly active: number;
  readonly closed: number;
  readonly total: number;
}

export interface HealthStatsResult extends JsonObject {
  readonly uptimeMs: number;
  readonly now: string;
  readonly sessions: HealthSessionStats;
  readonly memory: HealthMemoryStats;
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
  readonly initialize: InitializeResult;
  readonly "agent.create": AgentCreateResult;
  readonly "agent.list": AgentListResult;
  readonly "agent.attach": AgentAttachResult;
  readonly "agent.stop": AgentStopResult;
  readonly "session.create": SessionCreateResult;
  readonly "session.list": SessionListResult;
  readonly "session.attach": SessionAttachResult;
  readonly "session.detach": SessionDetachResult;
  readonly "session.terminate": SessionTerminateResult;
  readonly "message.send": MessageSendResult;
  readonly "message.stream": MessageStreamResult;
  readonly "tool.approve": ToolDecisionResult;
  readonly "tool.deny": ToolDecisionResult;
  readonly "permission.list": PermissionListResult;
  readonly "fs.fuzzy_search": FuzzyFileSearchResponse;
  readonly "commandExec.start": CommandExecResponse;
  readonly "commandExec.write": CommandExecWriteResponse;
  readonly "commandExec.resize": CommandExecResizeResponse;
  readonly "commandExec.terminate": CommandExecTerminateResponse;
  readonly "health.ping": HealthPingResult;
  readonly "health.ready": HealthReadyResult;
  readonly "health.stats": HealthStatsResult;
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
