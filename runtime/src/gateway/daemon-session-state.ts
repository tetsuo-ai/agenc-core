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
import { createCompactBoundaryMessage } from "../llm/context-compaction.js";
import type { LLMMessage } from "../llm/types.js";
import type { Task, TaskStore } from "../tools/system/task-tracker.js";
import type { PersistentWorkerManager } from "./persistent-worker-manager.js";
import {
  MemoryArtifactStore,
  type ArtifactCompactionState,
  type ContextArtifactRecord,
} from "../memory/artifact-store.js";
import { entryToMessage } from "../memory/types.js";
import {
  clearStatefulContinuationMetadata,
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
import type { PersistedWebChatForkSource } from "../channels/webchat/session-store.js";
import {
  clearForkedReviewSurfaceState,
  clearForkedVerificationSurfaceState,
  coerceReviewSurfaceState,
  coerceVerificationSurfaceState,
  reconcileReviewSurfaceState,
  reconcileVerificationSurfaceState,
} from "./watch-cockpit.js";

const WEB_SESSION_RUNTIME_STATE_KEY_PREFIX = "webchat:runtime-state:";
const WEB_SESSION_REPLAY_STATE_KEY_PREFIX = "webchat:replay-state:";

export interface PersistedSessionReplayForkMarker {
  readonly parentSessionId: string;
  readonly source: PersistedWebChatForkSource;
  readonly forkedAt: number;
}

export interface PersistedSessionReplaySnapshot {
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
  readonly forkMarker?: PersistedSessionReplayForkMarker;
  /**
   * Active task carryover for the next compatible turn. Round-trips through
   * web-session resume so a paused implementation/artifact-update task can
   * resume on a new client connection without losing the workflow contract
   * fingerprint, source/target artifacts, or task lineage.
   */
  readonly activeTaskContext?: ActiveTaskContext;
}

export interface PersistedSessionReplayState {
  readonly version: 1;
  readonly boundarySeq: number;
  readonly migratedFromLegacyAt?: number;
  readonly snapshot: PersistedSessionReplaySnapshot;
  readonly tailEvents: readonly LLMMessage[];
}

/** @deprecated Use PersistedSessionReplayState. */
export type PersistedSessionRuntimeState = PersistedSessionReplayState;

/** @deprecated Use PersistedSessionReplayState. */
export type PersistedWebSessionRuntimeState = PersistedSessionReplayState;

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

function readArtifactCompactionState(
  metadata: Record<string, unknown>,
): ArtifactCompactionState | undefined {
  const candidate = metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY];
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  if (typeof record.snapshotId !== "string" || record.snapshotId.trim().length === 0) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  if (!Array.isArray(record.artifactRefs)) {
    return undefined;
  }
  return candidate as ArtifactCompactionState;
}

function readArtifactCompactionRecords(
  metadata: Record<string, unknown>,
): readonly ContextArtifactRecord[] {
  const candidate = metadata[SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY];
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter(
    (record): record is ContextArtifactRecord =>
      !!record &&
      typeof record === "object" &&
      typeof (record as ContextArtifactRecord).id === "string" &&
      typeof (record as ContextArtifactRecord).sessionId === "string" &&
      typeof (record as ContextArtifactRecord).title === "string" &&
      typeof (record as ContextArtifactRecord).summary === "string" &&
      typeof (record as ContextArtifactRecord).content === "string",
  );
}

function webSessionReplayStateKey(webSessionId: string): string {
  return `${WEB_SESSION_REPLAY_STATE_KEY_PREFIX}${webSessionId}`;
}

function cloneReplayTailEvents(tailEvents: readonly LLMMessage[]): readonly LLMMessage[] {
  return tailEvents.map((event) => JSON.parse(JSON.stringify(event)) as LLMMessage);
}

