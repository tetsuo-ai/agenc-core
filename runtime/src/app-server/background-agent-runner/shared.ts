/**
 * Shared types and small helpers for the daemon background-agent runner.
 * Split out of background-agent-runner.ts as a pure move.
 */

import { createHash } from "node:crypto";
import type {
  BootstrapLocalRuntimeSessionOptions,
  LocalRuntimeBootstrap,
} from "../../bin/bootstrap.js";
import { ensureAgentControl } from "../../bin/delegate-tool.js";
import type { AgentControl } from "../../agents/control.js";
import type { ManagedThread } from "../../agents/thread-manager.js";
import { runAgent } from "../../agents/run-agent.js";
import type { AuthBackend } from "../../auth/backend.js";
import type { LLMMessage } from "../../llm/types.js";
import type { ToolRecoveryCategory } from "../../tools/types.js";
import { stableStringify } from "../../utils/stableStringify.js";
import type {
  ResolveDurableEffectReviewOptions,
  ResolveDurableEffectReviewResult,
} from "../../state/effect-review.js";
import type { ReviewDecision } from "../../permissions/review-decision.js";
import type {
  McpServerMutationResult,
  McpSurfaceSnapshot,
} from "../../session/session.js";
import type { Event } from "../../session/event-log.js";
import type {
  SessionEditorInteraction,
  SessionSubmitOptions,
} from "../../session/autonomous-mode.js";
import type {
  CodePredictionSource,
} from "../../services/code-prediction/types.js";
import type {
  SessionElicitationResponseParams,
} from "../../elicitation/respond.js";
import type {
  AgentStatus as DaemonAgentStatus,
  JsonObject,
  JsonValue,
  MessageContent,
  PermissionListResult,
  SessionMcpServerConfig,
  SessionPartialCompactFromMessageParams,
  SessionPartialCompactFromMessageResult,
  SessionRollbackCompactionResult,
  SessionExtendCompactionRollbackRetentionResult,
  SessionRewindConversationToMessageResult,
  SessionPreviewFileRewindResult,
  SessionRewindFilesToMessageResult,
  SessionSnapshotResult,
  SessionTranscriptResult,
  SessionTranscriptV2Result,
  SessionHookConfigShape,
  SessionHookValidationIssueShape,
  SessionHookRunDiagnosticShape,
  SessionPermissionRuleMutationParams,
  SessionPermissionRuleMutationResult,
  SessionShellExecuteParams,
  SessionShellExecuteResult,
} from "../protocol/index.js";
import type { AgenCRealtimeThreadBinding } from "../realtime.js";
import type { AgenCRealtimeCallClient } from "../realtime-transport.js";
import type {
  RealtimeTransportConnection,
  RealtimeTransportRequest,
} from "../../conversation/realtime/conversation.js";
import { isRecord } from "../../utils/record.js";
import type {
  ExecutionAdmissionKernel,
} from "../../budget/execution-admission-kernel.js";
import type {
  CsvAgentJobsRepositoryProvider,
} from "../csv-agent-jobs-authority.js";
import type {
  RunResumeReason,
  RunRuntimeSettingsSnapshot,
  RunTerminalResult,
} from "../../contracts/run-contracts.js";
import type {
  ResumeRolloutDescriptorLease,
} from "../../session/session-store.js";
import type { AgentRuntimeOptions } from "../../session/runtime-options.js";

export interface AgenCBackgroundAgentStartParams {
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly initialContent?: MessageContent;
  readonly deferInitialTurn?: boolean;
  readonly initialDisplayUserMessage?: string | null;
  readonly initialEditorInteraction?: SessionEditorInteraction;
  readonly metadata?: JsonObject;
  readonly unattendedAllow: readonly string[];
  readonly unattendedDeny: readonly string[];
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
  readonly runtimeOptions: AgentRuntimeOptions;
  /**
   * Per-invocation env overrides forwarded from the CLI. Merged on
   * top of `this.#env` so the user's latest `OPENAI_BASE_URL` /
   * proxy / API key for THIS agent invocation wins over the frozen
   * env snapshot captured when the daemon was launched.
   */
  readonly envOverrides?: { readonly [key: string]: string };
}

