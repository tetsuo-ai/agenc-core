import type {
  ChatExecuteParams,
  ChatExecutorResult,
} from "../llm/chat-executor-types.js";
import type { LLMPipelineStopReason } from "../llm/policy.js";
import type { ActiveTaskContext } from "../llm/turn-execution-contract-types.js";
import type { LLMStatefulResumeAnchor } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type {
  RuntimeContractSnapshot,
  RuntimeContractStatusSnapshot,
  RuntimeTaskHandle,
  RuntimeWorkerHandle,
} from "../runtime-contract/types.js";
import {
  updateRuntimeContractMailboxLayer,
  updateRuntimeContractTaskLayer,
  updateRuntimeContractWorkerLayer,
} from "../runtime-contract/types.js";
import type { Task, TaskStore } from "../tools/system/task-tracker.js";
import type { PersistentWorkerManager } from "./persistent-worker-manager.js";
import {
  MemoryArtifactStore,
  type ContextArtifactRecord,
  type ArtifactCompactionState,
} from "../memory/artifact-store.js";
import {
  DEFAULT_SESSION_SHELL_PROFILE,
  SESSION_SHELL_PROFILE_METADATA_KEY,
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  SESSION_REVIEW_SURFACE_STATE_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY,
  SESSION_WORKFLOW_STATE_METADATA_KEY,
  coerceSessionShellProfile,
  resolveSessionShellProfile,
  type Session,
  type ReviewSurfaceState,
  type SessionShellProfile,
  type VerificationSurfaceState,
} from "./session.js";
import {
  coerceSessionWorkflowState,
  resolveSessionWorkflowState,
  type SessionWorkflowState,
} from "./workflow-state.js";
import {
  clearForkedReviewSurfaceState,
  clearForkedVerificationSurfaceState,
  coerceReviewSurfaceState,
  coerceVerificationSurfaceState,
  reconcileReviewSurfaceState,
  reconcileVerificationSurfaceState,
} from "./watch-cockpit.js";

const WEB_SESSION_RUNTIME_STATE_KEY_PREFIX = "webchat:runtime-state:";

export interface PersistedSessionRuntimeState {
  readonly version: 6;
  readonly shellProfile?: SessionShellProfile;
  readonly workflowState?: SessionWorkflowState;
  readonly statefulResumeAnchor?: LLMStatefulResumeAnchor;
  readonly statefulHistoryCompacted?: boolean;
  readonly artifactSnapshotId?: string;
  readonly artifactSessionId?: string;
  readonly runtimeContractSnapshot?: RuntimeContractSnapshot;
  readonly runtimeContractStatusSnapshot?: RuntimeContractStatusSnapshot;
  readonly reviewSurfaceState?: ReviewSurfaceState;
  readonly verificationSurfaceState?: VerificationSurfaceState;
  /**
   * Active task carryover for the next compatible turn. Round-trips through
   * web-session resume so a paused implementation/artifact-update task can
   * resume on a new client connection without losing the workflow contract
   * fingerprint, source/target artifacts, or task lineage.
   */
  readonly activeTaskContext?: ActiveTaskContext;
}

/** @deprecated Use PersistedSessionRuntimeState. */
export type PersistedWebSessionRuntimeState = PersistedSessionRuntimeState;

const SESSION_STATEFUL_LINEAGE_PHASES = new Set([
  "initial",
  "tool_followup",
]);
const MAX_STATUS_SNAPSHOT_TASKS = 20;
const MAX_STATUS_SNAPSHOT_WORKERS = 10;
const MAX_STATUS_SNAPSHOT_MILESTONES = 20;

function isTerminalStopReason(
  value: unknown,
): value is LLMPipelineStopReason {
  return (
    value === "completed" ||
    value === "tool_calls" ||
    value === "validation_error" ||
    value === "provider_error" ||
    value === "authentication_error" ||
    value === "rate_limited" ||
    value === "timeout" ||
    value === "tool_error" ||
    value === "budget_exceeded" ||
    value === "no_progress" ||
    value === "cancelled"
  );
}

function isTerminalWorkerState(
  state: RuntimeWorkerHandle["state"],
): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function buildRuntimeTaskHandle(task: Task): RuntimeTaskHandle {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    updatedAt: task.updatedAt,
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.externalRef !== undefined
      ? { externalRef: { ...task.externalRef } }
      : {}),
    ...(task.executionLocation !== undefined
      ? { executionLocation: task.executionLocation }
      : {}),
    ...(task.outputReady !== undefined ? { outputReady: task.outputReady } : {}),
    ...(task.outputRef?.path ? { outputPath: task.outputRef.path } : {}),
    waitTool: "task.wait",
    outputTool: "task.output",
  };
}

