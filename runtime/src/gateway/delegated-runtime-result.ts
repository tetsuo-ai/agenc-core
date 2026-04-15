import { createHash } from "node:crypto";
import type {
  RuntimeVerifierVerdict,
  DelegatedRuntimeResult,
  RuntimeExecutionLocation,
} from "../runtime-contract/types.js";
import type { VerifierRequirement } from "./verifier-probes.js";
import type { WorkflowCompletionState } from "../workflow/completion-state.js";
import type { WorkflowProgressSnapshot } from "../workflow/completion-progress.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";

interface DelegatedRuntimeResultParams {
  readonly surface: DelegatedRuntimeResult["surface"];
  readonly workerSessionId?: string;
  readonly status?: DelegatedRuntimeResult["status"];
  readonly completionState?: WorkflowCompletionState;
  readonly completionProgress?: WorkflowProgressSnapshot;
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

export interface DelegatedTerminalOutcome {
  readonly success: boolean;
  readonly terminalStatus: Exclude<
    DelegatedRuntimeResult["status"],
    "in_progress"
  >;
  readonly runtimeResult: DelegatedRuntimeResult;
  readonly failureReason?: string;
}

export interface PlannerVerifierSnapshot {
  readonly performed: boolean;
  readonly overall: "pass" | "retry" | "fail" | "skipped";
  readonly summary?: string;
}

export function mapPlannerVerifierSnapshotToRuntimeVerdict(
  snapshot: PlannerVerifierSnapshot | undefined,
): RuntimeVerifierVerdict | undefined {
  if (!snapshot) return undefined;
  return {
    attempted: snapshot.performed === true,
    overall: snapshot.overall,
    ...(typeof snapshot.summary === "string" && snapshot.summary.trim().length > 0
      ? { summary: snapshot.summary.trim() }
      : {}),
  };
}

export function mergeVerifierRequirements(params: {
  readonly inherited?: VerifierRequirement;
  readonly resolved?: VerifierRequirement;
}): VerifierRequirement | undefined {
  const inherited = params.inherited;
  const resolved = params.resolved;
  if (!inherited) return resolved;
  if (!resolved) return inherited;

  return {
    required: inherited.required || resolved.required,
    profiles: uniqueStrings([...inherited.profiles, ...resolved.profiles]),
    probeCategories: uniqueStrings([
      ...inherited.probeCategories,
      ...resolved.probeCategories,
    ]) as VerifierRequirement["probeCategories"],
    mutationPolicy:
      inherited.mutationPolicy === "read_only_workspace" ||
      resolved.mutationPolicy === "read_only_workspace"
        ? "read_only_workspace"
        : resolved.mutationPolicy,
    allowTempArtifacts:
      inherited.allowTempArtifacts || resolved.allowTempArtifacts,
    bootstrapSource:
      inherited.bootstrapSource === "fallback" ||
      resolved.bootstrapSource === "fallback"
        ? "fallback"
        : inherited.bootstrapSource === "derived" ||
            resolved.bootstrapSource === "derived"
          ? "derived"
          : resolved.bootstrapSource,
    rationale: uniqueStrings([...inherited.rationale, ...resolved.rationale]),
  };
}

export function resolveDelegatedTerminalStatus(params: {
  readonly completionState?: WorkflowCompletionState;
  readonly stopReason?: string;
  readonly reportedStatus?: string;
}): Exclude<DelegatedRuntimeResult["status"], "in_progress"> {
  if (params.stopReason === "cancelled" || params.reportedStatus === "cancelled") {
    return "cancelled";
  }
  if (params.stopReason === "timeout" || params.reportedStatus === "timed_out") {
    return "timed_out";
  }
  if (params.completionState === "completed") {
    return "completed";
  }
  return "failed";
}

export function buildDelegatedIncompleteReason(params: {
  readonly completionState?: WorkflowCompletionState;
  readonly completionProgress?: Pick<
    WorkflowProgressSnapshot,
    "remainingRequirements"
  >;
  readonly stopReasonDetail?: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
}): string | undefined {
  if (!params.completionState || params.completionState === "completed") {
    return undefined;
  }
  const remainingRequirements =
    params.completionProgress?.remainingRequirements?.filter((entry) =>
      typeof entry === "string" && entry.trim().length > 0
    ) ?? [];
  const remainingSuffix = remainingRequirements.length > 0
    ? ` Remaining requirements: ${remainingRequirements.join(", ")}.`
    : "";
  const detailSuffix =
    typeof params.stopReasonDetail === "string" &&
      params.stopReasonDetail.trim().length > 0
      ? ` ${params.stopReasonDetail.trim()}`
      : "";
  return (
    `Sub-agent did not reach a completed workflow state (${params.completionState}).` +
    remainingSuffix +
    detailSuffix
  ).trim();
}

export function buildDelegatedRuntimeResult(
  params: DelegatedRuntimeResultParams,
): DelegatedRuntimeResult {
  const completionState = resolveEffectiveCompletionState({
    completionState: params.completionState,
    verifierRequirement: params.verifierRequirement,
    verifierVerdict: params.verifierVerdict,
  });
  const status = params.status ??
    resolveDelegatedTerminalStatus({
      completionState,
      stopReason: params.stopReason,
    });
  return {
    surface: params.surface,
    status,
    ...(params.workerSessionId ? { workerSessionId: params.workerSessionId } : {}),
    ...(completionState ? { completionState } : {}),
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    ...(params.stopReasonDetail ? { stopReasonDetail: params.stopReasonDetail } : {}),
    ...(params.validationCode ? { validationCode: params.validationCode } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.verifierRequirement
      ? { verifierRequirement: params.verifierRequirement }
      : {}),
    ...(params.verifierVerdict ? { verifierVerdict: params.verifierVerdict } : {}),
    ...(params.executionLocation
      ? { executionLocation: params.executionLocation }
      : {}),
    ...(params.executionEnvelopeFingerprint
      ? { executionEnvelopeFingerprint: params.executionEnvelopeFingerprint }
      : {}),
    ...(params.continuationSessionId
      ? { continuationSessionId: params.continuationSessionId }
      : {}),
    ...(params.outputReady !== undefined ? { outputReady: params.outputReady } : {}),
    ...(params.ownedArtifacts ? { ownedArtifacts: params.ownedArtifacts } : {}),
  };
}

export function resolveDelegatedTerminalOutcome(params: {
  readonly surface: DelegatedRuntimeResult["surface"];
  readonly workerSessionId?: string;
  readonly reportedStatus?: string;
  readonly completionState?: WorkflowCompletionState;
  readonly completionProgress?: WorkflowProgressSnapshot;
  readonly stopReason?: string;
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly taskId?: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly executionEnvelopeFingerprint?: string;
  readonly continuationSessionId?: string;
  readonly ownedArtifacts?: readonly string[];
}): DelegatedTerminalOutcome {
  const completionState = resolveEffectiveCompletionState({
    completionState: params.completionState,
    verifierRequirement: params.verifierRequirement,
    verifierVerdict: params.verifierVerdict,
  });
  const terminalStatus = resolveDelegatedTerminalStatus({
    completionState,
    stopReason: params.stopReason,
    reportedStatus: params.reportedStatus,
  });
  const runtimeResult = buildDelegatedRuntimeResult({
    surface: params.surface,
    workerSessionId: params.workerSessionId,
    status: terminalStatus,
    completionState,
    completionProgress: params.completionProgress,
    stopReason: params.stopReason,
    stopReasonDetail: params.stopReasonDetail,
    validationCode: params.validationCode,
    taskId: params.taskId,
    verifierRequirement: params.verifierRequirement,
    verifierVerdict: params.verifierVerdict,
    executionLocation: params.executionLocation,
    executionEnvelopeFingerprint: params.executionEnvelopeFingerprint,
    continuationSessionId: params.continuationSessionId,
    outputReady: true,
    ownedArtifacts: params.ownedArtifacts,
  });
  const failureReason = buildDelegatedIncompleteReason({
    completionState,
    completionProgress: params.completionProgress,
    stopReasonDetail: params.stopReasonDetail,
    verifierRequirement: params.verifierRequirement,
    verifierVerdict: params.verifierVerdict,
  });
  return {
    success: terminalStatus === "completed" && completionState === "completed",
    terminalStatus,
    runtimeResult,
    ...(failureReason ? { failureReason } : {}),
  };
}

export function computeDelegatedExecutionEnvelopeFingerprint(
  payload: unknown,
): string {
  return createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

function resolveEffectiveCompletionState(params: {
  readonly completionState?: WorkflowCompletionState;
  readonly verifierRequirement?: VerifierRequirement;
  readonly verifierVerdict?: RuntimeVerifierVerdict;
}): WorkflowCompletionState | undefined {
  return params.completionState;
}

function uniqueStrings<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