export interface AgenCBackgroundAgentStartResult {
  readonly agentId: string;
  readonly agentPath?: string;
  /** Internal pre-publication rollback token; never serialized to clients. */
  readonly restoreAttemptId?: string;
  readonly startedAt: string;
  readonly status: "running";
  readonly rolloutPath?: string;
  readonly rolloutDev?: string;
  readonly rolloutIno?: string;
}

export interface AgenCBackgroundAgentRestoreParams {
  readonly agentId: string;
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
  readonly runtimeOptions: AgentRuntimeOptions;
  /** Exact canonical rollout selected by the trusted CLI resolver. */
  readonly resumeRolloutPath?: string;
  /** One-shot daemon descriptor authority transferred into SessionStore. */
  readonly resumeRolloutLease?: ResumeRolloutDescriptorLease;
  /** Server-observed workspace identity, reproved inside bootstrap. */
  readonly resumeCwdIdentity?: { readonly dev: string; readonly ino: string };
  /** Daemon-held directory descriptor pinned across bootstrap acquisition. */
  readonly resumeCwdFd?: number;
  readonly envOverrides?: { readonly [key: string]: string };
  /** User-requested continuation of a cleanly terminal canonical run. */
  readonly reopenTerminalRun?: boolean;
  /** Resume a daemon-suspended canonical run without changing its epoch. */
  readonly resumeSuspendedRun?: boolean;
  /** Internal suspension disposition; never inferred from caller prose. */
  readonly suspendedResumeReason?: RunResumeReason;
  /** Canonical open run still awaiting its durable first-input activation. */
  readonly resumeStartupActivationPending?: boolean;
  /** Complete canonical overlay restored before this generation accepts ingress. */
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  /** Exact-generation cleanup barrier for a user-selected disk continuation. */
  readonly explicitColdResume?: boolean;
  /** Opaque caller-owned generation token for pre-publication rollback only. */
  readonly restoreAttemptId?: string;
  readonly startedAt?: string;
  readonly currentSessionId?: string;
  readonly initialMessages?: ReadonlyArray<LLMMessage>;
  readonly replayToolCalls?: readonly AgenCBackgroundAgentReplayToolCall[];
  readonly onReplayToolResult?: (
    result: AgenCBackgroundAgentReplayToolResult,
  ) => void | Promise<void>;
  readonly metadata?: JsonObject;
}

export interface AgenCBackgroundAgentReplayToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
}

export interface AgenCBackgroundAgentReplayToolResult {
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly result: string;
  readonly isError: boolean;
  readonly terminalStatus?: "completed" | "failed" | "poisoned";
  readonly recoveryCategory?: ToolRecoveryCategory;
}

export interface AgenCBackgroundAgentSnapshot {
  readonly status: DaemonAgentStatus;
  readonly lastActiveAt: string;
  readonly metadata?: JsonObject;
  /** Live daemon-owned session authority, captured after its durable commit. */
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  /** Canonical cursor for strict successor reconciliation on attached clients. */
  readonly runtimeSettingsEventId?: string;
  /** Present only after the canonical run_terminal event was fsync-committed. */
  readonly terminal?: AgenCBackgroundAgentTerminalSnapshot;
  /** Present only after the canonical run_suspended event was fsync-committed. */
  readonly suspension?: AgenCBackgroundAgentSuspensionSnapshot;
}

export interface AgenCBackgroundAgentTerminalSnapshot {
  readonly openedAt: string;
  readonly epoch: number;
  readonly eventId: string;
  readonly rolloutPath: string;
  readonly result: RunTerminalResult;
}