function normalizeRuntimeContractStatusSnapshot(
  value: unknown,
): RuntimeContractStatusSnapshot | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const updatedAt =
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : undefined;
  if (candidate.version !== 1 || updatedAt === undefined) {
    return undefined;
  }
  const snapshot = candidate as unknown as RuntimeContractStatusSnapshot;
  return {
    ...snapshot,
    version: 1,
    updatedAt,
    ...(typeof snapshot.lastTurnTraceId === "string" &&
    snapshot.lastTurnTraceId.trim().length > 0
      ? { lastTurnTraceId: snapshot.lastTurnTraceId.trim() }
      : {}),
    ...(isTerminalStopReason(snapshot.stopReason)
      ? { stopReason: snapshot.stopReason }
      : {}),
    openTasks: Array.isArray(snapshot.openTasks) ? snapshot.openTasks : [],
    openWorkers: Array.isArray(snapshot.openWorkers) ? snapshot.openWorkers : [],
    remainingMilestones: Array.isArray(snapshot.remainingMilestones)
      ? snapshot.remainingMilestones
      : [],
    omittedTaskCount:
      typeof snapshot.omittedTaskCount === "number" &&
      Number.isFinite(snapshot.omittedTaskCount)
        ? snapshot.omittedTaskCount
        : 0,
    omittedWorkerCount:
      typeof snapshot.omittedWorkerCount === "number" &&
      Number.isFinite(snapshot.omittedWorkerCount)
        ? snapshot.omittedWorkerCount
        : 0,
    omittedMilestoneCount:
      typeof snapshot.omittedMilestoneCount === "number" &&
      Number.isFinite(snapshot.omittedMilestoneCount)
        ? snapshot.omittedMilestoneCount
        : 0,
  };
}

function isStatefulResumeAnchor(
  value: unknown,
): value is LLMStatefulResumeAnchor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.previousResponseId !== "string") return false;
  if (candidate.previousResponseId.trim().length === 0) return false;
  if (
    candidate.reconciliationHash !== undefined &&
    typeof candidate.reconciliationHash !== "string"
  ) {
    return false;
  }
  return true;
}

function cloneResumeAnchor(
  anchor: LLMStatefulResumeAnchor,
): LLMStatefulResumeAnchor {
  return {
    previousResponseId: anchor.previousResponseId,
    ...(anchor.reconciliationHash
      ? { reconciliationHash: anchor.reconciliationHash }
      : {}),
  };
}

function webSessionRuntimeStateKey(webSessionId: string): string {
  return `${WEB_SESSION_RUNTIME_STATE_KEY_PREFIX}${webSessionId}`;
}

function coerceActiveTaskContext(value: unknown): ActiveTaskContext | undefined {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    typeof (value as Record<string, unknown>).taskLineageId === "string"
  ) {
    return value as ActiveTaskContext;
  }
  return undefined;
}

