import type {
  ChatExecuteParams,
  ChatExecutorResult,
} from "../llm/chat-executor-types.js";
import type { LLMPipelineStopReason } from "../llm/policy.js";
import type { ActiveTaskContext } from "../llm/turn-execution-contract-types.js";
import type { LLMStatefulResumeAnchor } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import { repairToolTurnSequence } from "../llm/tool-turn-validator.js";
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
  SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY,
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
  SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY,
  cloneInteractiveContextState,
  coerceInteractiveContextState,
  normalizeInteractiveExecutionLocation,
  type InteractiveContextRequest,
  type InteractiveContextState,
} from "./interactive-context.js";
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
import {
  clearSessionReadCache,
  seedSessionReadState,
} from "../tools/system/filesystem.js";
import {
  isPathWithinRoot,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";

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
  readonly interactiveContextState?: InteractiveContextState;
  readonly statefulResumeAnchor?: LLMStatefulResumeAnchor;
  readonly statefulHistoryCompacted?: boolean;
  readonly sessionStartContextMessages?: readonly LLMMessage[];
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
  readonly version: 1 | 2;
  readonly boundarySeq: number;
  readonly migratedFromLegacyAt?: number;
  readonly snapshot: PersistedSessionReplaySnapshot;
  readonly history?: readonly LLMMessage[];
  readonly tailEvents?: readonly LLMMessage[];
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

function readInteractiveContextState(
  metadata: Record<string, unknown>,
): InteractiveContextState | undefined {
  return coerceInteractiveContextState(
    metadata[SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY],
  );
}

function filterReadSeedsToWorkspace(
  state: InteractiveContextState | undefined,
  workspaceRoot: string | undefined,
): InteractiveContextState | undefined {
  if (!state) {
    return undefined;
  }
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(
    workspaceRoot ?? state.executionLocation?.workspaceRoot,
  );
  const readSeeds = normalizedWorkspaceRoot
    ? state.readSeeds.filter((entry) => {
        const normalizedPath = normalizeWorkspaceRoot(entry.path);
        return Boolean(
          normalizedPath &&
            isPathWithinRoot(normalizedPath, normalizedWorkspaceRoot),
        );
      })
    : state.readSeeds;
  return {
    ...cloneInteractiveContextState(state)!,
    readSeeds,
    ...(normalizedWorkspaceRoot
      ? {
          executionLocation: state.executionLocation
            ? {
                ...state.executionLocation,
                workspaceRoot: normalizedWorkspaceRoot,
              }
            : undefined,
        }
      : {}),
  };
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

function cloneReplayHistory(history: readonly LLMMessage[]): readonly LLMMessage[] {
  return (history ?? []).map((event) => JSON.parse(JSON.stringify(event)) as LLMMessage);
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
  const sessionStartContextMessages = Array.isArray(
    session.metadata[SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY],
  )
    ? (
        session.metadata[
          SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY
        ] as readonly LLMMessage[]
      ).filter(
        (message): message is LLMMessage =>
          !!message &&
          typeof message === "object" &&
          typeof message.role === "string" &&
          "content" in message,
      )
    : [];
  const activeTaskContext = coerceActiveTaskContext(
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY],
  );
  const interactiveContextState = readInteractiveContextState(session.metadata);
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
    !interactiveContextState &&
    !historyCompacted &&
    sessionStartContextMessages.length === 0 &&
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
    ...(interactiveContextState
      ? { interactiveContextState: cloneInteractiveContextState(interactiveContextState) }
      : {}),
    statefulResumeAnchor: resumeAnchor,
    statefulHistoryCompacted: historyCompacted ? true : undefined,
    ...(sessionStartContextMessages.length > 0
      ? { sessionStartContextMessages: cloneReplayHistory(sessionStartContextMessages) }
      : {}),
    artifactSnapshotId,
    artifactSessionId,
    runtimeContractSnapshot,
    runtimeContractStatusSnapshot,
    reviewSurfaceState,
    verificationSurfaceState,
    activeTaskContext: hasActiveTaskContext ? activeTaskContext : undefined,
  };
}

