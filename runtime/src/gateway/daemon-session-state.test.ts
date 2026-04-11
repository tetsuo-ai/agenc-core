import { describe, expect, it } from "vitest";

import type { MemoryBackend } from "../memory/types.js";
import {
  buildRuntimeContractStatusSnapshotForSession,
  buildSessionStatefulOptions,
  clearWebSessionRuntimeState,
  enrichRuntimeContractSnapshotForSession,
  hydrateWebSessionRuntimeState,
  persistSessionRuntimeContractStatusSnapshot,
  persistWebSessionRuntimeState,
} from "./daemon-session-state.js";
import {
  SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY,
  type Session,
} from "./session.js";
import type {
  ArtifactCompactionState,
  ContextArtifactRecord,
} from "../memory/artifact-store.js";
import { createRuntimeContractSnapshot } from "../runtime-contract/types.js";

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

  it("persists and hydrates runtime contract status snapshots across web-session resume", async () => {
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    persistSessionRuntimeContractStatusSnapshot(session, {
      version: 1,
      updatedAt: 123,
      lastTurnTraceId: "turn-trace-1",
      completionState: "blocked",
      stopReason: "validation_error",
      stopReasonDetail: "verification required",
      taskLayer: createRuntimeContractSnapshot({
        runtimeContractV2: true,
        stopHooksEnabled: true,
        asyncTasksEnabled: true,
        persistentWorkersEnabled: true,
        mailboxEnabled: true,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: true,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      }).taskLayer,
      workerLayer: createRuntimeContractSnapshot({
        runtimeContractV2: true,
        stopHooksEnabled: true,
        asyncTasksEnabled: true,
        persistentWorkersEnabled: true,
        mailboxEnabled: true,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: true,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      }).workerLayer,
      mailboxLayer: createRuntimeContractSnapshot({
        runtimeContractV2: true,
        stopHooksEnabled: true,
        asyncTasksEnabled: true,
        persistentWorkersEnabled: true,
        mailboxEnabled: true,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: true,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      }).mailboxLayer,
      verifierStages: createRuntimeContractSnapshot({
        runtimeContractV2: true,
        stopHooksEnabled: true,
        asyncTasksEnabled: true,
        persistentWorkersEnabled: true,
        mailboxEnabled: true,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: true,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      }).verifierStages,
      openTasks: [
        {
          id: "1",
          kind: "subagent",
          status: "in_progress",
          updatedAt: 120,
          waitTool: "task.wait",
          outputTool: "task.output",
        },
      ],
      openWorkers: [
        {
          id: "worker-1",
          kind: "persistent_worker",
          status: "running",
          updatedAt: 121,
          workerId: "worker-1",
          workerName: "worker-1",
          state: "running",
          pendingTaskCount: 1,
          stopRequested: false,
        },
      ],
      remainingMilestones: [{ id: "phase-1", description: "finish phase 1" }],
      omittedTaskCount: 0,
      omittedWorkerCount: 0,
      omittedMilestoneCount: 0,
    });

    await persistWebSessionRuntimeState(memoryBackend, "web-session-status", session);

    const hydrated = createSession();
    await hydrateWebSessionRuntimeState(
      memoryBackend,
      "web-session-status",
      hydrated,
    );

    expect(
      hydrated.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY],
    ).toMatchObject({
      version: 1,
      lastTurnTraceId: "turn-trace-1",
      completionState: "blocked",
      openTasks: [expect.objectContaining({ id: "1" })],
      openWorkers: [expect.objectContaining({ workerId: "worker-1" })],
    });
  });

});

describe("enrichRuntimeContractSnapshotForSession", () => {
  it("hydrates mailbox layer state from the worker manager", async () => {
    const result = await enrichRuntimeContractSnapshotForSession({
      sessionId: "session:test",
      result: {
        runtimeContractSnapshot: createRuntimeContractSnapshot({
          runtimeContractV2: true,
          stopHooksEnabled: true,
          asyncTasksEnabled: true,
          persistentWorkersEnabled: true,
          mailboxEnabled: true,
          verifierRuntimeRequired: true,
          verifierProjectBootstrap: true,
          workerIsolationWorktree: false,
          workerIsolationRemote: false,
        }),
      } as any,
      workerManager: {
        describeRuntimeMailboxLayer: async () => ({
          configured: true,
          effective: true,
          pendingParentToWorker: 2,
          pendingWorkerToParent: 1,
          unackedCount: 1,
        }),
      } as any,
    });

    expect(result.runtimeContractSnapshot?.mailboxLayer).toEqual({
      configured: true,
      effective: true,
      pendingParentToWorker: 2,
      pendingWorkerToParent: 1,
      unackedCount: 1,
    });
  });

  it("builds a bounded runtime contract status snapshot from tasks, workers, and milestones", async () => {
    const flags = {
      runtimeContractV2: true,
      stopHooksEnabled: true,
      asyncTasksEnabled: true,
      persistentWorkersEnabled: true,
      mailboxEnabled: true,
      verifierRuntimeRequired: true,
      verifierProjectBootstrap: true,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    } as const;
    const snapshot = await buildRuntimeContractStatusSnapshotForSession({
      sessionId: "session:test",
      turnTraceId: "turn-trace-2",
      result: {
        completionState: "partial",
        stopReason: "completed",
        stopReasonDetail: "needs more work",
        runtimeContractSnapshot: createRuntimeContractSnapshot(flags),
        completionProgress: {
          remainingMilestones: Array.from({ length: 22 }, (_, index) => ({
            id: `m-${index + 1}`,
            description: `milestone ${index + 1}`,
          })),
        },
      } as any,
      taskStore: {
        listTasks: async () =>
          Array.from({ length: 22 }, (_, index) => ({
            id: String(index + 1),
            kind: "manual",
            ownerSessionId: "session:test",
            subject: `task ${index + 1}`,
            description: `task ${index + 1}`,
            status: "in_progress",
            blocks: [],
            blockedBy: [],
            events: [],
            outputReady: false,
            createdAt: index,
            updatedAt: index + 1,
          })),
      } as any,
      workerManager: {
        listWorkers: async () =>
          Array.from({ length: 12 }, (_, index) => ({
            id: `worker-${index + 1}`,
            kind: "persistent_worker",
            status: "running",
            updatedAt: index + 1,
            workerId: `worker-${index + 1}`,
            workerName: `worker-${index + 1}`,
            state: "running",
            pendingTaskCount: 1,
            stopRequested: false,
          })),
      } as any,
    });

    expect(snapshot).toMatchObject({
      version: 1,
      lastTurnTraceId: "turn-trace-2",
      completionState: "partial",
      stopReason: "completed",
      omittedTaskCount: 2,
      omittedWorkerCount: 2,
      omittedMilestoneCount: 2,
    });
    expect(snapshot?.openTasks).toHaveLength(20);
    expect(snapshot?.openTasks[0]).toMatchObject({ id: "22" });
    expect(snapshot?.openWorkers).toHaveLength(10);
    expect(snapshot?.remainingMilestones).toHaveLength(20);
  });
});
