import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { AcceptanceProbeCategory } from "../gateway/subagent-orchestrator-types.js";
import type {
  VerifierBootstrapSource,
  VerifierProfileKind,
  VerifierRequirement,
} from "../gateway/verifier-probes.js";

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
  readonly launchMode: "none" | "session_subagent" | "durable_task_handle";
  readonly activePublicWorkers: number;
  readonly inactiveReason?: string;
}

export interface RuntimeMailboxLayerSnapshot {
  readonly configured: boolean;
  readonly effective: boolean;
  readonly inactiveReason?: string;
}

export interface RuntimeVerifierStageSnapshot {
  readonly bootstrapConfigured: boolean;
  readonly bootstrapAttempted: boolean;
  readonly bootstrapSource?: VerifierBootstrapSource;
  readonly runtimeRequired: boolean;
  readonly launcherKind: "none" | "subagent";
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
  readonly legacyTopLevelVerifierMode: "none" | "pending" | "applied" | "skipped";
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
  readonly taskId?: string;
  readonly summary?: string;
}

export interface RuntimeTaskHandle {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly summary?: string;
  readonly externalRef?: {
    readonly kind: string;
    readonly id: string;
    readonly sessionId?: string;
    readonly runId?: string;
  };
  readonly outputReady?: boolean;
  readonly outputPath?: string;
  readonly waitTool?: "task.wait";
  readonly outputTool?: "task.output";
}

export interface RuntimeMailboxMessage {
  readonly type: string;
  readonly workerId?: string;
  readonly taskId?: string;
  readonly subject?: string;
  readonly body?: string;
}

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
  return {
    flags,
    validatorOrder: [...COMPLETION_VALIDATOR_ORDER],
    validators: COMPLETION_VALIDATOR_ORDER.map((id) => ({
      id,
      enabled: id === "top_level_verifier"
        ? flags.runtimeContractV2 && flags.verifierRuntimeRequired
        : true,
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
      inactiveReason: flags.persistentWorkersEnabled
        ? "persistent_workers_not_implemented"
        : "flag_disabled",
    },
    mailboxLayer: {
      configured: flags.mailboxEnabled,
      effective: false,
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
    legacyTopLevelVerifierMode: flags.runtimeContractV2 ? "none" : "pending",
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

export function updateRuntimeContractLegacyVerifierMode(params: {
  readonly snapshot: RuntimeContractSnapshot;
  readonly legacyTopLevelVerifierMode: RuntimeContractSnapshot["legacyTopLevelVerifierMode"];
}): RuntimeContractSnapshot {
  return {
    ...params.snapshot,
    legacyTopLevelVerifierMode: params.legacyTopLevelVerifierMode,
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