function buildPersistedSessionRuntimeState(
  session: Session,
): PersistedSessionRuntimeState | undefined {
  const resumeAnchorCandidate =
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  const resumeAnchor = isStatefulResumeAnchor(resumeAnchorCandidate)
    ? cloneResumeAnchor(resumeAnchorCandidate)
    : undefined;
  const historyCompacted =
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] === true;
  const artifactContext =
    session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY];
  const artifactSnapshotId =
    typeof artifactContext === "object" &&
    artifactContext !== null &&
    typeof (artifactContext as Record<string, unknown>).snapshotId === "string"
      ? String((artifactContext as Record<string, unknown>).snapshotId)
      : undefined;
  const activeTaskContext = coerceActiveTaskContext(
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY],
  );
  const hasActiveTaskContext = activeTaskContext !== undefined;
  const runtimeContractSnapshot =
    typeof session.metadata[SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY] === "object" &&
      session.metadata[SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY] !== null
      ? (session.metadata[
          SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY
        ] as RuntimeContractSnapshot)
      : undefined;
  const runtimeContractStatusSnapshot =
    typeof session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY] ===
        "object" &&
      session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY] !== null
      ? normalizeRuntimeContractStatusSnapshot(
          session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY],
        )
      : undefined;
  const reviewSurfaceState = reconcileReviewSurfaceState(
    coerceReviewSurfaceState(
      session.metadata[SESSION_REVIEW_SURFACE_STATE_METADATA_KEY],
    ),
  );
  const verificationSurfaceState = reconcileVerificationSurfaceState(
    coerceVerificationSurfaceState(
      session.metadata[SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY],
    ),
  );
  const shellProfile = resolveSessionShellProfile(session.metadata);
  const hasPersistedShellProfile =
    shellProfile !== DEFAULT_SESSION_SHELL_PROFILE;
  const workflowState = resolveSessionWorkflowState(session.metadata);
  const hasPersistedWorkflowState =
    workflowState.stage !== "idle" ||
    workflowState.worktreeMode !== "off" ||
    Boolean(workflowState.objective);
  if (
    !hasPersistedShellProfile &&
    !hasPersistedWorkflowState &&
    !resumeAnchor &&
    !historyCompacted &&
    !artifactSnapshotId &&
    !runtimeContractSnapshot &&
    !runtimeContractStatusSnapshot &&
    !reviewSurfaceState &&
    !verificationSurfaceState &&
    !hasActiveTaskContext
  ) {
    return undefined;
  }
  return {
    version: 6,
    ...(hasPersistedShellProfile ? { shellProfile } : {}),
    ...(hasPersistedWorkflowState ? { workflowState } : {}),
    ...(resumeAnchor ? { statefulResumeAnchor: resumeAnchor } : {}),
    ...(historyCompacted ? { statefulHistoryCompacted: true } : {}),
    ...(artifactSnapshotId ? { artifactSnapshotId } : {}),
    ...(artifactSnapshotId ? { artifactSessionId: session.id } : {}),
    ...(runtimeContractSnapshot ? { runtimeContractSnapshot } : {}),
    ...(runtimeContractStatusSnapshot ? { runtimeContractStatusSnapshot } : {}),
    ...(reviewSurfaceState ? { reviewSurfaceState } : {}),
    ...(verificationSurfaceState ? { verificationSurfaceState } : {}),
    ...(hasActiveTaskContext ? { activeTaskContext } : {}),
  };
}

function coercePersistedSessionRuntimeState(
  value: unknown,
): PersistedSessionRuntimeState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 &&
    candidate.version !== 2 &&
    candidate.version !== 3 &&
    candidate.version !== 4 &&
    candidate.version !== 5 &&
    candidate.version !== 6
  ) {
    return undefined;
  }
  const shellProfile = coerceSessionShellProfile(candidate.shellProfile);
  const workflowState = coerceSessionWorkflowState(candidate.workflowState);
  const resumeAnchor = isStatefulResumeAnchor(candidate.statefulResumeAnchor)
    ? cloneResumeAnchor(candidate.statefulResumeAnchor)
    : undefined;
  const historyCompacted = candidate.statefulHistoryCompacted === true;
  const artifactSnapshotId =
    typeof candidate.artifactSnapshotId === "string" &&
    candidate.artifactSnapshotId.trim().length > 0
      ? candidate.artifactSnapshotId.trim()
      : undefined;
  const artifactSessionId =
    typeof candidate.artifactSessionId === "string" &&
    candidate.artifactSessionId.trim().length > 0
      ? candidate.artifactSessionId.trim()
      : undefined;
  const activeTaskContext = coerceActiveTaskContext(candidate.activeTaskContext);
  const runtimeContractSnapshot =
    typeof candidate.runtimeContractSnapshot === "object" &&
      candidate.runtimeContractSnapshot !== null
      ? (candidate.runtimeContractSnapshot as RuntimeContractSnapshot)
      : undefined;
  const runtimeContractStatusSnapshot =
    normalizeRuntimeContractStatusSnapshot(candidate.runtimeContractStatusSnapshot);
  const reviewSurfaceState = reconcileReviewSurfaceState(
    coerceReviewSurfaceState(candidate.reviewSurfaceState),
  );
  const verificationSurfaceState = reconcileVerificationSurfaceState(
    coerceVerificationSurfaceState(candidate.verificationSurfaceState),
  );
  if (
    !shellProfile &&
    !workflowState &&
    !resumeAnchor &&
    !historyCompacted &&
    !artifactSnapshotId &&
    !runtimeContractSnapshot &&
    !runtimeContractStatusSnapshot &&
    !reviewSurfaceState &&
    !verificationSurfaceState &&
    !activeTaskContext
  ) {
    return undefined;
  }
  return {
    version: 6,
    ...(shellProfile ? { shellProfile } : {}),
    ...(workflowState ? { workflowState } : {}),
    ...(resumeAnchor ? { statefulResumeAnchor: resumeAnchor } : {}),
    ...(historyCompacted ? { statefulHistoryCompacted: true } : {}),
    ...(artifactSnapshotId ? { artifactSnapshotId } : {}),
    ...(artifactSessionId ? { artifactSessionId } : {}),
    ...(runtimeContractSnapshot ? { runtimeContractSnapshot } : {}),
    ...(runtimeContractStatusSnapshot ? { runtimeContractStatusSnapshot } : {}),
    ...(reviewSurfaceState ? { reviewSurfaceState } : {}),
    ...(verificationSurfaceState ? { verificationSurfaceState } : {}),
    ...(activeTaskContext ? { activeTaskContext } : {}),
  };
}

