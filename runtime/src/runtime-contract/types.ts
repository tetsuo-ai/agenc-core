import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { AcceptanceProbeCategory } from "../gateway/subagent-orchestrator-types.js";
import type { ApprovalDisposition } from "../gateway/approvals.js";
import type { LLMPipelineStopReason } from "../llm/policy.js";
import type { WorkflowCompletionState } from "../workflow/completion-state.js";
import type { WorkflowRequestMilestone } from "../workflow/request-completion.js";
import type {
  VerifierBootstrapSource,
  VerifierProfileKind,
  VerifierRequirement,
} from "../gateway/verifier-probes.js";
import type { SessionShellProfile } from "../gateway/shell-profile.js";

export type CompletionValidatorId =
  | "artifact_evidence"
  | "turn_end_stop_gate"
  | "request_task_progress"
  | "filesystem_artifact_verification"
  | "deterministic_acceptance_probes"
  | "top_level_verifier";

export type CompletionValidatorOutcome =
  | "pass"
  | "retry_with_blocking_message"
  | "fail_closed"
  | "skipped";

export interface RuntimeContractFlags {
  readonly runtimeContractV2: boolean;
  readonly stopHooksEnabled: boolean;
  readonly asyncTasksEnabled: boolean;
  readonly persistentWorkersEnabled: boolean;
  readonly mailboxEnabled: boolean;
  readonly verifierRuntimeRequired: boolean;
  readonly verifierProjectBootstrap: boolean;
  readonly workerIsolationWorktree: boolean;
  readonly workerIsolationRemote: boolean;
}

export interface RuntimeVerifierVerdict {
  readonly attempted: boolean;
  readonly overall: "pass" | "fail" | "retry" | "skipped";
  readonly summary?: string;
}

export type RuntimeExecutionLocationMode =
  | "local"
  | "worktree"
  | "remote_session"
  | "remote_job";

export interface RuntimeExecutionLocation {
  readonly mode: RuntimeExecutionLocationMode;
  readonly workspaceRoot?: string;
  readonly workingDirectory?: string;
  readonly fallbackReason?: string;
  readonly gitRoot?: string;
  readonly worktreePath?: string;
  readonly worktreeRef?: string;
  readonly lifecycle?: "active" | "removed" | "retained_dirty";
  readonly handleId?: string;
  readonly serverName?: string;
  readonly remoteSessionId?: string;
  readonly remoteJobId?: string;
}

export interface RuntimeContractValidatorSnapshot {
  readonly id: CompletionValidatorId;
  readonly enabled: boolean;
  readonly executed: boolean;
  readonly outcome: CompletionValidatorOutcome;
  readonly reason?: string;
  readonly validationCode?: DelegationOutputValidationCode;
}

export interface RuntimeToolProtocolSnapshot {
  readonly open: boolean;
  readonly pendingToolCallIds: readonly string[];
  readonly repairCount: number;
  readonly lastRepairReason?: string;
  readonly violationCount: number;
  readonly lastViolation?: string;
}

export interface RuntimeTaskLayerSnapshot {
  readonly configured: boolean;
  readonly effective: boolean;
  readonly backend: string;
  readonly durability: string;
  readonly totalTasks: number;
  readonly activeCount: number;
  readonly publicHandleCount: number;
  readonly inactiveReason?: string;
}

export interface RuntimeWorkerLayerSnapshot {
  readonly configured: boolean;
  readonly effective: boolean;
  readonly launchMode:
    | "none"
    | "session_subagent"
    | "durable_task_handle"
    | "persistent_worker_pool";
  readonly activePublicWorkers: number;
  readonly stateCounts?: Partial<
    Record<
      | "starting"
      | "running"
      | "idle"
      | "waiting_for_permission"
      | "verifying"
      | "completed"
      | "failed"
      | "cancelled",
      number
    >
  >;
  readonly executionLocationCounts?: Partial<
    Record<RuntimeExecutionLocationMode, number>
  >;
  readonly latestReusableWorkerId?: string;
  readonly inactiveReason?: string;
}

