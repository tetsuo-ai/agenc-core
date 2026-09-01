/**
 * Daemon-backed session adapter for the AgenC TUI.
 *
 * F-04b keeps the existing TUI session contract intact while routing user
 * input and streamed session events through the daemon protocol.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AgenCDaemonResponseError } from "../app-server/agent-cli.js";
import { isTerminalDaemonErrorPayload } from "./daemon-terminal-error.js";
import type {
  AgentAttachParams,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  ElicitationRespondParams,
  JsonObject,
  JsonValue,
  MessageContentBlock,
  MessageStreamParams,
  RequestId,
  SessionMcpStatusResult,
  SessionMcpAddServerParams,
  SessionMcpServerByNameParams,
  SessionMcpServerConfig,
  SessionMcpServerMutationResult,
  SessionPartialCompactFromMessageParams,
  SessionPartialCompactFromMessageResult,
  SessionRollbackCompactionParams,
  SessionRollbackCompactionResult,
  SessionExtendCompactionRollbackRetentionParams,
  SessionExtendCompactionRollbackRetentionResult,
  SessionRewindConversationToMessageParams,
  SessionRewindConversationToMessageResult,
  SessionFileRewindParams,
  SessionPreviewFileRewindResult,
  SessionRewindFilesToMessageResult,
  SessionSetModelParams,
  SessionSetModelResult,
  SessionSetPermissionModeParams,
  SessionSetPermissionModeResult,
  SessionPermissionRuleMutationParams,
  SessionPermissionRuleMutationResult,
  SessionHooksStatusParams,
  SessionHooksStatusResult,
  SessionHooksSetDisabledParams,
  SessionHooksSetDisabledResult,
  SessionApplyConfigParams,
  SessionApplyConfigResult,
  SessionSnapshotResult,
  SessionShellExecuteParams,
  SessionShellExecuteResult,
  SessionResolveToolCallResult,
  WorkspaceEditorAcquireParams,
  WorkspaceEditorCancelPredictionParams,
  WorkspaceEditorCancelPredictionSessionParams,
  WorkspaceEditorCancelPredictionResult,
  WorkspaceEditorChangesListParams,
  WorkspaceEditorChangesListResult,
  WorkspaceEditorPredictParams,
  WorkspaceEditorPredictSessionParams,
  WorkspaceEditorPredictionFeedbackParams,
  WorkspaceEditorPredictionFeedbackSessionParams,
  WorkspaceEditorPredictionFeedbackResult,
  WorkspaceEditorPredictionResult,
  WorkspaceEditorHeartbeatParams,
  WorkspaceEditorLeaseResult,
  WorkspaceEditorProposalApplyParams,
  WorkspaceEditorProposalApplyResult,
  WorkspaceEditorProposalDiscardResult,
  WorkspaceEditorProposalParams,
  WorkspaceEditorProposalResult,
  WorkspaceEditorProposalStatusParams,
  WorkspaceEditorProposalStatusResult,
  WorkspaceEditorReleaseParams,
  WorkspaceEditorReleaseResult,
  WorkspaceEditorRecoveredTopologyListParams,
  WorkspaceEditorRecoveredTopologyListResult,
  WorkspaceEditorRecoveredTopologyResolveParams,
  WorkspaceEditorRecoveredTopologyResolveResult,
  WorkspaceEditorStaleAuthorityRefreshParams,
  WorkspaceEditorStaleAuthorityRefreshResult,
  WorkspaceEditorSyncParams,
  WorkspaceEditorSyncResult,
  WorkspaceEditorTopologyCompleteParams,
  WorkspaceEditorTopologyCompleteResult,
  WorkspaceEditorTopologyFinalizeParams,
  WorkspaceEditorTopologyReleaseResult,
  WorkspaceEditorTopologyReserveParams,
  WorkspaceEditorTopologyReserveResult,
} from "../app-server/protocol/index.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import {
  reviewDecisionIsAllow,
  type ReviewDecision,
} from "../permissions/review-decision.js";
import {
  replacePermissionRuleSourceBuckets,
} from "../permissions/permission-updates.js";
import { validateCanonicalSessionPermissionRuleBuckets } from "../permissions/session-rule-buckets.js";
import type { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { parseRuleString, serializeRuleValue } from "../permissions/rules.js";
import type {
  PermissionBehavior,
  PermissionRuleValue,
} from "../permissions/types.js";
import { notifyTasksUpdated } from "../utils/tasks.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  takeAskUserQuestionUpdatedInput,
} from "../tools/ask-user-question/tool.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";
import type { PhaseEvent } from "../phases/events.js";
import type {
  IdleInputAdmission,
  IdleInputOwnership,
  McpManager,
  McpServerMutationResult,
  McpSessionServerConfig,
  McpSurfaceServer,
  McpSurfaceSnapshot,
  McpSurfaceTool,
} from "../session/session.js";
import { isMcpUrlCompletionResponse } from "../elicitation/url-completion.js";
import { takePlanApprovalChoice } from "./plan-approval-choice.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../tools/ExitPlanModeTool/constants.js";
import {
  createRealtimeTuiControls,
  type AgenCRealtimeTuiControls,
  type CreateRealtimeTuiControlsOptions,
} from "./realtime/controller.js";
import type {
  RealtimeAudioPlayer,
  StartRealtimeAudioCapture,
} from "./realtime/audio.js";
import type {
  AgenCCompactProgressControls,
  AgenCShellExecuteParams,
} from "./session-types.js";
import { mcpServerNameValidationIssue } from "../mcp-client/server-name.js";
import { isRecord } from "../utils/record.js";
import { logForDebugging } from "../utils/debug.js";
import type { AgentRoleWorkspace } from "../agents/role-workspace.js";
import type { SessionEditorInteraction } from "../session/autonomous-mode.js";
import type { RunRuntimeSettingsSnapshot } from "../contracts/run-contracts.js";
import {
  applyDaemonTuiRuntimeSettingsAuthority,
  type AgenCDaemonOnlyTuiSession,
} from "../app-server-client/index.js";

export const AGENC_DAEMON_RECONNECTING_MESSAGE =
  "daemon disconnected, reconnecting";

const MAX_DAEMON_QUEUED_INPUTS = 512;
const MAX_DAEMON_QUEUED_INPUT_BYTES = 16 * 1_024 * 1_024;

function validateDaemonPermissionRuleMutationResult(
  result: SessionPermissionRuleMutationResult,
  sessionId: string,
  requested: Omit<SessionPermissionRuleMutationParams, "sessionId">,
): Readonly<Record<PermissionBehavior, readonly PermissionRuleValue[]>> {
  if (
    result.sessionId !== sessionId ||
    typeof result.applied !== "boolean" ||
    result.operation !== requested.operation ||
    result.behavior !== requested.behavior ||
    result.rule !== requested.rule ||
    !isRecord(result.sessionRules)
  ) {
    throw new Error("daemon returned an invalid permission-rule mutation result");
  }
  const resultRule = parseRuleString(result.rule);
  if (resultRule === null || serializeRuleValue(resultRule) !== result.rule) {
    throw new Error("daemon returned a non-canonical permission rule");
  }
  const canonical = validateCanonicalSessionPermissionRuleBuckets(
    result.sessionRules,
    "daemon session permission rules",
  );
  const finalBucket = canonical.serialized[result.behavior];
  if (
    (result.operation === "add" && !finalBucket.includes(result.rule)) ||
    (result.operation === "remove" && finalBucket.includes(result.rule))
  ) {
    throw new Error(
      "daemon permission-rule result does not match its canonical session bucket",
    );
  }
  return canonical.parsed;
}

async function projectDaemonSessionPermissionRules(
  registry: Pick<PermissionModeRegistry, "transact">,
  projection: Readonly<
    Record<PermissionBehavior, readonly PermissionRuleValue[]>
  >,
): Promise<void> {
  await registry.transact((current) => {
    return {
      next: replacePermissionRuleSourceBuckets(
        current,
        "session",
        projection,
      ),
      result: () => undefined,
    };
  });
}

let nextRealtimeTranscriptEventSequence = 0;

const ACTIVE_DAEMON_TRANSCRIPT_EVENTS = new Set([
  "agent_message",
  "agent_message_delta",
  "tool_call_started",
  "tool_progress",
  "tool_call_completed",
  "request_permissions",
  "request_user_input",
  "mcp_elicitation_request",
]);

const TERMINAL_DAEMON_TRANSCRIPT_EVENTS = new Set([
  "turn_complete",
  "turn_aborted",
  "error",
]);

export type AgenCDaemonConnectionStatus =
  "connected" | "disconnected" | "reconnecting";

export interface AgenCDaemonConnectionState extends JsonObject {
  readonly status: AgenCDaemonConnectionStatus;
  readonly id?: string;
  readonly message?: string;
}

export interface AgenCTuiBridgeSession extends AgenCCompactProgressControls {
  readonly conversationId: string;
  readonly sessionConfiguration?: {
    readonly provider?: { readonly slug?: string };
    readonly collaborationMode?: { readonly model?: string };
  };
  /** Preserved from the daemon/bootstrap session for immutable role discovery. */
  readonly roleWorkspace?: Pick<AgentRoleWorkspace, "id" | "cwd">;
  readonly services: {
    approvalResolver?: ApprovalResolver;
    requestUserInputResolver?: {
      request(
        event: RequestUserInputEvent,
        signal?: AbortSignal,
      ): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
    readonly [key: string]: unknown;
  };
  readonly initialTranscriptEvents?: readonly unknown[];
  getInitialTranscriptEvents?(): readonly unknown[];
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
  emitPhaseEvent?(event: PhaseEvent): void;
  clearDaemonSession?(): Promise<void>;
  resolveDaemonToolCall?(params: {
    readonly toolCallId: string;
    readonly disposition:
      | "confirmed_committed"
      | "confirmed_no_effect"
      | "remains_unknown";
    readonly evidenceRef: string;
    readonly evidenceSha256: string;
    readonly reviewer?: string;
  }): Promise<SessionResolveToolCallResult>;
  getDaemonSessionSnapshot?(): Promise<SessionSnapshotResult>;
  partialCompactFromMessage?(params: {
    readonly messageOrdinal: number;
    readonly direction: "from" | "up_to";
    readonly feedback?: string;
    readonly signal?: AbortSignal;
  }): Promise<SessionPartialCompactFromMessageResult>;
  rollbackCompaction?(params: {
    readonly attemptId: string;
    readonly reviewedBranchTargetSessionId?: string;
  }): Promise<SessionRollbackCompactionResult>;
  extendCompactionRollbackRetention?(params: {
    readonly attemptId: string;
    readonly extendedUntilMs: number;
  }): Promise<SessionExtendCompactionRollbackRetentionResult>;
  rewindConversationToMessage?(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionRewindConversationToMessageResult>;
  previewFileRewind?(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionPreviewFileRewindResult>;
  rewindFilesToMessage?(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionRewindFilesToMessageResult>;
  applyProviderModelSelection?(selection: {
    readonly provider: string;
    readonly model: string;
  }): Promise<SessionSetModelResult>;
  setPendingProviderSwitch?(
    pending: { provider: string; model: string; profile?: string } | null,
  ): void;
  setDaemonPermissionMode?(
    mode: string,
  ): Promise<SessionSetPermissionModeResult>;
  mutateDaemonPermissionRule?(params: {
    readonly operation: SessionPermissionRuleMutationParams["operation"];
    readonly behavior: SessionPermissionRuleMutationParams["behavior"];
    readonly rule: string;
  }): Promise<SessionPermissionRuleMutationResult>;
  getDaemonHooksStatus?(): Promise<SessionHooksStatusResult>;
  setDaemonHooksDisabled?(
    disabled: boolean,
  ): Promise<SessionHooksSetDisabledResult>;
  applyDaemonConfig?(params: {
    profile?: string;
    reload?: boolean;
  }): Promise<SessionApplyConfigResult>;
  acquireWorkspaceEditor?(
    params: WorkspaceEditorAcquireParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  syncWorkspaceEditor?(
    params: WorkspaceEditorSyncParams,
  ): Promise<WorkspaceEditorSyncResult>;
  refreshWorkspaceEditorStaleAuthority?(
    params: WorkspaceEditorStaleAuthorityRefreshParams,
  ): Promise<WorkspaceEditorStaleAuthorityRefreshResult>;
  heartbeatWorkspaceEditor?(
    params: WorkspaceEditorHeartbeatParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  releaseWorkspaceEditor?(
    params: WorkspaceEditorReleaseParams,
  ): Promise<WorkspaceEditorReleaseResult>;
  reserveWorkspaceEditorTopology?(
    params: WorkspaceEditorTopologyReserveParams,
  ): Promise<WorkspaceEditorTopologyReserveResult>;
  completeWorkspaceEditorTopology?(
    params: WorkspaceEditorTopologyCompleteParams,
  ): Promise<WorkspaceEditorTopologyCompleteResult>;
  releaseWorkspaceEditorTopology?(
    params: WorkspaceEditorTopologyFinalizeParams,
  ): Promise<WorkspaceEditorTopologyReleaseResult>;
  listRecoveredWorkspaceEditorTopologies?(
    params: WorkspaceEditorRecoveredTopologyListParams,
  ): Promise<WorkspaceEditorRecoveredTopologyListResult>;
  resolveRecoveredWorkspaceEditorTopology?(
    params: WorkspaceEditorRecoveredTopologyResolveParams,
  ): Promise<WorkspaceEditorRecoveredTopologyResolveResult>;
  getWorkspaceEditorProposal?(
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalResult>;
  getWorkspaceEditorProposalStatus?(
    params: WorkspaceEditorProposalStatusParams,
  ): Promise<WorkspaceEditorProposalStatusResult>;
  applyWorkspaceEditorProposal?(
    params: WorkspaceEditorProposalApplyParams,
  ): Promise<WorkspaceEditorProposalApplyResult>;
  discardWorkspaceEditorProposal?(
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalDiscardResult>;
  listWorkspaceEditorChanges?(
    params: WorkspaceEditorChangesListParams,
  ): Promise<WorkspaceEditorChangesListResult>;
  predictEditorCode?(
    params: WorkspaceEditorPredictSessionParams,
  ): Promise<WorkspaceEditorPredictionResult>;
  cancelEditorPrediction?(
    params: WorkspaceEditorCancelPredictionSessionParams,
  ): Promise<WorkspaceEditorCancelPredictionResult>;
  reportEditorPredictionFeedback?(
    params: WorkspaceEditorPredictionFeedbackSessionParams,
  ): Promise<WorkspaceEditorPredictionFeedbackResult>;
  readonly realtime?: AgenCRealtimeTuiControls;
  executeShellCommand?(
    params: AgenCShellExecuteParams,
  ): Promise<SessionShellExecuteResult>;
  readonly activeTurn?: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  submit?(
    message: string,
    opts?: {
      readonly displayUserMessage?: string | null;
      readonly editorInteraction?: SessionEditorInteraction;
    },
  ): Promise<void>;
  enqueueIdleInput?(input: unknown, ownership?: IdleInputOwnership): number;
  enqueueIdleInputBatch?(
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ): number;
  enqueueIdleInputBatchOwned?(
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ): IdleInputAdmission;
  rollbackIdleInputAdmission?(token: string): boolean;
  commitIdleInputAdmission?(token: string): boolean;
  listMcpClients?(): readonly unknown[];
  listMcpTools?(): readonly unknown[];
  mcpSurfaceSnapshot?(): McpSurfaceSnapshot;
  refreshMcpSurface?(): Promise<McpSurfaceSnapshot>;
  subscribeToMcpSurface?(
    cb: (snapshot: McpSurfaceSnapshot) => void,
  ): () => void;
}

export type AgenCDaemonBackedTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> = Omit<
  Session,
  | "conversationId"
  | "enqueueIdleInput"
  | "enqueueIdleInputBatch"
  | "enqueueIdleInputBatchOwned"
  | "rollbackIdleInputAdmission"
  | "commitIdleInputAdmission"
  | "getInitialTranscriptEvents"
  | "listMcpClients"
  | "listMcpTools"
  | "submit"
  | "subscribeToEvents"
> & {
  readonly conversationId: string;
  getInitialTranscriptEvents(): readonly unknown[];
  subscribeToEvents(cb: (event: unknown) => void): () => void;
  submit(
    message: string,
    opts?: {
      readonly displayUserMessage?: string | null;
      readonly editorInteraction?: SessionEditorInteraction;
    },
  ): Promise<void>;
  enqueueIdleInput(input: unknown, ownership?: IdleInputOwnership): number;
  enqueueIdleInputBatch(
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ): number;
  enqueueIdleInputBatchOwned(
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ): IdleInputAdmission;
  rollbackIdleInputAdmission(token: string): boolean;
  commitIdleInputAdmission(token: string): boolean;
  readonly realtime: AgenCRealtimeTuiControls;
  respondToUserInput(
    requestId: RequestId,
    response: ElicitationRespondParams["response"],
  ): Promise<AgenCDaemonResultByMethod["elicitation.respond"]>;
  respondToMcpElicitation(
    serverName: string,
    requestId: RequestId,
    response: ElicitationRespondParams["response"],
  ): Promise<AgenCDaemonResultByMethod["elicitation.respond"]>;
  partialCompactFromMessage(params: {
    readonly messageOrdinal: number;
    readonly direction: "from" | "up_to";
    readonly feedback?: string;
    readonly signal?: AbortSignal;
  }): Promise<SessionPartialCompactFromMessageResult>;
  rollbackCompaction(params: {
    readonly attemptId: string;
    readonly reviewedBranchTargetSessionId?: string;
  }): Promise<SessionRollbackCompactionResult>;
  extendCompactionRollbackRetention(params: {
    readonly attemptId: string;
    readonly extendedUntilMs: number;
  }): Promise<SessionExtendCompactionRollbackRetentionResult>;
  rewindConversationToMessage(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionRewindConversationToMessageResult>;
  previewFileRewind(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionPreviewFileRewindResult>;
  rewindFilesToMessage(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionRewindFilesToMessageResult>;
};

export interface AgenCDaemonTuiClient {
  request(
    method: "session.shell.execute",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionShellExecuteResult>;
  request(
    method: "session.partialCompactFromMessage",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionPartialCompactFromMessageResult>;
  request(
    method: "session.rollbackCompaction",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionRollbackCompactionResult>;
  request(
    method: "session.extendCompactionRollbackRetention",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionExtendCompactionRollbackRetentionResult>;
  request(
    method: "session.rewindConversationToMessage",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionRewindConversationToMessageResult>;
  request(
    method: "session.previewFileRewind",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionPreviewFileRewindResult>;
  request(
    method: "session.rewindFilesToMessage",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionRewindFilesToMessageResult>;
  request(
    method: "session.setModel",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionSetModelResult>;
  request(
    method: "session.setPermissionMode",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionSetPermissionModeResult>;
  request(
    method: "session.permissions.mutateRule",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionPermissionRuleMutationResult>;
  request(
    method: "session.hooks.status",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionHooksStatusResult>;
  request(
    method: "session.hooks.setDisabled",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionHooksSetDisabledResult>;
  request(
    method: "session.applyConfig",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionApplyConfigResult>;
  request(
    method: "session.mcp.reconnectServer",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionMcpServerMutationResult>;
  request(
    method: "session.mcp.enableServer",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionMcpServerMutationResult>;
  request(
    method: "session.mcp.disableServer",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionMcpServerMutationResult>;
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgenCDaemonResultByMethod[Method]>;
  subscribeToNotifications?(cb: (event: JsonObject) => void): () => void;
  subscribeToSessionEvents(
    sessionId: string,
    cb: (event: JsonObject) => void,
  ): () => void;
  getConnectionState?(): AgenCDaemonConnectionState | null;
  subscribeToConnectionState?(
    cb: (state: AgenCDaemonConnectionState) => void,
  ): () => void;
}

interface AgenCDaemonEditorPredictionClient {
  request(
    method: "workspace.editor.predict",
    params: WorkspaceEditorPredictParams,
  ): Promise<WorkspaceEditorPredictionResult>;
  request(
    method: "workspace.editor.cancelPrediction",
    params: WorkspaceEditorCancelPredictionParams,
  ): Promise<WorkspaceEditorCancelPredictionResult>;
  request(
    method: "workspace.editor.predictionFeedback",
    params: WorkspaceEditorPredictionFeedbackParams,
  ): Promise<WorkspaceEditorPredictionFeedbackResult>;
}

interface AgenCDaemonEditorCoherenceClient {
  request(
    method: "workspace.editor.acquire",
    params: WorkspaceEditorAcquireParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  request(
    method: "workspace.editor.sync",
    params: WorkspaceEditorSyncParams,
  ): Promise<WorkspaceEditorSyncResult>;
  request(
    method: "workspace.editor.staleAuthority.refresh",
    params: WorkspaceEditorStaleAuthorityRefreshParams,
  ): Promise<WorkspaceEditorStaleAuthorityRefreshResult>;
  request(
    method: "workspace.editor.heartbeat",
    params: WorkspaceEditorHeartbeatParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  request(
    method: "workspace.editor.release",
    params: WorkspaceEditorReleaseParams,
  ): Promise<WorkspaceEditorReleaseResult>;
  request(
    method: "workspace.editor.topology.reserve",
    params: WorkspaceEditorTopologyReserveParams,
  ): Promise<WorkspaceEditorTopologyReserveResult>;
  request(
    method: "workspace.editor.topology.complete",
    params: WorkspaceEditorTopologyCompleteParams,
  ): Promise<WorkspaceEditorTopologyCompleteResult>;
  request(
    method: "workspace.editor.topology.release",
    params: WorkspaceEditorTopologyFinalizeParams,
  ): Promise<WorkspaceEditorTopologyReleaseResult>;
  request(
    method: "workspace.editor.topology.recovered.list",
    params: WorkspaceEditorRecoveredTopologyListParams,
  ): Promise<WorkspaceEditorRecoveredTopologyListResult>;
  request(
    method: "workspace.editor.topology.recovered.resolve",
    params: WorkspaceEditorRecoveredTopologyResolveParams,
  ): Promise<WorkspaceEditorRecoveredTopologyResolveResult>;
  request(
    method: "workspace.editor.proposal.get",
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalResult>;
  request(
    method: "workspace.editor.proposal.status",
    params: WorkspaceEditorProposalStatusParams,
  ): Promise<WorkspaceEditorProposalStatusResult>;
  request(
    method: "workspace.editor.proposal.apply",
    params: WorkspaceEditorProposalApplyParams,
  ): Promise<WorkspaceEditorProposalApplyResult>;
  request(
    method: "workspace.editor.proposal.discard",
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalDiscardResult>;
  request(
    method: "workspace.editor.changes.list",
    params: WorkspaceEditorChangesListParams,
  ): Promise<WorkspaceEditorChangesListResult>;
}

export interface AgenCDaemonTuiSessionOptions<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> {
  readonly baseSession: Session;
  readonly client: AgenCDaemonTuiClient;
  readonly sessionId: string;
  readonly clientId: string;
  readonly conversationId?: string;
  readonly realtimeThreadId?: string;
  readonly realtimeWebrtcSessionFactory?: CreateRealtimeTuiControlsOptions["startWebrtcSession"];
  readonly realtimeAudioCaptureFactory?: StartRealtimeAudioCapture;
  readonly realtimeAudioPlayer?: RealtimeAudioPlayer;
  /** Snapshot cursor captured only after this socket's session route exists. */
  readonly runtimeSettingsCursor: {
    readonly eventId: string;
    readonly cwd: string;
  };
}

export interface AgenCDaemonAgentTuiSessionOptions<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> extends Omit<
    AgenCDaemonTuiSessionOptions<Session>,
    "sessionId" | "runtimeSettingsCursor"
  > {
  readonly agentId: string;
}

export async function attachDaemonAgentTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
>(
  options: AgenCDaemonAgentTuiSessionOptions<Session>,
): Promise<AgenCDaemonBackedTuiSession<Session>> {
  const attachment = await options.client.request("agent.attach", {
    agentId: options.agentId,
    clientId: options.clientId,
  } satisfies AgentAttachParams);
  const sessionId = Array.isArray(attachment.sessionIds)
    ? attachment.sessionIds[0]
    : undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`daemon agent has no attached session: ${options.agentId}`);
  }
  if (!Array.isArray(attachment.sessions)) {
    throw new Error("daemon agent attachment has no session summaries");
  }
  const attachedSessions = attachment.sessions.filter(
    (session) => session.sessionId === sessionId,
  );
  if (attachedSessions.length !== 1) {
    throw new Error(
      "daemon agent attachment must contain exactly one primary session summary",
    );
  }
  const attachedSession = attachedSessions[0];
  const authorityCwd = attachedSession?.cwd;
  if (
    attachedSession === undefined ||
    !["idle", "running", "waiting"].includes(attachedSession.status) ||
    typeof authorityCwd !== "string" ||
    authorityCwd.trim() !== authorityCwd ||
    authorityCwd.length === 0 ||
    Buffer.byteLength(authorityCwd, "utf8") > 4_096 ||
    !isAbsolute(authorityCwd)
  ) {
    throw new Error(
      "daemon agent attachment primary session must be active with a bounded absolute cwd",
    );
  }
  await applyDaemonTuiRuntimeSettingsAuthority(
    options.baseSession as unknown as AgenCDaemonOnlyTuiSession,
    authorityCwd,
    attachment.runtimeSettings,
  );
  return createDaemonTuiSession({
    ...options,
    sessionId,
    conversationId: attachment.runtimeSessionId ?? options.agentId,
    realtimeThreadId: options.agentId,
    runtimeSettingsCursor: {
      eventId: attachment.runtimeSettingsEventId,
      cwd: authorityCwd,
    },
  });
}

export function createDaemonTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
>(
  options: AgenCDaemonTuiSessionOptions<Session>,
): AgenCDaemonBackedTuiSession<Session> {
  const { baseSession, client, sessionId, clientId } = options;
  // These authenticated TUI-only methods are intentionally absent from the
  // public daemon method union. The transport accepts known internal methods;
  // keep the widening narrow so ordinary TUI calls remain contract-checked.
  const editorPredictionClient =
    client as unknown as AgenCDaemonEditorPredictionClient;
  const editorCoherenceClient =
    client as unknown as AgenCDaemonEditorCoherenceClient;
  const conversationId = options.conversationId ?? sessionId;
  // Share the task board with the daemon turn: TodoWrite persists the board
  // under the conversation id (getTaskListId prefers the ambient session's
  // conversationId), so the TUI's store must resolve to the SAME id — the
  // per-process random session UUIDs on each side would never match and the
  // todo list would silently never appear in daemon mode.
  if (process.env.AGENC_TASK_LIST_ID !== conversationId) {
    process.env.AGENC_TASK_LIST_ID = conversationId;
    // The TasksV2Store resolves the board dir on its first fetch — which runs
    // at App mount, BEFORE this async attach sets the env var — and then
    // stops polling on an empty list, so it would never discover the real
    // board. Nudge it: the subscriber callback triggers a re-fetch that picks
    // up the corrected id and points the fs watcher at the real directory.
    // Harmless when the store has not subscribed yet (its first fetch then
    // already resolves the right id).
    notifyTasksUpdated();
  }
  const realtimeThreadId = options.realtimeThreadId ?? conversationId;
  type DaemonQueuedInput = {
    readonly blocks: readonly MessageContentBlock[];
    readonly bytes: number;
    readonly ownership?: IdleInputOwnership;
  };
  const queuedInputs: DaemonQueuedInput[] = [];
  const eventSubscribers = new Set<(event: unknown) => void>();
  // Backlog of received daemon events, replayed to subscribers that register
  // LATE. The daemon replays the session's early events exactly once when the
  // RPC subscription opens — a local subscriber that registers after that
  // single replay (the transcript hook mounts after other subscriptions)
  // would otherwise lose early events FOREVER: the user's first prompt
  // (user_message) never reached the transcript hook and the message was
  // invisible until ctrl+o. Replay from the same received stream — ids match,
  // so the reducer's eventKey dedupe collapses any overlap with live events.
  const receivedEvents: unknown[] = [];
  const REPLAY_BACKLOG_LIMIT = 500;
  let activeTurnSnapshot: { readonly turnId: string } | null = null;
  let daemonTurnStartGeneration = 0;
  let inFlightShellExecutionCount = 0;
  const inFlightShellCommandIds = new Set<string>();
  let shellBatchStartedWithActiveTurn = false;
  let shellBatchTurnStartGeneration = 0;
  // Terminal transcript events are authoritative for a turn. Tool cleanup can
  // arrive afterward; those late events must never manufacture a new
  // "daemon-turn" and relatch the TUI spinner.
  let terminalDaemonTurnObserved = false;
  let queuedInputCount = 0;
  let queuedInputBytes = 0;
  let inFlightInputCount = 0;
  let inFlightInputBytes = 0;
  let nextQueuedInputSequence = 0;
  const idleInputAdmissions = new Map<
    string,
    {
      readonly entries: readonly DaemonQueuedInput[];
      readonly inputCount: number;
      readonly bytes: number;
    }
  >();
  let unsubscribeDaemonEvents: (() => void) | null = null;
  let runtimeSettingsAuthorityError: Error | null = null;
  const markDaemonActivityActive = (event: unknown): void => {
    if (terminalDaemonTurnObserved) return;
    const payload = (event as { readonly payload?: unknown }).payload;
    const turnId =
      isJsonObject(payload) &&
      typeof payload.turnId === "string" &&
      payload.turnId.length > 0
        ? payload.turnId
        : (activeTurnSnapshot?.turnId ?? "daemon-turn");
    activeTurnSnapshot = { turnId };
  };
  const noteDaemonActivity = (event: unknown): void => {
    if (typeof event !== "object" || event === null) {
      return;
    }
    const eventType = (event as { readonly type?: unknown }).type;
    // Raw session errors are diagnostic events. A terminal agent-status error
    // carries an explicit marker added by transcriptEventFromAgentStatus.
    if (
      typeof eventType === "string" &&
      TERMINAL_DAEMON_TRANSCRIPT_EVENTS.has(eventType)
    ) {
      if (
        eventType === "error" &&
        !isTerminalDaemonErrorPayload(
          (event as { readonly payload?: unknown }).payload,
        )
      ) {
        return;
      }
      activeTurnSnapshot = null;
      terminalDaemonTurnObserved = true;
      return;
    }
    if (eventType === "turn_start" || eventType === "turn_started") {
      daemonTurnStartGeneration += 1;
      terminalDaemonTurnObserved = false;
      markDaemonActivityActive(event);
      return;
    }
    if (
      typeof eventType === "string" &&
      ACTIVE_DAEMON_TRANSCRIPT_EVENTS.has(eventType)
    ) {
      const payload = (event as { readonly payload?: unknown }).payload;
      const callId =
        isJsonObject(payload) && typeof payload.callId === "string"
          ? payload.callId
          : null;
      if (callId !== null && inFlightShellCommandIds.has(callId)) {
        // Direct shell calls emit ordinary tool transcript events, but they
        // do not own a model turn. Preserve any real turn snapshot without
        // manufacturing one from the shell's tool lifecycle.
        return;
      }
      markDaemonActivityActive(event);
      return;
    }
    if (eventType !== "background_agent_status") {
      return;
    }
    const payload = (event as { readonly payload?: unknown }).payload;
    if (typeof payload !== "object" || payload === null) return;
    const status = (payload as { readonly status?: unknown }).status;
    const turnId = (payload as { readonly turnId?: unknown }).turnId;
    if (typeof status !== "string") return;
    if (status === "idle") {
      activeTurnSnapshot = null;
      return;
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      activeTurnSnapshot = null;
      terminalDaemonTurnObserved = true;
      return;
    }
    if (terminalDaemonTurnObserved) return;
    activeTurnSnapshot = {
      turnId:
        typeof turnId === "string" && turnId.length > 0
          ? turnId
          : "daemon-turn",
    };
  };
  const broadcastDaemonEvent = (event: unknown): void => {
    noteDaemonActivity(event);
    if (receivedEvents.length < REPLAY_BACKLOG_LIMIT) {
      receivedEvents.push(event);
    }
    for (const subscriber of [...eventSubscribers]) {
      subscriber(event);
    }
  };
  const realtime = createRealtimeTuiControls({
    threadId: realtimeThreadId,
    client,
    emitEvent: broadcastDaemonEvent,
    ...(options.realtimeWebrtcSessionFactory !== undefined
      ? { startWebrtcSession: options.realtimeWebrtcSessionFactory }
      : {}),
    ...(options.realtimeAudioCaptureFactory !== undefined
      ? { startAudioCapture: options.realtimeAudioCaptureFactory }
      : {}),
    ...(options.realtimeAudioPlayer !== undefined
      ? { audioPlayer: options.realtimeAudioPlayer }
      : {}),
  });
  const mcpProjection = createDaemonMcpProjection(client, sessionId);
  const services: MutableBridgeServices = {
    ...baseSession.services,
    mcpManager: mcpProjection.manager,
  };
  const eventBridgeSession: AgenCTuiBridgeSession = {
    ...baseSession,
    services,
  };
  const runtimeSettingsReconciler = createRuntimeSettingsReconciler({
    baseSession: eventBridgeSession,
    cursor: options.runtimeSettingsCursor,
    onFailure: (error) => {
      runtimeSettingsAuthorityError = error;
      broadcastDaemonEvent({
        id: `daemon-runtime-settings-authority-failed-${Date.now()}`,
        type: "error",
        payload: {
          cause: "runtime_settings_authority_gap",
          message: error.message,
          terminal: true,
          terminalSource: "runtime_settings_authority",
        },
      });
      const abortTerminal = (
        baseSession as AgenCTuiBridgeSession & {
          abortTerminal?: (reason: string) => void;
        }
      ).abortTerminal;
      abortTerminal?.("runtime_settings_authority_gap");
    },
  });
  const assertRuntimeSettingsAuthority = (): void => {
    if (runtimeSettingsAuthorityError !== null) {
      throw runtimeSettingsAuthorityError;
    }
  };
  const failRuntimeSettingsAuthority = (
    cause: unknown,
    failureCause: string,
  ): never => {
    if (runtimeSettingsAuthorityError !== null) {
      throw runtimeSettingsAuthorityError;
    }
    const error =
      cause instanceof Error
        ? cause
        : new Error(`runtime-settings reconciliation failed: ${String(cause)}`);
    runtimeSettingsAuthorityError = error;
    try {
      broadcastDaemonEvent({
        id: `daemon-runtime-settings-authority-failed-${Date.now()}`,
        type: "error",
        payload: {
          cause: failureCause,
          message: error.message,
          terminal: true,
          terminalSource: "runtime_settings_authority",
        },
      });
    } catch {
      // The authority fence and terminal abort below must survive UI listeners.
    }
    try {
      (
        baseSession as AgenCTuiBridgeSession & {
          abortTerminal?: (reason: string) => void;
        }
      ).abortTerminal?.(failureCause);
    } catch {
      // The sticky authority error still fences every subsequent bridge call.
    }
    throw error;
  };
  const isProvenPrecommitAuthorityRejection = (error: unknown): boolean => {
    if (!(error instanceof AgenCDaemonResponseError)) return false;
    if (error.code === -32602) return true;
    return (
      isJsonObject(error.data) &&
      error.data.authorityPhase === "precommit"
    );
  };
  let runtimeSettingsAuthorityMutationTail: Promise<void> = Promise.resolve();
  const runRuntimeSettingsAuthorityMutation = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = runtimeSettingsAuthorityMutationTail.then(operation);
    runtimeSettingsAuthorityMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const ensureDaemonEventsSubscribed = (): void => {
    if (unsubscribeDaemonEvents !== null) return;
    unsubscribeDaemonEvents = subscribeToDaemonEvents(
      client,
      sessionId,
      realtimeThreadId,
      eventBridgeSession,
      realtime,
      mcpProjection,
      broadcastDaemonEvent,
      runtimeSettingsReconciler,
    );
    const currentConnectionState = client.getConnectionState?.();
    if (
      currentConnectionState !== null &&
      currentConnectionState !== undefined
    ) {
      runtimeSettingsReconciler?.noteConnectionState(currentConnectionState);
      mcpProjection.noteConnectionState(currentConnectionState);
    }
  };
  const awaitRuntimeSettingsAuthority = async (): Promise<void> => {
    ensureDaemonEventsSubscribed();
    await runtimeSettingsReconciler?.barrier();
    assertRuntimeSettingsAuthority();
  };
  const maybeStopDaemonEvents = (): void => {
    if (
      eventSubscribers.size > 0 ||
      mcpProjection.hasSubscribers() ||
      runtimeSettingsReconciler !== undefined ||
      unsubscribeDaemonEvents === null
    ) {
      return;
    }
    unsubscribeDaemonEvents();
    unsubscribeDaemonEvents = null;
    mcpProjection.noteConnectionObservationGap();
  };
  const admitQueuedInputs = (
    inputs: readonly unknown[],
    owned: boolean,
    ownership?: IdleInputOwnership,
  ): IdleInputAdmission => {
    const entries = inputs
      .map((input) => queuedInputBlocks(input))
      .filter((blocks) => blocks.length > 0)
      .map((blocks): DaemonQueuedInput => ({
        blocks,
        bytes: queuedInputBlocksBytes(blocks),
        ...(ownership !== undefined
          ? {
              ownership: {
                workspaceView: ownership.workspaceView,
                ...(ownership.editorInteractionId !== undefined
                  ? {
                      editorInteractionId: ownership.editorInteractionId,
                    }
                  : {}),
              },
            }
          : {}),
      }));
    const inputCount = entries.length;
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (
      queuedInputCount + inFlightInputCount + inputCount >
        MAX_DAEMON_QUEUED_INPUTS ||
      queuedInputBytes + inFlightInputBytes + bytes >
        MAX_DAEMON_QUEUED_INPUT_BYTES
    ) {
      throw new Error(
        "Session mailbox is full; queued input was not accepted.",
      );
    }
    const firstSequence = inputCount === 0 ? 0 : nextQueuedInputSequence + 1;
    nextQueuedInputSequence += inputCount;
    const lastSequence = inputCount === 0 ? 0 : nextQueuedInputSequence;
    queuedInputs.push(...entries);
    queuedInputCount += inputCount;
    queuedInputBytes += bytes;
    const token =
      inputCount === 0 ? "daemon-idle:empty" : `daemon-idle:${randomUUID()}`;
    if (owned && inputCount > 0) {
      idleInputAdmissions.set(token, {
        entries,
        inputCount,
        bytes,
      });
    }
    return {
      token,
      firstSequence,
      lastSequence,
      count: inputCount,
    };
  };
  const rollbackQueuedInputAdmission = (token: string): boolean => {
    if (token === "daemon-idle:empty") return true;
    const admission = idleInputAdmissions.get(token);
    if (admission === undefined) return false;
    const claimedIndexes = new Set<number>();
    const indexes = admission.entries.map((entry) => {
      const index = queuedInputs.findIndex(
        (candidate, candidateIndex) =>
          candidate === entry && !claimedIndexes.has(candidateIndex),
      );
      if (index >= 0) claimedIndexes.add(index);
      return index;
    });
    if (indexes.some((index) => index < 0)) {
      idleInputAdmissions.delete(token);
      return false;
    }
    for (const index of [...indexes].sort((left, right) => right - left)) {
      queuedInputs.splice(index, 1);
    }
    queuedInputCount = Math.max(0, queuedInputCount - admission.inputCount);
    queuedInputBytes = Math.max(0, queuedInputBytes - admission.bytes);
    idleInputAdmissions.delete(token);
    return true;
  };
  const daemonSessionBase = { ...baseSession };
  Reflect.deleteProperty(daemonSessionBase, "listMcpClients");
  Reflect.deleteProperty(daemonSessionBase, "listMcpTools");
  Reflect.deleteProperty(daemonSessionBase, "setPendingProviderSwitch");
  if (runtimeSettingsReconciler !== undefined) {
    ensureDaemonEventsSubscribed();
  }
  return {
    ...daemonSessionBase,
    conversationId,
    services,
    mcpSurfaceSnapshot: () => mcpProjection.snapshot(),
    refreshMcpSurface: () => mcpProjection.refresh(),
    subscribeToMcpSurface: (cb) => {
      const unsubscribe = mcpProjection.subscribe(cb);
      ensureDaemonEventsSubscribed();
      return () => {
        unsubscribe();
        maybeStopDaemonEvents();
      };
    },
    realtime,
    activeTurn: {
      unsafePeek: () =>
        activeTurnSnapshot ?? baseSession.activeTurn?.unsafePeek?.() ?? null,
    },
    submit: async (message, opts) => {
      await runtimeSettingsAuthorityMutationTail;
      await awaitRuntimeSettingsAuthority();
      const queuedInputsBeforeSubmission = [...queuedInputs];
      const queuedEntries: DaemonQueuedInput[] = [];
      const retained: DaemonQueuedInput[] = [];
      for (const entry of queuedInputs) {
        const selected =
          opts?.editorInteraction !== undefined
            ? entry.ownership?.workspaceView === "editor" &&
              entry.ownership.editorInteractionId ===
                opts.editorInteraction.interactionId
            : entry.ownership?.workspaceView !== "editor";
        if (selected) {
          queuedEntries.push(entry);
        } else {
          retained.push(entry);
        }
      }
      queuedInputs.splice(0, queuedInputs.length, ...retained);
      const queued = queuedEntries.flatMap((entry) => entry.blocks);
      const submittedInputCount = queuedEntries.length;
      const submittedInputBytes = queuedEntries.reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      );
      queuedInputCount = Math.max(0, queuedInputCount - submittedInputCount);
      queuedInputBytes = Math.max(0, queuedInputBytes - submittedInputBytes);
      if (queued.length === 0 && message.length === 0) return;
      inFlightInputCount += submittedInputCount;
      inFlightInputBytes += submittedInputBytes;
      const streamId = `${clientId}:${Date.now()}`;
      terminalDaemonTurnObserved = false;
      activeTurnSnapshot = { turnId: streamId };
      const content =
        queued.length === 0
          ? message
          : [
              ...queued,
              ...(message.length > 0
                ? [{ type: "text", text: message } as MessageContentBlock]
                : []),
            ];
      try {
        const metadata: JsonObject = {
          ...(opts?.displayUserMessage !== undefined
            ? { displayUserMessage: opts.displayUserMessage }
            : {}),
          ...(opts?.editorInteraction !== undefined
            ? {
                editorInteraction: {
                  interactionId: opts.editorInteraction.interactionId,
                  kind: opts.editorInteraction.kind,
                  policy: opts.editorInteraction.policy,
                  editorInstanceId: opts.editorInteraction.editorInstanceId,
                  bufferHandle: opts.editorInteraction.bufferHandle,
                  changedtick: opts.editorInteraction.changedtick,
                  contentSha256: opts.editorInteraction.contentSha256,
                  ...(opts.editorInteraction.path !== undefined
                    ? { path: opts.editorInteraction.path }
                    : {}),
                  range: {
                    start: {
                      line: opts.editorInteraction.range.start.line,
                      column: opts.editorInteraction.range.start.column,
                    },
                    end: {
                      line: opts.editorInteraction.range.end.line,
                      column: opts.editorInteraction.range.end.column,
                    },
                  },
                  ...(opts.editorInteraction.selectionMode !== undefined
                    ? {
                        selectionMode: opts.editorInteraction.selectionMode,
                      }
                    : {}),
                },
              }
            : {}),
        };
        await client.request("message.stream", {
          sessionId,
          content,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          streamId,
        } satisfies MessageStreamParams);
        const submitted = new Set(queuedEntries);
        for (const [token, admission] of idleInputAdmissions) {
          if (admission.entries.every((entry) => submitted.has(entry))) {
            idleInputAdmissions.delete(token);
          }
        }
      } catch (error) {
        // gaphunt3 #16: message.stream can reject on a transient/dropped daemon
        // socket (the same failure cancelTurn/setPendingProviderSwitch
        // anticipate). The queued idle inputs (pasted images, attachments,
        // startup messages) were already drained out of `queuedInputs` above;
        // if we don't roll them back the user's content is lost permanently
        // with no transcript entry. Re-prepend the drained blocks so the next
        // submit re-sends them, preserving at-least-once delivery.
        if (queuedEntries.length > 0) {
          const originalEntries = new Set(queuedInputsBeforeSubmission);
          const admittedAfterSubmission = queuedInputs.filter(
            (entry) => !originalEntries.has(entry),
          );
          queuedInputs.splice(
            0,
            queuedInputs.length,
            ...queuedInputsBeforeSubmission,
            ...admittedAfterSubmission,
          );
          queuedInputCount += submittedInputCount;
          queuedInputBytes += submittedInputBytes;
        }
        activeTurnSnapshot = null;
        throw error;
      } finally {
        inFlightInputCount = Math.max(
          0,
          inFlightInputCount - submittedInputCount,
        );
        inFlightInputBytes = Math.max(
          0,
          inFlightInputBytes - submittedInputBytes,
        );
      }
    },
    enqueueIdleInput: (input, ownership) => {
      try {
        void admitQueuedInputs([input], false, ownership);
        return queuedInputCount;
      } catch {
        return -1;
      }
    },
    enqueueIdleInputBatch: (inputs, ownership) => {
      try {
        void admitQueuedInputs(inputs, false, ownership);
        return queuedInputCount;
      } catch {
        return -1;
      }
    },
    enqueueIdleInputBatchOwned: (inputs, ownership) =>
      admitQueuedInputs(inputs, true, ownership),
    rollbackIdleInputAdmission: rollbackQueuedInputAdmission,
    commitIdleInputAdmission: (token) => {
      if (token === "daemon-idle:empty") return true;
      return idleInputAdmissions.delete(token);
    },
    respondToUserInput: async (requestId, response) =>
      client.request("elicitation.respond", {
        sessionId,
        requestId,
        kind: "request_user_input",
        response,
      } satisfies ElicitationRespondParams),
    respondToMcpElicitation: async (serverName, requestId, response) =>
      client.request("elicitation.respond", {
        sessionId,
        requestId,
        kind: "mcp",
        serverName,
        response,
      } satisfies ElicitationRespondParams),
    clearDaemonSession: async () => {
      await client.request("session.clear", { sessionId });
    },
    resolveDaemonToolCall: async (params: {
      readonly toolCallId: string;
      readonly disposition:
        | "confirmed_committed"
        | "confirmed_no_effect"
        | "remains_unknown";
      readonly evidenceRef: string;
      readonly evidenceSha256: string;
      readonly reviewer?: string;
    }) =>
      client.request("session.resolveToolCall", {
        sessionId,
        toolCallId: params.toolCallId,
        disposition: params.disposition,
        evidenceRef: params.evidenceRef,
        evidenceSha256: params.evidenceSha256,
        ...(params.reviewer !== undefined ? { reviewer: params.reviewer } : {}),
      }),
    getDaemonSessionSnapshot: async () =>
      client.request("session.snapshot", { sessionId }),
    executeShellCommand: async ({ command, commandId, signal }) => {
      if (inFlightShellExecutionCount === 0) {
        shellBatchStartedWithActiveTurn =
          activeTurnSnapshot !== null ||
          baseSession.activeTurn?.unsafePeek?.() != null;
        shellBatchTurnStartGeneration = daemonTurnStartGeneration;
      }
      inFlightShellExecutionCount += 1;
      inFlightShellCommandIds.add(commandId);
      try {
        return await client.request(
          "session.shell.execute",
          {
            sessionId,
            commandId,
            command,
          } satisfies SessionShellExecuteParams,
          signal === undefined ? undefined : { signal },
        );
      } finally {
        inFlightShellCommandIds.delete(commandId);
        inFlightShellExecutionCount = Math.max(
          0,
          inFlightShellExecutionCount - 1,
        );
        if (
          inFlightShellExecutionCount === 0 &&
          !shellBatchStartedWithActiveTurn &&
          daemonTurnStartGeneration === shellBatchTurnStartGeneration
        ) {
          // Direct shell tool events share the ordinary daemon activity
          // stream but do not own a model turn and therefore have no
          // turn_complete event. The RPC response is their terminal boundary.
          // Mark it terminal so late tool cleanup cannot relatch the TUI.
          activeTurnSnapshot = null;
          terminalDaemonTurnObserved = true;
        }
      }
    },
    cancelActiveTurn: async (reason?: string) => {
      // Best-effort: a closed/disconnected daemon socket throws. The
      // user pressed ESC — they want the turn to stop, but a thrown
      // error here doesn't help them. Swallow and let the next health
      // check / event surface the disconnection separately.
      // Timeout: a WEDGED daemon (idle deadlock) never answers the RPC at
      // all — without a deadline the ESC press vanishes silently and the
      // UI keeps showing "Working…" forever. Give up after 5s and tell the
      // user the interrupt could not be delivered.
      try {
        await client.request(
          "session.cancelTurn",
          {
            sessionId,
            ...(reason !== undefined ? { reason } : {}),
          },
          { signal: AbortSignal.timeout(5_000) },
        );
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        if (timedOut) {
          broadcastDaemonEvent({
            id: `agenc-daemon-cancel-unacked-${Date.now()}`,
            type: "warning",
            payload: {
              cause: "daemon_delivery_failed",
              action: "session.cancelTurn",
              message:
                "interrupt not acknowledged by the daemon (it may be unresponsive) — try ESC again, or restart the daemon",
            },
          });
        }
      }
    },
    partialCompactFromMessage: async (params) =>
      client.request(
        "session.partialCompactFromMessage",
        {
          sessionId,
          messageOrdinal: params.messageOrdinal,
          direction: params.direction,
          ...(params.feedback !== undefined
            ? { feedback: params.feedback }
            : {}),
        } satisfies SessionPartialCompactFromMessageParams,
        {
          signal: params.signal,
        },
      ),
    rollbackCompaction: async (params) =>
      client.request("session.rollbackCompaction", {
        sessionId,
        attemptId: params.attemptId,
        ...(params.reviewedBranchTargetSessionId !== undefined
          ? { reviewedBranchTargetSessionId: params.reviewedBranchTargetSessionId }
          : {}),
      } satisfies SessionRollbackCompactionParams),
    extendCompactionRollbackRetention: async (params) =>
      client.request("session.extendCompactionRollbackRetention", {
        sessionId,
        attemptId: params.attemptId,
        extendedUntilMs: params.extendedUntilMs,
      } satisfies SessionExtendCompactionRollbackRetentionParams),
    rewindConversationToMessage: async (params) =>
      client.request("session.rewindConversationToMessage", {
        sessionId,
        messageOrdinal: params.messageOrdinal,
      } satisfies SessionRewindConversationToMessageParams),
    previewFileRewind: async (params) =>
      client.request("session.previewFileRewind", {
        sessionId,
        messageOrdinal: params.messageOrdinal,
      } satisfies SessionFileRewindParams),
    rewindFilesToMessage: async (params) =>
      client.request("session.rewindFilesToMessage", {
        sessionId,
        messageOrdinal: params.messageOrdinal,
      } satisfies SessionFileRewindParams),
    applyProviderModelSelection: (selection) =>
      runRuntimeSettingsAuthorityMutation(async () => {
        await awaitRuntimeSettingsAuthority();
        try {
          const result = await client.request("session.setModel", {
            sessionId,
            provider: selection.provider,
            model: selection.model,
          } satisfies SessionSetModelParams);
          if (
            result.provider.length === 0 ||
            result.model.length === 0 ||
            result.runtimeSettingsEventId.length === 0 ||
            result.summary.length === 0
          ) {
            throw new Error(
              "daemon model response omitted its canonical runtime-settings coordinates",
            );
          }
          await runtimeSettingsReconciler.waitFor(
            result.runtimeSettingsEventId,
          );
          const configuration = eventBridgeSession.sessionConfiguration;
          if (
            configuration?.provider?.slug !== result.provider ||
            configuration.collaborationMode?.model !== result.model
          ) {
            throw new Error(
              "daemon model response was not followed by a matching canonical runtime-settings successor",
            );
          }
          if (
            result.applied &&
            (result.provider !== selection.provider ||
              result.model !== selection.model)
          ) {
            throw new Error(
              "daemon applied a provider/model pair other than the requested canonical pair",
            );
          }
          return result;
        } catch (error) {
          if (isProvenPrecommitAuthorityRejection(error)) throw error;
          return failRuntimeSettingsAuthority(
            error,
            "provider_model_authority_reconciliation_failed",
          );
        }
      }),
    setDaemonPermissionMode: (mode) =>
      runRuntimeSettingsAuthorityMutation(async () => {
        await awaitRuntimeSettingsAuthority();
        try {
          const result = await client.request("session.setPermissionMode", {
            sessionId,
            mode,
          } satisfies SessionSetPermissionModeParams);
          await awaitRuntimeSettingsAuthority();
          const registry = (
            eventBridgeSession.services as typeof eventBridgeSession.services & {
              readonly permissionModeRegistry?: {
                current(): { readonly mode?: unknown };
              };
            }
          ).permissionModeRegistry;
          if (
            registry === undefined ||
            typeof registry.current !== "function" ||
            registry.current().mode !== result.mode
          ) {
            throw new Error(
              "daemon permission-mode response was not followed by matching canonical runtime settings",
            );
          }
          return result;
        } catch (error) {
          if (isProvenPrecommitAuthorityRejection(error)) throw error;
          return failRuntimeSettingsAuthority(
            error,
            "permission_rule_authority_reconciliation_failed",
          );
        }
      }),
    mutateDaemonPermissionRule: (params) =>
      runRuntimeSettingsAuthorityMutation(async () => {
        await awaitRuntimeSettingsAuthority();
        try {
        const result = await client.request("session.permissions.mutateRule", {
          sessionId,
          operation: params.operation,
          behavior: params.behavior,
          rule: params.rule,
        } satisfies SessionPermissionRuleMutationParams);
        const projection = validateDaemonPermissionRuleMutationResult(
          result,
          sessionId,
          params,
        );
        const registry = (
          eventBridgeSession.services as typeof eventBridgeSession.services & {
            readonly permissionModeRegistry?: Partial<PermissionModeRegistry>;
          }
        ).permissionModeRegistry;
        if (registry === undefined || typeof registry.transact !== "function") {
          throw new Error(
            "daemon-backed session has no permission-rule projection registry",
          );
        }
        await projectDaemonSessionPermissionRules(
          registry as Pick<PermissionModeRegistry, "transact">,
          projection,
        );
        return result;
        } catch (error) {
          if (isProvenPrecommitAuthorityRejection(error)) throw error;
          return failRuntimeSettingsAuthority(
            error,
            "permission_rule_authority_reconciliation_failed",
          );
        }
      }),
    getDaemonHooksStatus: async () =>
      client.request("session.hooks.status", {
        sessionId,
      } satisfies SessionHooksStatusParams),
    setDaemonHooksDisabled: async (disabled) =>
      client.request("session.hooks.setDisabled", {
        sessionId,
        disabled,
      } satisfies SessionHooksSetDisabledParams),
    applyDaemonConfig: (p) =>
      runRuntimeSettingsAuthorityMutation(async () => {
        await awaitRuntimeSettingsAuthority();
        try {
          if (p.reload === true) {
            // session.applyConfig refreshes only this agent's live config
            // store. Predictions are daemon-owned, so reload the daemon-global
            // snapshot first.
            await client.request("daemon.reload", {});
          }
          const result = await client.request("session.applyConfig", {
            sessionId,
            ...(p.profile !== undefined ? { profile: p.profile } : {}),
            ...(p.reload !== undefined ? { reload: p.reload } : {}),
          } satisfies SessionApplyConfigParams);
          if (!result.applied) return result;
          if (
            result.provider === undefined ||
            result.provider.length === 0 ||
            result.model === undefined ||
            result.model.length === 0 ||
            result.runtimeSettingsEventId === undefined ||
            result.runtimeSettingsEventId.length === 0
          ) {
            throw new Error(
              "daemon config response omitted its canonical runtime-settings coordinates",
            );
          }
          await runtimeSettingsReconciler.waitFor(
            result.runtimeSettingsEventId,
          );
          const configuration = eventBridgeSession.sessionConfiguration;
          if (
            configuration?.provider?.slug !== result.provider ||
            configuration.collaborationMode?.model !== result.model
          ) {
            throw new Error(
              "daemon config response was not followed by matching canonical runtime settings",
            );
          }
          return result;
        } catch (error) {
          if (isProvenPrecommitAuthorityRejection(error)) throw error;
          return failRuntimeSettingsAuthority(
            error,
            "config_authority_reconciliation_failed",
          );
        }
      }),
    acquireWorkspaceEditor: async (params) =>
      editorCoherenceClient.request("workspace.editor.acquire", params),
    syncWorkspaceEditor: async (params) =>
      editorCoherenceClient.request("workspace.editor.sync", params),
    refreshWorkspaceEditorStaleAuthority: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.staleAuthority.refresh",
        params,
      ),
    heartbeatWorkspaceEditor: async (params) =>
      editorCoherenceClient.request("workspace.editor.heartbeat", params),
    releaseWorkspaceEditor: async (params) =>
      editorCoherenceClient.request("workspace.editor.release", params),
    reserveWorkspaceEditorTopology: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.topology.reserve",
        params,
      ),
    completeWorkspaceEditorTopology: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.topology.complete",
        params,
      ),
    releaseWorkspaceEditorTopology: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.topology.release",
        params,
      ),
    listRecoveredWorkspaceEditorTopologies: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.topology.recovered.list",
        params,
      ),
    resolveRecoveredWorkspaceEditorTopology: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.topology.recovered.resolve",
        params,
      ),
    getWorkspaceEditorProposal: async (params) =>
      editorCoherenceClient.request("workspace.editor.proposal.get", params),
    getWorkspaceEditorProposalStatus: async (params) =>
      editorCoherenceClient.request("workspace.editor.proposal.status", params),
    applyWorkspaceEditorProposal: async (params) =>
      editorCoherenceClient.request("workspace.editor.proposal.apply", params),
    discardWorkspaceEditorProposal: async (params) =>
      editorCoherenceClient.request(
        "workspace.editor.proposal.discard",
        params,
      ),
    listWorkspaceEditorChanges: async (params) =>
      editorCoherenceClient.request("workspace.editor.changes.list", params),
    predictEditorCode: async (params) =>
      editorPredictionClient.request("workspace.editor.predict", {
        ...params,
        sessionId,
      } satisfies WorkspaceEditorPredictParams),
    cancelEditorPrediction: async (params) =>
      editorPredictionClient.request("workspace.editor.cancelPrediction", {
        ...params,
        sessionId,
      } satisfies WorkspaceEditorCancelPredictionParams),
    reportEditorPredictionFeedback: async (params) =>
      editorPredictionClient.request("workspace.editor.predictionFeedback", {
        ...params,
        sessionId,
      } satisfies WorkspaceEditorPredictionFeedbackParams),
    subscribeToEvents: (cb) => {
      // Late registrants get the backlog first (see receivedEvents above) —
      // without this, a subscriber mounting after the daemon's one-shot RPC
      // replay permanently misses every event that preceded it.
      for (const event of receivedEvents) {
        cb(event);
      }
      eventSubscribers.add(cb);
      ensureDaemonEventsSubscribed();
      return () => {
        eventSubscribers.delete(cb);
        maybeStopDaemonEvents();
      };
    },
    getInitialTranscriptEvents: () => [
      ...baseInitialTranscriptEvents(baseSession),
      ...connectionNoticeEvents(client.getConnectionState?.() ?? null),
    ],
  } as AgenCDaemonBackedTuiSession<Session>;
}

interface MutableBridgeServices {
  mcpManager?: unknown;
  [key: string]: unknown;
}

interface DaemonMcpProjection {
  readonly manager: McpManager;
  snapshot(): McpSurfaceSnapshot;
  refresh(minimumRevision?: number): Promise<McpSurfaceSnapshot>;
  invalidate(revision: number): void;
  noteConnectionState(state: AgenCDaemonConnectionState): void;
  noteConnectionObservationGap(): void;
  subscribe(listener: (snapshot: McpSurfaceSnapshot) => void): () => void;
  hasSubscribers(): boolean;
}

function freezeDaemonMcpSnapshot(
  result: SessionMcpStatusResult,
): McpSurfaceSnapshot {
  if (!Array.isArray(result.servers) || !Array.isArray(result.tools)) {
    throw new Error("Daemon MCP status returned invalid projection arrays");
  }
  return Object.freeze({
    revision: result.revision,
    servers: Object.freeze(
      result.servers.map((server, index): McpSurfaceServer => {
        const name = daemonMcpProjectionServerName(
          server.name,
          `servers[${index}].name`,
        );
        const transport = daemonMcpProjectionTransport(
          server.transport,
          `servers[${index}].transport`,
        );
        const state = daemonMcpProjectionState(
          server.state,
          `servers[${index}].state`,
        );
        if (typeof server.enabled !== "boolean") {
          throw new Error(
            `Daemon MCP status servers[${index}].enabled must be boolean`,
          );
        }
        if (typeof server.required !== "boolean") {
          throw new Error(
            `Daemon MCP status servers[${index}].required must be boolean`,
          );
        }
        if (!Number.isSafeInteger(server.toolCount) || server.toolCount < 0) {
          throw new Error(
            `Daemon MCP status servers[${index}].toolCount must be a non-negative safe integer`,
          );
        }
        const displayTarget =
          server.displayTarget === undefined
            ? undefined
            : daemonMcpProjectionDisplayTarget(
                server.displayTarget,
                `servers[${index}].displayTarget`,
              );
        return Object.freeze({
          name,
          transport,
          enabled: server.enabled,
          required: server.required,
          state,
          ...(displayTarget !== undefined ? { displayTarget } : {}),
          toolCount: server.toolCount,
        });
      }),
    ),
    tools: Object.freeze(
      result.tools.map((tool, index): McpSurfaceTool =>
        Object.freeze({
          serverName: daemonMcpProjectionServerName(
            tool.serverName,
            `tools[${index}].serverName`,
          ),
          name: daemonMcpProjectionString(
            tool.name,
            `tools[${index}].name`,
            512,
          ),
        }),
      ),
    ),
  });
}

function daemonMcpProjectionString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > maxLength ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value)
  ) {
    throw new Error(`Daemon MCP status ${field} is invalid`);
  }
  return value;
}

function daemonMcpProjectionServerName(
  value: unknown,
  field: string,
): string {
  if (mcpServerNameValidationIssue(value) !== undefined) {
    throw new Error(`Daemon MCP status ${field} is invalid`);
  }
  return value as string;
}

function daemonMcpProjectionTransport(
  value: unknown,
  field: string,
): McpSurfaceServer["transport"] {
  if (
    value === "stdio" ||
    value === "sse" ||
    value === "http" ||
    value === "websocket"
  ) {
    return value;
  }
  throw new Error(`Daemon MCP status ${field} is invalid`);
}

function daemonMcpProjectionState(
  value: unknown,
  field: string,
): McpSurfaceServer["state"] {
  if (
    value === "connected" ||
    value === "pending" ||
    value === "failed" ||
    value === "disabled" ||
    value === "needs-auth" ||
    value === "disconnected"
  ) {
    return value;
  }
  throw new Error(`Daemon MCP status ${field} is invalid`);
}

function daemonMcpProjectionDisplayTarget(
  value: unknown,
  field: string,
): string {
  const target = daemonMcpProjectionString(value, field, 512);
  if (!/[\\/]/u.test(target)) {
    if (target.length <= 256) return target;
    throw new Error(`Daemon MCP status ${field} is invalid`);
  }
  try {
    const endpoint = new URL(target);
    if (
      (endpoint.protocol === "http:" ||
        endpoint.protocol === "https:" ||
        endpoint.protocol === "ws:" ||
        endpoint.protocol === "wss:") &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      endpoint.origin === target
    ) {
      return target;
    }
  } catch {
    // Fall through to the boundary error below.
  }
  throw new Error(`Daemon MCP status ${field} is invalid`);
}

function daemonMcpSnapshotSignature(snapshot: McpSurfaceSnapshot): string {
  return JSON.stringify([snapshot.servers, snapshot.tools]);
}

function createDaemonMcpProjection(
  client: AgenCDaemonTuiClient,
  sessionId: string,
): DaemonMcpProjection {
  let snapshot: McpSurfaceSnapshot = Object.freeze({
    revision: 0,
    servers: Object.freeze([]),
    tools: Object.freeze([]),
  });
  let hasAcceptedSnapshot = false;
  let acceptedRevision = -1;
  let connectionEpoch = 0;
  let wasConnected = client.getConnectionState?.()?.status === "connected";
  let requestedRevision = -1;
  let refreshTask: Promise<McpSurfaceSnapshot> | null = null;
  const listeners = new Set<(next: McpSurfaceSnapshot) => void>();

  const publish = (next: McpSurfaceSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        logForDebugging(
          `Daemon MCP projection listener failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { level: "error" },
        );
      }
    }
  };
  const applyResult = (result: SessionMcpStatusResult): void => {
    if (result.sessionId !== sessionId) {
      throw new Error(
        `Daemon MCP status session mismatch: ${result.sessionId} !== ${sessionId}`,
      );
    }
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) {
      throw new Error("Daemon MCP status returned an invalid revision");
    }
    if (result.revision < acceptedRevision) return;
    const next = freezeDaemonMcpSnapshot(result);
    if (hasAcceptedSnapshot && result.revision === acceptedRevision) {
      if (
        daemonMcpSnapshotSignature(next) !==
        daemonMcpSnapshotSignature(snapshot)
      ) {
        throw new Error(
          `Daemon MCP status revision ${result.revision} changed payload`,
        );
      }
      return;
    }
    acceptedRevision = result.revision;
    hasAcceptedSnapshot = true;
    publish(next);
  };
  const refresh = (minimumRevision = -1): Promise<McpSurfaceSnapshot> => {
    requestedRevision = Math.max(requestedRevision, minimumRevision);
    if (refreshTask !== null) return refreshTask;
    const taskEpoch = connectionEpoch;
    const task = (async (): Promise<McpSurfaceSnapshot> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const targetRevision = requestedRevision;
        requestedRevision = -1;
        let result: SessionMcpStatusResult;
        try {
          result = await client.request("session.mcp.status", { sessionId });
        } catch (error) {
          if (connectionEpoch !== taskEpoch) return snapshot;
          requestedRevision = Math.max(requestedRevision, targetRevision);
          if (attempt === 2) throw error;
          continue;
        }
        if (connectionEpoch !== taskEpoch) return snapshot;
        applyResult(result);
        if (acceptedRevision >= targetRevision && requestedRevision <= acceptedRevision) {
          return snapshot;
        }
        requestedRevision = Math.max(requestedRevision, targetRevision);
      }
      throw new Error(
        `Daemon MCP status did not reach revision ${requestedRevision}`,
      );
    })();
    refreshTask = task;
    void task.finally(() => {
      if (refreshTask === task) refreshTask = null;
    }).catch(() => undefined);
    return task;
  };
  const refreshAfterMutation = async (): Promise<void> => {
    try {
      await refresh();
    } catch (error) {
      logForDebugging(
        `Daemon MCP projection refresh failed after mutation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { level: "warn" },
      );
    }
  };
  const mutationResult = (
    remote: SessionMcpServerMutationResult,
  ): McpServerMutationResult => ({
    serverName: remote.serverName,
    success: remote.success,
    toolCount: remote.toolCount,
    ...(remote.error !== undefined ? { error: remote.error } : {}),
  });

  const manager: McpManager = {
    effectiveServers: async () => {
      await refresh();
      return new Map(
        snapshot.servers.map((server) => [
          server.name,
          {
            enabled: server.enabled,
            required: server.required,
            ...(server.displayTarget !== undefined &&
            server.transport === "stdio"
              ? { command: server.displayTarget }
              : server.displayTarget !== undefined
                ? { url: server.displayTarget }
                : {}),
          },
        ]),
      );
    },
    toolPluginProvenance: async () => null,
    refreshFromAuthority: async () => {
      const current = await refresh();
      return {
        configuredServers: current.servers.map((server) => server.name),
        requiredServers: current.servers
          .filter((server) => server.required)
          .map((server) => server.name),
      };
    },
    addServer: async (config: McpSessionServerConfig) => {
      const daemonConfig: SessionMcpServerConfig = {
        name: config.name,
        ...(config.transport !== undefined
          ? { transport: config.transport }
          : {}),
        ...(config.command !== undefined ? { command: config.command } : {}),
        ...(config.args !== undefined ? { args: [...config.args] } : {}),
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
        ...(config.required !== undefined ? { required: config.required } : {}),
      };
      const remote = await client.request("session.mcp.addServer", {
        sessionId,
        config: daemonConfig,
      } satisfies SessionMcpAddServerParams);
      await refreshAfterMutation();
      return mutationResult(remote);
    },
    reconnectServer: async (name: string) => {
      const remote = await client.request("session.mcp.reconnectServer", {
        sessionId,
        serverName: name,
      } satisfies SessionMcpServerByNameParams);
      await refreshAfterMutation();
      return mutationResult(remote);
    },
    enableServer: async (name: string) => {
      const remote = await client.request("session.mcp.enableServer", {
        sessionId,
        serverName: name,
      } satisfies SessionMcpServerByNameParams);
      await refreshAfterMutation();
      return mutationResult(remote);
    },
    disableServer: async (name: string) => {
      const remote = await client.request("session.mcp.disableServer", {
        sessionId,
        serverName: name,
      } satisfies SessionMcpServerByNameParams);
      await refreshAfterMutation();
      return mutationResult(remote);
    },
    getTools: () => snapshot.tools,
    getToolsByServer: (name) =>
      snapshot.tools.filter((tool) => tool.serverName === name),
    getConfiguredServers: () =>
      snapshot.servers.map((server): McpSessionServerConfig => ({
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        required: server.required,
        ...(server.displayTarget !== undefined && server.transport === "stdio"
          ? { command: server.displayTarget }
          : server.displayTarget !== undefined
            ? { endpoint: server.displayTarget }
            : {}),
      })),
    getConnectionState: (name) => {
      const state = snapshot.servers.find((server) => server.name === name);
      if (state === undefined || state.state === "disconnected") return undefined;
      return state.state === "failed"
        ? { type: "failed" as const }
        : { type: state.state };
    },
    isConnected: (name) =>
      snapshot.servers.some(
        (server) => server.name === name && server.state === "connected",
      ),
    resolveMcpToolInfo: (toolName) => {
      const tool = snapshot.tools.find((candidate) => candidate.name === toolName);
      return tool === undefined
        ? undefined
        : { serverName: tool.serverName, toolName: tool.name };
    },
    getServerForTool: (toolName) =>
      snapshot.tools.find((candidate) => candidate.name === toolName)?.serverName,
    getConnectedServers: () =>
      snapshot.servers
        .filter((server) => server.state === "connected")
        .map((server) => server.name),
    mcpSurfaceSnapshot: () => snapshot,
    subscribeMcpSurfaceInvalidations: (listener) => {
      const wrapped = (next: McpSurfaceSnapshot): void =>
        listener(next.revision);
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
  };

  return {
    manager,
    snapshot: () => snapshot,
    refresh,
    invalidate: (revision) => {
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      if (revision <= acceptedRevision) return;
      void refresh(revision).catch((error: unknown) => {
        logForDebugging(
          `Daemon MCP invalidation refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { level: "warn" },
        );
      });
    },
    noteConnectionState: (state) => {
      const connected = state.status === "connected";
      if (connected && !wasConnected) {
        connectionEpoch += 1;
        acceptedRevision = -1;
        hasAcceptedSnapshot = false;
        requestedRevision = -1;
        refreshTask = null;
        void refresh().catch((error: unknown) => {
          logForDebugging(
            `Daemon MCP projection refresh failed after reconnect: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { level: "warn" },
          );
        });
      }
      wasConnected = connected;
    },
    noteConnectionObservationGap: () => {
      wasConnected = false;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasSubscribers: () => listeners.size > 0,
  };
}

function queuedInputBlocks(input: unknown): MessageContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (!isJsonObject(input)) return [];
  return messageContentBlocks(input.content);
}

function queuedInputBlocksBytes(
  blocks: readonly MessageContentBlock[],
): number {
  try {
    return Buffer.byteLength(JSON.stringify(blocks), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function messageContentBlocks(
  content: JsonValue | undefined,
): MessageContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): MessageContentBlock[] => {
    if (!isJsonObject(part) || typeof part.type !== "string") return [];
    if (part.type === "text") {
      return typeof part.text === "string"
        ? [{ type: "text", text: part.text }]
        : [];
    }
    if (part.type === "image_url") {
      const image = part.image_url;
      if (isJsonObject(image) && typeof image.url === "string") {
        return [{ type: "image_url", image_url: { url: image.url } }];
      }
    }
    return [];
  });
}

interface CanonicalRuntimeSettingsEvent {
  readonly eventId: string;
  readonly previousSettingsEventId: string | null;
  readonly settings: RunRuntimeSettingsSnapshot;
}

interface RuntimeSettingsReconciler {
  acceptInitial(event: JsonObject, deliver: () => void): void;
  acceptLive(event: JsonObject, deliver: () => void): void;
  finishInitialReplay(): void;
  noteConnectionState(state: AgenCDaemonConnectionState): void;
  barrier(): Promise<void>;
  waitFor(eventId: string): Promise<void>;
}

function canonicalRuntimeSettingsEvent(
  event: JsonObject,
): CanonicalRuntimeSettingsEvent | null {
  if (event.type === "runtime_settings_authority_gap") {
    throw new Error(
      "daemon runtime-settings pre-subscribe buffer overflowed; re-attach is required",
    );
  }
  if (event.type !== "run_runtime_settings_changed") return null;
  const payload = event.payload;
  const eventId =
    typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : typeof event.id === "string" && event.id.length > 0
        ? event.id
        : undefined;
  if (
    eventId === undefined ||
    !isJsonObject(payload) ||
    (payload.previousSettingsEventId !== null &&
      typeof payload.previousSettingsEventId !== "string")
  ) {
    throw new Error("daemon runtime-settings event has no canonical cursor");
  }
  return {
    eventId,
    previousSettingsEventId: payload.previousSettingsEventId,
    settings: {
      permissionMode: payload.permissionMode,
      prePlanMode: payload.prePlanMode,
      autoModeActive: payload.autoModeActive,
      autoModeAvailable: payload.autoModeAvailable,
      bypassPermissionsModeAvailable: payload.bypassPermissionsModeAvailable,
      bypassPermissionsWorkspace: payload.bypassPermissionsWorkspace,
      bypassPermissionsConsentWorkspace:
        payload.bypassPermissionsConsentWorkspace,
      model: payload.model,
      provider: payload.provider,
      profile: payload.profile,
      reasoningEffort: payload.reasoningEffort,
      modelVerbosity: payload.modelVerbosity,
      serviceTier: payload.serviceTier,
      hooksDisabled: payload.hooksDisabled,
    } as RunRuntimeSettingsSnapshot,
  };
}

function createRuntimeSettingsReconciler(params: {
  readonly baseSession: AgenCTuiBridgeSession;
  readonly cursor: { readonly eventId: string; readonly cwd: string };
  readonly onFailure: (error: Error) => void;
}): RuntimeSettingsReconciler {
  let cursor = params.cursor.eventId;
  let failure: Error | null = null;
  let observedConnectionGap = false;
  let queue: Promise<void> = Promise.resolve();
  let pendingWork = 0;
  const appliedEventIds = new Set<string>([cursor]);
  const waiters = new Map<
    string,
    Set<{
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    }>
  >();
  const initial: Array<{
    readonly event: CanonicalRuntimeSettingsEvent | null;
    readonly deliver: () => void;
  }> = [];

  const fail = (error: unknown): void => {
    if (failure !== null) return;
    failure =
      error instanceof Error
        ? error
        : new Error(
             `daemon runtime-settings reconciliation failed: ${String(error)}`,
           );
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(failure);
    }
    waiters.clear();
    params.onFailure(failure);
  };
  const markApplied = (eventId: string): void => {
    appliedEventIds.add(eventId);
    const pending = waiters.get(eventId);
    if (pending === undefined) return;
    waiters.delete(eventId);
    for (const waiter of pending) waiter.resolve();
  };
  const enqueue = (work: () => Promise<void> | void): void => {
    pendingWork += 1;
    queue = queue
      .then(work)
      .catch(fail)
      .finally(() => {
        pendingWork -= 1;
      });
  };
  const applySuccessor = async (entry: {
    readonly event: CanonicalRuntimeSettingsEvent | null;
    readonly deliver: () => void;
  }): Promise<void> => {
    if (failure !== null) return;
    if (entry.event === null) {
      entry.deliver();
      return;
    }
    if (entry.event.eventId === cursor) {
      markApplied(entry.event.eventId);
      entry.deliver();
      return;
    }
    if (entry.event.previousSettingsEventId !== cursor) {
      throw new Error(
        `daemon runtime-settings cursor gap: expected successor of ${cursor}, received ${entry.event.eventId}`,
      );
    }
    await applyDaemonTuiRuntimeSettingsAuthority(
      params.baseSession as unknown as AgenCDaemonOnlyTuiSession,
      params.cursor.cwd,
      entry.event.settings,
    );
    cursor = entry.event.eventId;
    markApplied(entry.event.eventId);
    entry.deliver();
  };
  const parse = (
    event: JsonObject,
    deliver: () => void,
  ): {
    readonly event: CanonicalRuntimeSettingsEvent | null;
    readonly deliver: () => void;
  } | null => {
    try {
      const parsed = canonicalRuntimeSettingsEvent(event);
      return { event: parsed, deliver };
    } catch (error) {
      fail(error);
      return null;
    }
  };

  return {
    acceptInitial: (event, deliver) => {
      const entry = parse(event, deliver);
      if (entry !== null) initial.push(entry);
    },
    acceptLive: (event, deliver) => {
      const entry = parse(event, deliver);
      if (entry === null) return;
      if (entry.event === null && pendingWork === 0 && failure === null) {
        entry.deliver();
        return;
      }
      enqueue(() => applySuccessor(entry));
    },
    finishInitialReplay: () => {
      if (initial.length === 0 || failure !== null) return;
      enqueue(async () => {
        if (failure !== null) return;
        const baselineIndex = initial.findIndex(
          (entry) => entry.event?.eventId === cursor,
        );
        const successorIndex = initial.findIndex(
          (entry) => entry.event?.previousSettingsEventId === cursor,
        );
        const startIndex = baselineIndex >= 0 ? baselineIndex : successorIndex;
        if (startIndex < 0) {
          const containsSettings = initial.some((entry) => entry.event !== null);
          if (containsSettings) {
            throw new Error(
              `daemon runtime-settings replay does not join snapshot cursor ${cursor}`,
            );
          }
          for (const entry of initial) await applySuccessor(entry);
          initial.length = 0;
          return;
        }
        for (let index = 0; index < startIndex; index += 1) {
          initial[index]!.deliver();
        }
        for (let index = startIndex; index < initial.length; index += 1) {
          await applySuccessor(initial[index]!);
        }
        initial.length = 0;
      });
    },
    noteConnectionState: (state) => {
      if (state.status !== "connected") {
        observedConnectionGap = true;
        if (waiters.size > 0) {
          fail(
            new Error(
              "daemon disconnected before the canonical runtime-settings successor arrived; re-attach is required",
            ),
          );
        }
        return;
      }
      if (observedConnectionGap) {
        fail(
          new Error(
            "daemon reconnected without an authoritative runtime-settings snapshot; re-attach is required",
          ),
        );
      }
    },
    barrier: async () => {
      await queue;
      if (failure !== null) throw failure;
    },
    waitFor: async (eventId) => {
      if (eventId.length === 0) {
        throw new Error("runtime-settings event id must be non-empty");
      }
      if (failure !== null) throw failure;
      if (appliedEventIds.has(eventId)) return;
      if (observedConnectionGap) {
        fail(
          new Error(
            "daemon connection changed before the canonical runtime-settings successor arrived; re-attach is required",
          ),
        );
        if (failure !== null) throw failure;
      }
      let resolveWaiter!: () => void;
      let rejectWaiter!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolveWaiter = resolve;
        rejectWaiter = reject;
      });
      const waiter = {
        resolve: resolveWaiter,
        reject: rejectWaiter,
      };
      const pending = waiters.get(eventId) ?? new Set();
      pending.add(waiter);
      waiters.set(eventId, pending);
      if (failure !== null) {
        pending.delete(waiter);
        if (pending.size === 0) waiters.delete(eventId);
        throw failure;
      }
      await promise;
    },
  };
}

function subscribeToDaemonEvents(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  realtimeThreadId: string,
  session: AgenCTuiBridgeSession,
  realtime: AgenCRealtimeTuiControls,
  mcpProjection: DaemonMcpProjection,
  cb: (event: unknown) => void,
  runtimeSettingsReconciler?: RuntimeSettingsReconciler,
): () => void {
  let replayingInitialEvents = true;
  const deliver = (event: JsonObject): void => {
    cb(event);
    void maybeBridgeDaemonApproval(
      client,
      sessionId,
      session,
      event,
      cb,
    );
    void maybeBridgeDaemonElicitation(
      client,
      sessionId,
      session,
      event,
      cb,
    );
  };
  const unsubscribeSession = client.subscribeToSessionEvents(
    sessionId,
    (event) => {
      if (
        event.method === "event.mcp_status_changed" &&
        isJsonObject(event.params) &&
        event.params.sessionId === sessionId &&
        typeof event.params.revision === "number"
      ) {
        mcpProjection.invalidate(event.params.revision);
        return;
      }
      const transcriptEvent = toTranscriptEvent(event);
      if (runtimeSettingsReconciler === undefined) {
        deliver(transcriptEvent);
      } else if (replayingInitialEvents) {
        runtimeSettingsReconciler.acceptInitial(transcriptEvent, () =>
          deliver(transcriptEvent),
        );
      } else {
        runtimeSettingsReconciler.acceptLive(transcriptEvent, () =>
          deliver(transcriptEvent),
        );
      }
    },
  );
  replayingInitialEvents = false;
  runtimeSettingsReconciler?.finishInitialReplay();
  const unsubscribeRealtime = client.subscribeToNotifications?.((event) => {
    const transcriptEvent = toRealtimeTranscriptEvent(event, realtimeThreadId);
    if (transcriptEvent === null) return;
    realtime.handleTranscriptEvent(transcriptEvent);
    cb(transcriptEvent);
  });
  const unsubscribeConnection = client.subscribeToConnectionState?.((state) => {
    runtimeSettingsReconciler?.noteConnectionState(state);
    mcpProjection.noteConnectionState(state);
    for (const event of connectionNoticeEvents(state)) {
      cb(event);
    }
  });
  return () => {
    unsubscribeSession();
    unsubscribeRealtime?.();
    unsubscribeConnection?.();
  };
}

/**
 * Surface a failed delivery RPC to the user as a warning notice.
 *
 * The approve/deny/elicitation decision the user made could not be delivered
 * to the daemon (e.g. a transient/disconnected socket). Without surfacing it,
 * the tool call hangs forever with no feedback. Mirror the connection-notice
 * shape so the TUI renders it like other daemon warnings.
 */
function emitDaemonDeliveryFailureNotice(
  cb: (event: unknown) => void,
  requestId: string,
  action: string,
  error: unknown,
): void {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
  cb({
    id: `agenc-daemon-delivery-failed-${requestId}`,
    type: "warning",
    payload: {
      message: `failed to deliver ${action} to daemon: ${message}`,
      cause: "daemon_delivery_failed",
      action,
      requestId,
    },
  });
}

async function maybeBridgeDaemonApproval(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  session: AgenCTuiBridgeSession,
  event: unknown,
  cb: (event: unknown) => void,
): Promise<void> {
  if (!isJsonObject(event) || event.type !== "request_permissions") return;
  const payload = event.payload;
  if (!isJsonObject(payload) || typeof payload.callId !== "string") return;
  const resolver = session.services.approvalResolver;
  if (resolver === undefined) return;
  const toolName =
    typeof payload.toolName === "string" ? payload.toolName : "tool";
  const decision = await resolver
    .request(buildDaemonApprovalCtx(session, payload, toolName))
    .catch((): ReviewDecision => ({ kind: "denied" }));
  // A transient daemon RPC failure here silently drops the user's
  // approve/deny decision and the tool call hangs forever. Catch and surface
  // it so the user gets feedback instead of an indefinite hang.
  try {
    if (reviewDecisionIsAllow(decision)) {
      // Fail-safe: an interactive ExitPlanMode approval should always carry a
      // recorded choice (the overlay sets it before resolving). Only interactive
      // approvals reach this bridge — daemon-side policy auto-approvals never do.
      // So if the side-channel somehow dropped, default an ExitPlanMode allow to
      // a "revise" record, which keeps the session IN plan mode rather than
      // silently exiting it (fail-safe, not fail-open).
      const choice =
        takePlanApprovalChoice(payload.callId) ??
        (toolName === EXIT_PLAN_MODE_TOOL_NAME
          ? ({ action: "revise" } as const)
          : undefined);
      // AskUserQuestion answers ride the same approval: the picker recorded
      // the merged input client-side via recordAskUserQuestionUpdatedInput —
      // ship it so the daemon-side tool execution finds the answers in its
      // own answeredInputs map instead of reporting "User did not provide
      // answers." after a visibly successful approval.
      const askUserQuestionInput =
        toolName === ASK_USER_QUESTION_TOOL_NAME
          ? takeAskUserQuestionUpdatedInput(payload.callId)
          : null;
      await client.request("tool.approve", {
        sessionId,
        requestId: payload.callId,
        scope: decision.kind === "approved_for_session" ? "session" : "once",
        ...(choice ? { exitPlan: choice } : {}),
        ...(askUserQuestionInput !== null
          ? {
              askUserQuestionInput:
                askUserQuestionInput as unknown as JsonObject,
            }
          : {}),
      });
      return;
    }
    await client.request("tool.deny", {
      sessionId,
      requestId: payload.callId,
      reason: decision.kind,
    });
  } catch (error) {
    emitDaemonDeliveryFailureNotice(
      cb,
      payload.callId,
      reviewDecisionIsAllow(decision) ? "tool.approve" : "tool.deny",
      error,
    );
  }
}

async function maybeBridgeDaemonElicitation(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  session: AgenCTuiBridgeSession,
  event: unknown,
  cb: (event: unknown) => void,
): Promise<void> {
  if (!isJsonObject(event) || typeof event.type !== "string") return;
  const payload = event.payload;
  if (!isJsonObject(payload)) return;
  if (
    event.type === "request_user_input" &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    const resolver = session.services.requestUserInputResolver;
    if (resolver === undefined) return;
    let response: RequestUserInputResponse | null;
    try {
      response = await resolver.request({
        requestId:
          typeof payload.requestId === "string"
            ? payload.requestId
            : payload.callId,
        callId: payload.callId,
        turnId: payload.turnId,
        questions: jsonObjectArray(
          payload.questions,
        ) as unknown as RequestUserInputEvent["questions"],
        ...(isJsonObject(payload.clientAction)
          ? {
              clientAction: payload.clientAction as unknown as NonNullable<
                RequestUserInputEvent["clientAction"]
              >,
            }
          : {}),
      });
    } catch {
      response = null;
    }
    const requestId =
      typeof payload.requestId === "string"
        ? payload.requestId
        : payload.callId;
    try {
      await client.request("elicitation.respond", {
        sessionId,
        requestId,
        kind: "request_user_input",
        response: (response ?? { action: "cancel" }) as unknown as JsonObject,
      } satisfies ElicitationRespondParams);
    } catch (error) {
      emitDaemonDeliveryFailureNotice(
        cb,
        requestId,
        "elicitation.respond",
        error,
      );
    }
    return;
  }
  if (
    event.type === "mcp_elicitation_request" &&
    typeof payload.serverName === "string" &&
    (typeof payload.requestId === "string" ||
      typeof payload.requestId === "number") &&
    typeof payload.turnId === "string" &&
    isJsonObject(payload.request)
  ) {
    const resolver = session.services.mcpElicitationResolver;
    if (resolver === undefined) return;
    const response = await resolver
      .request({
        serverName: payload.serverName,
        requestId: payload.requestId,
        turnId: payload.turnId,
        request:
          payload.request as unknown as McpElicitationRequestEvent["request"],
      })
      .catch((): McpElicitationResponse => ({ action: "cancel" }));
    if (isMcpUrlCompletionResponse(response)) return;
    try {
      await client.request("elicitation.respond", {
        sessionId,
        requestId: payload.requestId,
        kind: "mcp",
        serverName: payload.serverName,
        response: (response ?? { action: "cancel" }) as unknown as JsonObject,
      } satisfies ElicitationRespondParams);
    } catch (error) {
      emitDaemonDeliveryFailureNotice(
        cb,
        String(payload.requestId),
        "elicitation.respond",
        error,
      );
    }
  }
}

function buildDaemonApprovalCtx(
  session: AgenCTuiBridgeSession,
  payload: JsonObject,
  toolName: string,
): ApprovalCtx {
  const callId = payload.callId as string;
  const input = isJsonObject(payload.input) ? payload.input : {};
  return {
    invocation: {
      session,
      turn: {
        subId: typeof payload.turnId === "string" ? payload.turnId : callId,
      },
      tracker: {
        appendFileDiff() {},
        snapshot: () => [],
        clear() {},
      },
      callId,
      toolName: { name: toolName },
      payload: {
        kind: "function",
        arguments: JSON.stringify(input),
      },
      source: "direct",
    } as unknown as ApprovalCtx["invocation"],
    callId,
    toolName,
    turnId: typeof payload.turnId === "string" ? payload.turnId : callId,
    ...(typeof payload.reason === "string"
      ? { retryReason: payload.reason }
      : {}),
    ...(typeof payload.planContent === "string"
      ? { planContent: payload.planContent }
      : {}),
    ...(typeof payload.planFilePath === "string"
      ? { planFilePath: payload.planFilePath }
      : {}),
  };
}

function baseInitialTranscriptEvents(
  session: AgenCTuiBridgeSession,
): readonly unknown[] {
  return [
    ...((session.getInitialTranscriptEvents?.() ??
      session.initialTranscriptEvents ??
      []) as readonly unknown[]),
  ];
}

function toTranscriptEvent(event: JsonObject): JsonObject {
  const msg = event.msg;
  if (isJsonObject(msg)) {
    return msg;
  }
  const method = event.method;
  const params = event.params;
  if (typeof method !== "string" || !isJsonObject(params)) {
    return event;
  }
  if (method === "event.message_chunk" && typeof params.delta === "string") {
    return {
      id: daemonTranscriptEventId(params, "message-delta"),
      type: "agent_message_delta",
      payload: { delta: params.delta },
    };
  }
  if (
    method === "event.tool_request" &&
    typeof params.requestId === "string" &&
    typeof params.toolName === "string"
  ) {
    return {
      id: daemonTranscriptEventId(params, `tool-request:${params.requestId}`),
      type: "tool_call_started",
      payload: {
        callId: params.requestId,
        toolName: params.toolName,
        args: JSON.stringify(params.input ?? {}),
      },
    };
  }
  if (
    method === "event.permission_request" &&
    typeof params.requestId === "string"
  ) {
    return {
      id: daemonTranscriptEventId(
        params,
        `permission-request:${params.requestId}`,
      ),
      type: "request_permissions",
      payload: {
        callId: params.requestId,
        ...(typeof params.toolName === "string"
          ? { toolName: params.toolName }
          : {}),
        ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
        permissions: Array.isArray(params.permissions)
          ? params.permissions.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        ...(params.input !== undefined ? { input: params.input } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        ...(typeof params.planContent === "string"
          ? { planContent: params.planContent }
          : {}),
        ...(typeof params.planFilePath === "string"
          ? { planFilePath: params.planFilePath }
          : {}),
      },
    };
  }
  if (
    method === "event.user_input_request" &&
    typeof params.requestId === "string" &&
    typeof params.callId === "string" &&
    typeof params.turnId === "string" &&
    Array.isArray(params.questions)
  ) {
    return {
      id: daemonTranscriptEventId(
        params,
        `user-input-request:${params.requestId}`,
      ),
      type: "request_user_input",
      payload: {
        requestId: params.requestId,
        callId: params.callId,
        turnId: params.turnId,
        questions: jsonObjectArray(params.questions),
        ...(isJsonObject(params.clientAction)
          ? { clientAction: params.clientAction }
          : {}),
      },
    };
  }
  if (
    method === "event.mcp_elicitation_request" &&
    (typeof params.requestId === "string" ||
      typeof params.requestId === "number") &&
    typeof params.serverName === "string" &&
    typeof params.turnId === "string" &&
    isJsonObject(params.request)
  ) {
    return {
      id: daemonTranscriptEventId(
        params,
        `mcp-elicitation:${String(params.requestId)}`,
      ),
      type: "mcp_elicitation_request",
      payload: {
        requestId: params.requestId,
        serverName: params.serverName,
        turnId: params.turnId,
        request: params.request,
      },
    };
  }
  if (method === "event.agent_status") {
    return transcriptEventFromAgentStatus(params);
  }
  if (method === "event.session_event" && isJsonObject(params.event)) {
    return {
      ...params.event,
      ...(typeof params.eventId === "string" && params.eventId.length > 0
        ? { eventId: params.eventId }
        : {}),
      id: daemonTranscriptEventId(
        params,
        typeof params.event.id === "string" ? params.event.id : "session-event",
      ),
    };
  }
  return event;
}

function toRealtimeTranscriptEvent(
  event: JsonObject,
  realtimeThreadId: string,
): JsonObject | null {
  const method = event.method;
  const params = event.params;
  if (typeof method !== "string" || !isJsonObject(params)) return null;
  if (!method.startsWith("thread/realtime/")) return null;
  if (params.threadId !== realtimeThreadId) return null;
  const id = stringParam(
    params.eventId,
    nextRealtimeEventId(method, params.threadId),
  );
  switch (method) {
    case "thread/realtime/started":
      return {
        id,
        type: "realtime_started",
        payload: {
          threadId: params.threadId,
          realtimeSessionId:
            typeof params.realtimeSessionId === "string"
              ? params.realtimeSessionId
              : null,
          ...(typeof params.version === "string"
            ? { version: params.version }
            : {}),
        },
      };
    case "thread/realtime/itemAdded":
      return {
        id,
        type: "realtime_item_added",
        payload: {
          threadId: params.threadId,
          item: params.item ?? null,
        },
      };
    case "thread/realtime/transcript/delta":
      return {
        id,
        type: "realtime_transcript_delta",
        payload: {
          threadId: params.threadId,
          role: typeof params.role === "string" ? params.role : "assistant",
          delta: typeof params.delta === "string" ? params.delta : "",
        },
      };
    case "thread/realtime/transcript/done":
      return {
        id,
        type: "realtime_transcript_done",
        payload: {
          threadId: params.threadId,
          role: typeof params.role === "string" ? params.role : "assistant",
          text: typeof params.text === "string" ? params.text : "",
        },
      };
    case "thread/realtime/outputAudio/delta":
      return {
        id,
        type: "realtime_output_audio_delta",
        payload: {
          threadId: params.threadId,
          audio: params.audio,
        },
      };
    case "thread/realtime/sdp":
      return {
        id,
        type: "realtime_sdp",
        payload: {
          threadId: params.threadId,
          sdp: typeof params.sdp === "string" ? params.sdp : "",
        },
      };
    case "thread/realtime/error":
      return {
        id,
        type: "realtime_error",
        payload: {
          threadId: params.threadId,
          message:
            typeof params.message === "string"
              ? params.message
              : "Realtime error",
        },
      };
    case "thread/realtime/closed":
      return {
        id,
        type: "realtime_closed",
        payload: {
          threadId: params.threadId,
          reason: typeof params.reason === "string" ? params.reason : null,
        },
      };
    default:
      return null;
  }
}

function nextRealtimeEventId(
  method: string,
  threadId: JsonValue | undefined,
): string {
  nextRealtimeTranscriptEventSequence += 1;
  return `realtime:${method}:${String(threadId ?? "thread")}:${nextRealtimeTranscriptEventSequence}`;
}

function transcriptEventFromAgentStatus(params: JsonObject): JsonObject {
  const status = params.status;
  const turnId = stringParam(
    params.turnId,
    stringParam(params.eventId, "status"),
  );
  if (status === "error") {
    return {
      id: daemonTranscriptEventId(params, turnId),
      type: "error",
      payload: {
        turnId,
        message:
          typeof params.message === "string" ? params.message : "agent error",
        terminal: true,
        terminalSource: "agent_status",
        ...(typeof params.runStatus === "string"
          ? { runStatus: params.runStatus }
          : {}),
      },
    };
  }
  return {
    id: daemonTranscriptEventId(params, turnId),
    type: "background_agent_status",
    payload: {
      turnId,
      status,
      ...(typeof params.agentId === "string" && params.agentId.length > 0
        ? { agentId: params.agentId }
        : {}),
      ...(typeof params.runStatus === "string" && params.runStatus.length > 0
        ? { runStatus: params.runStatus }
        : {}),
      ...(typeof params.message === "string"
        ? { message: params.message }
        : {}),
    },
  };
}

function daemonTranscriptEventId(params: JsonObject, fallback: string): string {
  const eventId = stringParam(params.eventId, fallback);
  const agentId = params.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) return eventId;
  return `daemon:${encodeURIComponent(agentId)}:${encodeURIComponent(eventId)}`;
}

function stringParam(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function jsonObjectArray(value: readonly unknown[]): JsonObject[] {
  return value.filter(isJsonObject);
}

function connectionNoticeEvents(
  state: AgenCDaemonConnectionState | null,
): readonly JsonObject[] {
  if (state === null || state.status === "connected") return [];
  return [
    {
      id: state.id ?? `agenc-daemon-${state.status}`,
      type: "warning",
      payload: {
        message: state.message ?? AGENC_DAEMON_RECONNECTING_MESSAGE,
        cause: "daemon_connection_state",
        status: state.status,
      },
    },
  ];
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}
