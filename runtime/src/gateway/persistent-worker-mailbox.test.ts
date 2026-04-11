import { describe, expect, it } from "vitest";

import type { MemoryBackend } from "../memory/types.js";
import { PersistentWorkerMailbox } from "./persistent-worker-mailbox.js";

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

describe("PersistentWorkerMailbox", () => {
  it("persists typed messages and filters them by direction/status", async () => {
    const mailbox = new PersistentWorkerMailbox({
      memoryBackend: createMemoryBackendStub(),
      now: () => 100,
    });

    const assignment = await mailbox.sendToWorker({
      type: "task_assignment",
      parentSessionId: "session-a",
      workerId: "worker-1",
      taskId: "1",
      objective: "Inspect parser.c",
    });
    const summary = await mailbox.sendToParent({
      type: "worker_summary",
      parentSessionId: "session-a",
      workerId: "worker-1",
      state: "idle",
      summary: "Worker ready for assignments.",
    });

    expect(assignment.messageId).toBe("mail-1");
    expect(summary.messageId).toBe("mail-2");
    expect(
      await mailbox.listMessages({
        parentSessionId: "session-a",
        workerId: "worker-1",
        direction: "parent_to_worker",
      }),
    ).toEqual([expect.objectContaining({ type: "task_assignment" })]);
    expect(
      await mailbox.listMessages({
        parentSessionId: "session-a",
        status: "pending",
      }),
    ).toHaveLength(2);
  });

  it("acknowledges and handles messages while preserving worker mailbox counts", async () => {
    const mailbox = new PersistentWorkerMailbox({
      memoryBackend: createMemoryBackendStub(),
      now: () => 200,
    });

    const permissionRequest = await mailbox.sendToParent({
      type: "permission_request",
      parentSessionId: "session-a",
      workerId: "worker-1",
      approvalRequestId: "approval-1",
      message: "Approve system.writeFile",
      subagentSessionId: "subagent:1",
    });
    await mailbox.acknowledgeMessage({
      parentSessionId: "session-a",
      messageId: permissionRequest.messageId,
    });

    const shutdown = await mailbox.sendToWorker({
      type: "shutdown_request",
      parentSessionId: "session-a",
      workerId: "worker-1",
      reason: "Coordinator stop requested.",
    });
    await mailbox.markHandled({
      parentSessionId: "session-a",
      messageId: shutdown.messageId,
    });

    expect(
      await mailbox.getWorkerMailboxCounts({
        parentSessionId: "session-a",
        workerId: "worker-1",
      }),
    ).toEqual(
      expect.objectContaining({
        pendingInboxCount: 0,
        pendingOutboxCount: 1,
      }),
    );
  });

  it("repairs acknowledged parent-to-worker messages back to pending", async () => {
    const mailbox = new PersistentWorkerMailbox({
      memoryBackend: createMemoryBackendStub(),
      now: () => 300,
    });

    const assignment = await mailbox.sendToWorker({
      type: "task_assignment",
      parentSessionId: "session-a",
      workerId: "worker-1",
      taskId: "7",
      objective: "Inspect lexer.c",
    });
    const verifier = await mailbox.sendToParent({
      type: "verifier_result",
      parentSessionId: "session-a",
      workerId: "worker-1",
      overall: "pass",
      summary: "Probe-backed verification passed.",
    });

    await mailbox.acknowledgeMessage({
      parentSessionId: "session-a",
      messageId: assignment.messageId,
    });
    await mailbox.acknowledgeMessage({
      parentSessionId: "session-a",
      messageId: verifier.messageId,
    });

    await mailbox.repairRuntimeState();

    const repaired = await mailbox.listMessages({
      parentSessionId: "session-a",
      workerId: "worker-1",
    });
    expect(repaired).toEqual([
      expect.objectContaining({
        messageId: assignment.messageId,
        status: "pending",
      }),
      expect.objectContaining({
        messageId: verifier.messageId,
        status: "acknowledged",
      }),
    ]);
    expect(
      await mailbox.describeRuntimeMailboxLayer({
        configured: true,
        parentSessionId: "session-a",
      }),
    ).toEqual({
      configured: true,
      effective: true,
      pendingParentToWorker: 1,
      pendingWorkerToParent: 1,
      unackedCount: 1,
    });
  });

  it("emits trace transitions only for persisted mailbox state changes", async () => {
    const traceEvents: Array<Record<string, unknown>> = [];
    const mailbox = new PersistentWorkerMailbox({
      memoryBackend: createMemoryBackendStub(),
      now: () => 400,
      onTraceEvent: async (event) => {
        traceEvents.push({
          action: event.action,
          messageId: event.messageId,
          status: event.status,
        });
      },
    });

    const message = await mailbox.sendToWorker({
      type: "task_assignment",
      parentSessionId: "session-a",
      workerId: "worker-1",
      taskId: "9",
      objective: "Inspect tracing",
    });
    await mailbox.acknowledgeMessage({
      parentSessionId: "session-a",
      messageId: message.messageId,
    });
    await mailbox.acknowledgeMessage({
      parentSessionId: "session-a",
      messageId: message.messageId,
    });
    await mailbox.markHandled({
      parentSessionId: "session-a",
      messageId: message.messageId,
    });
    await mailbox.markHandled({
      parentSessionId: "session-a",
      messageId: message.messageId,
    });

    expect(traceEvents).toEqual([
      expect.objectContaining({
        action: "sent",
        messageId: message.messageId,
        status: "pending",
      }),
      expect.objectContaining({
        action: "acknowledged",
        messageId: message.messageId,
        status: "acknowledged",
      }),
      expect.objectContaining({
        action: "handled",
        messageId: message.messageId,
        status: "handled",
      }),
    ]);
  });
});