function buildPersistedSessionReplaySnapshot(
  session: Session,
): PersistedSessionReplaySnapshot | undefined {
  const resumeAnchorCandidate =
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  const resumeAnchor = isStatefulResumeAnchor(resumeAnchorCandidate)
    ? cloneResumeAnchor(resumeAnchorCandidate)
    : undefined;
  const historyCompacted =
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] === true;
  const activeTaskContext = coerceActiveTaskContext(
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY],
  );
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
  const artifactContext =
    typeof session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY] === "object" &&
      session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY] !== null
      ? (session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY] as ArtifactCompactionState)
      : undefined;
  const artifactSnapshotId = artifactContext?.snapshotId;
  const artifactSessionId = artifactContext?.sessionId;
  const hasActiveTaskContext = activeTaskContext !== undefined;
  if (
    !hasPersistedShellProfile &&
    !hasPersistedWorkflowState &&
    !resumeAnchor &&
    !historyCompacted &&
    !artifactSnapshotId &&
    !artifactSessionId &&
    !runtimeContractSnapshot &&
    !runtimeContractStatusSnapshot &&
    !reviewSurfaceState &&
    !verificationSurfaceState &&
    !hasActiveTaskContext
  ) {
    return undefined;
  }
  return {
    shellProfile: hasPersistedShellProfile ? shellProfile : undefined,
    workflowState: hasPersistedWorkflowState ? workflowState : undefined,
    statefulResumeAnchor: resumeAnchor,
    statefulHistoryCompacted: historyCompacted ? true : undefined,
    artifactSnapshotId,
    artifactSessionId,
    runtimeContractSnapshot,
    runtimeContractStatusSnapshot,
    reviewSurfaceState,
    verificationSurfaceState,
    activeTaskContext: hasActiveTaskContext ? activeTaskContext : undefined,
  };
}

function buildReplayTailEvents(
  sessionId: string,
  snapshot: PersistedSessionReplaySnapshot,
  boundarySeq: number,
): readonly LLMMessage[] {
  const summaryParts: string[] = [];
  if (snapshot.shellProfile) {
    summaryParts.push(`shell=${snapshot.shellProfile}`);
  }
  if (snapshot.workflowState) {
    summaryParts.push(`workflow=${snapshot.workflowState.stage}`);
    if (snapshot.workflowState.objective) {
      summaryParts.push(`objective=${snapshot.workflowState.objective}`);
    }
  }
  if (snapshot.statefulResumeAnchor) {
    summaryParts.push(`resume=${snapshot.statefulResumeAnchor.previousResponseId}`);
  }
  if (snapshot.statefulHistoryCompacted) {
    summaryParts.push("history_compacted=true");
  }
  if (snapshot.runtimeContractSnapshot) {
    summaryParts.push("runtime_contract=true");
  }
  if (snapshot.runtimeContractStatusSnapshot) {
    summaryParts.push(
      `runtime_status=${snapshot.runtimeContractStatusSnapshot.completionState ?? snapshot.runtimeContractStatusSnapshot.stopReason ?? "unknown"}`,
    );
  }
  if (snapshot.reviewSurfaceState?.status) {
    summaryParts.push(`review=${snapshot.reviewSurfaceState.status}`);
  }
  if (snapshot.verificationSurfaceState?.status) {
    summaryParts.push(`verification=${snapshot.verificationSurfaceState.status}`);
  }
  if (snapshot.activeTaskContext?.taskLineageId) {
    summaryParts.push(`task=${snapshot.activeTaskContext.taskLineageId}`);
  }
  if (snapshot.forkMarker) {
    summaryParts.push(`fork=${snapshot.forkMarker.parentSessionId}`);
  }
  if (snapshot.artifactSnapshotId) {
    summaryParts.push(`artifact=${snapshot.artifactSnapshotId}`);
  }
  if (snapshot.artifactSessionId) {
    summaryParts.push(`artifact_session=${snapshot.artifactSessionId}`);
  }
  if (summaryParts.length === 0) {
    return [];
  }
  return [
    createCompactBoundaryMessage({
      boundaryId: `${sessionId}:${boundarySeq}`,
      source: "session_compaction",
      sourceMessageCount: 0,
      retainedTailCount: 0,
      summaryText: summaryParts.join(" | "),
    }),
  ];
}

export function buildSessionReplayHistory(
  thread: readonly LLMMessage[],
  replayState: PersistedSessionReplayState | undefined,
): readonly LLMMessage[] {
  return [
    ...thread,
    ...(replayState?.tailEvents ? cloneReplayTailEvents(replayState.tailEvents) : []),
  ];
}

function buildPersistedSessionRuntimeState(
  session: Session,
  existing?: PersistedSessionReplayState,
): PersistedSessionReplayState | undefined {
  const snapshot = buildPersistedSessionReplaySnapshot(session);
  if (!snapshot) {
    return undefined;
  }
  const nextBoundarySeq = existing
    ? existing.boundarySeq + 1
    : 1;
  const tailEvents = buildReplayTailEvents(session.id, snapshot, nextBoundarySeq);
  const next: PersistedSessionReplayState = {
    version: 1,
    boundarySeq: nextBoundarySeq,
    ...(existing?.migratedFromLegacyAt
      ? { migratedFromLegacyAt: existing.migratedFromLegacyAt }
      : {}),
    snapshot,
    tailEvents,
  };
  if (
    existing &&
    JSON.stringify(existing.snapshot) === JSON.stringify(next.snapshot) &&
    JSON.stringify(existing.tailEvents) === JSON.stringify(next.tailEvents)
  ) {
    return existing;
  }
  return next;
}

