// @generated from the daemon protocol and its referenced declarations. Do not edit.

// Regenerate: npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types -- --write

// Public wire types only; this module has no runtime-internal imports.

/** JSON-RPC version required on daemon requests, responses, and notifications. */
export const JSON_RPC_VERSION = "2.0" as const;

/**
 * Current daemon protocol version.
 * 1.2 adds identity-bearing transcript.v2 and turn-scoped cancellation.
 * 1.3 adds the passive MCP status projection and its live-only invalidation.
 * 1.4 makes the owning agent runtime authority part of agent.attach.
 * 1.5 adds the effective hook-suppression projection.
 * 1.6 makes the live canonical run-settings snapshot part of agent.attach.
 * 1.7 adds inactive permission capabilities to that required snapshot and an
 * authenticated internal session permission-rule mutation authority.
 * 1.8 requires the exact plugin storage root in owning agent runtime authority
 * and binds successful model and config mutation responses to the exact
 * canonical runtime-settings event that clients must apply.
 * 1.9 adds admitted shell execution on the daemon-owned live session for
 * internal clients.
 * 1.10 adds daemon-owned local routines and opt-in routine invalidations.
 * Clients that need any of these additive surfaces must not negotiate an older
 * daemon.
 */
export const AGENC_DAEMON_PROTOCOL_VERSION = "1.10.0" as const;

export const AGENC_DAEMON_METHODS = [
    "remote.capabilities",
    "remote.status",
    "remote.start",
    "remote.stop",
    "remote.pair.begin",
    "remote.pair.refresh",
    "remote.pair.cancel",
    "remote.devices",
    "remote.pending",
    "remote.approve",
    "remote.revoke",
    "telegram.capabilities",
    "telegram.status",
    "telegram.configure",
    "telegram.start",
    "telegram.stop",
    "telegram.revoke",
    "telegram.agents.list",
    "telegram.agents.create",
    "telegram.agents.update",
    "telegram.agents.start",
    "telegram.agents.stop",
    "telegram.agents.remove",
    "telegram.agents.pair.begin",
    "telegram.agents.pair.confirm",
    "telegram.agents.pair.cancel",
    "initialize",
    "request.cancel",
    "agent.create",
    "agent.list",
    "agent.attach",
    "agent.stop",
    "agent.logs",
    "run.status",
    "run.result",
    "run.replay",
    "run.evidence",
    "run.cancel",
    "run.start",
    "routine.capabilities",
    "routine.list",
    "routine.get",
    "routine.create",
    "routine.update",
    "routine.delete",
    "routine.run",
    "routine.runs",
    "routine.cancel",
    "csvJob.review.list",
    "csvJob.review.show",
    "csvJob.review.resolve",
    "session.create",
    "session.list",
    "session.attach",
    "session.detach",
    "session.terminate",
    "session.clear",
    "session.snapshot",
    "session.transcript",
    "session.transcript.v2",
    "session.cancelTurn",
    "session.resolveToolCall",
    "session.mcp.status",
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
    "daemon.shutdown",
    "auth.login",
    "auth.whoami",
    "auth.logout",
] as const;

export const AGENC_DAEMON_NOTIFICATION_METHODS = [
    "routine.updated",
    "commandExec.outputDelta",
    "event.message_chunk",
    "event.tool_request",
    "event.permission_request",
    "event.user_input_request",
    "event.mcp_elicitation_request",
    "event.mcp_status_changed",
    "event.agent_status",
    "event.session_event",
    "event.event_gap",
    "thread/realtime/started",
    "thread/realtime/itemAdded",
    "thread/realtime/transcript/delta",
    "thread/realtime/transcript/done",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/sdp",
    "thread/realtime/error",
    "thread/realtime/closed",
] as const;

export type AgenCDaemonMethod = (typeof AGENC_DAEMON_METHODS)[number];

export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export interface JsonObject {
    readonly [key: string]: JsonValue | undefined;
}

export type RequestId = string | number;

export interface AgenCDaemonRequestWithParams<Method extends AgenCDaemonMethod, Params extends JsonObject> {
    readonly jsonrpc: typeof JSON_RPC_VERSION;
    readonly id: RequestId;
    readonly method: Method;
    readonly params: Params;
}

export type EmptyParams = Record<string, never>;

export interface AgenCDaemonRequestWithoutParams<Method extends AgenCDaemonMethod> {
    readonly jsonrpc: typeof JSON_RPC_VERSION;
    readonly id: RequestId;
    readonly method: Method;
    readonly params?: EmptyParams;
}

export interface RoutineIdParams extends JsonObject {
    readonly id: string;
}

/** Versioned local-daemon contract. No caller-supplied credentials or runtime authority. */
export type RoutineSchedule = {
    readonly kind: "manual";
} | {
    readonly kind: "cron";
    readonly expression: string;
};

export interface RoutineCreateParams extends JsonObject {
    readonly name: string;
    readonly description?: string;
    readonly instructions: string;
    readonly cwd: string;
    readonly schedule: RoutineSchedule;
    readonly provider?: string;
    readonly model?: string;
    readonly permissionMode?: "default" | "plan";
    readonly enabled?: boolean;
    readonly notifyOnCompletion?: boolean;
}

export interface RoutineUpdateParams extends RoutineIdParams {
    readonly patch: Partial<RoutineCreateParams>;
    readonly expectedUpdatedAt?: string;
}

export interface RoutineDeleteParams extends RoutineIdParams {
    readonly expectedUpdatedAt?: string;
}

export interface RoutineRunsParams extends RoutineIdParams {
    readonly limit?: number;
}

export interface RoutineCancelParams extends RoutineIdParams {
    readonly runId?: string;
}

export interface DaemonProtocolInfo extends JsonObject {
    readonly version: string;
}

export interface InitializeParams extends JsonObject {
    /**
     * Compatibility flat version field. Accepted when `protocol` is omitted, and must
     * match `protocol.version` when both are sent.
     */
    readonly protocolVersion?: string;
    /**
     * Canonical protocol metadata for the initialize handshake.
     */
    readonly protocol?: DaemonProtocolInfo;
    readonly clientName?: string;
    readonly authCookie?: string;
    readonly capabilities?: JsonObject;
}

export interface RequestCancelParams extends JsonObject {
    readonly requestId: RequestId;
    readonly reason?: string;
}

export interface AgentResumeSourceProof extends JsonObject {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly sha256: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
}

export type MessageContentBlock = (JsonObject & {
    readonly type: "text";
    readonly text: string;
}) | (JsonObject & {
    readonly type: "image_url";
    readonly image_url: JsonObject & {
        readonly url: string;
    };
});

export type MessageContent = string | readonly MessageContentBlock[];

export interface EditorInteractionPositionParams extends JsonObject {
    readonly line: number;
    readonly column: number;
}

export interface EditorInteractionRangeParams extends JsonObject {
    readonly start: EditorInteractionPositionParams;
    readonly end: EditorInteractionPositionParams;
}

/**
 * JSON-wire mirror of SessionEditorInteraction. Keep this protocol-owned shape
 * structurally aligned without importing runtime session internals.
 */
export interface EditorInteractionParams extends JsonObject {
    readonly interactionId: string;
    readonly kind: "ask" | "explain" | "fix" | "edit" | "refactor";
    readonly policy: "read_only" | "proposal_only";
    readonly editorInstanceId: string;
    readonly bufferHandle: number;
    readonly changedtick: number;
    readonly contentSha256: string;
    readonly path?: string;
    readonly range: EditorInteractionRangeParams;
    readonly selectionMode?: "character" | "line" | "block";
}

export interface AgentRuntimeOptionsParams extends JsonObject {
    readonly simpleMode: boolean;
    /** Omission by an older client is normalized to false. */
    readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
    readonly stdinDataMode: boolean;
    readonly remoteMode: boolean;
    readonly remoteMemoryRoot?: string;
    readonly coworkMemoryPathOverride?: string;
    readonly coworkMemoryExtraGuidelines?: string;
    readonly posixShellPath?: string;
    readonly commandWrapperArgv?: readonly string[];
    readonly sessionTempRoot?: string;
    readonly pluginStorageRoot: string;
    readonly allowUntrustedHooks: boolean;
}

