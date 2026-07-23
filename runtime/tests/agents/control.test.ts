import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  AgentControl,
  AgentAssignmentRejectedError,
  AgentReferenceUnresolvedError,
  MAX_AGENT_DEPTH,
  MaxDepthExceededError,
  ThreadNotFoundError,
  renderInputPreview,
} from "./control.js";
import { AgentRegistry, type AgentMetadata } from "./registry.js";
import {
  _resetAgentRolesForTesting,
  _resetNicknamePoolForTesting,
  agentRoleFingerprint,
  createAgentRoleWorkspace,
  registerAgentRole,
  requireAgentRole,
} from "./role.js";
import { RolloutStore } from "../session/rollout-store.js";
import { ThreadManager } from "./thread-manager.js";
import {
  SimpleMailbox,
  type InterAgentCommunication,
} from "../session/session.js";
import { resolveStateDatabasePaths } from "../state/sqlite-driver.js";
import type { ExecutionAdmissionClient } from "../budget/admission-client.js";

let agencHome = "";
let originalAgencHome = "";

function stubSession(
  opts: {
    rolloutStore?: RolloutStore | null;
    conversationId?: string;
    cwd?: string;
    submit?: (
      message: string,
      opts?: { displayUserMessage?: string | null },
    ) => Promise<void>;
    services?: {
      readonly executionAdmission?: ExecutionAdmissionClient;
      readonly admissionRequired?: boolean;
    };
  } = {},
) {
  const emitted: unknown[] = [];
  const mailbox = new SimpleMailbox<
    InterAgentCommunication & { seq: number }
  >();
  const cwd = opts.cwd ?? agencHome;
  return {
    emit: (e: unknown) => {
      emitted.push(e);
    },
    eventLog: {
      emit: (e: unknown) => {
        emitted.push(e);
        return e;
      },
    },
    nextInternalSubId: () => `sub-${emitted.length}`,
    childInboxes: new Map(),
    mailbox,
    ...(opts.submit !== undefined ? { submit: opts.submit } : {}),
    rolloutStore: opts.rolloutStore ?? null,
    conversationId: opts.conversationId ?? "session-test",
    roleWorkspace: createAgentRoleWorkspace(cwd),
    sessionConfiguration: { cwd },
    services: opts.services ?? { admissionRequired: false },
    _emitted: emitted,
  } as unknown as ConstructorParameters<typeof AgentControl>[0]["session"];
}

function openRolloutStore(opts: {
  cwd: string;
  sessionId: string;
  resume?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    ...(opts.resume ? { resume: true } : {}),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    originator: "control-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function roleProvenance(control: AgentControl, roleName: string) {
  return {
    agentRoleWorkspaceId: control.roleWorkspace.id,
    agentRoleFingerprint: agentRoleFingerprint(
      requireAgentRole(control.roleWorkspace, roleName),
    ),
  };
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-control-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
  _resetAgentRolesForTesting();
  _resetNicknamePoolForTesting();
});