function coercePersistedSessionRuntimeState(
  value: unknown,
): PersistedSessionReplayState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version === 1) {
    const boundarySeq =
      typeof candidate.boundarySeq === "number" &&
      Number.isFinite(candidate.boundarySeq) &&
      candidate.boundarySeq >= 0
        ? Math.floor(candidate.boundarySeq)
        : undefined;
    const snapshotCandidate = candidate.snapshot as
      | Record<string, unknown>
      | undefined;
    const snapshot =
      snapshotCandidate && typeof snapshotCandidate === "object"
        ? {
            ...(coerceSessionShellProfile(snapshotCandidate.shellProfile)
              ? { shellProfile: coerceSessionShellProfile(snapshotCandidate.shellProfile) }
              : {}),
            ...(coerceSessionWorkflowState(snapshotCandidate.workflowState)
              ? { workflowState: coerceSessionWorkflowState(snapshotCandidate.workflowState) }
              : {}),
            ...(isStatefulResumeAnchor(snapshotCandidate.statefulResumeAnchor)
              ? {
                  statefulResumeAnchor: cloneResumeAnchor(
                    snapshotCandidate.statefulResumeAnchor,
                  ),
                }
              : {}),
            ...(snapshotCandidate.statefulHistoryCompacted === true
              ? { statefulHistoryCompacted: true }
              : {}),
            ...(typeof snapshotCandidate.artifactSnapshotId === "string" &&
            snapshotCandidate.artifactSnapshotId.trim().length > 0
              ? { artifactSnapshotId: snapshotCandidate.artifactSnapshotId.trim() }
              : {}),
            ...(typeof snapshotCandidate.artifactSessionId === "string" &&
            snapshotCandidate.artifactSessionId.trim().length > 0
              ? { artifactSessionId: snapshotCandidate.artifactSessionId.trim() }
              : {}),
            ...(typeof snapshotCandidate.runtimeContractSnapshot === "object" &&
            snapshotCandidate.runtimeContractSnapshot !== null
              ? {
                  runtimeContractSnapshot:
                    snapshotCandidate.runtimeContractSnapshot as RuntimeContractSnapshot,
                }
              : {}),
            ...(normalizeRuntimeContractStatusSnapshot(
              snapshotCandidate.runtimeContractStatusSnapshot,
            )
              ? {
                  runtimeContractStatusSnapshot:
                    normalizeRuntimeContractStatusSnapshot(
                      snapshotCandidate.runtimeContractStatusSnapshot,
                    ),
                }
              : {}),
            ...(reconcileReviewSurfaceState(
              coerceReviewSurfaceState(snapshotCandidate.reviewSurfaceState),
            )
              ? {
                  reviewSurfaceState: reconcileReviewSurfaceState(
                    coerceReviewSurfaceState(snapshotCandidate.reviewSurfaceState),
                  ),
                }
              : {}),
            ...(reconcileVerificationSurfaceState(
              coerceVerificationSurfaceState(snapshotCandidate.verificationSurfaceState),
            )
              ? {
                  verificationSurfaceState: reconcileVerificationSurfaceState(
                    coerceVerificationSurfaceState(
                      snapshotCandidate.verificationSurfaceState,
                    ),
                  ),
                }
              : {}),
            ...(coerceActiveTaskContext(snapshotCandidate.activeTaskContext)
              ? {
                  activeTaskContext: coerceActiveTaskContext(
                    snapshotCandidate.activeTaskContext,
                  ),
                }
              : {}),
            ...(snapshotCandidate.forkMarker &&
            typeof snapshotCandidate.forkMarker === "object"
              ? {
                  forkMarker: {
                    parentSessionId: String(
                      (snapshotCandidate.forkMarker as Record<string, unknown>)
                        .parentSessionId ?? "",
                    ).trim(),
                    source:
                      (snapshotCandidate.forkMarker as Record<string, unknown>)
                        .source === "checkpoint" ||
                      (snapshotCandidate.forkMarker as Record<string, unknown>)
                        .source === "runtime_state" ||
                      (snapshotCandidate.forkMarker as Record<string, unknown>)
                        .source === "history"
                        ? ((snapshotCandidate.forkMarker as Record<string, unknown>)
                            .source as PersistedWebChatForkSource)
                        : undefined,
                    forkedAt:
                      typeof (snapshotCandidate.forkMarker as Record<string, unknown>)
                        .forkedAt === "number" &&
                      Number.isFinite(
                        (snapshotCandidate.forkMarker as Record<string, unknown>)
                          .forkedAt,
                      )
                        ? (snapshotCandidate.forkMarker as Record<string, unknown>)
                            .forkedAt
                        : undefined,
                  } as PersistedSessionReplayForkMarker,
                }
              : {}),
          }
        : undefined;
    const tailEvents = Array.isArray(candidate.tailEvents)
      ? candidate.tailEvents.filter(
          (event): event is LLMMessage =>
            !!event &&
            typeof event === "object" &&
            typeof (event as LLMMessage).role === "string" &&
            "content" in event,
        )
      : [];
    if (boundarySeq === undefined || !snapshot) {
      return undefined;
    }
    return {
      version: 1,
      boundarySeq,
      ...(typeof candidate.migratedFromLegacyAt === "number" &&
      Number.isFinite(candidate.migratedFromLegacyAt)
        ? { migratedFromLegacyAt: candidate.migratedFromLegacyAt }
        : {}),
      snapshot: snapshot as PersistedSessionReplaySnapshot,
      tailEvents: cloneReplayTailEvents(tailEvents),
    };
  }

  if (
    candidate.version !== 2 &&
    candidate.version !== 3 &&
    candidate.version !== 4 &&
    candidate.version !== 5 &&
    candidate.version !== 6 &&
    candidate.version !== 7
  ) {
    return undefined;
  }

  const snapshot = buildPersistedSessionReplaySnapshot({
    id: "legacy",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata: {
      ...(candidate.shellProfile !== undefined
        ? { [SESSION_SHELL_PROFILE_METADATA_KEY]: candidate.shellProfile }
        : {}),
      ...(candidate.workflowState !== undefined
        ? { [SESSION_WORKFLOW_STATE_METADATA_KEY]: candidate.workflowState }
        : {}),
      ...(candidate.statefulResumeAnchor !== undefined
        ? { [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: candidate.statefulResumeAnchor }
        : {}),
      ...(candidate.statefulHistoryCompacted === true ||
      typeof candidate.artifactSnapshotId === "string"
        ? { [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true }
        : {}),
      ...(candidate.artifactSnapshotId !== undefined
        ? {
            [SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY]: {
              version: 1,
              snapshotId: candidate.artifactSnapshotId,
              sessionId:
                typeof candidate.artifactSessionId === "string"
                  ? candidate.artifactSessionId
                  : "",
              createdAt: 0,
              source: "session_compaction",
              historyDigest: "",
              sourceMessageCount: 0,
              retainedTailCount: 0,
              openLoops: [],
              artifactRefs: [],
            },
          }
        : {}),
      ...(candidate.artifactSessionId !== undefined
        ? {
            [SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY]: {
              sessionId: candidate.artifactSessionId,
            },
          }
        : {}),
      ...(candidate.runtimeContractSnapshot !== undefined
        ? {
            [SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY]:
              candidate.runtimeContractSnapshot,
          }
        : {}),
      ...(candidate.runtimeContractStatusSnapshot !== undefined
        ? {
            [SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY]:
              candidate.runtimeContractStatusSnapshot,
          }
        : {}),
      ...(candidate.reviewSurfaceState !== undefined
        ? {
            [SESSION_REVIEW_SURFACE_STATE_METADATA_KEY]:
              candidate.reviewSurfaceState,
          }
        : {}),
      ...(candidate.verificationSurfaceState !== undefined
        ? {
            [SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY]:
              candidate.verificationSurfaceState,
          }
        : {}),
      ...(candidate.activeTaskContext !== undefined
        ? {
            [SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY]:
              candidate.activeTaskContext,
          }
        : {}),
    },
  });
  if (!snapshot) {
    return undefined;
  }
  const tailEvents = buildReplayTailEvents("legacy", snapshot, 1);
  return {
    version: 1,
    boundarySeq: 1,
    migratedFromLegacyAt: Date.now(),
    snapshot,
    tailEvents,
  };
}

function clonePersistedSessionRuntimeState(
  state: PersistedSessionRuntimeState,
): PersistedSessionRuntimeState {
  return JSON.parse(
    JSON.stringify(state),
  ) as PersistedSessionRuntimeState;
}

export async function loadPersistedSessionReplayState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<PersistedSessionReplayState | undefined> {
  const replayKey = webSessionReplayStateKey(webSessionId);
  const persisted = coercePersistedSessionRuntimeState(
    await memoryBackend.get(replayKey),
  );
  if (persisted) {
    return persisted;
  }

  const legacy = coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  if (!legacy) {
    return undefined;
  }

  await memoryBackend.set(replayKey, legacy);
  await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
  return legacy;
}

export async function loadPersistedSessionReplayContext(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<{
  readonly state?: PersistedSessionReplayState;
  readonly history: readonly LLMMessage[];
}> {
  const [state, thread] = await Promise.all([
    loadPersistedSessionReplayState(memoryBackend, webSessionId),
    memoryBackend.getThread(webSessionId).catch(() => []),
  ]);
  return {
    state,
    history: buildSessionReplayHistory(
      thread.map((entry) => entryToMessage(entry)),
      state,
    ),
  };
}

/** @deprecated Use loadPersistedSessionReplayState. */
export const loadPersistedSessionRuntimeState = loadPersistedSessionReplayState;

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
  const artifactContext = readArtifactCompactionState(session.metadata);
  if (!resumeAnchor && !historyCompacted && !artifactContext) return undefined;
  return {
    ...(resumeAnchor ? { resumeAnchor } : {}),
    ...(historyCompacted ? { historyCompacted: true } : {}),
    ...(artifactContext ? { artifactContext } : {}),
  };
}

export async function persistSessionReplayState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const key = webSessionReplayStateKey(webSessionId);
  const existing = coercePersistedSessionRuntimeState(
    await memoryBackend.get(key),
  ) ?? coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  const persisted = buildPersistedSessionRuntimeState(session, existing);
  if (!persisted) {
    await artifactStore.clearSession(session.id);
    await memoryBackend.delete(key);
    await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
    return;
  }
  const artifactContext = readArtifactCompactionState(session.metadata);
  const artifactRecords = readArtifactCompactionRecords(session.metadata);
  if (artifactContext) {
    await artifactStore.persistSnapshot({
      state: artifactContext,
      records: artifactRecords,
    });
  } else {
    await artifactStore.clearSession(session.id);
  }
  await memoryBackend.set(key, persisted);
  await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
}