function clonePersistedSessionRuntimeState(
  state: PersistedSessionRuntimeState,
): PersistedSessionRuntimeState {
  return JSON.parse(
    JSON.stringify(state),
  ) as PersistedSessionRuntimeState;
}

export async function loadPersistedSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<PersistedSessionRuntimeState | undefined> {
  return coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
}

export function buildSessionStatefulOptions(
  session: Session,
): ChatExecuteParams["stateful"] | undefined {
  const resumeAnchorCandidate =
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  const resumeAnchor = isStatefulResumeAnchor(resumeAnchorCandidate)
    ? resumeAnchorCandidate
    : undefined;
  const historyCompacted =
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] === true;
  const artifactContext = session.metadata[
    SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY
  ] as ArtifactCompactionState | undefined;
  if (!resumeAnchor && !historyCompacted && !artifactContext) return undefined;
  return {
    ...(resumeAnchor ? { resumeAnchor } : {}),
    ...(historyCompacted ? { historyCompacted: true } : {}),
    ...(artifactContext ? { artifactContext } : {}),
  };
}

export async function persistSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const artifactContext = session.metadata[
    SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY
  ] as ArtifactCompactionState | undefined;
  const artifactRecords = Array.isArray(
    session.metadata[SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY],
  )
    ? (session.metadata[
        SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY
      ] as readonly ContextArtifactRecord[])
    : [];
  if (artifactContext) {
    await artifactStore.persistSnapshot({
      state: artifactContext,
      records: artifactRecords,
    });
  }
  const persisted = buildPersistedSessionRuntimeState(session);
  const key = webSessionRuntimeStateKey(webSessionId);
  if (!persisted) {
    await artifactStore.clearSession(session.id);
    await memoryBackend.delete(key);
    return;
  }
  await memoryBackend.set(key, persisted);
}

export async function clearSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const persisted = coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  if (persisted?.artifactSessionId) {
    await artifactStore.clearSession(persisted.artifactSessionId);
  }
  await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
}

export async function hydrateSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const persisted = coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  if (!persisted) return;
  if (persisted.shellProfile) {
    session.metadata[SESSION_SHELL_PROFILE_METADATA_KEY] = persisted.shellProfile;
  }
  if (persisted.workflowState) {
    session.metadata[SESSION_WORKFLOW_STATE_METADATA_KEY] = persisted.workflowState;
  }
  if (persisted.statefulResumeAnchor) {
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY] =
      cloneResumeAnchor(persisted.statefulResumeAnchor);
  }
  if (persisted.statefulHistoryCompacted) {
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] = true;
  }
  if (persisted.artifactSnapshotId) {
    const snapshot = await artifactStore.loadSnapshot(
      persisted.artifactSessionId ?? session.id,
    );
    if (snapshot?.state) {
      session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY] =
        snapshot.state;
      session.metadata[SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY] =
        snapshot.records;
    }
  }
  if (persisted.activeTaskContext) {
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY] =
      persisted.activeTaskContext;
  }
  if (persisted.reviewSurfaceState) {
    session.metadata[SESSION_REVIEW_SURFACE_STATE_METADATA_KEY] =
      persisted.reviewSurfaceState;
  }
  if (persisted.verificationSurfaceState) {
    session.metadata[SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY] =
      persisted.verificationSurfaceState;
  }
  if (persisted.runtimeContractSnapshot) {
    session.metadata[SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY] =
      persisted.runtimeContractSnapshot;
  }
  if (persisted.runtimeContractStatusSnapshot) {
    session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY] =
      persisted.runtimeContractStatusSnapshot;
  }
}

