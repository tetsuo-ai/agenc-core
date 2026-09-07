/**
 * Standalone subset of the AgenC daemon JSON-RPC protocol
 * (`runtime/src/app-server/protocol/index.ts`).
 *
 * Wire declarations are generated into a standalone module and re-exported
 * under the SDK's established names. check:sdk-generated-types verifies the
 * artifact and compiles exact request/result/envelope parity for every public
 * method. Helpers may default cwd or adapt older replay results; those helper
 * types do not change the generic request mappings.
 */

import type * as Wire from "./protocol-wire.generated.js";
export type * from "./routines.js";

export type {
  SessionTranscriptV2ActiveTurn,
  SessionTranscriptV2Message,
  SessionTranscriptV2Result,
  SessionTranscriptV2TurnResult,
} from "./transcript-v2.generated.js";

/** JSON-RPC 2.0 envelope version sent on every request. */
export const AGENC_SDK_JSON_RPC_VERSION = "2.0" as const;
/** Protocol the SDK advertises on `initialize`. Handshake rules are in docs/sdk.md. */
export const AGENC_SDK_DAEMON_PROTOCOL_VERSION = "1.10.0" as const;

/** Preserve named wire fields while allowing helpers to supply cwd. */
export type AgencDefaultCwdParams<Params extends { readonly cwd: string }> =
  Omit<
    {
      [
        Key in keyof Params as string extends Key
          ? never
          : number extends Key
            ? never
            : Key
      ]: Params[Key];
    },
    "cwd"
  > & { readonly cwd?: string } & JsonObject;

export type JsonPrimitive = Wire.JsonPrimitive;
export type JsonValue = Wire.JsonValue;
export type JsonObject = Wire.JsonObject;

export type RequestId = Wire.RequestId;

/**
 * Every public daemon request method, in the runtime's declaration order.
 * Mirror of `AGENC_DAEMON_METHODS` — see the module docblock for the drift
 * guard.
 */
