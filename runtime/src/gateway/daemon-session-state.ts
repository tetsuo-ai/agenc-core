import type { ChatExecuteParams, ChatExecutorResult } from "../llm/chat-executor.js";
import type { ActiveTaskContext } from "../llm/turn-execution-contract-types.js";
import type { LLMStatefulResumeAnchor } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import {
  MemoryArtifactStore,
  type ContextArtifactRecord,
  type ArtifactCompactionState,
} from "../memory/artifact-store.js";
import {
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  type Session,
} from "./session.js";

const WEB_SESSION_RUNTIME_STATE_KEY_PREFIX = "webchat:runtime-state:";

interface PersistedWebSessionRuntimeState {
  readonly version: 2;
  readonly statefulResumeAnchor?: LLMStatefulResumeAnchor;
  readonly statefulHistoryCompacted?: boolean;
  readonly artifactSnapshotId?: string;
  readonly artifactSessionId?: string;
  /**
   * Active task carryover for the next compatible turn. Round-trips through
   * web-session resume so a paused implementation/artifact-update task can
   * resume on a new client connection without losing the workflow contract
   * fingerprint, source/target artifacts, or task lineage.
   */
  readonly activeTaskContext?: unknown;
}

const SESSION_STATEFUL_LINEAGE_PHASES = new Set([
  "initial",
  "tool_followup",
]);

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

function buildPersistedWebSessionRuntimeState(
  session: Session,
): PersistedWebSessionRuntimeState | undefined {
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
  const activeTaskContext =
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY];
  const hasActiveTaskContext =
    typeof activeTaskContext === "object" && activeTaskContext !== null;
  if (
    !resumeAnchor &&
    !historyCompacted &&
    !artifactSnapshotId &&
    !hasActiveTaskContext
  ) {
    return undefined;
  }
  return {
    version: 2,
    ...(resumeAnchor ? { statefulResumeAnchor: resumeAnchor } : {}),
    ...(historyCompacted ? { statefulHistoryCompacted: true } : {}),
    ...(artifactSnapshotId ? { artifactSnapshotId } : {}),
    ...(artifactSnapshotId ? { artifactSessionId: session.id } : {}),
    ...(hasActiveTaskContext ? { activeTaskContext } : {}),
  };
}

function coercePersistedWebSessionRuntimeState(
  value: unknown,
): PersistedWebSessionRuntimeState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 && candidate.version !== 2) return undefined;
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
  const activeTaskContext =
    typeof candidate.activeTaskContext === "object" &&
    candidate.activeTaskContext !== null
      ? candidate.activeTaskContext
      : undefined;
  if (
    !resumeAnchor &&
    !historyCompacted &&
    !artifactSnapshotId &&
    !activeTaskContext
  ) {
    return undefined;
  }
  return {
    version: 2,
    ...(resumeAnchor ? { statefulResumeAnchor: resumeAnchor } : {}),
    ...(historyCompacted ? { statefulHistoryCompacted: true } : {}),
    ...(artifactSnapshotId ? { artifactSnapshotId } : {}),
    ...(artifactSessionId ? { artifactSessionId } : {}),
    ...(activeTaskContext ? { activeTaskContext } : {}),
  };
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

export async function persistWebSessionRuntimeState(
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
  const persisted = buildPersistedWebSessionRuntimeState(session);
  const key = webSessionRuntimeStateKey(webSessionId);
  if (!persisted) {
    await artifactStore.clearSession(session.id);
    await memoryBackend.delete(key);
    return;
  }
  await memoryBackend.set(key, persisted);
}

export async function clearWebSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const persisted = coercePersistedWebSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  if (persisted?.artifactSessionId) {
    await artifactStore.clearSession(persisted.artifactSessionId);
  }
  await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
}

export async function hydrateWebSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const artifactStore = new MemoryArtifactStore(memoryBackend);
  const persisted = coercePersistedWebSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  if (!persisted) return;
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
}

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
  const raw = session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY];
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).version === 1 &&
    typeof (raw as Record<string, unknown>).taskLineageId === "string"
  ) {
    return raw as ActiveTaskContext;
  }
  return undefined;
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