export async function forkSessionRuntimeState(
  memoryBackend: MemoryBackend,
  params: {
    sourceWebSessionId: string;
    targetWebSessionId: string;
    shellProfile?: SessionShellProfile;
    workflowState?: Partial<SessionWorkflowState>;
  },
): Promise<boolean> {
  const persisted = await loadPersistedSessionRuntimeState(
    memoryBackend,
    params.sourceWebSessionId,
  );
  if (!persisted) {
    return false;
  }

  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const next = {
    ...clonePersistedSessionRuntimeState(persisted),
  } as {
    version: 6;
    shellProfile?: SessionShellProfile;
    workflowState?: SessionWorkflowState;
    statefulResumeAnchor?: LLMStatefulResumeAnchor;
    statefulHistoryCompacted?: boolean;
    artifactSnapshotId?: string;
    artifactSessionId?: string;
    runtimeContractSnapshot?: RuntimeContractSnapshot;
    runtimeContractStatusSnapshot?: RuntimeContractStatusSnapshot;
    reviewSurfaceState?: ReviewSurfaceState;
    verificationSurfaceState?: VerificationSurfaceState;
    activeTaskContext?: ActiveTaskContext;
  };
  const mergedWorkflowState = (() => {
    if (persisted.workflowState) {
      const objective =
        params.workflowState?.objective !== undefined
          ? params.workflowState.objective
          : persisted.workflowState.objective;
      return {
        ...persisted.workflowState,
        ...(params.workflowState?.stage
          ? { stage: params.workflowState.stage }
          : {}),
        ...(params.workflowState?.worktreeMode
          ? { worktreeMode: params.workflowState.worktreeMode }
          : {}),
        ...(objective ? { objective } : {}),
      } satisfies SessionWorkflowState;
    }
    if (!params.workflowState) {
      return undefined;
    }
    return {
      stage: params.workflowState.stage ?? "idle",
      worktreeMode: params.workflowState.worktreeMode ?? "off",
      enteredAt: 0,
      updatedAt: 0,
      ...(params.workflowState.objective
        ? { objective: params.workflowState.objective }
        : {}),
    } satisfies SessionWorkflowState;
  })();

  delete next.activeTaskContext;
  delete next.runtimeContractSnapshot;
  delete next.runtimeContractStatusSnapshot;
  next.reviewSurfaceState = clearForkedReviewSurfaceState(
    persisted.reviewSurfaceState,
  );
  next.verificationSurfaceState = clearForkedVerificationSurfaceState(
    persisted.verificationSurfaceState,
  );

  if (params.shellProfile) {
    next.shellProfile = params.shellProfile;
  }
  if (mergedWorkflowState) {
    next.workflowState = mergedWorkflowState;
  }

  if (persisted.artifactSnapshotId) {
    const snapshot = await artifactStore.loadSnapshot(
      persisted.artifactSessionId ?? params.sourceWebSessionId,
    );
    if (snapshot) {
      await artifactStore.persistSnapshot({
        state: {
          ...snapshot.state,
          sessionId: params.targetWebSessionId,
        },
        records: snapshot.records.map((record) => ({
          ...record,
          sessionId: params.targetWebSessionId,
        })),
      });
      next.artifactSessionId = params.targetWebSessionId;
      next.artifactSnapshotId = snapshot.state.snapshotId;
    } else {
      delete next.artifactSessionId;
      delete next.artifactSnapshotId;
    }
  }

  await memoryBackend.set(
    webSessionRuntimeStateKey(params.targetWebSessionId),
    next,
  );
  return true;
}

/** @deprecated Use loadPersistedSessionRuntimeState. */
export const loadPersistedWebSessionRuntimeState = loadPersistedSessionRuntimeState;
/** @deprecated Use persistSessionRuntimeState. */
export const persistWebSessionRuntimeState = persistSessionRuntimeState;
/** @deprecated Use clearSessionRuntimeState. */
export const clearWebSessionRuntimeState = clearSessionRuntimeState;
/** @deprecated Use hydrateSessionRuntimeState. */
export const hydrateWebSessionRuntimeState = hydrateSessionRuntimeState;
/** @deprecated Use forkSessionRuntimeState. */
export const forkWebSessionRuntimeState = forkSessionRuntimeState;