afterEach(() => {
  _resetNicknamePoolForTesting();
  _resetAgentRolesForTesting();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("AgentControl", () => {
  it("spawn() produces a LiveAgent with allocated path + nickname", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    expect(live.agentPath.startsWith("/root/")).toBe(true);
    expect(live.nickname).toBeDefined();
    expect(live.depth).toBe(1);
    expect(live.metadata.agentRoleWorkspaceId).toBe(control.roleWorkspace.id);
  });

  it("spawn() can use an explicit task-name path segment", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({
      parentPath: "/root",
      agentName: "task_3",
    });
    expect(live.agentPath).toBe("/root/task_3");
    expect(live.metadata.agentPath).toBe("/root/task_3");
  });

  it("reaps a keep-alive worker idle past the grace and frees its registry slot", async () => {
    vi.useFakeTimers();
    try {
      const session = stubSession();
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      const live = await control.spawn({ parentPath: "/root" });
      expect(registry.activeCount).toBe(1);
      // Worker finishes a turn and parks idle (keep-alive between turns).
      live.status.markRunning("turn-1");
      live.status.markIdle("turn-1");
      // Advance past the 10min grace + one 60s reaper interval.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 60_000 + 1_000);
      expect(live.status.value.status).toBe("shutdown");
      expect(registry.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reap a keep-alive worker that went back to running", async () => {
    vi.useFakeTimers();
    try {
      const session = stubSession();
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      const live = await control.spawn({ parentPath: "/root" });
      live.status.markRunning("turn-1");
      live.status.markIdle("turn-1");
      // Reused before the grace elapses: flips back to running.
      live.status.markRunning("turn-2");
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 60_000 + 1_000);
      expect(live.status.value.status).toBe("running");
      expect(registry.activeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I-1: depth beyond cap is rejected", async () => {
    // maxDepth=2 means depth=2 is accepted and depth=3 rejects.
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const first = await control.spawn({ parentPath: "/root" });
    expect(first.depth).toBe(1);
    const second = await control.spawn({ parentPath: first.agentPath });
    expect(second.depth).toBe(2);
    await expect(
      control.spawn({ parentPath: second.agentPath }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("I-1: depth = cap is accepted", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const d1 = await control.spawn({ parentPath: "/root" });
    const d2 = await control.spawn({ parentPath: d1.agentPath });
    const d3 = await control.spawn({ parentPath: d2.agentPath });
    expect(d3.depth).toBe(3);
    await expect(
      control.spawn({ parentPath: d3.agentPath }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("spawn() rejects unrecognized role names without charging a live slot", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });

    await expect(
      control.spawn({ parentPath: "/root", roleName: "missing-role" }),
    ).rejects.toThrow("unknown agent_type 'missing-role'");
    expect(registry.activeCount).toBe(0);
  });

  it("spawn() atomically rejects changed expected role provenance before mutation", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    registerAgentRole(control.roleWorkspace, {
      name: "scanner",
      config: { disallowlist: ["Edit", "Write"] },
    });
    const expectedRole = requireAgentRole(control.roleWorkspace, "scanner");
    const expectedRoleProvenance = {
      agentRole: expectedRole.name,
      agentRoleWorkspaceId: control.roleWorkspace.id,
      agentRoleFingerprint: agentRoleFingerprint(expectedRole),
    };

    registerAgentRole(control.roleWorkspace, {
      name: "scanner",
      config: { disallowlist: [] },
    });

    await expect(
      control.spawn({
        parentPath: "/root",
        roleName: "scanner",
        expectedRoleProvenance,
      }),
    ).rejects.toThrow("cannot resume changed agent role: scanner");
    expect(registry.activeCount).toBe(0);
    expect(
      (session as unknown as { childInboxes: Map<string, unknown> })
        .childInboxes,
    ).toHaveLength(0);
  });

  it("spawn() does not alias-fallback when an expected workspace role was removed", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    registerAgentRole(control.roleWorkspace, {
      name: "scanner",
      config: { disallowlist: ["Edit", "Write"] },
    });
    const expectedRole = requireAgentRole(control.roleWorkspace, "scanner");
    const expectedRoleProvenance = {
      agentRole: expectedRole.name,
      agentRoleWorkspaceId: control.roleWorkspace.id,
      agentRoleFingerprint: agentRoleFingerprint(expectedRole),
    };
    _resetAgentRolesForTesting();

    await expect(
      control.spawn({
        parentPath: "/root",
        roleName: "scanner",
        expectedRoleProvenance,
      }),
    ).rejects.toThrow("cannot resume unknown agent role: scanner");
    expect(registry.activeCount).toBe(0);
    expect(
      (session as unknown as { childInboxes: Map<string, unknown> })
        .childInboxes,
    ).toHaveLength(0);
  });

  it("spawn() preserves live state when thread IDs or durable provenance conflict", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-persist-a-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "spawn-persistence-conflicts",
    });
    try {
      const sessionA = stubSession({
        rolloutStore,
        cwd,
        conversationId: "root-a",
      });
      const registryA = new AgentRegistry();
      const controlA = new AgentControl({
        session: sessionA,
        registry: registryA,
      });
      controlA.registerSessionRoot("root-a");
      const existing = await controlA.spawn({
        parentPath: "/root",
        threadId: "duplicate-thread",
        agentName: "existing",
      });

      await expect(
        controlA.spawn({
          parentPath: "/root",
          threadId: "duplicate-thread",
          agentName: "duplicate",
        }),
      ).rejects.toThrow("agent thread id already exists");
      expect(registryA.activeCount).toBe(1);
      expect(controlA.getLive(existing.agentId)).toBe(existing);
      expect(registryA.agentIdForPath(existing.agentPath)).toBe(
        existing.agentId,
      );
      expect(registryA.agentIdForPath("/root/duplicate")).toBeUndefined();
      expect(sessionA.childInboxes.size).toBe(1);

      rolloutStore.upsertThreadSpawnEdge({
        parentThreadId: "root-a",
        childThreadId: "durable-conflict",
        parentPath: "/root",
        metadata: {
          agentId: "durable-conflict",
          agentPath: "/root/original",
          agentNickname: "original",
          agentRole: "default",
          ...roleProvenance(controlA, "default"),
          depth: 1,
        },
        status: "open",
      });
      const durableBefore = rolloutStore.getThreadSpawnEdge("durable-conflict");

      const sessionB = stubSession({
        rolloutStore,
        cwd,
        conversationId: "root-b",
      });
      const registryB = new AgentRegistry();
      const controlB = new AgentControl({
        session: sessionB,
        registry: registryB,
      });
      controlB.registerSessionRoot("root-b");
      await expect(
        controlB.spawn({
          parentPath: "/root",
          threadId: "durable-conflict",
          agentName: "failed",
        }),
      ).rejects.toThrow("agent thread id already exists");
      expect(registryB.activeCount).toBe(0);
      expect(registryB.liveAgents()).toEqual([]);
      expect(registryB.agentIdForPath("/root/failed")).toBeUndefined();
      expect(controlB.getLive("durable-conflict")).toBeUndefined();
      expect(sessionB.childInboxes.size).toBe(0);
      expect(rolloutStore.getThreadSpawnEdge("durable-conflict")).toEqual(
        durableBefore,
      );
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("spawn() restores allocated and preferred nicknames after durable insert failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-nickname-rollback-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "nickname-persistence-rollback",
    });
    const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
    try {
      const session = stubSession({
        cwd,
        conversationId: "nickname-root",
        rolloutStore,
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      control.registerSessionRoot("nickname-root");
      registerAgentRole(control.roleWorkspace, {
        name: "single-nickname",
        config: { nicknameCandidates: ["only-nickname"] },
      });
      raw.exec(`
        CREATE TRIGGER reject_control_spawn
        BEFORE INSERT ON thread_spawn_edges
        BEGIN
          SELECT RAISE(ABORT, 'forced spawn persistence failure');
        END;
      `);

      await expect(
        control.spawn({
          parentPath: "/root",
          roleName: "single-nickname",
          agentName: "allocated_failure",
        }),
      ).rejects.toThrow("forced spawn persistence failure");
      expect(registry.hasNickname("only-nickname")).toBe(false);

      await expect(
        control.spawn({
          parentPath: "/root",
          preferredNickname: "preferred-failure",
          agentName: "preferred_failure",
        }),
      ).rejects.toThrow("forced spawn persistence failure");
      expect(registry.hasNickname("preferred-failure")).toBe(false);
      expect(registry.activeCount).toBe(0);
      expect(registry.liveAgents()).toEqual([]);
      expect(control.listLive()).toEqual([]);
      expect(
        (session as unknown as { childInboxes: Map<string, unknown> })
          .childInboxes.size,
      ).toBe(0);
    } finally {
      raw.close();
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns the committed child and releases capacity when admission reconciliation fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-reconcile-failure-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "spawn-reconcile-failure",
    });
    const acquire = vi.fn(
      async (input: Parameters<ExecutionAdmissionClient["acquire"]>[0]) => ({
        decision: "allow" as const,
        reservation: {
          reservationId: "spawn-reconcile-reservation",
          step: { runId: "reconcile-root", stepId: input.stepId },
          kind: input.kind,
          estimate: {
            maxInputTokens: input.maxInputTokens,
            maxOutputTokens: input.maxOutputTokens,
            maxCostUsd: input.maxCostUsd,
          },
        },
        request: {},
        signal: new AbortController().signal,
      }),
    );
    const markDispatched = vi.fn();
    const reconcile = vi.fn(() => {
      throw new Error("forced reconciliation journal failure");
    });
    const holdUnknown = vi.fn();
    const acknowledgeCompletion = vi.fn();
    const admission = {
      scope: {
        runId: "reconcile-root",
        workspaceId: cwd,
        sessionId: "reconcile-root",
        autonomous: false,
      },
      acquire,
      markDispatched,
      reconcile,
      holdUnknown,
      acknowledgeCompletion,
      cancelRun: vi.fn(),
      void: vi.fn(),
      recordFallback: vi.fn(),
      forSession: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } as unknown as ExecutionAdmissionClient;
    try {
      const session = stubSession({
        cwd,
        conversationId: "reconcile-root",
        rolloutStore,
        services: { executionAdmission: admission, admissionRequired: true },
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      control.registerSessionRoot("reconcile-root");

      const child = await control.spawn({
        parentPath: "/root",
        threadId: "committed-reconcile-child",
        agentName: "committed_child",
      });

      expect(child.agentId).toBe("committed-reconcile-child");
      expect(control.getLive(child.agentId)).toBe(child);
      expect(registry.agentIdForPath("/root/committed_child")).toBe(
        child.agentId,
      );
      expect(rolloutStore.getThreadSpawnEdge(child.agentId)?.status).toBe(
        "open",
      );
      expect(reconcile).toHaveBeenCalledWith("spawn-reconcile-reservation", {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
      expect(holdUnknown).toHaveBeenCalledWith(
        "spawn-reconcile-reservation",
        "spawn_reconciliation_failed_after_commit",
      );
      expect(acknowledgeCompletion).toHaveBeenCalledWith(
        "spawn-reconcile-reservation",
      );
      expect(
        (
          session as unknown as {
            _emitted: Array<{
              msg?: { type?: string; payload?: { cause?: string } };
            }>;
          }
        )._emitted.some(
          (event) =>
            event.msg?.type === "warning" &&
            event.msg.payload?.cause ===
              "spawn_admission_reconciliation_failed",
        ),
      ).toBe(true);

      await expect(
        control.spawn({
          parentPath: "/root",
          threadId: "committed-reconcile-child",
          agentName: "duplicate_child",
        }),
      ).rejects.toThrow("agent thread id already exists");
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("releases admission capacity when durable-edge failure journaling also fails", async () => {
    const cwd = mkdtempSync(
      join(tmpdir(), "agenc-control-settlement-failure-"),
    );
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "spawn-settlement-failure",
    });
    const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
    const holdUnknown = vi.fn(() => {
      throw new Error("forced unknown-hold journal failure");
    });
    const acknowledgeCompletion = vi.fn();
    const admission = {
      scope: {
        runId: "settlement-root",
        workspaceId: cwd,
        sessionId: "settlement-root",
        autonomous: false,
      },
      acquire: vi.fn(
        async (input: Parameters<ExecutionAdmissionClient["acquire"]>[0]) => ({
          decision: "allow" as const,
          reservation: {
            reservationId: "spawn-settlement-reservation",
            step: { runId: "settlement-root", stepId: input.stepId },
          },
          request: {},
          signal: new AbortController().signal,
        }),
      ),
      markDispatched: vi.fn(),
      reconcile: vi.fn(),
      holdUnknown,
      acknowledgeCompletion,
      cancelRun: vi.fn(),
      void: vi.fn(),
      recordFallback: vi.fn(),
      forSession: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } as unknown as ExecutionAdmissionClient;
    try {
      raw.exec(`
        CREATE TRIGGER reject_admitted_control_spawn
        BEFORE INSERT ON thread_spawn_edges
        BEGIN
          SELECT RAISE(ABORT, 'forced admitted spawn persistence failure');
        END;
      `);
      const session = stubSession({
        cwd,
        conversationId: "settlement-root",
        rolloutStore,
        services: { executionAdmission: admission, admissionRequired: true },
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      control.registerSessionRoot("settlement-root");

      await expect(
        control.spawn({
          parentPath: "/root",
          threadId: "settlement-failure-child",
          agentName: "settlement_failure",
        }),
      ).rejects.toThrow("forced admitted spawn persistence failure");

      expect(holdUnknown).toHaveBeenCalledWith(
        "spawn-settlement-reservation",
        "spawn_commit_outcome_unknown",
      );
      expect(acknowledgeCompletion).toHaveBeenCalledOnce();
      expect(acknowledgeCompletion).toHaveBeenCalledWith(
        "spawn-settlement-reservation",
      );
      expect(control.getLive("settlement-failure-child")).toBeUndefined();
      expect(registry.activeCount).toBe(0);
    } finally {
      raw.close();
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not publish a child when its parent is interrupted during edge persistence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-persist-cancel-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "spawn-persistence-cancel",
    });
    try {
      const session = stubSession({
        cwd,
        conversationId: "cancel-root",
        rolloutStore,
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 2 });
      control.registerSessionRoot("cancel-root");
      const parent = await control.spawn({
        parentPath: "/root",
        threadId: "cancel-parent",
        agentName: "parent",
      });
      const createEdge = rolloutStore.createThreadSpawnEdge.bind(rolloutStore);
      vi.spyOn(rolloutStore, "createThreadSpawnEdge").mockImplementation(
        (edge) => {
          createEdge(edge);
          if (edge.childThreadId === "cancel-child") {
            control.interrupt(parent.agentId, "test persistence race");
          }
        },
      );

      await expect(
        control.spawn({
          parentPath: parent.agentPath,
          threadId: "cancel-child",
          agentName: "child",
        }),
      ).rejects.toThrow("interrupted mid-spawn");

      expect(control.getLive("cancel-child")).toBeUndefined();
      expect(registry.agentIdForPath("/root/parent/child")).toBeUndefined();
      expect(registry.activeCount).toBe(1);
      expect(rolloutStore.getThreadSpawnEdge("cancel-child")?.status).toBe(
        "closed",
      );
      expect(
        (
          session as unknown as { childInboxes: Map<string, unknown> }
        ).childInboxes.has("cancel-child"),
      ).toBe(false);
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a cancelled child registered when durable edge close fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-close-failure-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "spawn-close-failure",
    });
    try {
      const session = stubSession({
        cwd,
        conversationId: "close-failure-root",
        rolloutStore,
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 2 });
      const threadManager = new ThreadManager({ control, registry });
      control.bindThreadManager(threadManager);
      control.registerSessionRoot("close-failure-root");
      const parent = await control.spawn({
        parentPath: "/root",
        threadId: "close-failure-parent",
        agentName: "parent",
      });
      const createEdge = rolloutStore.createThreadSpawnEdge.bind(rolloutStore);
      vi.spyOn(rolloutStore, "createThreadSpawnEdge").mockImplementation(
        (edge) => {
          createEdge(edge);
          if (edge.childThreadId === "close-failure-child") {
            control.interrupt(parent.agentId, "test close failure");
          }
        },
      );
      const closeSpy = vi
        .spyOn(rolloutStore, "setThreadSpawnEdgeStatus")
        .mockImplementation((childThreadId, status) => {
          if (childThreadId === "close-failure-child" && status === "closed") {
            throw new Error("forced edge close failure");
          }
          throw new Error("unexpected edge status call");
        });

      await expect(
        control.spawn({
          parentPath: parent.agentPath,
          threadId: "close-failure-child",
          agentName: "child",
        }),
      ).rejects.toThrow("forced edge close failure");

      const child = control.getLive("close-failure-child");
      expect(
        rolloutStore.getThreadSpawnEdge("close-failure-child")?.status,
      ).toBe("open");
      expect(child).toBeDefined();
      expect(child?.abortController.signal.aborted).toBe(true);
      expect(registry.agentIdForPath("/root/parent/child")).toBe(
        "close-failure-child",
      );
      expect(threadManager.getThread("close-failure-child").threadId).toBe(
        "close-failure-child",
      );
      expect(
        (
          session as unknown as { childInboxes: Map<string, unknown> }
        ).childInboxes.has("close-failure-child"),
      ).toBe(true);
      closeSpy.mockRestore();
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("AgentControlOpts.maxDepth override is honored", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 0 });
    // cap=0 permits only the root session.
    await expect(control.spawn({ parentPath: "/root" })).rejects.toBeInstanceOf(
      MaxDepthExceededError,
    );
  });

  it("MAX_AGENT_DEPTH default is 1", () => {
    expect(MAX_AGENT_DEPTH).toBe(1);
  });

  it("reads agent_max_depth from the session config when no explicit override is provided", async () => {
    const session = stubSession() as ReturnType<typeof stubSession> & {
      config: { agent_max_depth: number };
    };
    session.config = { agent_max_depth: 2 };
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    expect(child.depth).toBe(2);
  });

  it("allows a per-call depth cap without changing the session cap", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 1 });
    const parent = await control.spawn({
      parentPath: "/root",
      agentName: "parent",
    });

    await expect(
      control.spawn({ parentPath: parent.agentPath, agentName: "blocked" }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);

    const child = await control.spawn({
      parentPath: parent.agentPath,
      agentName: "child",
      depthCap: 2,
    });
    expect(child.agentPath).toBe("/root/parent/child");
    expect(child.depth).toBe(2);

    await expect(
      control.spawn({
        parentPath: child.agentPath,
        agentName: "too_deep",
        depthCap: 2,
      }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("interrupt() cascades to descendants and fires AbortController", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    control.interrupt(parent.agentId, "user_interrupt");
    expect(parent.abortController.signal.aborted).toBe(true);
    expect(child.abortController.signal.aborted).toBe(true);
  });

  it("shutdown() clears live + registry + childInboxes", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const live = await control.spawn({ parentPath: "/root" });
    expect(control.listLive().length).toBe(1);
    await control.shutdown(live.agentId);
    expect(control.listLive().length).toBe(0);
    expect(registry.activeCount).toBe(0);
  });

  it("keeps the live control plane intact when durable close fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-close-failure-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "shutdown-durability-first",
    });
    const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
    try {
      const session = stubSession({
        cwd,
        conversationId: "root-close-failure",
        rolloutStore,
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      control.registerSessionRoot("root-close-failure");
      const live = await control.spawn({
        parentPath: "/root",
        agentName: "durable_child",
      });
      raw.exec(`
        CREATE TRIGGER reject_control_close
        BEFORE UPDATE OF status ON thread_spawn_edges
        WHEN OLD.child_thread_id = '${live.agentId}' AND NEW.status = 'closed'
        BEGIN
          SELECT RAISE(ABORT, 'forced close failure');
        END;
      `);

      await expect(
        control.shutdown(live.agentId, "closed_by_tool"),
      ).rejects.toThrow("forced close failure");
      expect(control.getLive(live.agentId)).toBe(live);
      expect(registry.agentIdForPath(live.agentPath)).toBe(live.agentId);
      expect(registry.activeCount).toBe(1);
      expect(live.upInbox.isClosed).toBe(false);
      expect(live.downInbox.isClosed).toBe(false);
      expect(live.abortController.signal.aborted).toBe(false);
      expect(
        (
          session as unknown as { childInboxes: Map<string, unknown> }
        ).childInboxes.get(live.agentId),
      ).toBe(live.upInbox);
      expect(rolloutStore.getThreadSpawnEdge(live.agentId)?.status).toBe(
        "open",
      );
    } finally {
      raw.close();
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("shutdownAll() cascades every live agent", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const a = await control.spawn({ parentPath: "/root" });
    const b = await control.spawn({ parentPath: "/root" });
    expect(control.listLive().length).toBe(2);
    await control.shutdownAll("session_shutdown");
    expect(control.listLive().length).toBe(0);
    expect(a.abortController.signal.aborted).toBe(true);
    expect(b.abortController.signal.aborted).toBe(true);
  });

  it("descendantsOf() filters by path prefix", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    const other = await control.spawn({ parentPath: "/root" });
    const descendants = control.descendantsOf(parent.agentPath);
    expect(descendants.map((d) => d.agentId)).toEqual([child.agentId]);
    void other;
  });

  it("resume() registers unknown metadata and returns a LiveAgent", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "thread-resume-1",
      agentPath: "/root/scout",
      agentNickname: "scout",
      agentRole: "explorer",
      ...roleProvenance(control, "explorer"),
      depth: 1,
    };
    const live = await control.resume({ parentPath: "/root", metadata });
    expect(live).not.toBeNull();
    expect(live!.agentId).toBe("thread-resume-1");
    expect(live!.agentPath).toBe("/root/scout");
    expect(live!.nickname).toBe("scout");
    expect(live!.depth).toBe(1);
    expect(live!.role.name).toBe("explorer");
    expect(registry.agentMetadataForThread("thread-resume-1")).toBeDefined();
    expect(registry.activeCount).toBe(1);
  });

  it("resume() fails closed for named legacy metadata without workspace provenance", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await expect(
      control.resume({
        parentPath: "/root",
        metadata: {
          agentId: "thread-legacy-role",
          agentPath: "/root/legacy_role",
          agentNickname: "legacy-role",
          agentRole: "worker",
          depth: 1,
        },
      }),
    ).rejects.toThrow("agent role workspace provenance is missing");
    expect(registry.activeCount).toBe(0);
  });

  it("resume() rejects malformed persisted roles before registry mutation", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    for (const [index, agentRole] of ["", null, false, 0].entries()) {
      await expect(
        control.resume({
          parentPath: "/root",
          metadata: {
            agentId: `thread-malformed-role-${index}`,
            agentPath: `/root/malformed_role_${index}`,
            agentNickname: `malformed-role-${index}`,
            agentRole: agentRole as never,
            agentRoleWorkspaceId: control.roleWorkspace.id,
            depth: 1,
          },
        }),
      ).rejects.toThrow("invalid agent metadata agentRole");
      expect(registry.activeCount).toBe(0);
    }
  });

  it("resume() resolves same-named roles only inside the session workspace", async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), "agenc-resume-role-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "agenc-resume-role-b-"));
    try {
      registerAgentRole(createAgentRoleWorkspace(workspaceA), {
        name: "shared-resume-role",
        config: { systemPrompt: "Workspace A resume prompt." },
      });
      registerAgentRole(createAgentRoleWorkspace(workspaceB), {
        name: "shared-resume-role",
        config: { systemPrompt: "Workspace B resume prompt." },
      });

      const registryA = new AgentRegistry();
      const registryB = new AgentRegistry();
      const controlA = new AgentControl({
        session: stubSession({
          cwd: workspaceA,
          conversationId: "workspace-a",
        }),
        registry: registryA,
      });
      const controlB = new AgentControl({
        session: stubSession({
          cwd: workspaceB,
          conversationId: "workspace-b",
        }),
        registry: registryB,
      });
      const metadata = (marker: "a" | "b"): AgentMetadata => ({
        agentId: `thread-resume-${marker}`,
        agentPath: `/root/resume_${marker}`,
        agentNickname: `resume-${marker}`,
        agentRole: "shared-resume-role",
        ...roleProvenance(
          marker === "a" ? controlA : controlB,
          "shared-resume-role",
        ),
        depth: 1,
      });

      const resumedA = await controlA.resume({
        parentPath: "/root",
        metadata: metadata("a"),
      });
      const resumedB = await controlB.resume({
        parentPath: "/root",
        metadata: metadata("b"),
      });

      expect(resumedA?.role.config.systemPrompt).toBe(
        "Workspace A resume prompt.",
      );
      expect(resumedB?.role.config.systemPrompt).toBe(
        "Workspace B resume prompt.",
      );
      await expect(
        controlB.resume({ parentPath: "/root", metadata: metadata("a") }),
      ).rejects.toThrow("agent role workspace mismatch");
      expect(registryB.activeCount).toBe(1);
    } finally {
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
  });

  it("resume() is idempotent for an already-live path", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const spawned = await control.spawn({ parentPath: "/root" });
    const metadata: AgentMetadata = {
      agentId: spawned.agentId,
      agentPath: spawned.agentPath,
      agentNickname: spawned.nickname,
      agentRole: spawned.role.name,
      agentRoleWorkspaceId: spawned.metadata.agentRoleWorkspaceId,
      agentRoleFingerprint: spawned.metadata.agentRoleFingerprint,
      depth: spawned.depth,
    };
    const resumed = await control.resume({
      parentPath: "/root",
      metadata,
    });
    expect(resumed).toBe(spawned);
    expect(registry.activeCount).toBe(1);
  });

  it("resume() rejects root, id, path, and role identity conflicts without mutation", async () => {
    const session = stubSession({ conversationId: "identity-root" });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    control.registerSessionRoot("identity-root");
    const live = await control.spawn({
      parentPath: "/root",
      agentName: "identity_child",
    });
    const base = live.metadata;
    const beforeInboxes = (
      session as unknown as { childInboxes: Map<string, unknown> }
    ).childInboxes.size;

    await expect(
      control.resume({
        parentPath: "/root",
        metadata: { ...base, agentId: "different-id" },
      }),
    ).rejects.toThrow(/identity conflicts/);
    await expect(
      control.resume({
        parentPath: "/root",
        metadata: { ...base, agentPath: "/root/different_path" },
      }),
    ).rejects.toThrow(/identity conflicts/);
    await expect(
      control.resume({
        parentPath: "/root",
        metadata: {
          ...base,
          agentRole: "explorer",
          ...roleProvenance(control, "explorer"),
        },
      }),
    ).rejects.toThrow(/does not match registered metadata/);
    await expect(
      control.resume({
        parentPath: "/root",
        metadata: {
          ...base,
          agentId: "identity-root",
          agentPath: "/root/root_copy",
        },
      }),
    ).rejects.toThrow(/session root/);

    expect(control.listLive()).toEqual([live]);
    expect(registry.activeCount).toBe(1);
    expect(registry.agentIdForPath(live.agentPath)).toBe(live.agentId);
    expect(
      (session as unknown as { childInboxes: Map<string, unknown> })
        .childInboxes.size,
    ).toBe(beforeInboxes);
  });

  it("resume() respects I-1 depth cap", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const metadata: AgentMetadata = {
      agentId: "thread-too-deep",
      agentPath: "/root/a/b/c",
      agentNickname: "too-deep",
      agentRole: "default",
      ...roleProvenance(control, "default"),
      depth: 3,
    };
    await expect(
      control.resume({ parentPath: "/root/a/b", metadata }),
    ).rejects.toBeInstanceOf(MaxDepthExceededError);
  });

  it("resume() rejects depth and parent lineage inconsistent with the agent path", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 4 });
    const base: AgentMetadata = {
      agentId: "thread-lineage",
      agentPath: "/root/a/b/c",
      agentNickname: "lineage",
      agentRole: "default",
      ...roleProvenance(control, "default"),
      depth: 3,
    };

    await expect(
      control.resume({
        parentPath: "/root/a/b",
        metadata: { ...base, depth: 0 },
      }),
    ).rejects.toThrow("does not match path depth");
    await expect(
      control.resume({ parentPath: "/root", metadata: base }),
    ).rejects.toThrow("does not match path parent");
    expect(registry.activeCount).toBe(0);
    expect(control.listLive()).toEqual([]);
  });

  it("resume() attaches the upInbox to session.childInboxes", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "thread-attach-1",
      agentPath: "/root/attach",
      agentNickname: "attach",
      agentRole: "default",
      ...roleProvenance(control, "default"),
      depth: 1,
    };
    const live = await control.resume({ parentPath: "/root", metadata });
    expect(live).not.toBeNull();
    const inboxes = (
      session as unknown as { childInboxes: Map<string, unknown> }
    ).childInboxes;
    expect(inboxes.get("thread-attach-1")).toBe(live!.upInbox);
  });

  it("resume() emits an agent_resumed warning", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "thread-emit-1",
      agentPath: "/root/emit",
      agentNickname: "emit",
      agentRole: "default",
      ...roleProvenance(control, "default"),
      depth: 1,
    };
    await control.resume({ parentPath: "/root", metadata });
    const emitted = (
      session as unknown as {
        _emitted: Array<{
          msg: { type: string; payload?: { cause?: string; message?: string } };
        }>;
      }
    )._emitted;
    const resumed = emitted.find(
      (e) =>
        e?.msg?.type === "warning" &&
        e?.msg?.payload?.cause === "agent_resumed",
    );
    expect(resumed).toBeDefined();
    expect(resumed!.msg.payload!.message).toContain("/root/emit");
    expect(resumed!.msg.payload!.message).toContain("emit");
  });

  // ───────────────────────────────────────────────────────────
  // Priority-1 routing (sendInput / appendMessage / IAC)
  // ───────────────────────────────────────────────────────────

  it("sendInput() routes to the child's downInbox + records preview", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    await control.sendInput(live.agentId, "hello from parent\nsecond line");
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]!;
    expect((msg as { triggerTurn: boolean }).triggerTurn).toBe(true);
    expect((msg as { content: string }).content).toContain("hello from parent");
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBe("hello from parent");
  });

  it("sendInput() throws ThreadNotFoundError for unknown thread id", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await expect(control.sendInput("missing", "x")).rejects.toBeInstanceOf(
      ThreadNotFoundError,
    );
  });

  it("clearConversationHistory() clears live messages and queues a history boundary", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    live.messages.push({ role: "assistant", content: "old reply" });

    await control.clearConversationHistory(live.agentId);

    expect(live.messages).toEqual([]);
    expect(live.downInbox.drain()).toEqual([
      expect.objectContaining({
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "history_clear" },
      }),
    ]);
  });

  it("appendMessage() sends non-turn-triggering message", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    await control.appendMessage(live.agentId, "context blob");
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]!;
    expect((msg as { triggerTurn: boolean }).triggerTurn).toBe(false);
    expect((msg as { content: string }).content).toBe("context blob");
    // appendMessage does NOT update lastTaskMessage (AgenC behavior).
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBeUndefined();
  });

  it("sendInterAgentCommunication() updates lastTaskMessage", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    await control.sendInterAgentCommunication(live.agentId, {
      author: "/root",
      recipient: live.agentPath,
      content: "iac payload",
      triggerTurn: false,
      metadata: { taskId: "task-123", deliveryMode: "queue_only" },
    });
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]! as { triggerTurn: boolean; content: string };
    expect(msg.triggerTurn).toBe(false);
    expect(msg.content).toBe("iac payload");
    expect(
      (msg as { metadata?: Readonly<Record<string, unknown>> }).metadata,
    ).toEqual({
      kind: "inter_agent_communication",
      taskId: "task-123",
      deliveryMode: "queue_only",
    });
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBe("iac payload");
  });

  it("assignTask() atomically reserves one assignment for an idle worker", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    live.status.markRunning("initial-turn");
    live.status.markIdle("initial-turn");

    const accepted = control.assignTask(live.agentId, {
      author: "/root",
      recipient: live.agentPath,
      content: "first task",
      taskId: "task-1",
    });

    expect(accepted).toEqual({
      taskId: "task-1",
      turnId: expect.any(String),
    });
    expect(live.assignment).toMatchObject({
      taskId: "task-1",
      turnId: accepted.turnId,
      author: "/root",
      state: "accepted",
    });
    expect(() =>
      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "racing task",
        taskId: "task-2",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentAssignmentRejectedError>>({
        code: "assignment_outstanding",
      }),
    );
    expect(live.downInbox.drain()).toEqual([
      expect.objectContaining({
        author: "/root",
        recipient: live.agentPath,
        content: "first task",
        triggerTurn: true,
        metadata: expect.objectContaining({
          taskId: "task-1",
          turnId: accepted.turnId,
        }),
      }),
    ]);
  });

  it("assignTask() rejects busy, self-targeted, and non-ancestor senders", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });

    expect(() =>
      control.assignTask(child.agentId, {
        author: parent.agentPath,
        recipient: child.agentPath,
        content: "busy",
        taskId: "busy-task",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentAssignmentRejectedError>>({
        code: "worker_not_idle",
      }),
    );

    child.status.markRunning("initial-turn");
    child.status.markIdle("initial-turn");
    expect(() =>
      control.assignTask(child.agentId, {
        author: child.agentPath,
        recipient: child.agentPath,
        content: "self",
        taskId: "self-task",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentAssignmentRejectedError>>({
        code: "self_target",
      }),
    );
    expect(() =>
      control.assignTask(child.agentId, {
        author: "/root/peer",
        recipient: child.agentPath,
        content: "peer",
        taskId: "peer-task",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentAssignmentRejectedError>>({
        code: "sender_not_ancestor",
      }),
    );
  });

  it("sendInterAgentCommunication() can queue a message to the root session", async () => {
    const submit = vi.fn(async () => {});
    const session = stubSession({ conversationId: "root-thread", submit });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    control.registerSessionRoot("root-thread");
    await control.sendInterAgentCommunication("root-thread", {
      author: "/root/task_3",
      recipient: "/root",
      content: "final answer",
      triggerTurn: true,
    });
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith("", { displayUserMessage: null });
    });
    const drained = session.mailbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      author: "/root/task_3",
      recipient: "/root",
      content: "final answer",
      triggerTurn: true,
    });
  });

  it("retries a transient root follow-up failure while its trigger remains queued", async () => {
    vi.useFakeTimers();
    try {
      let session!: ReturnType<typeof stubSession>;
      const submit = vi
        .fn<NonNullable<Parameters<typeof stubSession>[0]["submit"]>>()
        .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
        .mockImplementationOnce(async () => {
          session.mailbox.drain();
        });
      session = stubSession({ conversationId: "root-thread", submit });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      control.registerSessionRoot("root-thread");

      await control.sendInterAgentCommunication("root-thread", {
        author: "/root/task_3",
        recipient: "/root",
        content: "retry this trigger",
        triggerTurn: true,
      });
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      expect(session.mailbox.hasPending()).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      expect(submit).toHaveBeenCalledTimes(2);
      expect(session.mailbox.hasPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a failed root follow-up for passive-only residue", async () => {
    vi.useFakeTimers();
    try {
      let session!: ReturnType<typeof stubSession>;
      const submit = vi.fn(async () => {
        session.mailbox.extractWhere((message) => message.triggerTurn);
        throw new Error("failed after trigger drain");
      });
      session = stubSession({ conversationId: "root-thread", submit });
      session.mailbox.send({
        author: "/root/task_3",
        recipient: "/root",
        content: "passive context",
        triggerTurn: false,
        direction: "up",
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      control.registerSessionRoot("root-thread");

      await control.sendInterAgentCommunication("root-thread", {
        author: "/root/task_3",
        recipient: "/root",
        content: "consumed trigger",
        triggerTurn: true,
      });
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      expect(session.mailbox.hasPending()).toBe(true);
      expect(session.mailbox.hasPendingTriggerTurn()).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ───────────────────────────────────────────────────────────
  // Priority-2 metadata + subtree queries
  // ───────────────────────────────────────────────────────────

  it("getAgentMetadata() returns registry metadata", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    const meta = control.getAgentMetadata(live.agentId);
    expect(meta).toBeDefined();
    expect(meta!.agentPath).toBe(live.agentPath);
    expect(meta!.depth).toBe(1);
  });

  it("listLiveAgentSubtreeThreadIds() returns self + descendants", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    const sub = control.listLiveAgentSubtreeThreadIds(parent.agentId);
    expect(sub).toContain(parent.agentId);
    expect(sub).toContain(child.agentId);
    expect(sub.length).toBe(2);
  });

  it("listAgents() filters by role name", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    // Don't register root — we want to assert the filter picks exactly
    // the one explorer child, not the synthetic root entry.
    await control.spawn({ parentPath: "/root", roleName: "explorer" });
    await control.spawn({ parentPath: "/root", roleName: "worker" });
    const explorers = control.listAgents({ roleName: "explorer" });
    expect(explorers.every((a) => a.agentName !== "/root")).toBe(true);
    expect(explorers.length).toBe(1);
  });

  it("listAgents() applies pathPrefix filter", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    control.registerSessionRoot("root-id");
    const p = await control.spawn({ parentPath: "/root" });
    await control.spawn({ parentPath: p.agentPath });
    const scoped = control.listAgents({ pathPrefix: p.agentPath });
    // Prefix excludes /root.
    expect(scoped.every((a) => a.agentName !== "/root")).toBe(true);
    expect(scoped.length).toBeGreaterThanOrEqual(2);
  });

  it("getTotalTokenUsage() aggregates live child usage", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const child = await control.spawn({ parentPath: "/root" });
    control.recordAgentUsage(child.agentId, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    const usage = control.getTotalTokenUsage();
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(7);
    expect(usage.totalTokens).toBe(18);
  });

  it("formatEnvironmentContextSubagents() produces a textual subtree", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    const text = control.formatEnvironmentContextSubagents(parent.agentId);
    expect(text).toContain(child.agentPath);
    expect(text).toContain(child.nickname);
  });

  it("resolveAgentReference() resolves @nickname to a live agent", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    const id = control.resolveAgentReference({
      reference: `@${live.nickname}`,
    });
    expect(id).toBe(live.agentId);
  });

  it("resolveAgentReference() throws when reference is unknown", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await control.spawn({ parentPath: "/root" });
    expect(() =>
      control.resolveAgentReference({ reference: "@nobody" }),
    ).toThrow(AgentReferenceUnresolvedError);
  });

  it("getAgentConfigSnapshot() returns a compact snapshot", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({
      parentPath: "/root",
      roleName: "explorer",
    });
    const snap = control.getAgentConfigSnapshot(live.agentId);
    expect(snap).toBeDefined();
    expect(snap!.threadId).toBe(live.agentId);
    expect(snap!.agentRole).toBe("explorer");
    expect(snap!.depth).toBe(1);
  });

  it("registerSessionRoot() lets listAgents include /root", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    // Before register: listAgents omits /root.
    const before = control.listAgents();
    expect(before.some((a) => a.agentName === "/root")).toBe(false);
    control.registerSessionRoot("root-1");
    const after = control.listAgents();
    expect(after.some((a) => a.agentName === "/root")).toBe(true);
  });

  // ───────────────────────────────────────────────────────────
  // Priority-3 completion watcher + rollout resume
  // ───────────────────────────────────────────────────────────

  it("maybeStartCompletionWatcher() emits IAC to parent on child completion", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    control.maybeStartCompletionWatcher({
      childThreadId: child.agentId,
      parentThreadId: parent.agentId,
    });
    child.status.markCompleted("turn-1", "done");
    // Give the microtask/watcher a chance to flush.
    await new Promise<void>((r) => setTimeout(r, 10));
    const drained = parent.downInbox.drain();
    expect(drained.length).toBeGreaterThanOrEqual(1);
    const msg = drained[0]! as {
      author: string;
      recipient: string;
      content: string;
      triggerTurn: boolean;
      metadata?: { kind?: string };
    };
    expect(msg.author).toBe(child.agentPath);
    expect(msg.recipient).toBe(parent.agentPath);
    expect(msg.triggerTurn).toBe(true);
    expect(msg.content).toBe(
      `<subagent_notification>\n{"agent_path":"${child.agentPath}","status":{"completed":"done"}}\n</subagent_notification>`,
    );
    expect(msg.metadata?.kind).toBe("inter_agent_communication");
  });

  it("maybeStartCompletionWatcher() treats completed as terminal and does not reopen it", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });

    control.maybeStartCompletionWatcher({
      childThreadId: child.agentId,
      parentThreadId: parent.agentId,
    });
    child.status.markCompleted("turn-1", "first done");
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(
      parent.downInbox
        .drain()
        .map((msg) => ("content" in msg ? msg.content : "")),
    ).toEqual([
      `<subagent_notification>\n{"agent_path":"${child.agentPath}","status":{"completed":"first done"}}\n</subagent_notification>`,
    ]);

    child.status.markRunning("turn-2");
    child.status.markCompleted("turn-2", "second done");
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(parent.downInbox.drain()).toEqual([]);
    expect(child.status.value).toMatchObject({
      status: "completed",
      turnId: "turn-1",
    });
  });

  it("maybeStartCompletionWatcher() queues root-child completion through the root session mailbox", async () => {
    const session = stubSession({ conversationId: "root-thread" });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    control.registerSessionRoot("root-thread");
    const child = await control.spawn({ parentPath: "/root" });

    control.maybeStartCompletionWatcher({
      childThreadId: child.agentId,
      parentThreadId: "root-thread",
    });
    child.status.markCompleted("turn-1", "done");

    await new Promise<void>((r) => setTimeout(r, 10));
    const drained = session.mailbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      author: child.agentPath,
      recipient: "/root",
      content: `<subagent_notification>\n{"agent_path":"${child.agentPath}","status":{"completed":"done"}}\n</subagent_notification>`,
      triggerTurn: true,
      direction: "up",
      metadata: { kind: "inter_agent_communication" },
    });
  });

  it("maybeStartCompletionWatcher() notifies the parent when the child handle is missing", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const parent = await control.spawn({ parentPath: "/root" });

    control.maybeStartCompletionWatcher({
      childThreadId: "missing-child-thread",
      parentThreadId: parent.agentId,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    const drained = parent.downInbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      content:
        '<subagent_notification>\n{"agent_path":"missing-child-thread","status":"not_found"}\n</subagent_notification>',
      triggerTurn: false,
      direction: "down",
      metadata: { kind: "subagent_notification", finalStatus: "not_found" },
    });
  });

  it("resumeAgentFromRollout() reopens open descendants after shutdown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-open-descendants",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });
      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(3);
      expect(result.rootLive).not.toBeNull();
      expect(result.rootLive!.agentId).toBe(root.agentId);
      expect(control.getLive(child.agentId)?.agentPath).toBe(child.agentPath);
      expect(control.getLive(grandchild.agentId)?.agentPath).toBe(
        grandchild.agentPath,
      );
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() restores descendants on a fresh control plane restart", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const sessionId = "resume-fresh-control-plane";
    const originalRolloutStore = openRolloutStore({
      cwd,
      sessionId,
    });
    let resumedRolloutStore: RolloutStore | null = null;
    try {
      const originalSession = stubSession({
        rolloutStore: originalRolloutStore,
        conversationId: sessionId,
      });
      const originalRegistry = new AgentRegistry();
      const originalControl = new AgentControl({
        session: originalSession,
        registry: originalRegistry,
        maxDepth: 3,
      });
      const root = await originalControl.spawn({ parentPath: "/root" });
      const child = await originalControl.spawn({ parentPath: root.agentPath });
      const grandchild = await originalControl.spawn({
        parentPath: child.agentPath,
      });

      await originalControl.shutdownAll("manager_shutdown");
      originalRolloutStore.close();

      resumedRolloutStore = openRolloutStore({
        cwd,
        sessionId,
        resume: true,
      });
      const resumedSession = stubSession({
        rolloutStore: resumedRolloutStore,
        conversationId: sessionId,
      });
      const resumedRegistry = new AgentRegistry();
      const resumedControl = new AgentControl({
        session: resumedSession,
        registry: resumedRegistry,
        maxDepth: 3,
      });

      const result = await resumedControl.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(3);
      expect(result.rootLive?.agentId).toBe(root.agentId);
      expect(resumedControl.getLive(child.agentId)?.agentPath).toBe(
        child.agentPath,
      );
      expect(resumedControl.getLive(grandchild.agentId)?.agentPath).toBe(
        grandchild.agentPath,
      );
    } finally {
      originalRolloutStore.close();
      resumedRolloutStore?.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() skips descendants beneath a closed child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-skips-closed-child",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });

      await control.shutdown(child.agentId, "delegate_teardown");
      await control.shutdown(root.agentId, "session_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(1);
      expect(control.getLive(child.agentId)).toBeUndefined();
      expect(control.getLive(grandchild.agentId)).toBeUndefined();
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() uses persisted edge metadata for descendants", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-uses-persisted-edge-metadata",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });
      const expectedPath = grandchild.agentPath;

      (
        grandchild.metadata as {
          agentPath?: string;
          depth: number;
        }
      ).agentPath = "/root/stale";
      (grandchild.metadata as { depth: number }).depth = 99;

      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(3);
      expect(control.getLive(grandchild.agentId)?.agentPath).toBe(expectedPath);
      expect(control.getLive(grandchild.agentId)?.depth).toBe(3);
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() skips descendants when parent resume fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-skips-corrupt-subtree",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      const child = await control.spawn({ parentPath: root.agentPath });
      const grandchild = await control.spawn({ parentPath: child.agentPath });

      const resumeSingle = control.resumeSingleAgentFromRollout.bind(control);
      vi.spyOn(control, "resumeSingleAgentFromRollout").mockImplementation(
        async (opts) => {
          if (opts.metadata.agentId === child.agentId) {
            throw new Error("child metadata corrupted");
          }
          return resumeSingle(opts);
        },
      );

      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(1);
      expect(control.getLive(child.agentId)).toBeUndefined();
      expect(control.getLive(grandchild.agentId)).toBeUndefined();
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resumeAgentFromRollout() rejects an edge whose parent id and path name different live agents", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-rollout-"));
    const rolloutStore = openRolloutStore({
      cwd,
      sessionId: "resume-rejects-parent-identity-split",
    });
    try {
      const session = stubSession({ rolloutStore });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry, maxDepth: 3 });
      const root = await control.spawn({
        parentPath: "/root",
        threadId: "real-root-child",
        agentName: "real_parent",
      });
      rolloutStore.createThreadSpawnEdge({
        childThreadId: "orphan-child",
        parentThreadId: root.agentId,
        parentPath: "/root/missing",
        metadata: {
          agentId: "orphan-child",
          agentPath: "/root/missing/orphan",
          agentNickname: "orphan",
          depth: 2,
        },
        status: "open",
      });
      await control.shutdownAll("manager_shutdown");

      const result = await control.resumeAgentFromRollout({
        rootThreadId: root.agentId,
        parentPath: "/root",
        metadata: root.metadata,
      });

      expect(result.resumedCount).toBe(1);
      expect(control.getLive("orphan-child")).toBeUndefined();
      expect(registry.agentIdForPath("/root/missing/orphan")).toBeUndefined();
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────
  // Priority-4 fork-mode spawn helpers
  // ───────────────────────────────────────────────────────────

  it("spawnForkedThread() requires a fork parent spawn-call id", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    await expect(
      control.spawnForkedThread("/root", { kind: "full_history" }),
    ).rejects.toThrow(/spawn_agent fork requires a parent spawn call id/);
  });

  it("spawnForkedThread() spawns with fork mode attached (happy path)", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawnForkedThread(
      "/root",
      { kind: "last_n_turns", n: 3 },
      { forkParentSpawnCallId: "call-123" },
    );
    expect(live).toBeDefined();
    expect(live.agentPath.startsWith("/root/")).toBe(true);
    expect(live.depth).toBe(1);
  });

  it("spawnAgentWithMetadata() accepts preset role + threadId", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawnAgentWithMetadata("/root", {
      roleName: "worker",
      threadId: "preset-thread-1",
    });
    expect(live.agentId).toBe("preset-thread-1");
    expect(live.role.name).toBe("worker");
  });

  it("spawnAgentWithMetadata() validates named metadata even with an explicit role", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const invalidMetadata = [
      { agentRole: "worker" },
      {
        agentRole: "worker",
        agentRoleWorkspaceId: createAgentRoleWorkspace(
          join(agencHome, "other-workspace"),
        ).id,
      },
    ] as const;

    for (const metadata of invalidMetadata) {
      await expect(
        control.spawnAgentWithMetadata("/root", {
          roleName: "worker",
          metadata,
        }),
      ).rejects.toThrow(/workspace (provenance is missing|mismatch)/);
      expect(registry.activeCount).toBe(0);
    }
  });

  // ───────────────────────────────────────────────────────────
  // Priority-5 subtree genealogy + render helper
  // ───────────────────────────────────────────────────────────

  it("prepareThreadSpawn() composes metadata without spawning", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const preview = control.prepareThreadSpawn({ parentPath: "/root" });
    expect(preview.metadata.agentPath!.startsWith("/root/")).toBe(true);
    expect(preview.metadata.agentId).toBe("pending");
    // No slot was consumed.
    expect(registry.activeCount).toBe(0);
  });

  it("openThreadSpawnChildren() returns direct children in path order", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 2 });
    const parent = await control.spawn({ parentPath: "/root" });
    const a = await control.spawn({ parentPath: parent.agentPath });
    const b = await control.spawn({ parentPath: parent.agentPath });
    const children = control.openThreadSpawnChildren(parent.agentId);
    expect(children.map(([, m]) => m.agentPath)).toEqual(
      [a, b]
        .map((x) => x.agentPath)
        .slice()
        .sort((l, r) => l.localeCompare(r)),
    );
  });

  it("liveThreadSpawnDescendants() walks the full tree", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const a = await control.spawn({ parentPath: "/root" });
    const b = await control.spawn({ parentPath: a.agentPath });
    const c = await control.spawn({ parentPath: b.agentPath });
    const descendants = control.liveThreadSpawnDescendants(a.agentId);
    expect(descendants).toContain(b.agentId);
    expect(descendants).toContain(c.agentId);
    expect(descendants.length).toBe(2);
  });

  it("renderInputPreview() keeps first line + truncates", () => {
    expect(renderInputPreview("one line")).toBe("one line");
    expect(renderInputPreview("first line\nsecond")).toBe("first line");
    const big = "x".repeat(300);
    const out = renderInputPreview(big);
    expect(out.length).toBe(200);
    expect(out.endsWith("...")).toBe(true);
  });
});
