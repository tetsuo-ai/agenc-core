import type { MemoryBackend } from "./types.js";

const SESSION_ARTIFACT_SNAPSHOT_KEY_PREFIX = "session-artifacts:snapshot:";
const SESSION_ARTIFACT_RECORD_KEY_PREFIX = "session-artifacts:record:";

export type ContextArtifactKind =
  | "task_brief"
  | "decision"
  | "plan"
  | "review"
  | "repo_snapshot"
  | "compiler_diagnostic"
  | "tool_result"
  | "test_result"
  | "file_change"
  | "conversation_chunk";

export interface ContextArtifactRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ContextArtifactKind;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly createdAt: number;
  readonly digest: string;
  readonly tags: readonly string[];
  readonly source: "session_compaction" | "executor_compaction";
}

export interface ContextArtifactRef {
  readonly id: string;
  readonly kind: ContextArtifactKind;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly digest: string;
  readonly tags: readonly string[];
}

export interface ArtifactCompactionState {
  readonly version: 1;
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly source: "session_compaction" | "executor_compaction";
  readonly historyDigest: string;
  readonly sourceMessageCount: number;
  readonly retainedTailCount: number;
  readonly narrativeSummary?: string;
  readonly openLoops: readonly string[];
  readonly artifactRefs: readonly ContextArtifactRef[];
}

interface PersistedArtifactSnapshot {
  readonly state: ArtifactCompactionState;
  readonly records: readonly ContextArtifactRecord[];
}

function snapshotKey(sessionId: string): string {
  return `${SESSION_ARTIFACT_SNAPSHOT_KEY_PREFIX}${sessionId}`;
}

function recordKey(sessionId: string, artifactId: string): string {
  return `${SESSION_ARTIFACT_RECORD_KEY_PREFIX}${sessionId}:${artifactId}`;
}

export class MemoryArtifactStore {
  private readonly backend: MemoryBackend;

  constructor(backend: MemoryBackend) {
    this.backend = backend;
  }

  async persistSnapshot(snapshot: PersistedArtifactSnapshot): Promise<void> {
    const existing =
      await this.backend.get<ArtifactCompactionState>(snapshotKey(snapshot.state.sessionId));
    const nextArtifactIds = new Set(snapshot.state.artifactRefs.map((ref) => ref.id));
    for (const record of snapshot.records) {
      await this.backend.set(recordKey(record.sessionId, record.id), record);
    }
    await this.backend.set(snapshotKey(snapshot.state.sessionId), snapshot.state);
    if (existing?.artifactRefs?.length) {
      for (const artifactRef of existing.artifactRefs) {
        if (!nextArtifactIds.has(artifactRef.id)) {
          await this.backend.delete(recordKey(snapshot.state.sessionId, artifactRef.id));
        }
      }
    }
  }

  async loadSnapshot(
    sessionId: string,
    expectedSnapshotId?: string,
  ): Promise<PersistedArtifactSnapshot | undefined> {
    const state =
      await this.backend.get<ArtifactCompactionState>(snapshotKey(sessionId));
    if (!state) {
      return undefined;
    }
    if (
      expectedSnapshotId !== undefined &&
      state.snapshotId !== expectedSnapshotId
    ) {
      return undefined;
    }
    const records: ContextArtifactRecord[] = [];
    for (const artifactRef of state.artifactRefs) {
      const record = await this.backend.get<ContextArtifactRecord>(
        recordKey(sessionId, artifactRef.id),
      );
      if (record) {
        records.push(record);
      }
    }
    return {
      state,
      records,
    };
  }

  async clearSession(sessionId: string): Promise<void> {
    const snapshot = await this.loadSnapshot(sessionId);
    if (snapshot) {
      for (const artifactRef of snapshot.state.artifactRefs) {
        await this.backend.delete(recordKey(sessionId, artifactRef.id));
      }
    }
    await this.backend.delete(snapshotKey(sessionId));
  }
}
