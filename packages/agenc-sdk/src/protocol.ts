/**
 * Hand-mirrored subset of the AgenC daemon JSON-RPC protocol
 * (`runtime/src/app-server/protocol/index.ts`).
 *
 * This package deliberately does NOT import runtime internals; the shapes
 * here are a standalone mirror of the daemon's public control surface.
 * Drift is guarded by `runtime/tests/sdk-package/protocol-drift.contract.test.ts`,
 * which compares {@link AGENC_SDK_DAEMON_METHODS} and
 * {@link AGENC_SDK_DAEMON_NOTIFICATION_METHODS} against the runtime's
 * `AGENC_DAEMON_METHODS` / `AGENC_DAEMON_NOTIFICATION_METHODS` arrays,
 * so any protocol change fails tests until this mirror is updated.
 */

export const AGENC_SDK_JSON_RPC_VERSION = "2.0" as const;
export const AGENC_SDK_DAEMON_PROTOCOL_VERSION = "1.0.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type RequestId = string | number;

/**
 * Every public daemon request method, in the runtime's declaration order.
 * Mirror of `AGENC_DAEMON_METHODS` — see the module docblock for the drift
 * guard.
 */
export const AGENC_SDK_DAEMON_METHODS = [
  "initialize",
  "request.cancel",
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "agent.logs",
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.terminate",
  "session.clear",
  "session.snapshot",
  "session.transcript",
  "session.cancelTurn",
  "session.mcp.addServer",
  "message.send",
  "message.stream",
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/stop",
  "thread/realtime/listVoices",
  "tool.approve",
  "tool.deny",
  "tool.cancel",
  "elicitation.respond",
  "permission.list",
  "fs.fuzzy_search",
  "commandExec.start",
  "commandExec.write",
  "commandExec.resize",
  "commandExec.terminate",
  "health.ping",
  "health.ready",
  "health.stats",
  "daemon.reload",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

export type AgencDaemonMethod = (typeof AGENC_SDK_DAEMON_METHODS)[number];

/**
 * Every server-to-client notification method, in the runtime's declaration
 * order. Mirror of `AGENC_DAEMON_NOTIFICATION_METHODS`.
 */
export const AGENC_SDK_DAEMON_NOTIFICATION_METHODS = [
  "commandExec.outputDelta",
  "event.message_chunk",
  "event.tool_request",
  "event.permission_request",
  "event.user_input_request",
  "event.mcp_elicitation_request",
  "event.agent_status",
  "event.session_event",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
] as const;

export type AgencDaemonNotificationMethod =
  (typeof AGENC_SDK_DAEMON_NOTIFICATION_METHODS)[number];

// ── Shared params/result shapes ──────────────────────────────────────

export interface DaemonProtocolInfo extends JsonObject {
  readonly version: string;
}

export interface InitializeParams extends JsonObject {
  readonly protocolVersion?: string;
  readonly protocol?: DaemonProtocolInfo;
  readonly clientName?: string;
  readonly authCookie?: string;
  readonly capabilities?: JsonObject;
}

export interface RequestCancelParams extends JsonObject {
  readonly requestId: RequestId;
  readonly reason?: string;
}

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export type MessageContentBlock =
  | (JsonObject & { readonly type: "text"; readonly text: string })
  | (JsonObject & {
      readonly type: "image_url";
      readonly image_url: JsonObject & { readonly url: string };
    });

export type MessageContent = string | readonly MessageContentBlock[];

export interface AgentCreateParams extends JsonObject {
  readonly objective?: string;
  /**
   * Absolute workspace directory. Required by the daemon (DAE-02).
   * SDK `spawnAgent` / `createSession` will fill `process.cwd()` when omitted
   * at the client boundary — never leave this unset on the wire.
   */
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly instructions?: string;
  readonly initialContent?: MessageContent;
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly metadata?: JsonObject;
  readonly permissionMode?: PermissionMode;
  readonly envOverrides?: { readonly [key: string]: string };
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

export interface AgentLogsParams extends JsonObject {
  readonly agentId: string;
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

export interface SessionClearParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionSnapshotParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionTranscriptParams extends JsonObject {
  readonly sessionId: string;
}

export interface SessionCancelTurnParams extends JsonObject {
  readonly sessionId: string;
  readonly reason?: string;
}

export interface SessionMcpServerConfig extends JsonObject {
  readonly name: string;
  readonly transport?: "stdio" | "sse" | "http" | "websocket" | "ws";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly endpoint?: string;
  readonly enabled?: boolean;
  readonly required?: boolean;
}

export interface SessionMcpAddServerParams extends JsonObject {
  readonly sessionId: string;
  readonly config: SessionMcpServerConfig;
}

export interface MessageSendParams extends JsonObject {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly clientMessageId?: string;
  readonly metadata?: JsonObject;
}

export interface MessageStreamParams extends MessageSendParams {
  readonly streamId?: string;
}

export interface ThreadRealtimeStartParams extends JsonObject {
  readonly threadId: string;
  readonly transport?: JsonObject | null;
  readonly realtimeSessionId?: string | null;
  readonly prompt?: string | null;
  readonly outputModality: "audio" | "text";
  readonly voice?: string | null;
}

export interface ThreadRealtimeAudioChunk extends JsonObject {
  readonly data: string;
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly samplesPerChannel?: number | null;
  readonly itemId?: string | null;
}

export interface ThreadRealtimeAppendAudioParams extends JsonObject {
  readonly threadId: string;
  readonly audio: ThreadRealtimeAudioChunk;
}

export interface ThreadRealtimeAppendTextParams extends JsonObject {
  readonly threadId: string;
  readonly text: string;
}

export interface ThreadRealtimeStopParams extends JsonObject {
  readonly threadId: string;
}

export interface ExitPlanApprovalPayload extends JsonObject {
  readonly action: "approve" | "revise";
  readonly mode?: "acceptEdits" | "default";
  readonly applyAllowedPrompts?: boolean;
  readonly clearContext?: boolean;
  readonly feedback?: string;
}

export interface ToolApproveParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly scope?: "once" | "session" | "agent";
  /**
   * Promote this approval to bypass-permissions mode for the owning daemon
   * session. This is intentionally opt-in: plain `scope: "session"` keeps its
   * existing, narrower cache semantics for semantically-equivalent calls.
   */
  readonly allowAllToolsForSession?: boolean;
  readonly exitPlan?: ExitPlanApprovalPayload;
}

export interface ToolDenyParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly reason?: string;
}

export interface ToolCancelParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: string;
  readonly reason?: string;
}