export interface RuntimeMailboxLayerSnapshot {
  readonly configured: boolean;
  readonly effective: boolean;
  readonly pendingParentToWorker: number;
  readonly pendingWorkerToParent: number;
  readonly unackedCount: number;
  readonly inactiveReason?: string;
}

export interface RuntimeVerifierStageSnapshot {
  readonly bootstrapConfigured: boolean;
  readonly bootstrapAttempted: boolean;
  readonly bootstrapSource?: VerifierBootstrapSource;
  readonly runtimeRequired: boolean;
  readonly launcherKind: "none" | "subagent" | "remote_job";
  readonly taskId?: string;
  readonly profiles?: readonly VerifierProfileKind[];
  readonly probeCategories?: readonly AcceptanceProbeCategory[];
  readonly stageStatus:
    | "inactive"
    | "pending"
    | "running"
    | "passed"
    | "retry"
    | "failed"
    | "skipped";
  readonly skipReason?: string;
}

export interface RuntimeContractSnapshot {
  readonly flags: RuntimeContractFlags;
  readonly validatorOrder: readonly CompletionValidatorId[];
  readonly validators: readonly RuntimeContractValidatorSnapshot[];
  readonly verifier: RuntimeVerifierVerdict;
  readonly taskLayer: RuntimeTaskLayerSnapshot;
  readonly workerLayer: RuntimeWorkerLayerSnapshot;
  readonly mailboxLayer: RuntimeMailboxLayerSnapshot;
  readonly verifierStages: RuntimeVerifierStageSnapshot;
  readonly toolProtocol: RuntimeToolProtocolSnapshot;
}

export interface CompletionValidatorResult {
  readonly id: CompletionValidatorId;
  readonly outcome: CompletionValidatorOutcome;
  readonly reason?: string;
  readonly blockingMessage?: string;
  readonly evidence?: unknown;
  readonly maxAttempts?: number;
  readonly exhaustedDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly verifier?: RuntimeVerifierVerdict;
  readonly verifierTaskId?: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly verifierLauncherKind?: "subagent" | "remote_job";
}

export interface CompletionValidatorContext {
  readonly sessionId: string;
  readonly workspaceRoot?: string;
  readonly turnClass: string;
  readonly stopReason: string;
}

export interface RuntimeWorkerHandle {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly workerId: string;
  readonly workerName: string;
  readonly shellProfile?: SessionShellProfile;
  readonly state:
    | "starting"
    | "running"
    | "idle"
    | "waiting_for_permission"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled";
  readonly taskId?: string;
  readonly currentTaskId?: string;
  readonly lastTaskId?: string;
  readonly pendingTaskCount: number;
  readonly pendingInboxCount?: number;
  readonly pendingOutboxCount?: number;
  readonly lastMailboxActivityAt?: number;
  readonly continuationSessionId?: string;
  readonly workingDirectory?: string;
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly verifierRequirement?: VerifierRequirement;
  readonly stopRequested: boolean;
  readonly summary?: string;
}

export interface RuntimeTaskHandle {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly summary?: string;
  readonly externalRef?: {
    readonly kind: string;
    readonly id: string;
    readonly sessionId?: string;
    readonly runId?: string;
  };
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly outputReady?: boolean;
  readonly outputPath?: string;
  readonly waitTool?: "task.wait";
  readonly outputTool?: "task.output";
}

export interface RuntimeContractStatusSnapshot {
  readonly version: 1;
  readonly updatedAt: number;
  readonly lastTurnTraceId?: string;
  readonly completionState?: WorkflowCompletionState;
  readonly stopReason?: LLMPipelineStopReason;
  readonly stopReasonDetail?: string;
  readonly taskLayer: RuntimeTaskLayerSnapshot;
  readonly workerLayer: RuntimeWorkerLayerSnapshot;
  readonly mailboxLayer: RuntimeMailboxLayerSnapshot;
  readonly verifierStages: RuntimeVerifierStageSnapshot;
  readonly openTasks: readonly RuntimeTaskHandle[];
  readonly openWorkers: readonly RuntimeWorkerHandle[];
  readonly remainingMilestones: readonly WorkflowRequestMilestone[];
  readonly omittedTaskCount: number;
  readonly omittedWorkerCount: number;
  readonly omittedMilestoneCount: number;
}