export const AGENC_SDK_DAEMON_METHODS = [
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

export type AgencDaemonMethod = (typeof AGENC_SDK_DAEMON_METHODS)[number];

/**
 * Every server-to-client notification method, in the runtime's declaration
 * order. Mirror of `AGENC_DAEMON_NOTIFICATION_METHODS`.
 */
export const AGENC_SDK_DAEMON_NOTIFICATION_METHODS = [
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

export type AgencDaemonNotificationMethod =
  (typeof AGENC_SDK_DAEMON_NOTIFICATION_METHODS)[number];

// ── Shared params/result shapes ──────────────────────────────────────

export type DaemonProtocolInfo = Wire.DaemonProtocolInfo;

/** Authenticated identity of the exact daemon process serving the connection. */
export type DaemonInstanceIdentity = Wire.DaemonInstanceIdentity;

export type InitializeParams = Wire.InitializeParams;

export type RequestCancelParams = Wire.RequestCancelParams;

export type DaemonShutdownParams = Wire.DaemonShutdownParams;

export type PermissionMode =
  "default" | "plan" | "acceptEdits" | "bypassPermissions";

/** Maximum raw `AgentCreateParams.addDirs` entries accepted by the daemon. */
export const AGENC_MAX_AGENT_CREATE_ADD_DIRS = 32;

export type MessageContentBlock = Wire.MessageContentBlock;

export type MessageContent = Wire.MessageContent;

export type AgentRuntimeOptionsParams = Wire.AgentRuntimeOptionsParams;

/** Helper input; generic request() uses the required-cwd wire shape. */
export type AgentCreateParams = AgencDefaultCwdParams<Wire.AgentCreateParams>;

export type AgentListParams = Wire.AgentListParams;

export type AgentAttachParams = Wire.AgentAttachParams;

export type AgentStopParams = Wire.AgentStopParams;

export type AgentLogsParams = Wire.AgentLogsParams;

export type RunStatusParams = Wire.RunStatusParams;

export type RunResultParams = Wire.RunResultParams;

export type RunReplayParams = Wire.RunReplayParams;

export type RunEvidenceParams = Wire.RunEvidenceParams;

export type RunCancelParams = Wire.RunCancelParams;

/** One required verification command for a verified-change workflow run. */
export type RunStartVerificationCommand = Wire.RunStartVerificationCommand;

export type RunStartParams = Wire.RunStartParams;

/** Helper input; generic request() uses the required-cwd wire shape. */
export type SessionCreateParams =
  AgencDefaultCwdParams<Wire.SessionCreateParams>;

export type SessionListParams = Wire.SessionListParams;

export type SessionAttachParams = Wire.SessionAttachParams;

export type SessionDetachParams = Wire.SessionDetachParams;

export type SessionTerminateParams = Wire.SessionTerminateParams;

export type SessionClearParams = Wire.SessionClearParams;

export type SessionSnapshotParams = Wire.SessionSnapshotParams;

export type SessionTranscriptParams = Wire.SessionTranscriptParams;

export type SessionTranscriptV2Params = Wire.SessionTranscriptV2Params;

export type SessionCancelTurnParams = Wire.SessionCancelTurnParams;

/** Protocol-1.0 request shape shipped with agenc-sdk 0.3.0. */
export type SessionResolveToolCallLegacyParams =
  Wire.SessionResolveToolCallLegacyParams;

/** Evidence-bearing request required for canonical durable effect records. */
export type SessionResolveToolCallEvidenceParams =
  Wire.SessionResolveToolCallEvidenceParams;

export type SessionResolveToolCallParams = Wire.SessionResolveToolCallParams;

export type SessionMcpStatusParams = Wire.SessionMcpStatusParams;

export type SessionMcpServerConfig = Wire.SessionMcpServerConfig;

export type SessionMcpAddServerParams = Wire.SessionMcpAddServerParams;

export type MessageSendParams = Wire.MessageSendParams;

export type MessageStreamParams = Wire.MessageStreamParams;

export type ThreadRealtimeStartParams = Wire.ThreadRealtimeStartParams;

export type ThreadRealtimeAudioChunk = Wire.ThreadRealtimeAudioChunk;

export type ThreadRealtimeAppendAudioParams =
  Wire.ThreadRealtimeAppendAudioParams;

export type ThreadRealtimeAppendTextParams =
  Wire.ThreadRealtimeAppendTextParams;

export type ThreadRealtimeStopParams = Wire.ThreadRealtimeStopParams;

export type ExitPlanApprovalPayload = Wire.ExitPlanApprovalPayload;

export type ToolApproveParams = Wire.ToolApproveParams;

export type ToolDenyParams = Wire.ToolDenyParams;

export type ToolCancelParams = Wire.ToolCancelParams;

export type ElicitationRespondParams = Wire.ElicitationRespondParams;

export type PermissionListParams = Wire.PermissionListParams;

export type FuzzyFileSearchParams = Wire.FuzzyFileSearchParams;

export type CommandExecTerminalSize = Wire.CommandExecTerminalSize;

export type CommandExecStartParams = Wire.CommandExecStartParams;

export type CommandExecWriteParams = Wire.CommandExecWriteParams;

export type CommandExecResizeParams = Wire.CommandExecResizeParams;

export type CommandExecTerminateParams = Wire.CommandExecTerminateParams;

export type EmptyParams = Wire.EmptyParams;

export type CsvJobReviewListWireParams = Wire.CsvJobReviewListParams;

export type CsvJobReviewShowWireParams = Wire.CsvJobReviewShowParams;

export type CsvJobReviewResolveWireParams = Wire.CsvJobReviewResolveParams;

export type AgencParamsByMethod = Wire.AgenCDaemonParamsByMethod;

// ── Result shapes ────────────────────────────────────────────────────

export type AgentStatus = Wire.AgentStatus;
export type AgentRunStatus = Wire.AgentRunStatus;
export type SessionStatus = Wire.SessionStatus;

export type AgentSummary = Wire.AgentSummary;

export type SessionSummary = Wire.SessionSummary;

export type InitializeResult = Wire.InitializeResult;

export type RequestCancelResult = Wire.RequestCancelResult;

export type AgentCreateResult = Wire.AgentCreateResult;

export type AgentListResult = Wire.AgentListResult;

/** Standalone wire mirror of the runtime's canonical run-settings snapshot. */
export type RunRuntimeSettingsSnapshot = Wire.RunRuntimeSettingsSnapshot;

export type AgentAttachResult = Wire.AgentAttachResult;

export type AgentAttachSessionSummary = Wire.AgentAttachSessionSummary;

export type AgentStopResult = Wire.AgentStopResult;

export type AgentLogSession = Wire.AgentLogSession;

export type AgentLogsResult = Wire.AgentLogsResult;

export type RunCancelResult = Wire.RunCancelResult;

/** Dirty-state summary of the user's checkout captured at workflow intake. */
export type RunStartBaseDirty = Wire.RunStartBaseDirty;

export type RunStartResult = Wire.RunStartResult;

/** JSON-serializable mirror of a workflow step's content-addressed artifact. */
export type RunWorkflowArtifactPointer = Wire.RunWorkflowArtifactPointer;

export type RunWorkflowStepStatus = Wire.RunWorkflowStepStatus;

export type RunWorkflowStatusStep = Wire.RunWorkflowStatusStep;

/**
 * M5 verified-change workflow projection, present on `run.status` only for
 * runs that recorded workflow steps.
 */
export type RunWorkflowStatus = Wire.RunWorkflowStatus;

/**
 * M5 evidence-bundle summary for `run.evidence`, present only when the run
 * has a per-run evidence ledger directory.
 */
export type RunEvidenceBundle = Wire.RunEvidenceBundle;

export type RunDurableRecord = Wire.RunDurableRecord;

export type RunStateSource = Wire.RunStateSource;

export type RunAdmissionSourceAvailability =
  Wire.RunAdmissionSourceAvailability;

export type RunAdmissionAggregateStatus = Wire.RunAdmissionAggregateStatus;

export type RunAdmissionSummary = Wire.RunAdmissionSummary;

export type RunStatusResult = Wire.RunStatusResult;

export type RunTerminalOutcome = Wire.RunTerminalOutcome;

export type RunTerminalOutputAvailability = Wire.RunTerminalOutputAvailability;

export type RunUsageTotals = Wire.RunUsageTotals;

/** Terminal output committed by M4 and readable after disconnect/restart. */
export type RunTerminalPersistedOutput = Wire.RunTerminalPersistedOutput;

/** Compatibility alias for code that names the unavailable branch directly. */
export type RunTerminalOutputUnavailable = RunTerminalOutputAvailability;
export type RunTerminalOutput =
  RunTerminalPersistedOutput | RunTerminalOutputAvailability;

export type RunResultResult = Wire.RunResultResult;

export type RunJournalCategory = Wire.RunJournalCategory;

/**
 * One event from the canonical append-only run journal.
 *
 * M3 admission events remain valid members of this shape; M4 workflow events
 * add a canonical category/name/payload envelope without forcing consumers to
 * understand every future event payload before they can advance a cursor.
 */
export type RunJournalEvent = Wire.RunJournalEvent;

/** Source-compatible M3 admission event contract. */
export type RunAdmissionJournalEvent = Wire.RunAdmissionJournalEvent;

/**
 * Event returned by the pre-M4 admission-journal compatibility reader.
 *
 * `category` is optional because SDK clients can connect to an older daemon
 * that predates the generalized M4 envelope. Every required M3 field remains
 * unchanged, so `isRunAdmissionReplayResult` restores the original
 * source-compatible event type without a cast.
 */
export interface RunAdmissionReplayEvent extends RunAdmissionJournalEvent {
  readonly category?: "admission";
  readonly payload?: JsonValue;
}

/** One event from either the canonical M4 or compatibility M3 replay source. */
export type RunReplayEvent = RunJournalEvent | RunAdmissionReplayEvent;

export type RunReplaySourceUnavailableGap = Wire.RunReplaySourceUnavailableGap;

/** A cursor range was retired or could not be recovered contiguously. */
export type RunReplayRetentionGap = Wire.RunReplayRetentionGap;

/** The supplied cursor is beyond the canonical journal tail. */
export type RunReplayCursorAheadGap = Wire.RunReplayCursorAheadGap;

export type RunReplayGap = Wire.RunReplayGap;

export type RunJournalReplaySource = Wire.RunJournalReplaySource;

export type RunAdmissionReplaySource = Wire.RunAdmissionReplaySource;

export type RunReplaySource = Wire.RunReplaySource;

export interface RunReplayPage extends JsonObject {
  readonly runId: string;
  readonly afterSequence: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextAfterSequence: number;
  readonly firstAvailableSequence?: number;
  readonly lastAvailableSequence?: number;
  readonly gap: RunReplayGap | null;
}

export interface RunJournalReplayResult extends RunReplayPage {
  readonly events: readonly RunJournalEvent[];
  readonly source: RunJournalReplaySource;
}

/** Source-compatible result for the existing M3 admission replay reader. */
export interface RunAdmissionReplayResult extends RunReplayPage {
  readonly events: readonly RunAdmissionReplayEvent[];
  readonly source: RunAdmissionReplaySource;
}

/** Discriminated by `source.kind`; M3 and M4 event contracts stay precise. */
export type RunReplayResult = RunJournalReplayResult | RunAdmissionReplayResult;

/** True when `run.replay` used the pre-generalized admission journal. */
export function isRunAdmissionReplayResult(
  result: RunReplayResult,
): result is RunAdmissionReplayResult {
  return result.source.kind === "execution_admission_journal";
}

/** True when `run.replay` used the canonical run journal. */
export function isRunJournalReplayResult(
  result: RunReplayResult,
): result is RunJournalReplayResult {
  return result.source.kind === "run_journal";
}

export type RunEvidenceCompleteness = Wire.RunEvidenceCompleteness;

export type RunEvidenceSource = Wire.RunEvidenceSource;

export type RunEvidenceCursor = Wire.RunEvidenceCursor;

export type RunEvidenceEventHash = Wire.RunEvidenceEventHash;

export type RunEvidenceHashes = Wire.RunEvidenceHashes;

export type RunEvidenceResult = Wire.RunEvidenceResult;

export type SessionCreateResult = Wire.SessionCreateResult;

export type SessionListResult = Wire.SessionListResult;

export type SessionAttachResult = Wire.SessionAttachResult;

export type SessionDetachResult = Wire.SessionDetachResult;

export type SessionTerminateResult = Wire.SessionTerminateResult;

export type SessionClearResult = Wire.SessionClearResult;

export interface TokenUsage extends JsonObject {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export type SessionSnapshotResult = Wire.SessionSnapshotResult;

export type SessionTranscriptMessage = Wire.SessionTranscriptMessage;

export type SessionTranscriptResult = Wire.SessionTranscriptResult;

export type SessionCancelTurnResult = Wire.SessionCancelTurnResult;

export type SessionResolveToolCallResult = Wire.SessionResolveToolCallResult;

export type SessionMcpStatusServer = Wire.SessionMcpStatusServer;

export type SessionMcpStatusTool = Wire.SessionMcpStatusTool;

export type SessionMcpStatusResult = Wire.SessionMcpStatusResult;

export type SessionMcpAddServerResult = Wire.SessionMcpAddServerResult;

export type MessageSendResult = Wire.MessageSendResult;

export type MessageSendTerminalResult = Wire.MessageSendTerminalResult;

export type MessageStreamResult = Wire.MessageStreamResult;

export type ToolDecisionResult = Wire.ToolDecisionResult;

export type ElicitationRespondResult = Wire.ElicitationRespondResult;

export type PermissionGrant = Wire.PermissionGrant;

export type PermissionListResult = Wire.PermissionListResult;

export type FuzzyFileSearchResult = Wire.FuzzyFileSearchResult;

export type FuzzyFileIndexRootFreshness = Wire.FuzzyFileIndexRootFreshness;

export type FuzzyFileIndexFreshness = Wire.FuzzyFileIndexFreshness;

export type FuzzyFileMatcherMetadata = Wire.FuzzyFileMatcherMetadata;

export type FuzzyFileSearchResponse = Wire.FuzzyFileSearchResponse;

export type CommandExecResponse = Wire.CommandExecResponse;

export type HealthPingResult = Wire.HealthPingResult;

export type HealthReadyResult = Wire.HealthReadyResult;

export type HealthStatsResult = Wire.HealthStatsResult;

export type DaemonReloadResult = Wire.DaemonReloadResult;

export type DaemonShutdownResult = Wire.DaemonShutdownResult;

export type AuthWhoamiResult = Wire.AuthWhoamiResult;

export type AuthLoginResult = Wire.AuthLoginResult;

export type AuthLogoutResult = Wire.AuthLogoutResult;

export type AgencResultByMethod = Wire.AgenCDaemonResultByMethod;

// ── Notification params ──────────────────────────────────────────────

export interface AgencEventBaseParams extends JsonObject {
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

export type EventMessageChunkParams = Wire.EventMessageChunkParams;

export type EventToolRequestParams = Wire.EventToolRequestParams;

export type EventPermissionRequestParams = Wire.EventPermissionRequestParams;

export type EventUserInputRequestParams = Wire.EventUserInputRequestParams;

export type EventMcpElicitationRequestParams =
  Wire.EventMcpElicitationRequestParams;

/** Non-journal control-plane invalidation for the passive MCP projection. */
export type EventMcpStatusChangedParams = Wire.EventMcpStatusChangedParams;

export type EventAgentStatusParams = Wire.EventAgentStatusParams;

export type EventSessionEventParams = Wire.EventSessionEventParams;

/** Observable, non-journal sentinel emitted by bounded live-delivery buffers. */
export type EventGapParams = Wire.EventGapParams;

// ── Envelopes ────────────────────────────────────────────────────────

export type AgencDaemonRequest<
  Method extends AgencDaemonMethod = AgencDaemonMethod,
> = Wire.AgenCDaemonRequestByMethod[Method];

/** Only methods whose wire envelope permits omission may omit the payload. */
export type AgencRequestParams<Method extends AgencDaemonMethod> =
  Extract<
    AgencDaemonRequest<Method>,
    { readonly params: unknown }
  > extends never
    ? [params?: AgencParamsByMethod[Method]]
    : [params: AgencParamsByMethod[Method]];

export type AgencDaemonErrorCode =
  -32700 | -32600 | -32601 | -32602 | -32603 | -32000;

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
