import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";

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

export interface RuntimeContractSnapshot {
  readonly flags: RuntimeContractFlags;
  readonly validatorOrder: readonly CompletionValidatorId[];
  readonly validators: readonly RuntimeContractValidatorSnapshot[];
  readonly verifier: RuntimeVerifierVerdict;
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
}

export interface RuntimeTaskHandle {
  readonly id: string;
  readonly status: string;
  readonly outputPath?: string;
}

export interface RuntimeMailboxMessage {
  readonly type: string;
  readonly workerId?: string;
  readonly taskId?: string;
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