export function buildSessionReplayHistory(
  thread: readonly LLMMessage[],
  replayState: PersistedSessionReplayState | undefined,
): readonly LLMMessage[] {
  if (replayState?.history && replayState.history.length > 0) {
    return repairToolTurnSequence(cloneReplayHistory(replayState.history), {
      repairMissingResults: true,
    });
  }
  return repairToolTurnSequence([
    ...thread,
    ...(replayState?.tailEvents ? cloneReplayHistory(replayState.tailEvents) : []),
  ], {
    repairMissingResults: true,
  });
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
  const next: PersistedSessionReplayState = {
    version: 2,
    boundarySeq: nextBoundarySeq,
    ...(existing?.migratedFromLegacyAt
      ? { migratedFromLegacyAt: existing.migratedFromLegacyAt }
      : {}),
    snapshot,
    history: cloneReplayHistory(session.history),
  };
  if (
    existing &&
    JSON.stringify(existing.snapshot) === JSON.stringify(next.snapshot) &&
    JSON.stringify(existing.history ?? []) === JSON.stringify(next.history ?? [])
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
  if (candidate.version === 1 || candidate.version === 2) {
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
            ...(coerceInteractiveContextState(
              snapshotCandidate.interactiveContextState,
            )
              ? {
                  interactiveContextState: cloneInteractiveContextState(
                    coerceInteractiveContextState(
                      snapshotCandidate.interactiveContextState,
                    ),
                  ),
                }
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
            ...(Array.isArray(snapshotCandidate.sessionStartContextMessages)
              ? {
                  sessionStartContextMessages: snapshotCandidate.sessionStartContextMessages
                    .filter(
                      (message): message is LLMMessage =>
                        !!message &&
                        typeof message === "object" &&
                        typeof (message as LLMMessage).role === "string" &&
                        "content" in message,
                    )
                    .map((message) => JSON.parse(JSON.stringify(message)) as LLMMessage),
                }
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
    const history = Array.isArray(candidate.history)
      ? candidate.history.filter(
          (event): event is LLMMessage =>
            !!event &&
            typeof event === "object" &&
            typeof (event as LLMMessage).role === "string" &&
            "content" in event,
        )
      : [];
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
      version: candidate.version as 1 | 2,
      boundarySeq,
      ...(typeof candidate.migratedFromLegacyAt === "number" &&
      Number.isFinite(candidate.migratedFromLegacyAt)
        ? { migratedFromLegacyAt: candidate.migratedFromLegacyAt }
        : {}),
      snapshot: snapshot as PersistedSessionReplaySnapshot,
      ...(history.length > 0 ? { history: cloneReplayHistory(history) } : {}),
      ...(tailEvents.length > 0 ? { tailEvents: cloneReplayHistory(tailEvents) } : {}),
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
  return {
    version: 1,
    boundarySeq: 1,
    migratedFromLegacyAt: Date.now(),
    snapshot,
    tailEvents: [],
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
  const state = await loadPersistedSessionReplayState(memoryBackend, webSessionId);
  if (state?.history && state.history.length > 0) {
    return {
      state,
      history: buildSessionReplayHistory([], state),
    };
  }
  const thread = await memoryBackend.getThread(webSessionId).catch(() => []);
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
  const sessionStartContextMessages = Array.isArray(
    session.metadata[SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY],
  )
    ? cloneReplayHistory(
        (
          session.metadata[
            SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY
          ] as readonly LLMMessage[]
        ).filter(
          (message): message is LLMMessage =>
            !!message &&
            typeof message === "object" &&
            typeof message.role === "string" &&
            "content" in message,
        ),
      )
    : [];
  if (
    !resumeAnchor &&
    !historyCompacted &&
    !artifactContext &&
    sessionStartContextMessages.length === 0
  ) {
    return undefined;
  }
  return {
    ...(resumeAnchor ? { resumeAnchor } : {}),
    ...(historyCompacted ? { historyCompacted: true } : {}),
    ...(artifactContext ? { artifactContext } : {}),
    ...(sessionStartContextMessages.length > 0
      ? { sessionStartContextMessages }
      : {}),
  };
}

export function buildSessionInteractiveContext(
  session: Session,
  options?: {
    readonly overrideState?: InteractiveContextState;
    readonly summaryText?: string;
  },
): InteractiveContextRequest | undefined {
  const state =
    options?.overrideState ?? readInteractiveContextState(session.metadata);
  const normalized = cloneInteractiveContextState(state);
  if (!normalized) {
    return undefined;
  }
  return {
    state: normalized,
    ...(typeof options?.summaryText === "string" &&
    options.summaryText.trim().length > 0
      ? { summaryText: options.summaryText.trim() }
      : {}),
  };
}

export function persistSessionInteractiveContext(
  session: Session,
  state: InteractiveContextState | undefined,
): void {
  if (!state) {
    delete session.metadata[SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY];
    return;
  }
  session.metadata[SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY] =
    cloneInteractiveContextState(state);
}

export function rebindSessionExecutionLocation(
  session: Session,
  executionLocation: InteractiveContextState["executionLocation"] | undefined,
): void {
  const current = readInteractiveContextState(session.metadata);
  if (!current && !executionLocation) {
    return;
  }
  persistSessionInteractiveContext(session, {
    version: 1,
    readSeeds: current?.readSeeds ?? [],
    ...(executionLocation
      ? {
          executionLocation: normalizeInteractiveExecutionLocation(
            executionLocation,
          ),
        }
      : {}),
    ...(current?.cacheSafePromptSnapshot
      ? { cacheSafePromptSnapshot: current.cacheSafePromptSnapshot }
      : {}),
    ...(current?.summaryRef ? { summaryRef: current.summaryRef } : {}),
    ...(current?.forkCarryover ? { forkCarryover: current.forkCarryover } : {}),
  });
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
  if (persisted.snapshot.interactiveContextState) {
    session.metadata[SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY] =
      cloneInteractiveContextState(
        filterReadSeedsToWorkspace(
          persisted.snapshot.interactiveContextState,
          persisted.snapshot.interactiveContextState.executionLocation?.workspaceRoot,
        ),
      );
    clearSessionReadCache(session.id);
    seedSessionReadState(
      session.id,
      (
        session.metadata[
          SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY
        ] as InteractiveContextState
      ).readSeeds,
    );
  } else {
    clearSessionReadCache(session.id);
  }
  if (persisted.snapshot.statefulResumeAnchor) {
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY] =
      cloneResumeAnchor(persisted.snapshot.statefulResumeAnchor);
  }
  if (persisted.snapshot.statefulHistoryCompacted) {
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] = true;
  }
  if (
    persisted.snapshot.sessionStartContextMessages &&
    persisted.snapshot.sessionStartContextMessages.length > 0
  ) {
    session.metadata[SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY] =
      cloneReplayHistory(persisted.snapshot.sessionStartContextMessages);
  }
  if (persisted.snapshot.artifactSessionId) {
    const artifactSnapshot = await artifactStore.loadSnapshot(
      persisted.snapshot.artifactSessionId,
      persisted.snapshot.artifactSnapshotId,
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
  const interactiveContextState = coerceInteractiveContextState(
    nextSnapshot.interactiveContextState,
  );
  if (interactiveContextState) {
    const clonedInteractiveState =
      cloneInteractiveContextState(interactiveContextState);
    nextSnapshot.interactiveContextState = {
      ...(clonedInteractiveState ?? {
        version: 1 as const,
        readSeeds: [],
      }),
      forkCarryover: {
        sourceSessionId: params.sourceWebSessionId,
        mode: "same_location",
      },
    } satisfies InteractiveContextState;
  }
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
    version: 2,
    ...(persisted.migratedFromLegacyAt
      ? { migratedFromLegacyAt: persisted.migratedFromLegacyAt }
      : {}),
    boundarySeq,
    snapshot: nextSnapshot as PersistedSessionReplaySnapshot,
    ...(persisted.history
      ? { history: cloneReplayHistory(persisted.history) }
      : {}),
    ...(persisted.tailEvents
      ? { tailEvents: cloneReplayHistory(persisted.tailEvents) }
      : {}),
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

export function persistSessionStartContextMessages(
  session: Session,
  result: ChatExecutorResult,
): void {
  if (
    result.sessionStartContextMessages &&
    result.sessionStartContextMessages.length > 0
  ) {
    session.metadata[SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY] =
      cloneReplayHistory(result.sessionStartContextMessages);
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