export interface AgenCBackgroundAgentSuspensionSnapshot {
  readonly openedAt: string;
  readonly epoch: number;
  readonly eventId: string;
  readonly sequence: number;
  readonly rolloutPath: string;
  readonly reason: "daemon_shutdown_idle";
  readonly suspendedAt: string;
}

export type AgenCBackgroundAgentDaemonShutdownResult =
  | {
      readonly disposition: "suspended";
      readonly suspension: AgenCBackgroundAgentSuspensionSnapshot;
    }
  | {
      readonly disposition: "cancelled";
      readonly terminal?: AgenCBackgroundAgentTerminalSnapshot;
    };

/**
 * The canonical suspension committed, but local daemon runtime teardown did
 * not complete cleanly. Callers must preserve the suspended projection while
 * still treating daemon cleanup as failed.
 */
export class AgenCBackgroundAgentSuspensionShutdownError extends Error {
  override readonly name = "AgenCBackgroundAgentSuspensionShutdownError";

  constructor(
    readonly suspension: AgenCBackgroundAgentSuspensionSnapshot,
    cause: unknown,
  ) {
    super(
      `run suspension ${suspension.eventId} committed but daemon runtime shutdown failed`,
      { cause },
    );
  }
}

export interface AgenCBackgroundAgentCancellationPreparation {
  readonly affectedRunIds: readonly string[];
  readonly voidedHolds: number;
  readonly heldUnknownHolds: number;
}

export interface AgenCBackgroundAgentTurnCancellationResult {
  readonly cancelled: boolean;
  readonly activeTurnId?: string;
  readonly stale?: boolean;
}

export interface AgenCBackgroundAgentSessionEventBinding {
  readonly sessionId: string;
  readonly emit: (event: JsonObject) => void | Promise<void>;
}

export interface AgenCBackgroundAgentMessageParams {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly originalContent: MessageContent;
  readonly displayUserMessage?: string | null;
  readonly editorInteraction?: SessionEditorInteraction;
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
  readonly ifBusy?: "reject";
}

export interface AgenCBackgroundAgentMessageResult {
  readonly disposition: "started" | "duplicate";
  readonly acceptedAt: string;
  readonly duplicateState?: "completed" | "incomplete";
  readonly turnId?: string;
  readonly terminal?: AgenCBackgroundAgentMessageTerminal;
}

export interface AgenCBackgroundAgentMessageTerminal extends JsonObject {
  readonly code: 0 | 1 | 130;
  readonly message?: string;
}

export type AgenCBackgroundAgentMessageErrorCode =
  "TURN_IN_PROGRESS" | "CLIENT_MESSAGE_ID_CONFLICT" | "PROMPT_BLOCKED";

export class AgenCBackgroundAgentMessageError extends Error {
  readonly code: AgenCBackgroundAgentMessageErrorCode;

  constructor(code: AgenCBackgroundAgentMessageErrorCode, message: string) {
    super(message);
    this.name = "AgenCBackgroundAgentMessageError";
    this.code = code;
  }
}

const DAEMON_USER_PROMPT_PREPARED: unique symbol = Symbol(
  "agenc.daemon-user-prompt-prepared",
);

type DaemonSessionSubmitOptions = SessionSubmitOptions & {
  readonly [DAEMON_USER_PROMPT_PREPARED]?: true;
};

export interface AgenCBackgroundAgentClearSessionParams {
  readonly sessionId: string;
  readonly clearedAt: string;
}

export interface AgenCBackgroundAgentSnapshotSessionParams {
  readonly sessionId: string;
}

export interface AgenCBackgroundAgentMcpAddServerParams {
  readonly sessionId: string;
  readonly config: SessionMcpServerConfig;
}

export interface AgenCBackgroundAgentMcpServerByNameParams {
  readonly sessionId: string;
  readonly serverName: string;
}