export type RuntimeMailboxDirection = "parent_to_worker" | "worker_to_parent";
export type RuntimeMailboxStatus = "pending" | "acknowledged" | "handled";
export type RuntimeMailboxMessageType =
  | "idle_notification"
  | "permission_request"
  | "permission_response"
  | "shutdown_request"
  | "task_assignment"
  | "mode_change"
  | "verifier_result"
  | "worker_summary";

interface RuntimeMailboxMessageBase {
  readonly messageId: string;
  readonly type: string;
  readonly parentSessionId: string;
  readonly workerId: string;
  readonly direction: RuntimeMailboxDirection;
  readonly status: RuntimeMailboxStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly taskId?: string;
  readonly correlationId?: string;
}

export interface RuntimeIdleNotificationMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "idle_notification";
  readonly direction: "worker_to_parent";
  readonly summary: string;
}

export interface RuntimePermissionRequestMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "permission_request";
  readonly direction: "worker_to_parent";
  readonly approvalRequestId: string;
  readonly message: string;
  readonly toolName?: string;
  readonly subagentSessionId?: string;
  readonly approverGroup?: string;
  readonly requiredApproverRoles?: readonly string[];
}

export interface RuntimePermissionResponseMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "permission_response";
  readonly direction: "parent_to_worker";
  readonly approvalRequestId: string;
  readonly disposition: ApprovalDisposition;
  readonly approvedBy?: string;
}

export interface RuntimeShutdownRequestMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "shutdown_request";
  readonly direction: "parent_to_worker";
  readonly reason?: string;
}

export interface RuntimeTaskAssignmentMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "task_assignment";
  readonly direction: "parent_to_worker";
  readonly taskId: string;
  readonly objective: string;
  readonly summary?: string;
}

export interface RuntimeModeChangeMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "mode_change";
  readonly direction: "parent_to_worker";
  readonly subject?: string;
  readonly body: string;
}

export interface RuntimeVerifierResultMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "verifier_result";
  readonly direction: "worker_to_parent";
  readonly overall: RuntimeVerifierVerdict["overall"];
  readonly summary?: string;
}

export interface RuntimeWorkerSummaryMessage
  extends RuntimeMailboxMessageBase {
  readonly type: "worker_summary";
  readonly direction: "worker_to_parent";
  readonly state: RuntimeWorkerHandle["state"];
  readonly summary: string;
}

export type RuntimeMailboxMessage =
  | RuntimeIdleNotificationMessage
  | RuntimePermissionRequestMessage
  | RuntimePermissionResponseMessage
  | RuntimeShutdownRequestMessage
  | RuntimeTaskAssignmentMessage
  | RuntimeModeChangeMessage
  | RuntimeVerifierResultMessage
  | RuntimeWorkerSummaryMessage;

export interface DelegatedRuntimeResult {
  readonly surface: "direct_child" | "planner_child" | "verifier";
  readonly workerSessionId?: string;
  readonly status:
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  readonly completionState?: "completed" | "partial" | "blocked" | "needs_verification";
  readonly stopReason?: string;
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly taskId?: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly executionEnvelopeFingerprint?: string;
  readonly continuationSessionId?: string;
  readonly outputReady?: boolean;
  readonly ownedArtifacts?: readonly string[];
}

export const COMPLETION_VALIDATOR_ORDER: readonly CompletionValidatorId[] = [
  "artifact_evidence",
  "turn_end_stop_gate",
  "request_task_progress",
  "filesystem_artifact_verification",
  "deterministic_acceptance_probes",
  "top_level_verifier",
];

