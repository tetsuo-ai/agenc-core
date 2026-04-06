import { describe, expect, it } from "vitest";

import type { MemoryBackend } from "../memory/types.js";
import {
  buildSessionStatefulOptions,
  clearWebSessionRuntimeState,
  hydrateWebSessionRuntimeState,
  persistWebSessionRuntimeState,
} from "./daemon-session-state.js";
import {
  SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  type Session,
} from "./session.js";
import type {
  ArtifactCompactionState,
  ContextArtifactRecord,
} from "../memory/artifact-store.js";

function createSession(metadata: Record<string, unknown> = {}): Session {
  return {
    id: "session:test",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata,
  };
}

function createMemoryBackendStub(): MemoryBackend {
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: async () => {
      throw new Error("not implemented");
    },
    getThread: async () => [],
    query: async () => [],
    deleteThread: async () => 0,
    listSessions: async () => [],
    set: async (key: string, value: unknown) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    get: async <T = unknown>(key: string) => {
      const value = kv.get(key);
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as T);
    },
    delete: async (key: string) => kv.delete(key),
    has: async (key: string) => kv.has(key),
    listKeys: async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    getDurability: () => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    }),
    flush: async () => {},
    clear: async () => {
      kv.clear();
    },
    close: async () => {},
    healthCheck: async () => true,
  };
}

describe("buildSessionStatefulOptions", () => {
  it("returns undefined when no stateful session metadata is present", () => {
    expect(buildSessionStatefulOptions(createSession())).toBeUndefined();
  });

  it("returns the stateful continuation options for stored anchors", () => {
    expect(
      buildSessionStatefulOptions(
        createSession({
          [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
            previousResponseId: "resp-123",
            reconciliationHash: "hash-123",
          },
          [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
        }),
      ),
    ).toEqual({
      resumeAnchor: {
        previousResponseId: "resp-123",
        reconciliationHash: "hash-123",
      },
      historyCompacted: true,
    });
  });

  it("ignores malformed anchors while preserving trusted compaction state", () => {
    expect(
      buildSessionStatefulOptions(
        createSession({
          [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
            previousResponseId: "   ",
          },
          [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
        }),
      ),
    ).toEqual({
      historyCompacted: true,
    });
  });

  it("returns artifact-backed stateful options when compacted artifact context exists", () => {
    const artifactContext: ArtifactCompactionState = {
      version: 1,
      snapshotId: "snapshot:abc",
      sessionId: "session:test",
      createdAt: 1,
      source: "session_compaction",
      historyDigest: "digest",
      sourceMessageCount: 10,
      retainedTailCount: 4,
      narrativeSummary: "Compacted shell workspace context",
      openLoops: ["Verify PLAN.md against src/main.c"],
      artifactRefs: [
        {
          id: "artifact:plan",
          kind: "plan",
          title: "PLAN.md",
          summary: "Shell roadmap and milestones",
          createdAt: 1,
          digest: "digest-plan",
          tags: ["plan", "PLAN.md"],
        },
      ],
    };

    expect(
      buildSessionStatefulOptions(
        createSession({
          [SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY]: artifactContext,
          [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
        }),
      ),
    ).toEqual({
      historyCompacted: true,
      artifactContext,
    });
  });
});

describe("web session runtime state helpers", () => {
  it("clears persisted runtime state during explicit session resets", async () => {
    const memoryBackend = createMemoryBackendStub();

    await persistWebSessionRuntimeState(
      memoryBackend,
      "web-session-1",
      createSession({
        [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
          previousResponseId: "resp-123",
          reconciliationHash: "hash-123",
        },
      }),
    );

    await clearWebSessionRuntimeState(memoryBackend, "web-session-1");

    const hydrated = createSession();
    await hydrateWebSessionRuntimeState(
      memoryBackend,
      "web-session-1",
      hydrated,
    );

    expect(hydrated.metadata).toEqual({});
  });

  it("persists and hydrates artifact-backed context across web-session resume", async () => {
    const memoryBackend = createMemoryBackendStub();
    const artifactContext: ArtifactCompactionState = {
      version: 1,
      snapshotId: "snapshot:plan",
      sessionId: "session:test",
      createdAt: 123,
      source: "session_compaction",
      historyDigest: "digest-plan",
      sourceMessageCount: 8,
      retainedTailCount: 4,
      narrativeSummary: "Compacted review loop for the shell workspace",
      openLoops: ["Verify PLAN.md against parser tests"],
      artifactRefs: [
        {
          id: "artifact:plan",
          kind: "plan",
          title: "PLAN.md",
          summary: "Shell roadmap and current milestones",
          createdAt: 123,
          digest: "digest-plan",
          tags: ["plan", "PLAN.md"],
        },
      ],
    };
    const artifactRecords: readonly ContextArtifactRecord[] = [
      {
        id: "artifact:plan",
        sessionId: "session:test",
        kind: "plan",
        title: "PLAN.md",
        summary: "Shell roadmap and current milestones",
        content: "PLAN.md defines the current shell implementation milestones.",
        createdAt: 123,
        digest: "digest-plan",
        tags: ["plan", "PLAN.md"],
        source: "session_compaction",
      },
    ];

    await persistWebSessionRuntimeState(
      memoryBackend,
      "web-session-artifacts",
      createSession({
        [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
          previousResponseId: "resp-123",
          reconciliationHash: "hash-123",
        },
        [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
        [SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY]: artifactContext,
        [SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY]: artifactRecords,
      }),
    );

    const hydrated = createSession();
    await hydrateWebSessionRuntimeState(
      memoryBackend,
      "web-session-artifacts",
      hydrated,
    );

    expect(
      hydrated.metadata[SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY],
    ).toEqual(artifactContext);
    expect(
      hydrated.metadata[SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY],
    ).toEqual(artifactRecords);
    expect(buildSessionStatefulOptions(hydrated)).toEqual({
      resumeAnchor: {
        previousResponseId: "resp-123",
        reconciliationHash: "hash-123",
      },
      historyCompacted: true,
      artifactContext,
    });
  });
  it("persists and hydrates active task context across web-session resume", async () => {
    const memoryBackend = createMemoryBackendStub();
    const activeTaskContext = {
      version: 1 as const,
      taskLineageId: "task-phase-0",
      contractFingerprint: "contract-phase-0",
      turnClass: "workflow_implementation" as const,
      ownerMode: "workflow_owner" as const,
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      displayArtifact: "PLAN.md",
    };

    await persistWebSessionRuntimeState(
      memoryBackend,
      "web-session-active-task",
      createSession({
        [SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY]: activeTaskContext,
      }),
    );

    const hydrated = createSession();
    await hydrateWebSessionRuntimeState(
      memoryBackend,
      "web-session-active-task",
      hydrated,
    );

    expect(
      hydrated.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY],
    ).toEqual(activeTaskContext);
  });

});