export interface AgenCBackgroundAgentPartialCompactParams {
  readonly sessionId: string;
  readonly messageOrdinal: number;
  readonly direction: SessionPartialCompactFromMessageParams["direction"];
  readonly feedback?: string;
  readonly signal?: AbortSignal;
}

export interface AgenCBackgroundAgentRollbackCompactionParams {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly reviewedBranchTargetSessionId?: string;
}

export interface AgenCBackgroundAgentExtendCompactionRetentionParams {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly extendedUntilMs: number;
}

export interface AgenCBackgroundAgentConversationRewindParams {
  readonly sessionId: string;
  readonly messageOrdinal: number;
  /** When aborted (request.cancel), refuse mid-flight rewind work (todo-108). */
  readonly signal?: AbortSignal;
}

export interface AgenCBackgroundAgentSetModelParams {
  readonly sessionId: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface AgenCBackgroundAgentSetModelResult {
  readonly applied: boolean;
  readonly provider: string;
  readonly model: string;
  readonly runtimeSettingsEventId: string;
  readonly summary: string;
}

export interface AgenCBackgroundAgentSetPermissionModeParams {
  readonly sessionId: string;
  readonly mode: string;
  /** Bound only by an explicit allow-all decision in the tool approval flow. */
  readonly bypassAuthority?: "operator_tool_approval";
}

export interface AgenCBackgroundAgentSetPermissionModeResult {
  readonly applied: boolean;
  readonly previousMode: string;
  readonly mode: string;
  /** Internal transaction hook; never serialized by session.setPermissionMode. */
  readonly rollback?: () => Promise<void>;
}

export interface AgenCBackgroundAgentPermissionRuleMutationResult {
  readonly applied: boolean;
  readonly operation: SessionPermissionRuleMutationParams["operation"];
  readonly behavior: SessionPermissionRuleMutationParams["behavior"];
  readonly rule: string;
  readonly sessionRules: SessionPermissionRuleMutationResult["sessionRules"];
}

export interface AgenCBackgroundAgentHooksStatusResult {
  readonly available: boolean;
  readonly sourcePath: string;
  readonly disabled: boolean;
  readonly hardSuppressed: boolean;
  readonly effectiveDisabled: boolean;
  readonly suppressionReason: "bare_mode" | "session_disabled" | null;
  readonly issues: readonly SessionHookValidationIssueShape[];
  readonly hooks: readonly SessionHookConfigShape[];
  readonly diagnostics: readonly SessionHookRunDiagnosticShape[];
}

export interface AgenCBackgroundAgentSetHooksDisabledParams {
  readonly disabled: boolean;
}

export interface AgenCBackgroundAgentSetHooksDisabledResult {
  readonly applied: boolean;
  readonly disabled: boolean;
  readonly hardSuppressed: boolean;
  readonly effectiveDisabled: boolean;
  readonly suppressionReason: "bare_mode" | "session_disabled" | null;
}

export interface AgenCBackgroundAgentApplyConfigParams {
  readonly sessionId: string;
  readonly profile?: string;
  readonly reload?: boolean;
}

export interface AgenCBackgroundAgentApplyConfigResult {
  readonly applied: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeSettingsEventId?: string;
  readonly summary: string;
}

export interface AgenCBackgroundAgentToolDecisionParams {
  readonly requestId: string;
  readonly decision: ReviewDecision;
}

export interface AgenCBackgroundAgentToolCancelParams {
  readonly requestId: string;
  readonly reason?: string;
}

export type AgenCBackgroundAgentElicitationResponseParams =
  SessionElicitationResponseParams;

export interface AgenCBackgroundAgentRunner {
  startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult>;
  getAgentSnapshot?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentSnapshot | null>;
  restoreAgent?(
    params: AgenCBackgroundAgentRestoreParams,
  ): Promise<boolean> | boolean;
  /**
   * Revoke an unpublished restored generation without poisoning its canonical
   * open epoch. The opaque attempt id prevents cleanup from touching a newer
   * generation installed under the same run id.
   */
  rollbackRestoredAgent?(
    agentId: string,
    restoreAttemptId: string,
  ): Promise<void>;
  /**
   * Gate ingress and fsync cancellation/admission evidence while the Session
   * journal listener is still live. `stopAgent` then owns quiescence and the
   * terminal-tail append; the lifecycle projects legacy state afterward.
   */
  prepareAgentCancellation?(
    agentId: string,
    reason: string,
  ): Promise<AgenCBackgroundAgentCancellationPreparation>;
  stopAgent?(agentId: string, reason?: string): Promise<void>;
  /** Daemon-only shutdown disposition; caller prose cannot select suspension. */
  suspendIdleAgentForDaemonShutdown?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentDaemonShutdownResult>;
  attachAgentSessionEvents?(
    agentId: string,
    binding: AgenCBackgroundAgentSessionEventBinding,
  ): Promise<void> | void;
  submitAgentMessage?(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<AgenCBackgroundAgentMessageResult>;
  executeAgentShell?(
    agentId: string,
    params: SessionShellExecuteParams,
    signal?: AbortSignal,
  ): Promise<SessionShellExecuteResult>;
  /** Resolve the live route without exposing the primary provider to callers. */
  resolveCodePredictionSource?(
    agentId: string,
  ): Promise<CodePredictionSource> | CodePredictionSource;
  clearAgentSession?(
    agentId: string,
    params: AgenCBackgroundAgentClearSessionParams,
  ): Promise<void>;
  snapshotAgentSession?(
    agentId: string,
    params: AgenCBackgroundAgentSnapshotSessionParams,
  ): Promise<SessionSnapshotResult>;
  getAgentSessionTranscript?(
    agentId: string,
    params: { readonly sessionId: string },
  ): Promise<SessionTranscriptResult>;
  getAgentSessionTranscriptV2?(
    agentId: string,
    params: { readonly sessionId: string },
  ): Promise<SessionTranscriptV2Result>;
  resolveLiveEffectReview?(
    agentId: string,
    params: ResolveDurableEffectReviewOptions,
  ): Promise<ResolveDurableEffectReviewResult>;
  addMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpAddServerParams,
  ): Promise<McpServerMutationResult>;
  reconnectMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult>;
  enableMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult>;
  disableMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult>;
  getMcpStatus?(agentId: string): Promise<McpSurfaceSnapshot>;
  partialCompactFromMessage?(
    agentId: string,
    params: AgenCBackgroundAgentPartialCompactParams,
  ): Promise<SessionPartialCompactFromMessageResult>;
  rollbackCompaction?(
    agentId: string,
    params: AgenCBackgroundAgentRollbackCompactionParams,
  ): Promise<SessionRollbackCompactionResult>;
  extendCompactionRollbackRetention?(
    agentId: string,
    params: AgenCBackgroundAgentExtendCompactionRetentionParams,
  ): Promise<SessionExtendCompactionRollbackRetentionResult>;
  rewindConversationToMessage?(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionRewindConversationToMessageResult>;
  previewFileRewind?(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionPreviewFileRewindResult>;
  rewindFilesToMessage?(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionRewindFilesToMessageResult>;
  setAgentModel?(
    agentId: string,
    params: AgenCBackgroundAgentSetModelParams,
  ): Promise<AgenCBackgroundAgentSetModelResult>;
  setAgentPermissionMode?(
    agentId: string,
    params: AgenCBackgroundAgentSetPermissionModeParams,
  ): Promise<AgenCBackgroundAgentSetPermissionModeResult>;
  mutateAgentPermissionRule?(
    agentId: string,
    params: SessionPermissionRuleMutationParams,
  ): Promise<AgenCBackgroundAgentPermissionRuleMutationResult>;
  getAgentHooksStatus?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentHooksStatusResult>;
  setAgentHooksDisabled?(
    agentId: string,
    params: AgenCBackgroundAgentSetHooksDisabledParams,
  ): Promise<AgenCBackgroundAgentSetHooksDisabledResult>;
  applyAgentConfig?(
    agentId: string,
    params: AgenCBackgroundAgentApplyConfigParams,
  ): Promise<AgenCBackgroundAgentApplyConfigResult>;
  resolveToolDecision?(
    agentId: string,
    params: AgenCBackgroundAgentToolDecisionParams,
  ): Promise<boolean>;
  cancelTool?(
    agentId: string,
    params: AgenCBackgroundAgentToolCancelParams,
  ): Promise<boolean>;
  /**
   * Interrupt the agent's currently-running turn (if any). Resolves to
   * `true` when an active turn was found and the agent's
   * AbortController was fired; `false` when the agent was idle.
   * Implementation MUST cascade to descendants so subagent turns are
   * also stopped — see {@link AgentControl.interrupt}.
   */
  interruptAgentTurn?(agentId: string, reason: string): Promise<boolean>;
  interruptAgentTurnIfMatches?(
    agentId: string,
    reason: string,
    expectedTurnId: string,
  ): Promise<AgenCBackgroundAgentTurnCancellationResult>;
  /**
   * Register a callback invoked once per agent immediately before the
   * runner removes that agent from its `#active` registry on terminal
   * status. The callback receives the final per-agent snapshot so the
   * lifecycle layer can record the terminal-state transition before the
   * underlying snapshot becomes unobservable. Without this hook,
   * `getAgentSnapshot` returns null after cleanup and the lifecycle's
   * lazy poll never observes the transition — leaving stale `running`
   * entries in `agent.list`.
   */
  setOnActiveAgentTerminated?(
    callback: (
      agentId: string,
      snapshot: AgenCBackgroundAgentSnapshot,
    ) => void | Promise<void>,
  ): void;
  respondToElicitation?(
    agentId: string,
    params: AgenCBackgroundAgentElicitationResponseParams,
  ): Promise<boolean>;
  listPermissions?(agentId: string): Promise<PermissionListResult | null>;
  resolveRealtimeThread?(
    threadId: string,
  ):
    | AgenCRealtimeThreadBinding
    | null
    | Promise<AgenCRealtimeThreadBinding | null>;
}

export type AgenCRunAgentFunction = typeof runAgent;

export type AgenCBootstrapFunction = (
  options: BootstrapLocalRuntimeSessionOptions,
) => Promise<LocalRuntimeBootstrap>;

export type AgenCEnsureAgentControlFunction = typeof ensureAgentControl;

export type AgenCBackgroundRealtimeTransportConnector = (
  request: RealtimeTransportRequest,
) => Promise<RealtimeTransportConnection> | RealtimeTransportConnection;

interface ActiveBackgroundAgent {
  readonly bootstrap: LocalRuntimeBootstrap;
  readonly control: AgentControl;
  readonly thread: ManagedThread;
  status: DaemonAgentStatus;
  readonly startedAt: string;
  /** Opaque generation proof retained only until publication succeeds/fails. */
  readonly restoreAttemptId?: string;
  /** Current canonical lifecycle epoch, recovered from run_reopened events. */
  runEpoch: number;
  /** True once daemon delivery is sourced from the Session EventLog. */
  canonicalEventBridgeInstalled: boolean;
  /** Cached immediately after the fsync-committed run_terminal append. */
  terminal?: AgenCBackgroundAgentTerminalSnapshot;
  /** Cached immediately after the fsync-committed run_suspended append. */
  suspension?: AgenCBackgroundAgentSuspensionSnapshot;
  /** Set only by the daemon-only clean shutdown path. */
  pendingSuspension?: {
    readonly eventId: string;
    readonly reason: "daemon_shutdown_idle";
    readonly suspendedAt: string;
  };
  /** Closes every runner ingress route before idle state is observed. */
  ingressClosed?: boolean;
  /** Result selected before shutdown quiescence; committed at journal close. */
  pendingTerminal?: RunTerminalResult;
  /** Fsync-committed operator intent that precedes admission cancellation. */
  cancellationRequest?: {
    readonly eventId: string;
    readonly sequence: number;
    readonly reason: string;
    readonly requestedAt: string;
  };
  /** Resume event that must be durably activated before ordinary input. */
  pendingStartupActivationResumeEventId?: string;
  /** Captured once so append ambiguity retries preserve exact evidence. */
  pendingStartupActivationActivatedAt?: string;
  runtimeSettings?: RunRuntimeSettingsSnapshot;
  runtimeSettingsEventId?: string;
  runtimeSettingsMutationQueue: Promise<void>;
  /** Preserves a close-boundary append failure through fail-soft teardown. */
  terminalCommitError?: unknown;
  /** True when a real Session owns the before-close terminal finalizer. */
  durableTerminalFinalizerInstalled: boolean;
  unsubscribeDurableTerminalFinalizer?: () => void;
  terminationNotified?: boolean;
  lastActiveAt: string;
  unsubscribeStatus?: () => void;
  uninstallApprovalBridge?: () => void;
  uninstallRuntimeSettingsPreCommit?: () => void;
  unsubscribeElicitationEvents?: () => void;
  unsubscribePhaseEvents?: () => void;
  unsubscribeMcpSurfaceInvalidations?: () => void;
  sessionBinding?: AgenCBackgroundAgentSessionEventBinding;
  bufferedEvents: BackgroundAgentDaemonEvent[];
  activeToolCallIds: Set<string>;
  historyEpoch: string;
  messageSubmission?: ActiveMessageSubmission;
  messageSubmissionQueue: Promise<void>;
  /** Resolves only after this exact generation has relinquished #active. */
  cleanupComplete: Promise<void>;
  pendingMessageSubmissionCount: number;
  readonly messageSubmissionsById: Map<string, ActiveMessageSubmission>;
  pendingShellExecutionCount: number;
  readonly shellExecutionsById: Map<string, ActiveShellExecution>;
  /**
   * True when no initial turn was submitted at spawn (deferInitialTurn
   * spawns and restored agents). Their thread sits in pending_init until
   * the first accepted message initializes it, so pending_init must not
   * count as busy for `ifBusy: "reject"` — rejecting there deadlocks the
   * session: the message that would initialize the thread is the message
   * being refused.
   */
  /**
   * Per-agent emission serialization chain. `#emitOrBufferEvent` awaits
   * an async-locked broadcast, so two fire-and-forget emits from a
   * single callback (e.g. status + budget-usage) can otherwise complete
   * out of order. Each emission is chained on this promise so events for
   * ONE agent are delivered in arrival order; cross-agent concurrency is
   * preserved because every ActiveBackgroundAgent owns its own chain.
   * Mirrors AgenCStdioTransport's #dispatchChain (transport/stdio.ts).
   */
  dispatchChain: Promise<void>;
}

interface ActiveMessageSubmission {
  readonly clientMessageId: string;
  readonly contentFingerprint: string;
  readonly streamId: string;
  readonly acceptedAt: string;
  turnId?: string;
  assistantMessageOrdinal: number;
  activeAssistantMessageId?: string;
  terminal?: AgenCBackgroundAgentMessageTerminal;
  readonly promise: Promise<AgenCBackgroundAgentMessageResult>;
  settled: boolean;
}

interface ActiveShellExecution {
  readonly commandFingerprint: string;
  readonly promise: Promise<SessionShellExecuteResult>;
  settled: boolean;
}

interface BackgroundAgentDaemonEvent {
  /** Existing session/subscription correlation envelope. */
  readonly id: string;
  /** Canonical run-journal identity, distinct from the reusable envelope id. */
  readonly eventId?: string;
  /** Canonical rollout sequence when this event originated in Session.EventLog. */
  readonly sequence?: number;
  readonly type: string;
  readonly payload?: JsonObject;
  readonly messageId?: string;
  readonly streamId?: string;
  readonly acceptedAt?: string;
  readonly runId?: string;
  readonly historyEpoch?: string;
  readonly turnId?: string;
  readonly clientMessageId?: string;
  /** Keep operation-scoped events out of model/run status projection. */
  readonly statusProjection?: "session_only";
}

interface AgentTerminalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

function positiveSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export interface AgenCDelegateBackgroundAgentRunnerOptions {
  readonly bootstrap?: AgenCBootstrapFunction;
  readonly ensureAgentControl?: AgenCEnsureAgentControlFunction;
  readonly authBackend?: AuthBackend;
  readonly executionAdmissionKernel?: ExecutionAdmissionKernel;
  readonly csvAgentJobsRepositories?: CsvAgentJobsRepositoryProvider;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
  readonly realtimeCallClient?: AgenCRealtimeCallClient;
  readonly realtimeConnectTransport?: AgenCBackgroundRealtimeTransportConnector;
  readonly onActiveAgentTerminated?: (
    agentId: string,
    snapshot: AgenCBackgroundAgentSnapshot,
  ) => void | Promise<void>;
}

export type AgenCDelegateBackgroundAgentRunnerRuntimeConfig = Pick<
  AgenCDelegateBackgroundAgentRunnerOptions,
  "realtimeCallClient" | "realtimeConnectTransport"
> & {
  readonly authBackend: AuthBackend | undefined;
};

function stringRecordField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantMessageId(turnId: string, ordinal: number): string {
  return `assistant:${turnId}:${ordinal}`;
}

function historyEpochForBoundary(runId: string, boundaryId: string): string {
  return `history:${runId}:${boundaryId}`;
}

function messageContentFingerprint(content: unknown): string {
  return createHash("sha256")
    .update(stableStringify(content) ?? "undefined", "utf8")
    .digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalEventId(event: Event): string {
  return (
    event.eventId ??
    (event.seq !== undefined
      ? `legacy-event:${event.seq}:${event.id}`
      : event.id)
  );
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function metadataStringField(
  value: JsonObject | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim().length > 0
    ? field.trim()
    : undefined;
}

function metadataStringList(
  value: JsonObject | undefined,
  key: string,
): readonly string[] | undefined {
  if (
    value === undefined ||
    !Object.prototype.hasOwnProperty.call(value, key)
  ) {
    return undefined;
  }
  const field = value[key];
  if (!Array.isArray(field)) return undefined;
  return field.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

function jsonObjectArray(value: readonly unknown[]): JsonObject[] {
  return value.filter(isJsonObject);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(
        (item) => item === undefined || isJsonValue(item),
      );
    default:
      return false;
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isToolRecoveryCategory(
  value: unknown,
): value is "idempotent" | "side-effecting" | "interactive" {
  return (
    value === "idempotent" ||
    value === "side-effecting" ||
    value === "interactive"
  );
}

function hashStable(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export {
  DAEMON_USER_PROMPT_PREPARED,
  positiveSequence,
  nonNegativeSequence,
  positiveInteger,
  stringRecordField,
  finiteNumber,
  assistantMessageId,
  historyEpochForBoundary,
  messageContentFingerprint,
  recordValue,
  canonicalEventId,
  nonNegativeFinite,
  metadataStringField,
  metadataStringList,
  jsonObjectArray,
  isJsonObject,
  isJsonValue,
  stringArray,
  isToolRecoveryCategory,
  hashStable,
};
export type {
  DaemonSessionSubmitOptions,
  ActiveBackgroundAgent,
  ActiveMessageSubmission,
  ActiveShellExecution,
  BackgroundAgentDaemonEvent,
  AgentTerminalUsage,
};
