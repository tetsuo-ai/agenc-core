import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./fork-context.js", () => ({
  forkSubagent: vi.fn(async () => ({
    messages: [{ role: "user", content: "seed prompt" }],
  })),
}));

vi.mock("./run-agent.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../session/event-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session/event-log.js")>()),
  emitWarning: vi.fn(),
}));

import { AgentStatusTracker } from "./status.js";
import { Mailbox } from "./mailbox.js";
import {
  _resetAgentRolesForTesting,
  createAgentRoleWorkspace,
  registerAgentRole,
  resolveAgentRole,
} from "./role.js";
import { delegate } from "./delegate.js";
import { forkSubagent } from "./fork-context.js";
import { runAgent } from "./run-agent.js";
import { AgentControl, type LiveAgent } from "./control.js";
import { AgentRegistry } from "./registry.js";
import type { AgentMetadata } from "./registry.js";
import { RolloutStore } from "../session/rollout-store.js";

const mockRunAgent = vi.mocked(runAgent);
const mockForkSubagent = vi.mocked(forkSubagent);
const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

function makeLive(
  agentId: string,
  agentPath: string,
  nickname = "alpha",
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: nickname,
    agentRole: "default",
    agentRoleWorkspaceId: ROLE_WORKSPACE.id,
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(ROLE_WORKSPACE, undefined),
    depth: 1,
    nickname,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeParentSession() {
  return {
    conversationId: "parent-session",
    abortController: new AbortController(),
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    snapshotHistoryMessages: () => [],
    sessionConfiguration: { cwd: "/repo" },
    config: { cwd: "/repo" },
    services: { admissionRequired: false },
  };
}

function runResult(result: {
  threadId: string;
  durationMs: number;
  outcome: "completed" | "errored" | "interrupted" | "aborted";
  finalMessage?: string;
  error?: unknown;
}) {
  return (async function* () {
    return result;
  })();
}

function makeRealDelegateHarness(label: string) {
  const cwd = mkdtempSync(join(tmpdir(), `agenc-delegate-${label}-`));
  const priorAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = cwd;
  const rolloutStore = new RolloutStore({
    cwd,
    sessionId: label,
    agencVersion: "0.6.0",
    autoStartScheduler: false,
  });
  rolloutStore.open({
    sessionId: label,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "delegate-test",
    agencVersion: "0.6.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  const roleWorkspace = createAgentRoleWorkspace(cwd);
  const parent = {
    ...makeParentSession(),
    conversationId: `${label}-parent`,
    sessionConfiguration: { cwd },
    config: { cwd },
    roleWorkspace,
    rolloutStore,
    childInboxes: new Map(),
    mailbox: { send: vi.fn() },
    services: { admissionRequired: false },
  };
  const registry = new AgentRegistry();
  const control = new AgentControl({
    session: parent as never,
    registry,
  });
  control.registerSessionRoot(parent.conversationId);
  return {
    cwd,
    parent,
    registry,
    control,
    rolloutStore,
    cleanup: () => {
      rolloutStore.close();
      _resetAgentRolesForTesting();
      if (priorAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = priorAgencHome;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("delegate lifecycle recovery", () => {
  it("launches in the background by default", async () => {
    const live = makeLive("thread-bg", "/root/background");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      markThreadSpawnEdgeClosed: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-bg",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run separately",
    });

    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") {
      throw new Error("expected async_launched");
    }
    await outcome.thread.join();
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(control.markThreadSpawnEdgeClosed).toHaveBeenCalledWith("thread-bg");
  });

  it("records summary cache params and tool transcript events from async runs", async () => {
    const live = makeLive("thread-summary", "/root/summary");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const cacheSafeParams = {
      systemPrompt: "",
      userContext: {},
      systemContext: {},
      toolUseContext: {},
      forkContextMessages: [],
    };
    mockRunAgent.mockImplementationOnce((params) =>
      (async function* () {
        params.onCacheSafeParams?.(cacheSafeParams as never);
        yield {
          kind: "tool_call" as const,
          callId: "call-1",
          toolName: "Read",
          arguments: '{"file_path":"x.ts"}',
        };
        yield {
          kind: "tool_result" as const,
          callId: "call-1",
          toolName: "Read",
          result: "file body",
          isError: false,
        };
        return {
          threadId: "thread-summary",
          durationMs: 5,
          outcome: "completed" as const,
          finalMessage: "done",
        };
      })(),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run separately",
    });

    expect(outcome.kind).toBe("async_launched");
    if (outcome.kind !== "async_launched") {
      throw new Error("expected async_launched");
    }
    await outcome.thread.join();
    expect(outcome.thread.summaryCacheSafeParams).toBe(cacheSafeParams);
    expect(outcome.thread.summaryMessages.map((message) => message.type)).toEqual([
      "assistant",
      "user",
    ]);
    expect(outcome.thread.summaryMessages[0]?.message.content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        id: "call-1",
        input: { file_path: "x.ts" },
      }),
    ]);
    expect(outcome.thread.summaryMessages[1]?.message.content).toEqual([
      expect.objectContaining({
        type: "tool_result",
        tool_use_id: "call-1",
      }),
    ]);
  });

  it("forceSynchronous overrides role-level background mode", async () => {
    const live = {
      ...makeLive("thread-sync", "/root/sync"),
      role: {
        ...resolveAgentRole(ROLE_WORKSPACE, undefined),
        config: { background: true },
      },
    };
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-sync",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "run inline",
      runInBackground: false,
      forceSynchronous: true,
    });

    expect(outcome.kind).toBe("sync_completed");
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-sync",
      "delegate_teardown",
    );
  });

  it("passes normalized parent history into forkSubagent for inherited fork modes", async () => {
    const live = makeLive("thread-1", "/root/alpha");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    await delegate({
      parent: {
        ...makeParentSession(),
        snapshotHistoryMessages: () => history,
      } as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "inspect history",
      forkMode: { kind: "full_history" },
    });

    expect(mockForkSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessages: history,
        mode: { kind: "full_history" },
      }),
    );
  });

  it("passes parent history into last_n_turns forks", async () => {
    const live = makeLive("thread-2", "/root/bravo");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      resumeAgentFromRollout: vi.fn(),
    };
    const history = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-2",
        durationMs: 5,
        outcome: "completed",
        finalMessage: "done",
      }),
    );

    await delegate({
      parent: {
        ...makeParentSession(),
        snapshotHistoryMessages: () => history,
      } as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "slice history",
      forkMode: { kind: "last_n_turns", n: 2 },
    });

    expect(mockForkSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessages: history,
        mode: { kind: "last_n_turns", n: 2 },
      }),
    );
  });

  it("rejects worktree isolation without a slug", async () => {
    const control = {
      spawn: vi.fn(),
      shutdown: vi.fn(),
      resumeAgentFromRollout: vi.fn(),
    };

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      isolation: "worktree",
    });

    expect(outcome).toEqual({
      kind: "rejected",
      reason: "worktree isolation requires a non-empty worktreeSlug",
    });
    expect(control.spawn).not.toHaveBeenCalled();
  });

  it("resumes the same live agent after a retryable failure", async () => {
    const live1 = makeLive("thread-1", "/root/alpha");
    const resumedLive = makeLive("thread-1", "/root/alpha");
    const control = {
      spawn: vi.fn(async () => live1),
      shutdown: vi.fn(async () => {}),
      assertAgentMetadataRoleWorkspace: vi.fn(),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: resumedLive,
      })),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({ kind: "resume" as const, reason: "retry" })),
      recordSuccess: vi.fn(),
    };

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 10,
        outcome: "errored",
        error: new Error("transient"),
      }),
    );
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 12,
        outcome: "completed",
        finalMessage: "done after resume",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }

    expect(control.spawn).toHaveBeenCalledTimes(1);
    expect(control.assertAgentMetadataRoleWorkspace).toHaveBeenCalledWith(
      live1.metadata,
    );
    expect(control.shutdown).toHaveBeenCalledWith("thread-1", "delegate_resume");
    expect(control.resumeAgentFromRollout).toHaveBeenCalledWith({
      rootThreadId: "thread-1",
      parentPath: "/root",
      metadata: live1.metadata,
    });
    expect(outcome.thread.threadId).toBe("thread-1");
    expect(outcome.thread.live).toBe(resumedLive);
    expect(outcome.result.finalMessage).toBe("done after resume");
    expect(resumeManager.recordFailure).toHaveBeenCalledOnce();
    expect(resumeManager.recordSuccess).toHaveBeenCalledWith("thread-1");
  });

  it("validates role provenance before mutating retryable resume state", async () => {
    const live = makeLive("thread-provenance", "/root/provenance");
    const control = {
      spawn: vi.fn(async () => live),
      shutdown: vi.fn(async () => {}),
      assertAgentMetadataRoleWorkspace: vi.fn(() => {
        throw new Error("agent role workspace mismatch");
      }),
      resumeAgentFromRollout: vi.fn(),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({ kind: "resume" as const, reason: "retry" })),
      recordSuccess: vi.fn(),
    };
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: live.agentId,
        durationMs: 10,
        outcome: "errored",
        error: new Error("transient"),
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }
    expect(outcome.result.outcome).toBe("errored");
    expect(control.assertAgentMetadataRoleWorkspace).toHaveBeenCalledWith(
      live.metadata,
    );
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(control.resumeAgentFromRollout).not.toHaveBeenCalled();
  });

  it("restarts with a fresh live handle after a hard failure", async () => {
    const live1 = makeLive("thread-1", "/root/alpha");
    const restartedLive = makeLive("thread-2", "/root/bravo");
    const control = {
      spawn: vi
        .fn(async () => live1)
        .mockImplementationOnce(async () => live1)
        .mockImplementationOnce(async () => restartedLive),
      shutdown: vi.fn(async () => {}),
      assertAgentMetadataRoleWorkspace: vi.fn(),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 0,
        rootLive: null,
      })),
    };
    const resumeManager = {
      recordFailure: vi.fn(() => ({
        kind: "restart" as const,
        reason: "hard_error",
      })),
      recordSuccess: vi.fn(),
      transferFailureCount: vi.fn(),
    };

    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-1",
        durationMs: 10,
        outcome: "errored",
        error: new Error("hard fail"),
      }),
    );
    mockRunAgent.mockImplementationOnce(() =>
      runResult({
        threadId: "thread-2",
        durationMs: 12,
        outcome: "completed",
        finalMessage: "done after restart",
      }),
    );

    const outcome = await delegate({
      parent: makeParentSession() as never,
      parentPath: "/root",
      control: control as never,
      registry: {} as never,
      taskPrompt: "fix it",
      runInBackground: false,
      resumeManager: resumeManager as never,
    });

    expect(outcome.kind).toBe("sync_completed");
    if (outcome.kind !== "sync_completed") {
      throw new Error("expected sync_completed");
    }

    expect(control.spawn).toHaveBeenCalledTimes(2);
    expect(control.spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRoleProvenance: live1.metadata,
      }),
    );
    expect(control.assertAgentMetadataRoleWorkspace).toHaveBeenCalledWith(
      live1.metadata,
    );
    expect(control.shutdown).toHaveBeenCalledWith("thread-1", "delegate_restart");
    expect(control.shutdown).toHaveBeenCalledWith(
      "thread-2",
      "delegate_teardown",
    );
    expect(control.resumeAgentFromRollout).not.toHaveBeenCalled();
    expect(outcome.thread.threadId).toBe("thread-2");
    expect(outcome.thread.live).toBe(restartedLive);
    expect(outcome.result.threadId).toBe("thread-2");
    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.finalMessage).toBe("done after restart");
    expect(resumeManager.recordSuccess).toHaveBeenCalledWith("thread-2");
  });

  it("preserves a live edge when a restrictive role changed before restart preflight", async () => {
    const harness = makeRealDelegateHarness("changed-role-restart");
    try {
      registerAgentRole(harness.control.roleWorkspace, {
        name: "scanner",
        config: { disallowlist: ["Edit", "Write"] },
      });
      const spawnSpy = vi.spyOn(harness.control, "spawn");
      const shutdownSpy = vi.spyOn(harness.control, "shutdown");
      const resumeFromRolloutSpy = vi.spyOn(
        harness.control,
        "resumeAgentFromRollout",
      );
      const resumeManager = {
        recordFailure: vi.fn(() => ({
          kind: "restart" as const,
          reason: "hard_error",
        })),
        recordSuccess: vi.fn(),
        transferFailureCount: vi.fn(),
      };
      mockRunAgent.mockImplementationOnce((params) => {
        registerAgentRole(harness.control.roleWorkspace, {
          name: "scanner",
          config: { disallowlist: [] },
        });
        return runResult({
          threadId: params.live.agentId,
          durationMs: 10,
          outcome: "errored",
          error: new Error("hard fail"),
        });
      });

      const outcome = await delegate({
        parent: harness.parent as never,
        parentPath: "/root",
        control: harness.control,
        registry: harness.registry,
        taskPrompt: "inspect only",
        role: "scanner",
        runInBackground: false,
        forceSynchronous: true,
        resumeManager: resumeManager as never,
      });

      expect(outcome.kind).toBe("sync_completed");
      if (outcome.kind !== "sync_completed") {
        throw new Error("expected sync_completed");
      }
      expect(outcome.result.outcome).toBe("errored");
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(shutdownSpy).not.toHaveBeenCalled();
      expect(resumeFromRolloutSpy).not.toHaveBeenCalled();
      expect(harness.control.getLive(outcome.thread.threadId)).toBe(
        outcome.thread.live,
      );
      expect(harness.registry.activeCount).toBe(1);
      expect(
        harness.rolloutStore.getThreadSpawnEdge(outcome.thread.threadId)
          ?.status,
      ).toBe("open");
    } finally {
      harness.cleanup();
    }
  });

  it("preserves a live edge when an alias-named role was removed before resume preflight", async () => {
    const harness = makeRealDelegateHarness("removed-role-resume");
    try {
      registerAgentRole(harness.control.roleWorkspace, {
        name: "scanner",
        config: { disallowlist: ["Edit", "Write"] },
      });
      const spawnSpy = vi.spyOn(harness.control, "spawn");
      const shutdownSpy = vi.spyOn(harness.control, "shutdown");
      const resumeFromRolloutSpy = vi.spyOn(
        harness.control,
        "resumeAgentFromRollout",
      );
      const resumeManager = {
        recordFailure: vi.fn(() => ({
          kind: "resume" as const,
          reason: "transient_provider_error",
        })),
        recordSuccess: vi.fn(),
      };
      mockRunAgent.mockImplementationOnce((params) => {
        // Removing the exact workspace role leaves the public `scanner`
        // built-in alias available. Provenance must not fall through to it.
        _resetAgentRolesForTesting();
        return runResult({
          threadId: params.live.agentId,
          durationMs: 10,
          outcome: "errored",
          error: new Error("transient"),
        });
      });

      const outcome = await delegate({
        parent: harness.parent as never,
        parentPath: "/root",
        control: harness.control,
        registry: harness.registry,
        taskPrompt: "inspect only",
        role: "scanner",
        runInBackground: false,
        forceSynchronous: true,
        resumeManager: resumeManager as never,
      });

      expect(outcome.kind).toBe("sync_completed");
      if (outcome.kind !== "sync_completed") {
        throw new Error("expected sync_completed");
      }
      expect(outcome.result.outcome).toBe("errored");
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(shutdownSpy).not.toHaveBeenCalled();
      expect(resumeFromRolloutSpy).not.toHaveBeenCalled();
      expect(harness.control.getLive(outcome.thread.threadId)).toBe(
        outcome.thread.live,
      );
      expect(harness.registry.activeCount).toBe(1);
      expect(
        harness.rolloutStore.getThreadSpawnEdge(outcome.thread.threadId)
          ?.status,
      ).toBe("open");
    } finally {
      harness.cleanup();
    }
  });
});