export interface AgentCreateParams extends JsonObject {
    readonly objective?: string;
    /**
     * Explicitly continue this canonical rollout instead of creating a fresh
     * run. The daemon reopens a terminal epoch only after durable recovery and
     * unknown-outcome review gates pass.
     */
    readonly resumeSessionId?: string;
    /** Exact absolute canonical rollout selected by the trusted CLI resolver. */
    readonly resumeRolloutPath?: string;
    /** Frozen resolver proof; the daemon independently revalidates every field. */
    readonly resumeSourceProof?: AgentResumeSourceProof;
    /**
     * Absolute workspace directory. Required (DAE-02): the daemon will not
     * invent a project root from its own process.cwd().
     */
    readonly cwd: string;
    readonly model?: string;
    readonly provider?: string;
    readonly profile?: string;
    /** Absolute explicit config layer selected by the invoking client. */
    readonly configPath?: string;
    /** Additional working directories selected by repeated CLI flags. */
    readonly addDirs?: readonly string[];
    readonly instructions?: string;
    readonly initialContent?: MessageContent;
    /**
     * Provision a live daemon session without submitting an initial model turn.
     *
     * Startup hooks and ordinary Agent side effects remain deferred until the
     * first non-Editor message arrives. This is used by the cold Editor
     * prediction path, which needs the selected provider/model but must not
     * manufacture a user turn or start tool-bearing background services.
     */
    readonly deferInitialTurn?: boolean;
    /**
     * Transcript-facing text for the atomic first turn. `undefined` renders
     * `initialContent`, while `null` suppresses the initial user-message row.
     *
     * This is an explicit agent.create field rather than opaque metadata because
     * the daemon must validate it before the first model turn is admitted.
     */
    readonly initialDisplayUserMessage?: string | null;
    /**
     * Trusted policy and immutable buffer identity for an Editor-originated
     * atomic first turn. The daemon validates this before starting the agent and
     * carries it into the first runTurn exactly as message.stream does later.
     */
    readonly initialEditorInteraction?: EditorInteractionParams;
    readonly unattendedAllow?: readonly string[];
    readonly unattendedDeny?: readonly string[];
    readonly metadata?: JsonObject;
    /**
     * Session-wide permission mode override for the spawned agent. When
     * set, the daemon-side bootstrap honors this in place of the project-
     * trust default. Used by `agenc --dangerously-bypass-approvals-and-sandbox`, which sends
     * `permissionMode: "bypassPermissions"` so the spawned agent's session
     * approvalPolicy resolves to `"never"` regardless of project trust.
     * Without this, --dangerously-bypass-approvals-and-sandbox only affected the local CLI bootstrap and was
     * dropped on the wire to the daemon.
     */
    readonly permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
    /** Immutable operator policy resolved by the creating client. */
    readonly runtimeOptions: AgentRuntimeOptionsParams;
    /**
     * Per-invocation environment overrides for the spawned agent. Used by
     * the TUI to propagate `OPENAI_BASE_URL` (and similar provider-config
     * env vars) from the CLI's process env into the daemon-owned agent —
     * without this, the daemon's runner uses the frozen env snapshot
     * captured at daemon-start time, so subsequent CLI invocations with
     * different env vars silently use the original values.
     *
     * Only string values are forwarded. Keys collected from a curated
     * allow-list (provider URLs, API keys, proxy settings) to avoid
     * leaking unrelated env into agent processes. Empty strings are explicit
     * clear markers so an unset client value cannot inherit stale daemon-start
     * provider/config state.
     */
    readonly envOverrides?: {
        readonly [key: string]: string;
    };
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

export interface RunStatusParams extends JsonObject {
    readonly runId: string;
}

export interface RunResultParams extends JsonObject {
    readonly runId: string;
}

export interface RunReplayParams extends JsonObject {
    readonly runId: string;
    /** Replay journal events strictly after this database-global sequence. */
    readonly afterSequence?: number;
    /** Defaults to 100; the daemon rejects values above 200. */
    readonly limit?: number;
}

export interface RunEvidenceParams extends JsonObject {
    readonly runId: string;
    /** Evidence journal events strictly after this database-global sequence. */
    readonly afterSequence?: number;
    /** Defaults to 100; the daemon rejects values above 200. */
    readonly limit?: number;
}

export interface RunCancelParams extends JsonObject {
    /** Root run id (= root agent id, the agent_runs primary key). */
    readonly runId: string;
    readonly reason?: string;
}

/** One required verification command for a verified-change workflow run. */
export interface RunStartVerificationCommand extends JsonObject {
    readonly label: string;
    readonly script: string;
}

export interface RunStartParams extends JsonObject {
    /** The engineering goal / issue text driving the change. */
    readonly goal: string;
    /** Absolute directory inside the target git repository (daemon cwd default). */
    readonly cwd?: string;
    readonly model?: string;
    readonly provider?: string;
    /** Reviewer configuration pinned into the frozen spec at intake. */
    readonly reviewerModel?: string;
    readonly maxCostUsd?: number;
    readonly maxTokens?: number;
    readonly deadlineAt?: string;
    readonly permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
    readonly unattendedAllow?: readonly string[];
    readonly unattendedDeny?: readonly string[];
    /** Required verification commands; the workflow demands at least one. */
    readonly requiredVerification?: readonly RunStartVerificationCommand[];
    readonly maxImplementAttempts?: number;
}

export interface CsvJobReviewListParams extends JsonObject {
    /** Absolute workspace root selecting the durable project database. */
    readonly cwd: string;
    readonly jobId: string;
    /** Opaque cursor returned by the preceding page. */
    readonly cursor?: string;
    /** Bounded page size; the durable CSV contract permits 1..100. */
    readonly limit?: number;
}

export interface CsvJobReviewShowParams extends JsonObject {
    readonly cwd: string;
    readonly jobId: string;
    readonly itemId: string;
}

export type CsvJobReviewDisposition = "confirmed_committed" | "confirmed_no_effect" | "remains_unknown";

export interface CsvJobReviewResolveParams extends JsonObject {
    readonly cwd: string;
    readonly jobId: string;
    readonly itemId: string;
    readonly disposition: CsvJobReviewDisposition;
    readonly evidenceRef: string;
    /** Lowercase SHA-256 digest of the operator's external evidence. */
    readonly evidenceSha256: string;
    readonly reviewer: string;
    readonly reason: string;
    /** Optional recovered result; valid only for confirmed_committed. */
    readonly result?: JsonObject;
}

export interface SessionCreateParams extends JsonObject {
    readonly agentId?: string;
    /**
     * Absolute workspace directory. Required (DAE-02) for new sessions.
     */
    readonly cwd: string;
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

export interface SessionTranscriptV2Params extends JsonObject {
    readonly sessionId: string;
}

export interface SessionCancelTurnParams extends JsonObject {
    readonly sessionId: string;
    readonly reason?: string;
    /** Cancel only when this exact turn is still active. */
    readonly expectedTurnId?: string;
}

/**
 * Protocol-1.0 compatibility request shipped with agenc-sdk 0.3.0.
 *
 * This shape may resolve only legacy poisoned rows that have no canonical
 * durable effect. Durable effect records always require explicit evidence.
 */
export interface SessionResolveToolCallLegacyParams extends JsonObject {
    readonly sessionId: string;
    /** When omitted, review every eligible legacy effect in the session. */
    readonly toolCallId?: string;
    readonly reviewer?: string;
    readonly disposition?: never;
    readonly evidenceRef?: never;
    readonly evidenceSha256?: never;
}

/** Evidence-bearing resolution required for every durable effect record. */
export interface SessionResolveToolCallEvidenceParams extends JsonObject {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly disposition: "confirmed_committed" | "confirmed_no_effect" | "remains_unknown";
    readonly evidenceRef: string;
    readonly evidenceSha256: string;
    readonly reviewer?: string;
}

export type SessionResolveToolCallParams = SessionResolveToolCallLegacyParams | SessionResolveToolCallEvidenceParams;

export interface SessionMcpStatusParams extends JsonObject {
    readonly sessionId: string;
}

export interface SessionMcpServerConfig extends JsonObject {
    readonly name: string;
    readonly transport?: "stdio" | "sse" | "http" | "websocket";
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
    /** Opt in to fail-fast admission instead of the legacy session queue. */
    readonly ifBusy?: "reject";
    readonly metadata?: JsonObject;
}

export interface MessageStreamParams extends MessageSendParams {
    readonly streamId?: string;
}

export interface ThreadRealtimeWebsocketTransport extends JsonObject {
    readonly type: "websocket";
}

export interface ThreadRealtimeWebrtcTransport extends JsonObject {
    readonly type: "webrtc";
    readonly sdp: string;
}

export type ThreadRealtimeStartTransport = ThreadRealtimeWebsocketTransport | ThreadRealtimeWebrtcTransport;

export type ThreadRealtimeOutputModality = "audio" | "text";

export type ThreadRealtimeVoice = "alloy" | "arbor" | "ash" | "ballad" | "breeze" | "cedar" | "coral" | "cove" | "echo" | "ember" | "juniper" | "maple" | "marin" | "sage" | "shimmer" | "sol" | "spruce" | "vale" | "verse";

export interface ThreadRealtimeStartParams extends JsonObject {
    readonly threadId: string;
    readonly transport?: ThreadRealtimeStartTransport | null;
    readonly realtimeSessionId?: string | null;
    readonly prompt?: string | null;
    readonly outputModality: ThreadRealtimeOutputModality;
    readonly voice?: ThreadRealtimeVoice | null;
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
    /** Opt in to bypassing future tool prompts for this daemon session only. */
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
    /** Maximum number of results to return. The daemon accepts 1 through 1,000. */
    readonly limit?: number;
    /** Rebuild the persistent index before evaluating the query. */
    readonly refresh?: boolean;
}

export type CommandExecEnv = Readonly<Record<string, string | null>>;

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
    readonly env?: CommandExecEnv | null;
    readonly size?: CommandExecTerminalSize | null;
}

export type CommandExecStartParams = CommandExecStartBase & ({
    readonly permissionProfile: string;
    readonly sandboxPolicy?: null;
} | {
    readonly sandboxPolicy: JsonObject;
    readonly permissionProfile?: null;
});

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

export interface DaemonShutdownParams extends JsonObject {
    readonly instanceId: string;
}

export type AgenCDaemonRequest = AgenCDaemonRequestWithParams<"telegram.capabilities" | "telegram.status" | "telegram.configure" | "telegram.start" | "telegram.stop" | "telegram.revoke", JsonObject> | AgenCDaemonRequestWithParams<"telegram.agents.list" | "telegram.agents.create" | "telegram.agents.update" | "telegram.agents.start" | "telegram.agents.stop" | "telegram.agents.remove" | "telegram.agents.pair.begin" | "telegram.agents.pair.confirm" | "telegram.agents.pair.cancel", JsonObject> | AgenCDaemonRequestWithParams<"remote.capabilities" | "remote.status" | "remote.start" | "remote.stop" | "remote.pair.begin" | "remote.pair.refresh" | "remote.pair.cancel" | "remote.devices" | "remote.pending" | "remote.approve" | "remote.revoke", JsonObject> | AgenCDaemonRequestWithoutParams<"routine.capabilities"> | AgenCDaemonRequestWithoutParams<"routine.list"> | AgenCDaemonRequestWithParams<"routine.get", RoutineIdParams> | AgenCDaemonRequestWithParams<"routine.create", RoutineCreateParams> | AgenCDaemonRequestWithParams<"routine.update", RoutineUpdateParams> | AgenCDaemonRequestWithParams<"routine.delete", RoutineDeleteParams> | AgenCDaemonRequestWithParams<"routine.run", RoutineIdParams> | AgenCDaemonRequestWithParams<"routine.runs", RoutineRunsParams> | AgenCDaemonRequestWithParams<"routine.cancel", RoutineCancelParams> | AgenCDaemonRequestWithParams<"initialize", InitializeParams> | AgenCDaemonRequestWithParams<"request.cancel", RequestCancelParams> | AgenCDaemonRequestWithParams<"agent.create", AgentCreateParams> | AgenCDaemonRequestWithParams<"agent.list", AgentListParams> | AgenCDaemonRequestWithParams<"agent.attach", AgentAttachParams> | AgenCDaemonRequestWithParams<"agent.stop", AgentStopParams> | AgenCDaemonRequestWithParams<"agent.logs", AgentLogsParams> | AgenCDaemonRequestWithParams<"run.status", RunStatusParams> | AgenCDaemonRequestWithParams<"run.result", RunResultParams> | AgenCDaemonRequestWithParams<"run.replay", RunReplayParams> | AgenCDaemonRequestWithParams<"run.evidence", RunEvidenceParams> | AgenCDaemonRequestWithParams<"run.cancel", RunCancelParams> | AgenCDaemonRequestWithParams<"run.start", RunStartParams> | AgenCDaemonRequestWithParams<"csvJob.review.list", CsvJobReviewListParams> | AgenCDaemonRequestWithParams<"csvJob.review.show", CsvJobReviewShowParams> | AgenCDaemonRequestWithParams<"csvJob.review.resolve", CsvJobReviewResolveParams> | AgenCDaemonRequestWithParams<"session.create", SessionCreateParams> | AgenCDaemonRequestWithParams<"session.list", SessionListParams> | AgenCDaemonRequestWithParams<"session.attach", SessionAttachParams> | AgenCDaemonRequestWithParams<"session.detach", SessionDetachParams> | AgenCDaemonRequestWithParams<"session.terminate", SessionTerminateParams> | AgenCDaemonRequestWithParams<"session.clear", SessionClearParams> | AgenCDaemonRequestWithParams<"session.snapshot", SessionSnapshotParams> | AgenCDaemonRequestWithParams<"session.transcript", SessionTranscriptParams> | AgenCDaemonRequestWithParams<"session.transcript.v2", SessionTranscriptV2Params> | AgenCDaemonRequestWithParams<"session.cancelTurn", SessionCancelTurnParams> | AgenCDaemonRequestWithParams<"session.resolveToolCall", SessionResolveToolCallParams> | AgenCDaemonRequestWithParams<"session.mcp.status", SessionMcpStatusParams> | AgenCDaemonRequestWithParams<"session.mcp.addServer", SessionMcpAddServerParams> | AgenCDaemonRequestWithParams<"message.send", MessageSendParams> | AgenCDaemonRequestWithParams<"message.stream", MessageStreamParams> | AgenCDaemonRequestWithParams<"thread/realtime/start", ThreadRealtimeStartParams> | AgenCDaemonRequestWithParams<"thread/realtime/appendAudio", ThreadRealtimeAppendAudioParams> | AgenCDaemonRequestWithParams<"thread/realtime/appendText", ThreadRealtimeAppendTextParams> | AgenCDaemonRequestWithParams<"thread/realtime/stop", ThreadRealtimeStopParams> | AgenCDaemonRequestWithoutParams<"thread/realtime/listVoices"> | AgenCDaemonRequestWithParams<"tool.approve", ToolApproveParams> | AgenCDaemonRequestWithParams<"tool.deny", ToolDenyParams> | AgenCDaemonRequestWithParams<"tool.cancel", ToolCancelParams> | AgenCDaemonRequestWithParams<"elicitation.respond", ElicitationRespondParams> | AgenCDaemonRequestWithParams<"permission.list", PermissionListParams> | AgenCDaemonRequestWithParams<"fs.fuzzy_search", FuzzyFileSearchParams> | AgenCDaemonRequestWithParams<"commandExec.start", CommandExecStartParams> | AgenCDaemonRequestWithParams<"commandExec.write", CommandExecWriteParams> | AgenCDaemonRequestWithParams<"commandExec.resize", CommandExecResizeParams> | AgenCDaemonRequestWithParams<"commandExec.terminate", CommandExecTerminateParams> | AgenCDaemonRequestWithoutParams<"health.ping"> | AgenCDaemonRequestWithoutParams<"health.ready"> | AgenCDaemonRequestWithoutParams<"health.stats"> | AgenCDaemonRequestWithoutParams<"daemon.reload"> | AgenCDaemonRequestWithParams<"daemon.shutdown", DaemonShutdownParams> | AgenCDaemonRequestWithoutParams<"auth.login"> | AgenCDaemonRequestWithoutParams<"auth.whoami"> | AgenCDaemonRequestWithoutParams<"auth.logout">;

export const AGENC_DAEMON_METHOD_CAPABILITIES_KEY = "daemon.methods" as const;

export const AGENC_DAEMON_INTERNAL_METHODS = [
    "workspace.editor.acquire",
    "workspace.editor.sync",
    "workspace.editor.staleAuthority.refresh",
    "workspace.editor.heartbeat",
    "workspace.editor.release",
    "workspace.editor.topology.reserve",
    "workspace.editor.topology.complete",
    "workspace.editor.topology.release",
    "workspace.editor.topology.recovered.list",
    "workspace.editor.topology.recovered.resolve",
    "workspace.editor.proposal.get",
    "workspace.editor.proposal.status",
    "workspace.editor.proposal.apply",
    "workspace.editor.proposal.discard",
    "workspace.editor.changes.list",
    "workspace.editor.predict",
    "workspace.editor.cancelPrediction",
    "workspace.editor.predictionFeedback",
    "session.partialCompactFromMessage",
    "session.rollbackCompaction",
    "session.extendCompactionRollbackRetention",
    "session.rewindConversationToMessage",
    "session.previewFileRewind",
    "session.rewindFilesToMessage",
    "session.shell.execute",
    "session.setModel",
    "session.setPermissionMode",
    "session.permissions.mutateRule",
    "session.hooks.status",
    "session.hooks.setDisabled",
    "session.applyConfig",
    "session.mcp.reconnectServer",
    "session.mcp.enableServer",
    "session.mcp.disableServer",
] as const;

export type AgenCDaemonInternalMethod = (typeof AGENC_DAEMON_INTERNAL_METHODS)[number];

export type AgenCDaemonKnownMethod = AgenCDaemonMethod | AgenCDaemonInternalMethod;

export type AgenCDaemonMethodCapabilities = JsonObject & {
    readonly [Method in AgenCDaemonKnownMethod]: boolean;
};

export type AgenCDaemonServerCapabilities = JsonObject & {
    readonly [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: AgenCDaemonMethodCapabilities;
};

export interface DaemonInstanceIdentity extends JsonObject {
    readonly pid: number;
    readonly instanceId: string;
    readonly processStart: string;
    readonly runtimeVersion: string;
    readonly commit: string;
    readonly buildTime: string;
}

export interface InitializeResult extends JsonObject {
    readonly type: "initialized";
    /**
     * Compatibility mirror of `protocol.version` for older daemon clients.
     */
    readonly protocolVersion: string;
    /**
     * Negotiated server protocol metadata for the connection.
     */
    readonly protocol: DaemonProtocolInfo;
    readonly capabilities: AgenCDaemonServerCapabilities;
    /** Present on the real daemon and bound to this authenticated connection. */
    readonly daemonIdentity?: DaemonInstanceIdentity;
}

export interface RequestCancelResult extends JsonObject {
    readonly requestId: RequestId;
    readonly cancelled: boolean;
    readonly reason?: string;
}

export type AgentStatus = "idle" | "running" | "stopping" | "stopped" | "error";

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

export interface AgentCreateResult extends AgentSummary {
    readonly sessionId?: string;
}

export interface AgentListResult extends JsonObject {
    readonly agents: readonly AgentSummary[];
    readonly nextCursor?: string;
}

/**
 * Canonical permission modes that may govern a root daemon session. `bubble`
 * is deliberately excluded: it is child-only authority and must never be
 * revived onto a recovered root run.
 */
export const RUN_RUNTIME_PERMISSION_MODES = [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
    "dontAsk",
    "auto",
    "unattended",
] as const;

export type RunRuntimePermissionMode = (typeof RUN_RUNTIME_PERMISSION_MODES)[number];

export const RUN_RUNTIME_REASONING_EFFORTS = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "none",
] as const;

export type RunRuntimeReasoningEffort = (typeof RUN_RUNTIME_REASONING_EFFORTS)[number];

export const RUN_RUNTIME_MODEL_VERBOSITIES = ["low", "medium", "high"] as const;

export type RunRuntimeModelVerbosity = (typeof RUN_RUNTIME_MODEL_VERBOSITIES)[number];

export const RUN_RUNTIME_SERVICE_TIERS = ["priority", "flex"] as const;

export type RunRuntimeServiceTier = (typeof RUN_RUNTIME_SERVICE_TIERS)[number];

/**
 * Complete desired session overlay. It intentionally omits permission rules:
 * those are recomputed from current trusted policy on recovery. A bypass
 * authorization and availability are daemon-owned. Any retained bypass
 * consent is bound to the exact canonical workspace spelling.
 */
export interface RunRuntimeSettingsSnapshot {
    readonly permissionMode: RunRuntimePermissionMode;
    readonly prePlanMode: RunRuntimePermissionMode | null;
    readonly autoModeActive: boolean;
    readonly autoModeAvailable: boolean;
    readonly bypassPermissionsModeAvailable: boolean;
    readonly bypassPermissionsWorkspace: string | null;
    readonly bypassPermissionsConsentWorkspace: string | null;
    readonly model: string;
    readonly provider: string;
    readonly profile: string | null;
    readonly reasoningEffort: RunRuntimeReasoningEffort | null;
    readonly modelVerbosity: RunRuntimeModelVerbosity | null;
    readonly serviceTier: RunRuntimeServiceTier | null;
    readonly hooksDisabled: boolean;
}

export type SessionStatus = "idle" | "running" | "waiting" | "closed" | "error";

export interface SessionSummary extends JsonObject {
    readonly sessionId: string;
    readonly agentId: string;
    readonly status: SessionStatus;
    readonly createdAt: string;
    readonly cwd?: string;
    /** Immutable role-discovery authority; execution cwd may be a worktree. */
    readonly roleWorkspace?: {
        readonly id: string;
        readonly cwd: string;
    };
    readonly metadata?: JsonObject;
    readonly activeAttachmentIds?: readonly string[];
    readonly closedAt?: string;
}

export interface AgentAttachSessionSummary extends SessionSummary {
    readonly cwd: string;
}

export interface AgentAttachResult extends JsonObject {
    readonly agentId: string;
    readonly attachmentId: string;
    readonly sessionIds: readonly string[];
    /** Immutable operator authority owned by the attached daemon session. */
    readonly runtimeOptions: AgentRuntimeOptionsParams;
    /** Live daemon-owned session settings; static session metadata is not authority. */
    readonly runtimeSettings: RunRuntimeSettingsSnapshot & JsonObject;
    /** Canonical settings event hydrated by this response. */
    readonly runtimeSettingsEventId: string;
    readonly runtimeSessionId?: string;
    readonly sessions: readonly AgentAttachSessionSummary[];
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

export interface AgentToolOutputLog extends JsonObject {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: string;
    readonly output: string;
    readonly outputBytes: number;
    readonly outputLogPath?: string;
    readonly outputLogBytes?: number;
}

export interface AgentLogsResult extends JsonObject {
    readonly agentId: string;
    readonly transcript: string;
    readonly sessions: readonly AgentLogSession[];
    readonly toolOutputs?: readonly AgentToolOutputLog[];
}

export interface RunDurableRecord extends JsonObject {
    readonly objective: string;
    readonly status: string;
    readonly startedAt: string;
    readonly lastActiveAt: string;
    readonly currentSessionId?: string;
    readonly createdByClient?: string;
    readonly lastSnapshotAt?: string;
    readonly metadata?: JsonObject;
}

export type RunAdmissionAggregateStatus = "none" | "queued" | "running" | "approval_required" | "reconciled" | "voided" | "held_unknown" | "provider_overrun" | "denied" | "cancelled" | "terminal_mixed";

export interface RunAdmissionSourceAvailability extends JsonObject {
    readonly jobs: boolean;
    readonly reservations: boolean;
    readonly allocations: boolean;
    readonly journal: boolean;
}

export interface RunAdmissionSummary extends JsonObject {
    readonly present: boolean;
    readonly currentStatus: RunAdmissionAggregateStatus;
    readonly active: boolean;
    readonly stepCount: number;
    readonly stepStatusCounts: Readonly<Record<string, number>>;
    readonly reservationCount: number;
    readonly reservationStatusCounts: Readonly<Record<string, number>>;
    readonly openReservationCount: number;
    readonly reservedTokens: number;
    readonly reservedCostUsd: number;
    readonly actualTokens: number;
    readonly actualCostUsd: number;
    readonly unpricedActualReservationCount: number;
    readonly allocationCount: number;
    readonly usedTokens: number;
    readonly heldTokens: number;
    readonly usedCostUsd: number;
    readonly heldCostUsd: number;
    readonly providerOverrunBlockedAllocationCount: number;
    readonly fallbackCount: number;
    readonly sources: RunAdmissionSourceAvailability;
    readonly updatedAt?: string;
}

export interface RunStateSource extends JsonObject {
    readonly kind: "existing_state_database";
    readonly projectDir: string;
    readonly readonly: true;
}

export type RunWorkflowStepStatus = "pending" | "running" | "committed" | "failed" | "cancelled" | "unknown_outcome" | "blocked";

/** JSON-serializable mirror of a workflow step's content-addressed artifact. */
export interface RunWorkflowArtifactPointer extends JsonObject {
    readonly step: {
        readonly runId: string;
        readonly stepId: string;
        readonly parentRunId?: string;
    };
    readonly role: string;
    readonly digest: string;
    readonly bytes: number;
    readonly storagePath: string;
    readonly recordedAt: string;
}

export interface RunWorkflowStatusStep extends JsonObject {
    readonly stepId: string;
    readonly stage: string;
    readonly status: RunWorkflowStepStatus;
    readonly attempts: number;
    readonly verdict?: string;
    readonly artifacts?: readonly RunWorkflowArtifactPointer[];
}

/**
 * M5 verified-change workflow projection, present on `run.status` only for
 * runs that recorded workflow steps (additive; derived read-only from
 * durable `run_effects` rows).
 */
export interface RunWorkflowStatus extends JsonObject {
    readonly steps: readonly RunWorkflowStatusStep[];
    /** Present when the run terminated with a frozen workflow stop reason. */
    readonly stopReason?: string;
}

export interface RunStatusResult extends JsonObject {
    readonly runId: string;
    readonly status: string;
    /** Terminal is true only for the current lifecycle epoch. */
    readonly terminal: boolean;
    readonly statusSource: "run_terminal_result" | "run_lifecycle_epoch" | "agent_run" | "admission_state";
    readonly durableRun?: RunDurableRecord;
    readonly admission: RunAdmissionSummary;
    readonly source: RunStateSource;
    /** M5 workflow projection; present only for verified-change workflow runs. */
    readonly workflow?: RunWorkflowStatus;
}

export type RunTerminalOutcome = "completed" | "failed" | "cancelled" | "stopped" | "unknown_outcome";

export interface RunUsageTotals extends JsonObject {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number;
    /** False when historical coverage or model pricing is incomplete. */
    readonly costKnown?: boolean;
}

/** Terminal output committed by M4 and readable after disconnect/restart. */
export interface RunTerminalPersistedOutput extends JsonObject {
    readonly available: true;
    readonly exitCode: number | null;
    readonly stopReason: string | null;
    readonly finalMessage: string | null;
    readonly usage: RunUsageTotals | null;
    readonly lastSequence: number | null;
}

export interface RunTerminalOutputAvailability extends JsonObject {
    readonly available: false;
    readonly reason: "terminal_output_not_persisted_in_existing_state";
}

export interface RunResultResult extends JsonObject {
    readonly runId: string;
    readonly status: string;
    readonly terminal: true;
    readonly terminalAt: string;
    readonly outcome: RunTerminalOutcome;
    readonly epoch?: number;
    readonly durableRun?: RunDurableRecord;
    readonly output: RunTerminalPersistedOutput | RunTerminalOutputAvailability;
    readonly source: RunStateSource;
}

export type RunJournalCategory = "run" | "step" | "admission" | "budget" | "permission" | "approval" | "effect" | "model" | "artifact" | "cancellation" | "recovery" | "terminal" | "session";

/** One canonical rollout event, preserving its existing id and sequence. */
export interface RunJournalEvent extends JsonObject {
    readonly sequence: number;
    readonly eventId: string;
    readonly timestamp?: string;
    readonly runId: string;
    readonly childRunId?: string;
    readonly sessionId?: string;
    readonly stepId?: string;
    readonly category: RunJournalCategory;
    readonly kind: string;
    readonly event: string;
    readonly payload?: JsonValue;
    readonly reason?: string;
    readonly reservationId?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly reservedTokens?: number;
    readonly reservedCostUsd?: number;
    readonly actualTokens?: number;
    readonly actualCostUsd?: number;
    readonly details?: JsonObject;
}

export interface RunReplaySourceUnavailableGap extends JsonObject {
    readonly kind: "source_unavailable";
    readonly reason: "execution_admission_journal_not_present" | "run_journal_not_present";
}

export interface RunReplayRetentionGap extends JsonObject {
    readonly kind: "event_gap";
    readonly runId: string;
    readonly afterSequence: number;
    readonly firstAvailableSequence: number;
    readonly reason: "retention" | "corruption_truncated" | "compaction";
}

/** The caller cursor names events beyond the canonical journal tail. */
export interface RunReplayCursorAheadGap extends JsonObject {
    readonly kind: "cursor_ahead";
    readonly runId: string;
    readonly afterSequence: number;
    readonly lastAvailableSequence: number;
    readonly reason: "cursor_ahead";
}

export type RunReplayGap = RunReplaySourceUnavailableGap | RunReplayRetentionGap | RunReplayCursorAheadGap;

export interface RunJournalReplaySource extends JsonObject {
    readonly kind: "run_journal";
    readonly available: boolean;
    readonly sequenceScope: "run";
    readonly canonical: "rollout_jsonl";
    readonly projection: "thread_rollout_items";
    readonly projectDir: string;
}

export interface RunAdmissionReplaySource extends JsonObject {
    readonly kind: "execution_admission_journal";
    readonly available: boolean;
    readonly sequenceScope: "project_state_database";
    readonly projectDir: string;
}

export type RunReplaySource = RunJournalReplaySource | RunAdmissionReplaySource;

export interface RunReplayResult extends JsonObject {
    readonly runId: string;
    readonly afterSequence: number;
    readonly limit: number;
    readonly events: readonly RunJournalEvent[];
    readonly hasMore: boolean;
    /** Pass this value as afterSequence for the next page. */
    readonly nextAfterSequence: number;
    readonly firstAvailableSequence?: number;
    readonly lastAvailableSequence?: number;
    /** Null means the append-only source was available; unavailable is explicit. */
    readonly gap: RunReplayGap | null;
    readonly source: RunReplaySource;
}

export type RunEvidenceCompleteness = "complete" | "partial" | "admission_source_unavailable" | "journal_gap";

export interface RunEvidenceSource extends JsonObject {
    readonly kind: "canonical_run_journal" | "existing_m3_admission_state";
    readonly projectDir: string;
    readonly admissionJournal: boolean;
    readonly workflowEvidenceIncluded: boolean;
    readonly completeness: RunEvidenceCompleteness;
}

export interface RunEvidenceCursor extends JsonObject {
    readonly afterSequence: number;
    readonly nextAfterSequence: number;
    readonly limit: number;
}

export interface RunEvidenceEventHash extends JsonObject {
    readonly sequence: number;
    readonly eventId: string;
    readonly sha256: string;
}

export interface RunEvidenceHashes extends JsonObject {
    readonly algorithm: "sha256";
    readonly runStateSha256: string;
    readonly admissionSummarySha256: string;
    readonly gapSha256: string;
    readonly eventHashes: readonly RunEvidenceEventHash[];
    readonly bundleSha256: string;
}

/**
 * M5 evidence-bundle summary for `run.evidence`, present only when the run
 * has a per-run evidence ledger directory (`<agencHome>/run-evidence/<runId>`).
 */
export interface RunEvidenceBundle extends JsonObject {
    /** Digest of the self-validated verified-change record, when persisted. */
    readonly recordDigest?: string;
    readonly sealed: boolean;
    readonly ledgerPath: string;
    readonly artifacts: readonly RunWorkflowArtifactPointer[];
}

export interface RunEvidenceResult extends JsonObject {
    readonly runId: string;
    readonly source: RunEvidenceSource;
    readonly cursor: RunEvidenceCursor;
    readonly hasMore: boolean;
    readonly gap: RunReplayGap | null;
    readonly events: readonly RunJournalEvent[];
    readonly hashes: RunEvidenceHashes;
    /** M5 evidence-ledger summary; present only when the run has a ledger dir. */
    readonly bundle?: RunEvidenceBundle;
}

export interface RunCancelResult extends JsonObject {
    readonly runId: string;
    /** True when the run was already terminal; nothing was written. */
    readonly alreadyTerminal: boolean;
    /** Runs moved to `cancelled` by this call (root included). */
    readonly cancelledRunIds: readonly string[];
    /** Open spawn edges closed by this call (child thread ids). */
    readonly closedEdgeChildIds: readonly string[];
    /** Live agents interrupted as the second, in-memory step. */
    readonly interruptedLiveAgentIds: readonly string[];
    /** Open budget holds voided across the cancelled subtree. */
    readonly voidedHolds: number;
}

/** Dirty-state summary of the user's checkout captured at workflow intake. */
export interface RunStartBaseDirty extends JsonObject {
    readonly dirty: boolean;
    readonly fileCount: number;
}

export interface RunStartResult extends JsonObject {
    readonly runId: string;
    /** Canonical digest of the frozen WorkflowSpec (the spec's durable identity). */
    readonly specDigest: string;
    /** Exact base commit recorded before any work began. */
    readonly baseCommit: string;
    readonly baseDirty: RunStartBaseDirty;
}

export interface RoutineCapabilities extends JsonObject {
    readonly version: 1;
    readonly available: true;
    readonly scheduleKinds: readonly [
        "manual",
        "cron"
    ];
    readonly permissionModes: readonly [
        "default",
        "plan"
    ];
    readonly timezone: string;
    readonly executionMode: "local";
    readonly maxRoutines: number;
    readonly maxRunsPerRoutine: number;
}

export type RoutineRunStatus = "starting" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RoutineRun extends JsonObject {
    readonly id: string;
    readonly routineId: string;
    readonly status: RoutineRunStatus;
    readonly trigger: "manual" | "schedule";
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly agentId: string | null;
    readonly sessionId: string | null;
    readonly coreRunId: string | null;
    readonly error: string | null;
}

export interface Routine extends RoutineCreateParams {
    readonly id: string;
    readonly description: string;
    readonly permissionMode: "default" | "plan";
    readonly enabled: boolean;
    readonly notifyOnCompletion: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly nextRunAt: string | null;
    readonly lastRun: RoutineRun | null;
}

export interface RoutineListResult extends JsonObject {
    readonly routines: readonly Routine[];
}

export interface RoutineResult extends JsonObject {
    readonly routine: Routine;
}

export interface RoutineDeleteResult extends JsonObject {
    readonly deleted: true;
}

export interface RoutineRunResult extends JsonObject {
    readonly run: RoutineRun;
}

export interface RoutineRunsResult extends JsonObject {
    readonly runs: readonly RoutineRun[];
}

export interface CsvJobReviewJobSummary extends JsonObject {
    readonly contractVersion: 1;
    readonly jobId: string;
    readonly status: "pending" | "running" | "completed" | "failed" | "cancelled" | "needs_review" | "finished_with_unknown_outcomes";
    readonly totalItems: number;
    readonly pendingItems: number;
    readonly runningItems: number;
    readonly completedItems: number;
    readonly failedItems: number;
    readonly cancelledItems: number;
    readonly unknownOutcomeItems: number;
    readonly reviewPendingItems: number;
    readonly resultBytes: number;
    readonly availableResults: number;
    readonly unavailableAfterReviewResults: number;
    readonly notProducedResults: number;
}

export type CsvJobReviewStatus = "pending" | "resolved" | "abandoned";

export type CsvJobReviewDomainAction = "mark_completed" | "retry_new_attempt" | "abandon_item";

export interface CsvJobReviewEvidenceProjection extends JsonObject {
    readonly bytes: number;
    readonly sha256: string;
    readonly truncated: boolean;
    readonly value?: JsonObject;
}

export interface CsvJobReviewEffectReference extends JsonObject {
    readonly runId: string;
    readonly stepId: string;
    readonly epoch: number;
}

export interface CsvJobReviewDetail extends JsonObject {
    readonly contractVersion: 1;
    readonly jobId: string;
    readonly itemId: string;
    readonly rowIndex: number;
    readonly sourceId?: string;
    readonly sourceIdTruncated?: boolean;
    readonly status: "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown_outcome";
    readonly attemptCount: number;
    readonly resultAvailability: "not_produced" | "available" | "unavailable_after_review";
    readonly resultSizeBytes: number;
    readonly resultDigest?: string;
    readonly reviewStatus: CsvJobReviewStatus;
    readonly reviewReason?: string;
    readonly reviewReasonTruncated?: boolean;
    readonly disposition?: CsvJobReviewDisposition;
    readonly domainAction?: CsvJobReviewDomainAction;
    readonly evidence?: CsvJobReviewEvidenceProjection;
    readonly effect?: CsvJobReviewEffectReference;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly completedAt?: number;
}

export interface CsvJobReviewItemSummary extends JsonObject {
    readonly itemId: string;
    readonly rowIndex: number;
    readonly sourceId?: string;
    readonly sourceIdTruncated?: boolean;
    readonly sourceIdDigest?: string;
    readonly status: CsvJobReviewDetail["status"];
    readonly attemptCount: number;
    readonly resultAvailability: CsvJobReviewDetail["resultAvailability"];
    readonly resultSizeBytes: number;
    readonly resultDigest?: string;
    readonly resultPreviewJson?: string;
    readonly resultPreviewTruncated?: boolean;
    readonly lastError?: string;
    readonly lastErrorTruncated?: boolean;
    readonly reviewStatus?: CsvJobReviewStatus;
    readonly reviewReason?: string;
    readonly reviewReasonTruncated?: boolean;
}

export interface CsvJobReviewListResult extends JsonObject {
    readonly contractVersion: 1;
    readonly job: CsvJobReviewJobSummary;
    readonly reviews: readonly CsvJobReviewItemSummary[];
    readonly nextCursor?: string;
}

export interface CsvJobReviewShowResult extends JsonObject {
    readonly contractVersion: 1;
    readonly review: CsvJobReviewDetail;
}

export interface CsvJobReviewResolveResult extends JsonObject {
    readonly contractVersion: 1;
    readonly outcome: "resolved" | "already_resolved";
    readonly review: CsvJobReviewDetail;
    readonly job?: CsvJobReviewJobSummary;
}

export interface SessionCreateResult extends SessionSummary {
}

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

/** Counters from the daemon-owned in-process session. */
export interface SessionSnapshotResult extends JsonObject {
    readonly sessionId: string;
    /** Number of completed turns recorded in the session's history. */
    readonly turnCount: number;
    readonly tokenUsage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        readonly costUsd: number;
        /** False when historical coverage or model pricing is incomplete. */
        readonly costKnown?: boolean;
    };
    /** Cumulative cache metrics across API calls this session. */
    readonly cacheStats: {
        readonly requestCount: number;
        readonly cacheReadInputTokens: number;
        readonly cacheCreationInputTokens: number;
        readonly cacheTotalInputTokens: number;
        readonly hitRate: number | null;
    };
    /**
     * What actually occupies the context window, by source. A client can
     * only estimate the conversation; the tool schemas, MCP catalog and
     * memory files are the daemon's own and were invisible from outside,
     * which is why a UI showing them had to make numbers up.
     */
    readonly contextBreakdown?: {
        /** Active provider/model whose context window this estimate describes. */
        readonly provider?: string;
        readonly model?: string;
        /** Counts use the runtime's rough estimator rather than provider tokens. */
        readonly estimated?: boolean;
        /** The model's real window, so shares are against the truth. */
        readonly windowTokens: number;
        readonly messageTokens: number;
        readonly systemPromptTokens: number;
        /** Always-loaded built-in tool schemas. */
        readonly systemToolTokens: number;
        readonly systemToolCount: number;
        /** Tool schemas served by MCP servers. */
        readonly mcpToolTokens: number;
        readonly mcpToolCount: number;
        /** Schemas the model can search for but that are not resident. */
        readonly deferredToolTokens: number;
        readonly deferredToolCount: number;
        readonly memoryFileTokens: number;
        readonly memoryFileCount: number;
    };
}

export interface SessionTranscriptMessage extends JsonObject {
    readonly role: string; // "user" | "assistant"
    readonly text: string;
}

export interface SessionTranscriptResult extends JsonObject {
    readonly sessionId: string;
    readonly messages: readonly SessionTranscriptMessage[];
}

export interface SessionTranscriptV2Message extends JsonObject {
    readonly messageId: string;
    readonly commitEventId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly turnId?: string;
    readonly clientMessageId?: string;
    /** Zero only for migrated response_item rows that predate event sequencing. */
    readonly committedSequence: number;
}

export interface SessionTranscriptV2ActiveTurn extends JsonObject {
    readonly turnId: string;
    readonly clientMessageId?: string;
}

/**
 * Closed-turn outcome rebuilt from the durable rollout. Timing comes from
 * the turn's own terminal event and usage from the token_count events it
 * enclosed, so a reopened or restored session keeps the per-turn rows a
 * live client would have shown.
 */
export interface SessionTranscriptV2TurnResult extends JsonObject {
    readonly turnId: string;
    /** Durable sequence of the turn's terminal event; anchors placement. */
    readonly committedSequence: number;
    readonly outcome: "completed" | "aborted" | "errored";
    readonly durationMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly model?: string;
    readonly provider?: string;
}

export interface SessionTranscriptV2Result extends JsonObject {
    readonly schemaVersion: 2;
    readonly sessionId: string;
    readonly runId: string;
    readonly historyEpoch: string;
    readonly asOfSequence: number;
    readonly messages: readonly SessionTranscriptV2Message[];
    readonly activeTurn?: SessionTranscriptV2ActiveTurn;
    readonly turnResults?: readonly SessionTranscriptV2TurnResult[];
}

export interface SessionCancelTurnResult extends JsonObject {
    readonly sessionId: string;
    /**
     * `true` when an active turn was found and interrupted; `false` when
     * no turn was running (idle session). Either response is normal —
     * idle is not an error.
     */
    readonly cancelled: boolean;
    readonly reason?: string;
    readonly activeTurnId?: string;
    readonly stale?: boolean;
}

export interface SessionResolveToolCallResult extends JsonObject {
    readonly sessionId: string;
    readonly resolved: readonly {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly eventId?: string;
    }[];
    readonly remaining: number;
}

export interface SessionMcpStatusServer extends JsonObject {
    readonly name: string;
    readonly transport: "stdio" | "sse" | "http" | "websocket";
    readonly enabled: boolean;
    readonly required: boolean;
    readonly state: "connected" | "pending" | "failed" | "disabled" | "needs-auth" | "disconnected";
    /** Sanitized executable basename or URL origin; never connection authority. */
    readonly displayTarget?: string;
    readonly toolCount: number;
}

export interface SessionMcpStatusTool extends JsonObject {
    readonly serverName: string;
    readonly name: string;
}

/** Passive, serializable projection of the daemon-owned MCP runtime. */
export interface SessionMcpStatusResult extends JsonObject {
    readonly sessionId: string;
    readonly revision: number;
    readonly servers: readonly SessionMcpStatusServer[];
    readonly tools: readonly SessionMcpStatusTool[];
}

export interface SessionMcpAddServerResult extends JsonObject {
    readonly sessionId: string;
    readonly serverName: string;
    readonly success: boolean;
    readonly toolCount: number;
    readonly error?: string;
}

export interface MessageSendTerminalResult extends JsonObject {
    readonly code: 0 | 1 | 130;
    readonly message?: string;
}

export interface MessageSendResult extends JsonObject {
    readonly messageId: string;
    readonly acceptedAt: string;
    readonly disposition?: "started" | "duplicate";
    /** Present for duplicate submissions so callers never guess crash outcomes. */
    readonly duplicateState?: "completed" | "incomplete";
    readonly turnId?: string;
    readonly terminal?: MessageSendTerminalResult;
}

export interface MessageStreamResult extends MessageSendResult {
    readonly streamId: string;
}

export interface ThreadRealtimeStartResponse extends JsonObject {
}

export interface ThreadRealtimeAppendAudioResponse extends JsonObject {
}

export interface ThreadRealtimeAppendTextResponse extends JsonObject {
}

export interface ThreadRealtimeStopResponse extends JsonObject {
}

export interface ThreadRealtimeVoicesList extends JsonObject {
    readonly v1: readonly ThreadRealtimeVoice[];
    readonly v2: readonly ThreadRealtimeVoice[];
    readonly defaultV1: ThreadRealtimeVoice;
    readonly defaultV2: ThreadRealtimeVoice;
}

export interface ThreadRealtimeListVoicesResponse extends JsonObject {
    readonly voices: ThreadRealtimeVoicesList;
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

export interface FuzzyFileSearchResult extends JsonObject {
    readonly root: string;
    readonly path: string;
    readonly match_type: "file" | "directory";
    readonly file_name: string;
    readonly score: number;
    readonly indices?: readonly number[];
}

export interface FuzzyFileIndexRootFreshness extends JsonObject {
    readonly root: string;
    readonly canonicalRoot: string;
    readonly generationId: number | null;
    readonly builtAt: string | null;
    readonly ageMs: number | null;
    readonly watcherStatus: "active" | "unsupported" | "failed" | "not_started";
    readonly directoryCoverage: "complete" | "nonempty_only";
    readonly lastAuditAt: string | null;
    readonly building: boolean;
    readonly stale: boolean;
    readonly degraded: boolean;
    readonly truncated: boolean;
    readonly reason: string | null;
}

export interface FuzzyFileIndexFreshness extends JsonObject {
    readonly schemaVersion: number;
    readonly stale: boolean;
    readonly degraded: boolean;
    readonly truncated: boolean;
    readonly roots: readonly FuzzyFileIndexRootFreshness[];
}

export interface FuzzyFileMatcherMetadata extends JsonObject {
    readonly quality: "optimal" | "degraded";
    readonly resourceLimited: boolean;
    readonly evaluatedCandidates: number;
    readonly totalCandidates: number;
}

export interface FuzzyFileSearchResponse extends JsonObject {
    readonly files: readonly FuzzyFileSearchResult[];
    /** Present for searches served by the persistent index. */
    readonly freshness?: FuzzyFileIndexFreshness;
    /** Present for searches served by the persistent index. */
    readonly matcher?: FuzzyFileMatcherMetadata;
}

export interface CommandExecResponse extends JsonObject {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface CommandExecWriteResponse extends JsonObject {
}

export interface CommandExecResizeResponse extends JsonObject {
}

export interface CommandExecTerminateResponse extends JsonObject {
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

export interface HealthSessionStats extends JsonObject {
    readonly active: number;
    readonly closed: number;
    readonly total: number;
}

export interface HealthMemoryStats extends JsonObject {
    readonly rss: number;
    readonly heapTotal: number;
    readonly heapUsed: number;
    readonly external: number;
    readonly arrayBuffers: number;
}

export interface HealthStateStats extends JsonObject {
    readonly available: boolean;
    readonly readonly: true;
    readonly projectDir: string;
    readonly agentRuns: number;
    readonly sessionStateSnapshots: number;
    readonly inFlightToolCalls: number;
    readonly logs: number;
}

export interface HealthStatsResult extends JsonObject {
    readonly uptimeMs: number;
    readonly now: string;
    readonly sessions: HealthSessionStats;
    readonly memory: HealthMemoryStats;
    readonly state?: HealthStateStats;
}

export interface DaemonReloadMcpServerResult extends JsonObject {
    readonly status: "disabled" | "unsupported" | "listening";
    readonly url?: string;
}

export interface DaemonReloadResult extends JsonObject {
    readonly reloaded: true;
    readonly configReloadedAt: string;
    readonly mcpServer: DaemonReloadMcpServerResult;
}

export interface DaemonShutdownResult extends JsonObject {
    readonly shuttingDown: true;
    readonly instanceId: string;
}

export interface AuthDaemonSocketIdentity extends JsonObject {
    readonly transport: "daemon";
    readonly verifiedBy: "cookie" | "peerUid" | "privateSocketOwner";
    readonly cookie?: "verified";
    readonly peerUid?: number | null;
    readonly privateSocketOwnerUid?: number | null;
}

export interface AuthIdentity extends JsonObject {
    readonly accountId?: string;
    readonly email?: string;
    readonly handle?: string;
    readonly displayName?: string;
    readonly plan?: string;
    readonly daemon?: AuthDaemonSocketIdentity;
}

export interface AuthLoginResult extends JsonObject {
    readonly authenticated: true;
    readonly provider?: string;
    readonly identity?: AuthIdentity;
}

export interface AuthWhoamiResult extends JsonObject {
    readonly authenticated: boolean;
    readonly provider?: string;
    readonly identity?: AuthIdentity;
    readonly subscriptionTier?: "free" | "pro" | "team" | "enterprise";
}

export interface AuthLogoutResult extends JsonObject {
    readonly authenticated: false;
}

export interface AgenCDaemonResultByMethod {
    readonly initialize: InitializeResult;
    readonly "request.cancel": RequestCancelResult;
    readonly "agent.create": AgentCreateResult;
    readonly "agent.list": AgentListResult;
    readonly "agent.attach": AgentAttachResult;
    readonly "agent.stop": AgentStopResult;
    readonly "agent.logs": AgentLogsResult;
    readonly "run.status": RunStatusResult;
    readonly "run.result": RunResultResult;
    readonly "run.replay": RunReplayResult;
    readonly "run.evidence": RunEvidenceResult;
    readonly "run.cancel": RunCancelResult;
    readonly "run.start": RunStartResult;
    readonly "routine.capabilities": RoutineCapabilities;
    readonly "remote.capabilities": JsonObject;
    readonly "remote.status": JsonObject;
    readonly "remote.start": JsonObject;
    readonly "remote.stop": JsonObject;
    readonly "remote.pair.begin": JsonObject;
    readonly "remote.pair.refresh": JsonObject;
    readonly "remote.pair.cancel": JsonObject;
    readonly "remote.devices": JsonObject;
    readonly "remote.pending": JsonObject;
    readonly "remote.approve": JsonObject;
    readonly "remote.revoke": JsonObject;
    readonly "telegram.capabilities": JsonObject;
    readonly "telegram.status": JsonObject;
    readonly "telegram.configure": JsonObject;
    readonly "telegram.start": JsonObject;
    readonly "telegram.stop": JsonObject;
    readonly "telegram.revoke": JsonObject;
    readonly "telegram.agents.list": JsonObject;
    readonly "telegram.agents.create": JsonObject;
    readonly "telegram.agents.update": JsonObject;
    readonly "telegram.agents.start": JsonObject;
    readonly "telegram.agents.stop": JsonObject;
    readonly "telegram.agents.remove": JsonObject;
    readonly "telegram.agents.pair.begin": JsonObject;
    readonly "telegram.agents.pair.confirm": JsonObject;
    readonly "telegram.agents.pair.cancel": JsonObject;
    readonly "routine.list": RoutineListResult;
    readonly "routine.get": RoutineResult;
    readonly "routine.create": RoutineResult;
    readonly "routine.update": RoutineResult;
    readonly "routine.delete": RoutineDeleteResult;
    readonly "routine.run": RoutineRunResult;
    readonly "routine.runs": RoutineRunsResult;
    readonly "routine.cancel": RoutineRunResult;
    readonly "csvJob.review.list": CsvJobReviewListResult;
    readonly "csvJob.review.show": CsvJobReviewShowResult;
    readonly "csvJob.review.resolve": CsvJobReviewResolveResult;
    readonly "session.create": SessionCreateResult;
    readonly "session.list": SessionListResult;
    readonly "session.attach": SessionAttachResult;
    readonly "session.detach": SessionDetachResult;
    readonly "session.terminate": SessionTerminateResult;
    readonly "session.clear": SessionClearResult;
    readonly "session.snapshot": SessionSnapshotResult;
    readonly "session.transcript": SessionTranscriptResult;
    readonly "session.transcript.v2": SessionTranscriptV2Result;
    readonly "session.cancelTurn": SessionCancelTurnResult;
    readonly "session.resolveToolCall": SessionResolveToolCallResult;
    readonly "session.mcp.status": SessionMcpStatusResult;
    readonly "session.mcp.addServer": SessionMcpAddServerResult;
    readonly "message.send": MessageSendResult;
    readonly "message.stream": MessageStreamResult;
    readonly "thread/realtime/start": ThreadRealtimeStartResponse;
    readonly "thread/realtime/appendAudio": ThreadRealtimeAppendAudioResponse;
    readonly "thread/realtime/appendText": ThreadRealtimeAppendTextResponse;
    readonly "thread/realtime/stop": ThreadRealtimeStopResponse;
    readonly "thread/realtime/listVoices": ThreadRealtimeListVoicesResponse;
    readonly "tool.approve": ToolDecisionResult;
    readonly "tool.deny": ToolDecisionResult;
    readonly "tool.cancel": ToolDecisionResult;
    readonly "elicitation.respond": ElicitationRespondResult;
    readonly "permission.list": PermissionListResult;
    readonly "fs.fuzzy_search": FuzzyFileSearchResponse;
    readonly "commandExec.start": CommandExecResponse;
    readonly "commandExec.write": CommandExecWriteResponse;
    readonly "commandExec.resize": CommandExecResizeResponse;
    readonly "commandExec.terminate": CommandExecTerminateResponse;
    readonly "health.ping": HealthPingResult;
    readonly "health.ready": HealthReadyResult;
    readonly "health.stats": HealthStatsResult;
    readonly "daemon.reload": DaemonReloadResult;
    readonly "daemon.shutdown": DaemonShutdownResult;
    readonly "auth.login": AuthLoginResult;
    readonly "auth.whoami": AuthWhoamiResult;
    readonly "auth.logout": AuthLogoutResult;
}

/** Invalidation only: clients refresh list/detail; no instructions or results are broadcast. */
export interface RoutineUpdatedEvent extends JsonObject {
    readonly id: string;
    readonly reason: "created" | "updated" | "deleted" | "run";
}

export type CommandExecOutputStream = "stdout" | "stderr";

export interface CommandExecOutputDeltaParams extends JsonObject {
    readonly processId: string;
    readonly stream: CommandExecOutputStream;
    readonly deltaBase64: string;
    readonly capReached: boolean;
}

export interface AgenCEventBaseParams extends JsonObject {
    readonly sessionId: string;
    readonly eventId: string;
    readonly agentId?: string;
    readonly runId?: string;
    readonly historyEpoch?: string;
    readonly sequence?: number;
    readonly acceptedAt?: string;
    readonly turnId?: string;
    readonly clientMessageId?: string;
    readonly messageId?: string;
    readonly metadata?: JsonObject;
}

export interface EventMessageChunkParams extends AgenCEventBaseParams {
    readonly streamId?: string;
    readonly delta: string;
}

export interface EventToolRequestParams extends AgenCEventBaseParams {
    readonly requestId: string;
    readonly toolName: string;
    readonly turnId?: string;
    readonly input?: JsonValue;
    readonly recoveryCategory?: "idempotent" | "side-effecting" | "interactive";
}

export interface EventPermissionRequestParams extends AgenCEventBaseParams {
    readonly requestId: string;
    readonly toolName?: string;
    readonly turnId?: string;
    readonly permissions: readonly string[];
    readonly input?: JsonValue;
    readonly reason?: string;
}

export interface EventUserInputRequestParams extends AgenCEventBaseParams {
    readonly requestId: string;
    readonly callId: string;
    readonly turnId: string;
    readonly questions: readonly JsonObject[];
    readonly clientAction?: JsonObject;
}

export interface EventMcpElicitationRequestParams extends AgenCEventBaseParams {
    readonly requestId: RequestId;
    readonly serverName: string;
    readonly turnId: string;
    readonly request: JsonObject;
}

/** Non-journal control-plane invalidation for the passive MCP projection. */
export interface EventMcpStatusChangedParams extends JsonObject {
    readonly sessionId: string;
    readonly revision: number;
}

export type AgentRunStatus = "pending" | "running" | "working" | "paused" | "blocked" | "suspended" | "completed" | "errored" | "stopped";

export interface EventAgentStatusParams extends AgenCEventBaseParams {
    readonly agentId: string;
    readonly status: AgentStatus;
    readonly runStatus?: AgentRunStatus;
    readonly turnId?: string;
    readonly message?: string;
}

export interface EventSessionEventParams extends AgenCEventBaseParams {
    readonly event: JsonObject;
}

/** Observable, non-journal sentinel emitted by bounded live-delivery buffers. */
export interface EventGapParams extends JsonObject {
    readonly type: "event_gap";
    readonly kind: "event_gap";
    readonly sessionId: string;
    readonly runId: string;
    readonly eventId?: string;
    readonly agentId?: string;
    readonly sequence?: number;
    readonly reason: "retention";
    readonly source: "background_runner_retention" | "multiplexer_retention";
    readonly retiredCount: number;
    /** False means replay is required but the loss count is unknown (zero). */
    readonly retiredCountKnown?: boolean;
    readonly coordinatesAvailable?: boolean;
    readonly afterSequence?: number;
    readonly firstAvailableSequence?: number;
}

export interface ThreadRealtimeBaseParams extends JsonObject {
    readonly threadId: string;
}

export type ThreadRealtimeVersion = "v1" | "v2";

export interface ThreadRealtimeStartedParams extends ThreadRealtimeBaseParams {
    readonly realtimeSessionId?: string | null;
    readonly version: ThreadRealtimeVersion;
}

export interface ThreadRealtimeItemAddedParams extends ThreadRealtimeBaseParams {
    readonly item: JsonValue;
}

export interface ThreadRealtimeTranscriptDeltaParams extends ThreadRealtimeBaseParams {
    readonly role: string;
    readonly delta: string;
}

export interface ThreadRealtimeTranscriptDoneParams extends ThreadRealtimeBaseParams {
    readonly role: string;
    readonly text: string;
}

export interface ThreadRealtimeOutputAudioDeltaParams extends ThreadRealtimeBaseParams {
    readonly audio: ThreadRealtimeAudioChunk;
}

export interface ThreadRealtimeSdpParams extends ThreadRealtimeBaseParams {
    readonly sdp: string;
}

export interface ThreadRealtimeErrorParams extends ThreadRealtimeBaseParams {
    readonly message: string;
}

export interface ThreadRealtimeClosedParams extends ThreadRealtimeBaseParams {
    readonly reason?: string | null;
}

export interface AgenCDaemonNotificationParamsByMethod {
    readonly "routine.updated": RoutineUpdatedEvent;
    readonly "commandExec.outputDelta": CommandExecOutputDeltaParams;
    readonly "event.message_chunk": EventMessageChunkParams;
    readonly "event.tool_request": EventToolRequestParams;
    readonly "event.permission_request": EventPermissionRequestParams;
    readonly "event.user_input_request": EventUserInputRequestParams;
    readonly "event.mcp_elicitation_request": EventMcpElicitationRequestParams;
    readonly "event.mcp_status_changed": EventMcpStatusChangedParams;
    readonly "event.agent_status": EventAgentStatusParams;
    readonly "event.session_event": EventSessionEventParams;
    readonly "event.event_gap": EventGapParams;
    readonly "thread/realtime/started": ThreadRealtimeStartedParams;
    readonly "thread/realtime/itemAdded": ThreadRealtimeItemAddedParams;
    readonly "thread/realtime/transcript/delta": ThreadRealtimeTranscriptDeltaParams;
    readonly "thread/realtime/transcript/done": ThreadRealtimeTranscriptDoneParams;
    readonly "thread/realtime/outputAudio/delta": ThreadRealtimeOutputAudioDeltaParams;
    readonly "thread/realtime/sdp": ThreadRealtimeSdpParams;
    readonly "thread/realtime/error": ThreadRealtimeErrorParams;
    readonly "thread/realtime/closed": ThreadRealtimeClosedParams;
}

export type AgenCDaemonErrorCode = -32700 | -32600 | -32601 | -32602 | -32603 | -32000;

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

/** Source-compatible M3 admission event contract. */
export interface RunAdmissionJournalEvent extends JsonObject {
    readonly sequence: number;
    readonly eventId: string;
    readonly timestamp: string;
    readonly runId: string;
    readonly stepId: string;
    readonly kind: string;
    readonly event: string;
    readonly reason?: string;
    readonly reservationId?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly reservedTokens?: number;
    readonly reservedCostUsd?: number;
    readonly actualTokens?: number;
    readonly actualCostUsd?: number;
    readonly details?: JsonObject;
}

type PublicRequestForMethod<Method, Request = AgenCDaemonRequest> =
  Request extends { readonly method: infer Names }
    ? Method extends Names
      ? { [Key in keyof Request]: Key extends "method" ? Method : Request[Key] }
      : never
    : never;

export type AgenCDaemonRequestByMethod = {
  readonly [Method in AgenCDaemonMethod]: PublicRequestForMethod<Method>;
};

export type AgenCDaemonParamsByMethod = {
  readonly [Method in AgenCDaemonMethod]: NonNullable<
    AgenCDaemonRequestByMethod[Method]["params"]
  >;
};