/** @deprecated Use persistSessionReplayState. */
export const persistSessionRuntimeState = persistSessionReplayState;

export async function clearSessionReplayState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const persisted = coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionReplayStateKey(webSessionId)),
  );
  const legacy = coercePersistedSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  const artifactSessionId =
    persisted?.snapshot.artifactSessionId ?? legacy?.snapshot.artifactSessionId;
  if (artifactSessionId) {
    await artifactStore.clearSession(artifactSessionId);
  }
  await memoryBackend.delete(webSessionReplayStateKey(webSessionId));
  await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
}

/** @deprecated Use clearSessionReplayState. */
export const clearSessionRuntimeState = clearSessionReplayState;

export async function hydrateSessionReplayState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const persisted = await loadPersistedSessionReplayState(
    memoryBackend,
    webSessionId,
  );
  if (!persisted) return;
  clearStatefulContinuationMetadata(session.metadata);
  if (persisted.snapshot.shellProfile) {
    session.metadata[SESSION_SHELL_PROFILE_METADATA_KEY] =
      persisted.snapshot.shellProfile;
  }
  if (persisted.snapshot.workflowState) {
    session.metadata[SESSION_WORKFLOW_STATE_METADATA_KEY] =
      persisted.snapshot.workflowState;
  }
  if (persisted.snapshot.statefulResumeAnchor) {
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY] =
      cloneResumeAnchor(persisted.snapshot.statefulResumeAnchor);
  }
  if (persisted.snapshot.statefulHistoryCompacted) {
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] = true;
  }
  if (persisted.snapshot.artifactSessionId) {
    const artifactSnapshot = await artifactStore.loadSnapshot(
      persisted.snapshot.artifactSessionId,
    );
    if (artifactSnapshot?.state) {
      session.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY] =
        artifactSnapshot.state;
      session.metadata[SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY] =
        artifactSnapshot.records;
    }
  }
  if (persisted.snapshot.activeTaskContext) {
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY] =
      persisted.snapshot.activeTaskContext;
  }
  if (persisted.snapshot.reviewSurfaceState) {
    session.metadata[SESSION_REVIEW_SURFACE_STATE_METADATA_KEY] =
      persisted.snapshot.reviewSurfaceState;
  }
  if (persisted.snapshot.verificationSurfaceState) {
    session.metadata[SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY] =
      persisted.snapshot.verificationSurfaceState;
  }
  if (persisted.snapshot.runtimeContractSnapshot) {
    session.metadata[SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY] =
      persisted.snapshot.runtimeContractSnapshot;
  }
  if (persisted.snapshot.runtimeContractStatusSnapshot) {
    session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY] =
      persisted.snapshot.runtimeContractStatusSnapshot;
  }
}