export function resolveSessionStatefulContinuation(
  result: ChatExecutorResult,
):
  | {
    readonly mode: "persist";
    readonly anchor: LLMStatefulResumeAnchor;
    readonly preserveHistoryCompacted?: boolean;
  }
  | {
    readonly mode: "clear";
  }
  | {
    readonly mode: "noop";
  } {
  if (result.callUsage.length === 0) {
    return { mode: "noop" };
  }

  const latestLineageDiagnostics = [...result.callUsage]
    .reverse()
    .find((entry) => {
      if (!SESSION_STATEFUL_LINEAGE_PHASES.has(entry.phase)) {
        return false;
      }
      const responseId = entry.statefulDiagnostics?.responseId?.trim();
      return typeof responseId === "string" && responseId.length > 0;
    })
    ?.statefulDiagnostics;
  const responseId = latestLineageDiagnostics?.responseId?.trim();
  const reconciliationHash =
    latestLineageDiagnostics?.reconciliationHash?.trim();
  const preserveHistoryCompacted =
    latestLineageDiagnostics?.historyCompacted === true &&
    latestLineageDiagnostics?.continued === true &&
    latestLineageDiagnostics?.anchorMatched === false;
  if (responseId && responseId.length > 0) {
    return {
      mode: "persist",
      anchor: {
        previousResponseId: responseId,
        ...(reconciliationHash ? { reconciliationHash } : {}),
      },
      ...(preserveHistoryCompacted ? { preserveHistoryCompacted: true } : {}),
    };
  }

  return { mode: "clear" };
}

export function persistSessionStatefulContinuation(
  session: Session,
  result: ChatExecutorResult,
): void {
  const continuation = resolveSessionStatefulContinuation(result);
  if (continuation.mode === "noop") {
    return;
  }
  if (continuation.mode === "persist") {
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY] =
      continuation.anchor;
    if (continuation.preserveHistoryCompacted) {
      session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] = true;
      return;
    }
    if (
      session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY] ===
      undefined
    ) {
      delete session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY];
    }
    return;
  }

  delete session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  delete session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY];
  delete session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY];
  delete session.metadata[SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY];
}

export function buildSessionActiveTaskContext(
  session: Session,
): ActiveTaskContext | undefined {
  return coerceActiveTaskContext(
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY],
  );
}

export function persistSessionActiveTaskContext(
  session: Session,
  result: ChatExecutorResult,
): void {
  if (result.activeTaskContext) {
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY] =
      result.activeTaskContext;
  } else {
    delete session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY];
  }
}

export function persistSessionRuntimeContractSnapshot(
  session: Session,
  result: ChatExecutorResult,
): void {
  if (result.runtimeContractSnapshot) {
    session.metadata[SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY] =
      result.runtimeContractSnapshot;
  } else {
    delete session.metadata[SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY];
  }
}

export function persistSessionRuntimeContractStatusSnapshot(
  session: Session,
  snapshot: RuntimeContractStatusSnapshot | undefined,
): void {
  if (snapshot) {
    session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY] =
      snapshot;
  } else {
    delete session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY];
  }
}