export interface ElicitationRespondParams extends JsonObject {
  readonly sessionId: string;
  readonly requestId: RequestId;
  readonly kind: "request_user_input" | "mcp";
  readonly serverName?: string;
  readonly response: JsonObject;
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

interface CommandExecStartBase extends JsonObject {
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
  readonly env?: Readonly<Record<string, string | null>> | null;
  readonly size?: CommandExecTerminalSize | null;
}

export type CommandExecStartParams = CommandExecStartBase & (
  | {
      readonly permissionProfile: string;
      readonly sandboxPolicy?: null;
    }
  | {
      readonly sandboxPolicy: JsonObject;
      readonly permissionProfile?: null;
    }
);

export interface CommandExecWriteParams extends JsonObject {
  readonly processId: string;
  readonly deltaBase64?: string | null;
  readonly closeStdin?: boolean;
}

export interface CommandExecResizeParams extends JsonObject {
  readonly processId: string;
  readonly size: CommandExecTerminalSize;
}

export interface CommandExecTerminateParams extends JsonObject {
  readonly processId: string;
}

export type EmptyParams = Record<string, never>;

export interface AgencParamsByMethod {
  readonly initialize: InitializeParams;
  readonly "request.cancel": RequestCancelParams;
  readonly "agent.create": AgentCreateParams;
  readonly "agent.list": AgentListParams;
  readonly "agent.attach": AgentAttachParams;
  readonly "agent.stop": AgentStopParams;
  readonly "agent.logs": AgentLogsParams;
  readonly "session.create": SessionCreateParams;
  readonly "session.list": SessionListParams;
  readonly "session.attach": SessionAttachParams;
  readonly "session.detach": SessionDetachParams;
  readonly "session.terminate": SessionTerminateParams;
  readonly "session.clear": SessionClearParams;
  readonly "session.snapshot": SessionSnapshotParams;
  readonly "session.transcript": SessionTranscriptParams;
  readonly "session.cancelTurn": SessionCancelTurnParams;
  readonly "session.mcp.addServer": SessionMcpAddServerParams;
  readonly "message.send": MessageSendParams;
  readonly "message.stream": MessageStreamParams;
  readonly "thread/realtime/start": ThreadRealtimeStartParams;
  readonly "thread/realtime/appendAudio": ThreadRealtimeAppendAudioParams;
  readonly "thread/realtime/appendText": ThreadRealtimeAppendTextParams;
  readonly "thread/realtime/stop": ThreadRealtimeStopParams;
  readonly "thread/realtime/listVoices": EmptyParams;
  readonly "tool.approve": ToolApproveParams;
  readonly "tool.deny": ToolDenyParams;
  readonly "tool.cancel": ToolCancelParams;
  readonly "elicitation.respond": ElicitationRespondParams;
  readonly "permission.list": PermissionListParams;
  readonly "fs.fuzzy_search": FuzzyFileSearchParams;
  readonly "commandExec.start": CommandExecStartParams;
  readonly "commandExec.write": CommandExecWriteParams;
  readonly "commandExec.resize": CommandExecResizeParams;
  readonly "commandExec.terminate": CommandExecTerminateParams;
  readonly "health.ping": EmptyParams;
  readonly "health.ready": EmptyParams;
  readonly "health.stats": EmptyParams;
  readonly "daemon.reload": EmptyParams;
  readonly "auth.login": EmptyParams;
  readonly "auth.whoami": EmptyParams;
  readonly "auth.logout": EmptyParams;
}

// ── Result shapes ────────────────────────────────────────────────────

export type AgentStatus = "idle" | "running" | "stopping" | "stopped" | "error";
export type AgentRunStatus =
  | "pending"
  | "running"
  | "working"
  | "paused"
  | "blocked"
  | "suspended"
  | "completed"
  | "errored"
  | "stopped";
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

export interface InitializeResult extends JsonObject {
  readonly type: "initialized";
  readonly protocolVersion: string;
  readonly protocol: DaemonProtocolInfo;
  readonly capabilities: JsonObject;
}

export interface RequestCancelResult extends JsonObject {
  readonly requestId: RequestId;
  readonly cancelled: boolean;
  readonly reason?: string;
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

export interface AgentLogSession extends JsonObject {
  readonly sessionId: string;
  readonly itemCount: number;
  readonly transcript: string;
  readonly rolloutPath?: string;
  readonly source?: string;
}

export interface AgentLogsResult extends JsonObject {
  readonly agentId: string;
  readonly transcript: string;
  readonly sessions: readonly AgentLogSession[];
  readonly toolOutputs?: readonly JsonObject[];
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

export interface SessionClearResult extends JsonObject {
  readonly sessionId: string;
  readonly cleared: true;
  readonly clearedAt: string;
}

export interface TokenUsage extends JsonObject {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface CacheStats extends JsonObject {
  readonly requestCount: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheTotalInputTokens: number;
  readonly hitRate: number | null;
}

export interface SessionSnapshotResult extends JsonObject {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly tokenUsage: TokenUsage;
  readonly cacheStats: CacheStats;
}

export interface SessionTranscriptMessage extends JsonObject {
  readonly role: string;
  readonly text: string;
}

export interface SessionTranscriptResult extends JsonObject {
  readonly sessionId: string;
  readonly messages: readonly SessionTranscriptMessage[];
}

export interface SessionCancelTurnResult extends JsonObject {
  readonly sessionId: string;
  readonly cancelled: boolean;
  readonly reason?: string;
}

export interface SessionMcpAddServerResult extends JsonObject {
  readonly sessionId: string;
  readonly serverName: string;
  readonly success: boolean;
  readonly toolCount: number;
  readonly error?: string;
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
  readonly decision: "approved" | "denied" | "cancelled";
}

export interface ElicitationRespondResult extends JsonObject {
  readonly requestId: RequestId;
  readonly resolved: boolean;
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

export interface FuzzyFileSearchResponse extends JsonObject {
  readonly files: readonly JsonObject[];
}

export interface CommandExecResponse extends JsonObject {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

export interface HealthStatsResult extends JsonObject {
  readonly uptimeMs: number;
  readonly now: string;
  readonly sessions: JsonObject;
  readonly memory: JsonObject;
  readonly state?: JsonObject;
}

export interface DaemonReloadResult extends JsonObject {
  readonly reloaded: true;
  readonly configReloadedAt: string;
  readonly mcpServer: JsonObject;
}

export interface AuthWhoamiResult extends JsonObject {
  readonly authenticated: boolean;
  readonly provider?: string;
  readonly identity?: JsonObject;
  readonly subscriptionTier?: "free" | "pro" | "team" | "enterprise";
}

export interface AuthLoginResult extends JsonObject {
  readonly authenticated: true;
  readonly provider?: string;
  readonly identity?: JsonObject;
}

export interface AuthLogoutResult extends JsonObject {
  readonly authenticated: false;
}

export interface AgencResultByMethod {
  readonly initialize: InitializeResult;
  readonly "request.cancel": RequestCancelResult;
  readonly "agent.create": AgentCreateResult;
  readonly "agent.list": AgentListResult;
  readonly "agent.attach": AgentAttachResult;
  readonly "agent.stop": AgentStopResult;
  readonly "agent.logs": AgentLogsResult;
  readonly "session.create": SessionCreateResult;
  readonly "session.list": SessionListResult;
  readonly "session.attach": SessionAttachResult;
  readonly "session.detach": SessionDetachResult;
  readonly "session.terminate": SessionTerminateResult;
  readonly "session.clear": SessionClearResult;
  readonly "session.snapshot": SessionSnapshotResult;
  readonly "session.transcript": SessionTranscriptResult;
  readonly "session.cancelTurn": SessionCancelTurnResult;
  readonly "session.mcp.addServer": SessionMcpAddServerResult;
  readonly "message.send": MessageSendResult;
  readonly "message.stream": MessageStreamResult;
  readonly "thread/realtime/start": JsonObject;
  readonly "thread/realtime/appendAudio": JsonObject;
  readonly "thread/realtime/appendText": JsonObject;
  readonly "thread/realtime/stop": JsonObject;
  readonly "thread/realtime/listVoices": JsonObject;
  readonly "tool.approve": ToolDecisionResult;
  readonly "tool.deny": ToolDecisionResult;
  readonly "tool.cancel": ToolDecisionResult;
  readonly "elicitation.respond": ElicitationRespondResult;
  readonly "permission.list": PermissionListResult;
  readonly "fs.fuzzy_search": FuzzyFileSearchResponse;
  readonly "commandExec.start": CommandExecResponse;
  readonly "commandExec.write": JsonObject;
  readonly "commandExec.resize": JsonObject;
  readonly "commandExec.terminate": JsonObject;
  readonly "health.ping": HealthPingResult;
  readonly "health.ready": HealthReadyResult;
  readonly "health.stats": HealthStatsResult;
  readonly "daemon.reload": DaemonReloadResult;
  readonly "auth.login": AuthLoginResult;
  readonly "auth.whoami": AuthWhoamiResult;
  readonly "auth.logout": AuthLogoutResult;
}

// ── Notification params ──────────────────────────────────────────────

export interface AgencEventBaseParams extends JsonObject {
  readonly sessionId: string;
  readonly eventId: string;
  readonly agentId?: string;
  readonly sequence?: number;
  readonly acceptedAt?: string;
  readonly metadata?: JsonObject;
}

export interface EventMessageChunkParams extends AgencEventBaseParams {
  readonly messageId?: string;
  readonly streamId?: string;
  readonly delta: string;
}

export interface EventToolRequestParams extends AgencEventBaseParams {
  readonly requestId: string;
  readonly toolName: string;
  readonly turnId?: string;
  readonly input?: JsonValue;
  readonly recoveryCategory?: "idempotent" | "side-effecting" | "interactive";
}

export interface EventPermissionRequestParams extends AgencEventBaseParams {
  readonly requestId: string;
  readonly toolName?: string;
  readonly turnId?: string;
  readonly permissions: readonly string[];
  readonly input?: JsonValue;
  readonly reason?: string;
}

export interface EventUserInputRequestParams extends AgencEventBaseParams {
  readonly requestId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly questions: readonly JsonObject[];
  readonly clientAction?: JsonObject;
}

export interface EventMcpElicitationRequestParams extends AgencEventBaseParams {
  readonly requestId: RequestId;
  readonly serverName: string;
  readonly turnId: string;
  readonly request: JsonObject;
}

export interface EventAgentStatusParams extends AgencEventBaseParams {
  readonly agentId: string;
  readonly status: AgentStatus;
  readonly runStatus?: AgentRunStatus;
  readonly turnId?: string;
  readonly message?: string;
}

export interface EventSessionEventParams extends AgencEventBaseParams {
  readonly event: JsonObject;
}

// ── Envelopes ────────────────────────────────────────────────────────

export interface AgencDaemonRequest<
  Method extends AgencDaemonMethod = AgencDaemonMethod,
> {
  readonly jsonrpc: typeof AGENC_SDK_JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly method: Method;
  readonly params?: AgencParamsByMethod[Method];
}

export type AgencDaemonErrorCode =
  | -32700
  | -32600
  | -32601
  | -32602
  | -32603
  | -32000;

export interface AgencDaemonErrorObject extends JsonObject {
  readonly code: AgencDaemonErrorCode;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface AgencDaemonSuccessResponse<
  Method extends AgencDaemonMethod = AgencDaemonMethod,
> {
  readonly jsonrpc: typeof AGENC_SDK_JSON_RPC_VERSION;
  readonly id: RequestId;
  readonly result: AgencResultByMethod[Method];
}

export interface AgencDaemonErrorResponse {
  readonly jsonrpc: typeof AGENC_SDK_JSON_RPC_VERSION;
  readonly id: RequestId | null;
  readonly error: AgencDaemonErrorObject;
}

export type AgencDaemonResponse<
  Method extends AgencDaemonMethod = AgencDaemonMethod,
> = AgencDaemonSuccessResponse<Method> | AgencDaemonErrorResponse;

export interface AgencDaemonNotification extends JsonObject {
  readonly jsonrpc: typeof AGENC_SDK_JSON_RPC_VERSION;
  readonly method: AgencDaemonNotificationMethod;
  readonly params: JsonObject;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