/** @deprecated Use hydrateSessionReplayState. */
export const hydrateSessionRuntimeState = hydrateSessionReplayState;

export async function forkSessionReplayState(
  memoryBackend: MemoryBackend,
  params: {
    sourceWebSessionId: string;
    targetWebSessionId: string;
    shellProfile?: SessionShellProfile;
    workflowState?: Partial<SessionWorkflowState>;
  },
): Promise<boolean> {
  const persisted = await loadPersistedSessionReplayState(
    memoryBackend,
    params.sourceWebSessionId,
  );
  if (!persisted) {
    return false;
  }
  const nextSnapshot = {
    ...clonePersistedSessionRuntimeState(persisted).snapshot,
    reviewSurfaceState: clearForkedReviewSurfaceState(
      persisted.snapshot.reviewSurfaceState,
    ),
    verificationSurfaceState: clearForkedVerificationSurfaceState(
      persisted.snapshot.verificationSurfaceState,
    ),
  } as Record<string, unknown>;
  const mergedWorkflowState = (() => {
    if (persisted.snapshot.workflowState) {
      const objective =
        params.workflowState?.objective !== undefined
          ? params.workflowState.objective
          : persisted.snapshot.workflowState.objective;
      return {
        ...persisted.snapshot.workflowState,
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

  if (params.shellProfile) {
    nextSnapshot.shellProfile = params.shellProfile;
  }
  if (mergedWorkflowState) {
    nextSnapshot.workflowState = mergedWorkflowState;
  }
  delete nextSnapshot.activeTaskContext;
  delete nextSnapshot.runtimeContractSnapshot;
  delete nextSnapshot.runtimeContractStatusSnapshot;
  delete nextSnapshot.artifactSessionId;
  delete nextSnapshot.artifactSnapshotId;
  nextSnapshot.forkMarker = {
    parentSessionId: params.sourceWebSessionId,
    source: "history",
    forkedAt: Date.now(),
  };
  const boundarySeq = persisted.boundarySeq + 1;
  const next: PersistedSessionReplayState = {
    version: 1,
    ...(persisted.migratedFromLegacyAt
      ? { migratedFromLegacyAt: persisted.migratedFromLegacyAt }
      : {}),
    boundarySeq,
    snapshot: nextSnapshot as PersistedSessionReplaySnapshot,
    tailEvents: buildReplayTailEvents(
    params.targetWebSessionId,
    nextSnapshot as PersistedSessionReplaySnapshot,
    boundarySeq,
  ),
  };

  await memoryBackend.set(
    webSessionReplayStateKey(params.targetWebSessionId),
    next,
  );
  await memoryBackend.delete(
    webSessionRuntimeStateKey(params.targetWebSessionId),
  );
  return true;
}

/** @deprecated Use forkSessionReplayState. */
export const forkSessionRuntimeState = forkSessionReplayState;
/** @deprecated Use loadPersistedSessionReplayState. */
export const loadPersistedWebSessionRuntimeState = loadPersistedSessionReplayState;
/** @deprecated Use persistSessionReplayState. */
export const persistWebSessionRuntimeState = persistSessionReplayState;
/** @deprecated Use clearSessionReplayState. */
export const clearWebSessionRuntimeState = clearSessionReplayState;
export const clearWebSessionReplayState = clearSessionReplayState;
/** @deprecated Use hydrateSessionReplayState. */
export const hydrateWebSessionRuntimeState = hydrateSessionReplayState;
export const hydrateWebSessionReplayState = hydrateSessionReplayState;
/** @deprecated Use forkSessionReplayState. */
export const forkWebSessionRuntimeState = forkSessionReplayState;

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
    delete session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY];
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