export function createRuntimeContractSnapshot(
  flags: RuntimeContractFlags,
): RuntimeContractSnapshot {
  const hookBackedValidatorIds = new Set<CompletionValidatorId>([
    "artifact_evidence",
    "turn_end_stop_gate",
    "filesystem_artifact_verification",
    "deterministic_acceptance_probes",
  ]);
  return {
    flags,
    validatorOrder: [...COMPLETION_VALIDATOR_ORDER],
    validators: COMPLETION_VALIDATOR_ORDER.map((id) => ({
      id,
      enabled: hookBackedValidatorIds.has(id) && flags.stopHooksEnabled,
      executed: false,
      outcome: "skipped",
    })),
    verifier: {
      attempted: false,
      overall: "skipped",
    },
    taskLayer: {
      configured: flags.asyncTasksEnabled,
      effective: false,
      backend: "uninitialized",
      durability: "unknown",
      totalTasks: 0,
      activeCount: 0,
      publicHandleCount: 0,
      inactiveReason: flags.asyncTasksEnabled
        ? "runtime_task_registry_uninitialized"
        : "flag_disabled",
    },
    workerLayer: {
      configured: flags.persistentWorkersEnabled,
      effective: false,
      launchMode: "none",
      activePublicWorkers: 0,
      stateCounts: {},
      inactiveReason: flags.persistentWorkersEnabled
        ? "persistent_worker_manager_uninitialized"
        : "flag_disabled",
    },
    mailboxLayer: {
      configured: flags.mailboxEnabled,
      effective: false,
      pendingParentToWorker: 0,
      pendingWorkerToParent: 0,
      unackedCount: 0,
      inactiveReason: flags.mailboxEnabled
        ? "mailbox_not_implemented"
        : "flag_disabled",
    },
    verifierStages: {
      bootstrapConfigured: flags.verifierProjectBootstrap,
      bootstrapAttempted: false,
      runtimeRequired: flags.verifierRuntimeRequired,
      launcherKind: flags.verifierRuntimeRequired ? "subagent" : "none",
      bootstrapSource: flags.verifierProjectBootstrap ? "fallback" : "disabled",
      profiles: [],
      probeCategories: [],
      stageStatus: flags.verifierRuntimeRequired ? "pending" : "inactive",
      ...(flags.verifierRuntimeRequired
        ? {}
        : { skipReason: "runtime_not_required" }),
    },
    toolProtocol: {
      open: false,
      pendingToolCallIds: [],
      repairCount: 0,
      violationCount: 0,
    },
  };
}

export function updateRuntimeContractValidatorSnapshot(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly id: CompletionValidatorId;
  readonly enabled?: boolean;
  readonly executed?: boolean;
  readonly outcome: CompletionValidatorOutcome;
  readonly reason?: string;
  readonly validationCode?: DelegationOutputValidationCode;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    validators: params.snapshot.validators.map((validator) =>
      validator.id === params.id
        ? {
          id: validator.id,
          enabled: params.enabled ?? validator.enabled,
          executed: params.executed ?? validator.executed,
          outcome: params.outcome,
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.validationCode ? { validationCode: params.validationCode } : {}),
        }
        : validator
    ),
  };
}

export function updateRuntimeContractVerifierVerdict(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly verifier: RuntimeVerifierVerdict;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    verifier: params.verifier,
  };
}

export function updateRuntimeContractTaskLayer(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly taskLayer: RuntimeTaskLayerSnapshot;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    taskLayer: params.taskLayer,
  };
}

export function updateRuntimeContractWorkerLayer(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly workerLayer: RuntimeWorkerLayerSnapshot;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    workerLayer: params.workerLayer,
  };
}

export function updateRuntimeContractMailboxLayer(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly mailboxLayer: RuntimeMailboxLayerSnapshot;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    mailboxLayer: params.mailboxLayer,
  };
}

export function updateRuntimeContractVerifierStage(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly verifierStages: RuntimeVerifierStageSnapshot;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    verifierStages: params.verifierStages,
  };
}

export function updateRuntimeContractToolProtocolSnapshot(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly open: boolean;
  readonly pendingToolCallIds: readonly string[];
  readonly repairCount: number;
  readonly lastRepairReason?: string;
  readonly violationCount: number;
  readonly lastViolation?: string;
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    toolProtocol: {
      open: params.open,
      pendingToolCallIds: [...params.pendingToolCallIds],
      repairCount: params.repairCount,
      ...(params.lastRepairReason
        ? { lastRepairReason: params.lastRepairReason }
        : {}),
      violationCount: params.violationCount,
      ...(params.lastViolation ? { lastViolation: params.lastViolation } : {}),
    },
  };
}