export async function buildRuntimeContractStatusSnapshotForSession(params: {
  readonly sessionId: string;
  readonly turnTraceId?: string;
  readonly result: ChatExecutorResult;
  readonly taskStore?: TaskStore | null;
  readonly workerManager?: PersistentWorkerManager | null;
}): Promise<RuntimeContractStatusSnapshot | undefined> {
  const snapshot = params.result.runtimeContractSnapshot;
  if (!snapshot) {
    return undefined;
  }

  const tasks = params.taskStore
    ? (await params.taskStore.listTasks(params.sessionId)).filter(
        (task) =>
          task.status !== "deleted" &&
          task.status !== "completed" &&
          task.status !== "failed" &&
          task.status !== "cancelled",
      )
    : [];
  const openTasks = tasks
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(buildRuntimeTaskHandle);
  const truncatedTasks = openTasks.slice(0, MAX_STATUS_SNAPSHOT_TASKS);

  const workers = params.workerManager
    ? (await params.workerManager.listWorkers(params.sessionId)).filter(
        (worker) => !isTerminalWorkerState(worker.state),
      )
    : [];
  const openWorkers = [...workers].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
  const truncatedWorkers = openWorkers.slice(0, MAX_STATUS_SNAPSHOT_WORKERS);

  const remainingMilestones = params.result.completionProgress?.remainingMilestones ?? [];
  const truncatedMilestones = remainingMilestones.slice(
    0,
    MAX_STATUS_SNAPSHOT_MILESTONES,
  );

  return {
    version: 1,
    updatedAt: Date.now(),
    ...(typeof params.turnTraceId === "string" && params.turnTraceId.trim().length > 0
      ? { lastTurnTraceId: params.turnTraceId.trim() }
      : {}),
    completionState: params.result.completionState,
    stopReason: params.result.stopReason,
    ...(params.result.stopReasonDetail
      ? { stopReasonDetail: params.result.stopReasonDetail }
      : {}),
    taskLayer: snapshot.taskLayer,
    workerLayer: snapshot.workerLayer,
    mailboxLayer: snapshot.mailboxLayer,
    verifierStages: snapshot.verifierStages,
    openTasks: truncatedTasks,
    openWorkers: truncatedWorkers,
    remainingMilestones: truncatedMilestones,
    omittedTaskCount: Math.max(0, openTasks.length - truncatedTasks.length),
    omittedWorkerCount: Math.max(
      0,
      openWorkers.length - truncatedWorkers.length,
    ),
    omittedMilestoneCount: Math.max(
      0,
      remainingMilestones.length - truncatedMilestones.length,
    ),
  };
}

export async function enrichRuntimeContractSnapshotForSession(params: {
  readonly sessionId: string;
  readonly result: ChatExecutorResult;
  readonly taskStore?: TaskStore | null;
  readonly workerManager?: PersistentWorkerManager | null;
}): Promise<ChatExecutorResult> {
  if (!params.result.runtimeContractSnapshot) {
    return params.result;
  }

  let snapshot = params.result.runtimeContractSnapshot;
  if (params.taskStore) {
    const taskLayer = await params.taskStore.describeRuntimeTaskLayer(
      params.sessionId,
      snapshot.flags.asyncTasksEnabled,
    );
    snapshot = updateRuntimeContractTaskLayer({
      snapshot,
      taskLayer,
    });

    if (
      snapshot.flags.persistentWorkersEnabled &&
      params.workerManager
    ) {
      snapshot = updateRuntimeContractWorkerLayer({
        snapshot,
        workerLayer: await params.workerManager.describeRuntimeWorkerLayer(
          params.sessionId,
          snapshot.flags.persistentWorkersEnabled,
        ),
      });
    } else {
      const sessionTasks = params.taskStore.list(params.sessionId);
      const activePublicWorkers = sessionTasks.filter(
        (task) => task.kind !== "manual" && task.status === "in_progress",
      ).length;
      snapshot = updateRuntimeContractWorkerLayer({
        snapshot,
        workerLayer: {
          configured:
            snapshot.flags.asyncTasksEnabled ||
            snapshot.flags.persistentWorkersEnabled,
          effective: snapshot.flags.asyncTasksEnabled,
          launchMode: snapshot.flags.asyncTasksEnabled
            ? "durable_task_handle"
            : "none",
          activePublicWorkers,
          stateCounts: {},
          ...(snapshot.flags.asyncTasksEnabled
            ? {}
            : {
                inactiveReason: snapshot.flags.persistentWorkersEnabled
                  ? "persistent_worker_manager_uninitialized"
                  : "flag_disabled",
              }),
        },
      });
    }
  }

  snapshot = updateRuntimeContractMailboxLayer({
    snapshot,
    mailboxLayer: await (
      params.workerManager?.describeRuntimeMailboxLayer(
        params.sessionId,
        snapshot.flags.mailboxEnabled,
      ) ?? Promise.resolve({
        configured: snapshot.flags.mailboxEnabled,
        effective: false,
        pendingParentToWorker: 0,
        pendingWorkerToParent: 0,
        unackedCount: 0,
        inactiveReason: snapshot.flags.mailboxEnabled
          ? "mailbox_manager_uninitialized"
          : "flag_disabled",
      })
    ),
  });

  if (snapshot === params.result.runtimeContractSnapshot) {
    return params.result;
  }
  return {
    ...params.result,
    runtimeContractSnapshot: snapshot,
  };
}
