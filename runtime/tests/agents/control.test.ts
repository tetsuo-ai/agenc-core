import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { createMultiAgentV2Tools } from "../../src/agents/v2/index.js";
import { injectChildToolArgs } from "../../src/agents/run-agent.js";
import { authorizeChildExecutionPlan, createChildExecutionPlan } from "../../src/agents/cross-provider.js";
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
  createAgentRoleWorkspace,
  registerAgentRole,
} from "./role.js";
import { RolloutStore } from "../session/rollout-store.js";
import { ThreadManager } from "./thread-manager.js";
import {
  SimpleMailbox,
  type InterAgentCommunication,
  type Session,
} from "../session/session.js";
import { upsertAgentRun } from "../state/agent-runs.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
} from "../state/sqlite-driver.js";
import type { ExecutionAdmissionClient } from "../budget/admission-client.js";
import {
  createMailboxMetadataRecord,
  isAgentExitedSentinel,
  readMailboxMetadata,
} from "./mailbox.js";

let agencHome = "";
let originalAgencHome = "";

const TEST_RUN_TIMESTAMP = "2026-08-03T00:00:00.000Z";

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
      readonly unifiedExecManager?: {
        readonly terminateOwnedProcesses: (request: { ownerId: string }) => { results: [] };
      };
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
    agencHome,
    sessionTempRoot: tmpdir(),
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

function seedRunningAgentRun(cwd: string, runId: string): void {
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    upsertAgentRun(driver, {
      id: runId,
      objective: "agent-control spawn-edge test fixture",
      status: "running",
      startedAt: TEST_RUN_TIMESTAMP,
      lastActiveAt: TEST_RUN_TIMESTAMP,
    });
  } finally {
    driver.close();
  }
}

function registerDurableSessionRoot(
  control: AgentControl,
  cwd: string,
  threadId: string,
): void {
  seedRunningAgentRun(cwd, threadId);
  control.registerSessionRoot(threadId);
}

function roleProvenance(control: AgentControl, roleName: string) {
  const role = control.roleCatalog.require(roleName);
  return {
    agentRoleWorkspaceId: control.roleWorkspace.id,
    agentRoleFingerprint: control.roleCatalog.fingerprint(role),
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
  it("snapshots and interrupts a worker with a string status projection", async () => {
    const session = stubSession();
    const control = new AgentControl({ session, registry: new AgentRegistry() });
    control.registerSessionRoot(session.conversationId);
    const worker = await control.spawn({ parentPath: "/root" });
    const status = vi.spyOn(worker.status, "value", "get").mockReturnValue("running" as never);
    try {
      expect(control.snapshotNativeWorkers(session.conversationId)[0]).toMatchObject({
        agentId: worker.agentId, status: "running",
      });
      expect(control.snapshotNativeWorkers(session.conversationId)[0]).not.toHaveProperty("terminal");
      control.interrupt(worker.agentId, "user_cancel");
      expect(worker.status.subject.value).toMatchObject({ status: "interrupted", turnId: worker.agentId });
    } finally {
      status.mockRestore();
      await control.shutdownAll();
    }
  });

  it("projects an object status terminal in native worker snapshots", async () => {
    const { childTerminalOutcome } = await import("../../src/agents/child-terminal.js");
    const session = stubSession();
    const control = new AgentControl({ session, registry: new AgentRegistry() });
    control.registerSessionRoot(session.conversationId);
    const worker = await control.spawn({ parentPath: "/root" });
    try {
      const terminal = childTerminalOutcome({ provider: "fake", model: "fake-model",
        reason: "completed", dispatch: "sent", completedWork: "done" });
      worker.status.markIdle("turn-1", terminal);
      expect(control.snapshotNativeWorkers(session.conversationId)[0]).toMatchObject({
        agentId: worker.agentId, status: "idle", terminal,
      });
    } finally { await control.shutdownAll(); }
  });
  it("preserves actual turn timing when interrupting a worker by its thread ID", async () => {
    const session = stubSession();
    const control = new AgentControl({ session, registry: new AgentRegistry() });
    control.registerSessionRoot(session.conversationId);
    const worker = await control.spawn({ parentPath: "/root" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      worker.status.markRunning("executing-turn");
      clock.mockReturnValue(130_000);
      control.interrupt(worker.agentId, "user_cancel");
      expect(worker.status.value).toMatchObject({ status: "interrupted", turnId: "executing-turn" });
      clock.mockReturnValue(200_000);
      worker.status.markInterrupted("executing-turn", "user_cancel");
      expect(control.snapshotNativeWorkers(session.conversationId)[0]?.timing)
        .toEqual({ turnId: "executing-turn", startedAt: 100_000, endedAt: 130_000 });
    } finally {
      clock.mockRestore();
      await control.shutdownAll();
    }
  });

  it("snapshots only current native descendants of the requested parent, including idle workers", async () => {
    const session = stubSession();
    const control = new AgentControl({ session, registry: new AgentRegistry(), maxDepth: 3 });
    control.registerSessionRoot(session.conversationId);
    const parent = await control.spawn({ parentPath: "/root" });
    const sibling = await control.spawn({ parentPath: "/root" });
    const child = await control.spawn({ parentPath: parent.agentPath });
    parent.status.markRunning("parent-turn");
    parent.status.markIdle("parent-turn");
    child.status.markRunning("child-turn");
    child.toolCallCount = 4;
    child.tokenUsage.totalTokens = 321;
    expect(control.snapshotNativeWorkers(parent.agentId)).toEqual([
      expect.objectContaining({ agentId: child.agentId, status: "running", toolUseCount: 4, tokenCount: 321 }),
    ]);
    expect(control.snapshotNativeWorkers(session.conversationId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: parent.agentId, status: "idle" }),
      expect.objectContaining({ agentId: sibling.agentId, status: "pending_init" }),
    ]));
    expect(control.snapshotNativeWorkers("unrelated-parent")).toEqual([]);
    await control.closeAgent(child.agentId);
    expect(control.snapshotNativeWorkers(parent.agentId)).toEqual([]);
    expect(control.snapshotNativeWorkers(session.conversationId)).toHaveLength(2);
    await control.shutdownAll();
  });

  it("retains planning authority through a live nested spawn after YOLO, without restricting an ordinary verification sibling", async () => {
    const session = stubSession();
    let context = createEmptyToolPermissionContext({ mode: "plan" });
    Object.assign(session, { permissionModeRegistry: { current: () => context } });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const inspector = await control.spawn({ parentPath: "/root", roleName: "default" });
    expect(inspector.metadata.executionConstraint).toMatchObject({ kind: "read-only", ownerThreadId: session.conversationId });
    context = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
    const descendant = await control.spawn({ parentPath: inspector.agentPath, roleName: "verification" });
    const sibling = await control.spawn({ parentPath: "/root", roleName: "verification" });
    expect(descendant.metadata.executionConstraint).toEqual(inspector.metadata.executionConstraint);
    expect(sibling.metadata.executionConstraint).toBeUndefined();
  });

  it("restores a persisted planning constraint even under a writable current parent", async () => {
    const session = stubSession();
    let context = createEmptyToolPermissionContext({ mode: "plan" });
    Object.assign(session, { permissionModeRegistry: { current: () => context } });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const inspector = await control.spawn({ parentPath: "/root", roleName: "default" });
    context = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
    const recovered = await control.spawn({ parentPath: "/root", expectedRoleProvenance: JSON.parse(JSON.stringify(inspector.metadata)) });
    expect(recovered.metadata.executionConstraint).toEqual(inspector.metadata.executionConstraint);
  });

  it("uses the signed child sender's readonly authority in root-owned coordinator closures", async () => {
    const session = stubSession();
    let context = createEmptyToolPermissionContext({ mode: "plan" });
    Object.assign(session, { permissionModeRegistry: { current: () => context } });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });
    const inspector = await control.spawn({ parentPath: "/root", roleName: "default" });
    context = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
    const writer = await control.spawn({ parentPath: "/root", roleName: "default" });
    const tools = createMultiAgentV2Tools({ getSession: () => session, workspace: control.roleWorkspace, roleCatalog: control.roleCatalog, ensureAgentControl: () => ({ control, registry }) });
    for (const name of ["send_message", "assign_task", "close_agent"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const args = injectChildToolArgs({ target: writer.agentPath, ...(name !== "close_agent" ? { message: "change something" } : {}) }, name, { childConversationId: inspector.agentId });
      const result = await tool.execute(args);
      expect(result.isError, result.content).toBe(true);
      expect(result.content).toContain("own constrained descendants");
    }
  });

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

  it("atomically transfers one pre-reserved capacity permit without reserving again", async () => {
    const session = stubSession();
    const registry = new AgentRegistry({ maxThreads: 1 });
    const control = new AgentControl({ session, registry });
    const permit = await registry.acquireSpawnPermit({ ownerId: "csv-job" });

    const live = await control.spawn({
      parentPath: "/root",
      agentName: "csv_worker",
      capacityPermit: permit,
      capacityOwnerId: "csv-job",
    });
    expect(registry.activeCount).toBe(1);
    expect(permit.isConsumed()).toBe(true);
    await control.shutdown(live.agentId, "test_complete");
    expect(registry.activeCount).toBe(0);
  });

  it("keeps an idle reusable worker alive indefinitely between assignments", async () => {
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
      // Long swarms can park workers for hours before assigning follow-up
      // work. Advancing a full day must not trigger hidden lifecycle cleanup.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(live.status.value.status).toBe("idle");
      expect(registry.activeCount).toBe(1);
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
    const expectedRole = control.roleCatalog.require("scanner");
    const expectedRoleProvenance = {
      agentRole: expectedRole.name,
      agentRoleWorkspaceId: control.roleWorkspace.id,
      agentRoleFingerprint: "0".repeat(64),
    };

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

  it("spawn() rejects the built-in role when an expected workspace override was removed", async () => {
    const workspace = createAgentRoleWorkspace(agencHome);
    registerAgentRole(workspace, {
      name: "scanner",
      config: { disallowlist: ["Edit", "Write"] },
    });
    const originalControl = new AgentControl({
      session: stubSession({ cwd: workspace.cwd }),
      registry: new AgentRegistry(),
    });
    const expectedRole = originalControl.roleCatalog.require("scanner");
    const expectedRoleProvenance = {
      agentRole: expectedRole.name,
      agentRoleWorkspaceId: originalControl.roleWorkspace.id,
      agentRoleFingerprint: originalControl.roleCatalog.fingerprint(expectedRole),
    };
    _resetAgentRolesForTesting();
    const session = stubSession({ cwd: workspace.cwd });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });

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
      registerDurableSessionRoot(controlA, cwd, "root-a");
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
      registerDurableSessionRoot(controlB, cwd, "root-b");
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
    const raw = new Database(
      resolveStateDatabasePaths({ cwd, agencHome }).stateDbPath,
    );
    try {
      const session = stubSession({
        cwd,
        conversationId: "nickname-root",
        rolloutStore,
      });
      registerAgentRole(session.roleWorkspace, {
        name: "single-nickname",
        config: { nicknameCandidates: ["only-nickname"] },
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      registerDurableSessionRoot(control, cwd, "nickname-root");
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
      registerDurableSessionRoot(control, cwd, "reconcile-root");

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
    const raw = new Database(
      resolveStateDatabasePaths({ cwd, agencHome }).stateDbPath,
    );
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
      registerDurableSessionRoot(control, cwd, "settlement-root");

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
      registerDurableSessionRoot(control, cwd, "cancel-root");
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
      registerDurableSessionRoot(control, cwd, "close-failure-root");
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

  it("treats canonical agent_max_depth zero as no subagent spawning", async () => {
    const session = stubSession() as ReturnType<typeof stubSession> & {
      config: { agent_max_depth: number };
    };
    session.config = { agent_max_depth: 0 };
    const control = new AgentControl({
      session,
      registry: new AgentRegistry(),
    });

    await expect(control.spawn({ parentPath: "/root" })).rejects.toMatchObject({
      cap: 0,
      depth: 1,
    });
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
    const raw = new Database(
      resolveStateDatabasePaths({ cwd, agencHome }).stateDbPath,
    );
    try {
      const session = stubSession({
        cwd,
        conversationId: "root-close-failure",
        rolloutStore,
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      registerDurableSessionRoot(control, cwd, "root-close-failure");
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
      agentRole: "scanner",
      ...roleProvenance(control, "scanner"),
      depth: 1,
    };
    const live = await control.resume({ parentPath: "/root", metadata });
    expect(live).not.toBeNull();
    expect(live!.agentId).toBe("thread-resume-1");
    expect(live!.agentPath).toBe("/root/scout");
    expect(live!.nickname).toBe("scout");
    expect(live!.depth).toBe(1);
    expect(live!.role.name).toBe("scanner");
    expect(registry.agentMetadataForThread("thread-resume-1")).toBeDefined();
    expect(registry.activeCount).toBe(1);
  });

  it("refuses a cross-provider child without a consent plan before persisting an edge", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-cross-provider-edge-"));
    const rolloutStore = openRolloutStore({ cwd, sessionId: "cross-provider-root" });
    try {
      const session = stubSession({ cwd, conversationId: "cross-provider-root", rolloutStore });
      const config = {
        model_provider: "grok",
        model: "grok-4.6",
        agents: { cross_provider_enabled: true, allowed_providers: ["deepseek"] },
      };
      Object.assign(session, {
        modelInfo: { slug: "grok-4.6" },
        providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }) },
        services: { ...session.services, configStore: { current: () => config } },
      });
      const registry = new AgentRegistry();
      const control = new AgentControl({ session, registry });
      registerDurableSessionRoot(control, cwd, "cross-provider-root");
      await expect(control.spawn({
        parentPath: "/root",
        providerSelection: { provider: "deepseek", model: "deepseek-v4-pro" },
      })).rejects.toThrow(/consent_unavailable/u);
      expect(registry.activeCount).toBe(0);
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists the complete child plan and rechecks its policy on resume", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-child-plan-edge-"));
    const rolloutStore = openRolloutStore({ cwd, sessionId: "plan-root" });
    try {
      const session = stubSession({ cwd, conversationId: "plan-root", rolloutStore });
      let allowed = ["deepseek"];
      const config = () => ({ model_provider: "grok", model: "grok-4.6",
        agents: { cross_provider_enabled: true, allowed_providers: allowed } });
      Object.assign(session, {
        modelInfo: { slug: "grok-4.6", provider: "grok" },
        providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }) },
        services: { ...session.services, configStore: { current: config } },
      });
      const control = new AgentControl({ session, registry: new AgentRegistry(), maxDepth: 3 });
      registerDurableSessionRoot(control, cwd, "plan-root");
      Object.assign(session.services, { crossProviderConsent: {
        ownerSessionId: "plan-root", sessionEpoch: "test-interactive-session",
        request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
          kind: "granted" as const,
          grant: { kind: "once" as const, ownerSessionId: "plan-root", sessionEpoch: "test-interactive-session",
            taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
        }),
      } });
      const proposedPlan = await createChildExecutionPlan({
        session, selection: { provider: "deepseek", model: "deepseek-v4-pro" },
        modelInfo: { slug: "deepseek-v4-pro", provider: "deepseek", supportsToolUse: true } as Session["modelInfo"],
        parentPath: "/root", taskId: "spawn-plan", taskName: "worker", taskText: "inspect",
        toolFree: false, forkedHistory: false,
      });
      const authorized = await authorizeChildExecutionPlan(session, proposedPlan);
      expect(authorized.kind).toBe("granted");
      if (authorized.kind !== "granted") throw new Error("fixture consent was not granted");
      const plan = authorized.plan;
      const live = await control.spawn({ parentPath: "/root", agentName: "worker",
        providerSelection: plan.route, executionPlan: plan });
      await expect(control.spawn({ parentPath: live.agentPath }))
        .rejects.toThrow(/consent provenance/u);
      expect(rolloutStore.getThreadSpawnEdge(live.agentId)?.metadata.executionPlan).toEqual(plan);
      expect(control.getAgentConfigSnapshot(live.agentId)?.executionPlan).toEqual(plan);
      expect(control.listAgents().find((agent) => agent.agentName === live.agentPath))
        .toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
      expect(control.snapshotNativeWorkers(session.conversationId).find((agent) => agent.agentId === live.agentId))
        .toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
      allowed = ["deepseek", "openai"];
      await expect(control.resume({ parentPath: "/root", metadata: live.metadata }))
        .rejects.toThrow(/execution plan.*policy changed/u);
    } finally {
      rolloutStore.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["provider removed", "credential gone"])("refuses legacy cross-provider recovery without a consent plan when %s", async (failure) => {
    const session = stubSession();
    let allowed = ["deepseek"];
    let credentialReady = true;
    const prepare = vi.fn(async () => {
      if (!credentialReady) throw new Error("DeepSeek credential is missing; add a saved API key");
      return { binding: { instance: { dispose: vi.fn() } } };
    });
    Object.assign(session, {
      modelInfo: { slug: "grok-4.6" },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }), prepare, prepareChild: prepare },
      services: { ...session.services, configStore: { current: () => ({ model_provider: "grok", model: "grok-4.6", agents: { cross_provider_enabled: true, allowed_providers: allowed } }) } },
    });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const metadata: AgentMetadata = {
      agentId: "cross-recovery", agentPath: "/root/cross_recovery", agentNickname: "cross",
      agentRole: "scanner", ...roleProvenance(control, "scanner"), depth: 1,
      crossProvider: { provider: "deepseek", model: "deepseek-v4-pro", policy: "user-or-managed-agents-v1" },
    };
    if (failure === "provider removed") allowed = [];
    else credentialReady = false;
    await expect(control.resume({ parentPath: "/root", metadata })).rejects.toThrow(/resume_blocked/u);
    expect(registry.activeCount).toBe(0);
  });

  it("blocks recovery of a signed-out sign-in child before dispatch", async () => {
    const session = stubSession({ conversationId: "sign-in-root" });
    let signedIn = true;
    const prepareChild = vi.fn(async () => {
      if (!signedIn) throw new Error("openai authentication failed (HTTP 401): signed out");
      return { authProfile: "sign_in", billingSource: "sign_in",
        binding: { instance: { dispose: vi.fn() }, factoryOptions: {
          baseURL: "https://chatgpt.com/backend-api/codex" } } };
    });
    Object.assign(session, {
      modelInfo: { slug: "grok-4.6", provider: "grok" },
      sessionConfiguration: { ...session.sessionConfiguration, cwd: "/workspace",
        collaborationMode: { model: "grok-4.6" } },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }), prepareChild,
        previewChildDestination: async () => ({ endpoint: "https://chatgpt.com/backend-api/codex",
          authProfile: "sign_in", billingSource: "sign_in" }) },
      services: { ...session.services, configStore: { current: () => ({ model_provider: "grok",
        model: "grok-4.6", agents: { cross_provider_enabled: true, allowed_providers: ["openai"] } }) },
        crossProviderConsent: { ownerSessionId: "sign-in-root", sessionEpoch: "live-epoch",
          request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
            kind: "granted" as const, grant: { kind: "once" as const, ownerSessionId: "sign-in-root",
              sessionEpoch: "live-epoch", taskId: disclosure.taskId,
              scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
          }) } },
    });
    const control = new AgentControl({ session, registry: new AgentRegistry() });
    const proposed = await createChildExecutionPlan({ session,
      selection: { provider: "openai", model: "gpt-6-luna" },
      modelInfo: { slug: "gpt-6-luna", provider: "openai", supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "sign-in-task", taskName: "worker", taskText: "inspect",
      toolFree: false, forkedHistory: false });
    const authorized = await authorizeChildExecutionPlan(session, proposed);
    expect(authorized.kind).toBe("granted");
    if (authorized.kind !== "granted") throw new Error("fixture consent was not granted");
    signedIn = false;
    const metadata: AgentMetadata = {
      agentId: "sign-in-child", agentPath: "/root/sign_in_child", agentNickname: "sign-in child",
      agentRole: "scanner", ...roleProvenance(control, "scanner"), depth: 1,
      crossProvider: { provider: "openai", model: "gpt-6-luna", policy: "user-or-managed-agents-v1" },
      executionPlan: authorized.plan,
    };
    await expect(control.resume({ parentPath: "/root", metadata })).rejects.toThrow(/resume_blocked/u);
    expect(prepareChild).toHaveBeenCalledOnce();
  });

  it("resumes an approved account-only OpenAI child after its parent switches to OpenAI", async () => {
    const session = stubSession({ conversationId: "account-model-root" });
    let parentProvider = "grok";
    let unrelatedDefaultModel: string | undefined;
    const prepareChild = vi.fn(async () => ({
      authProfile: "sign_in" as const, billingSource: "sign_in" as const,
      signInModelCapabilities: { supportsToolUse: true },
      binding: { provider: "openai", model: "account-only-model",
        instance: { dispose: vi.fn() }, factoryOptions: {
          baseURL: "https://chatgpt.com/backend-api/codex" } },
    }));
    Object.assign(session, {
      modelInfo: { slug: "grok-4.6", provider: "grok" },
      sessionConfiguration: { ...session.sessionConfiguration, cwd: "/workspace",
        collaborationMode: { model: "grok-4.6" } },
      providerService: { current: () => ({ provider: parentProvider, model: "grok-4.6" }),
        prepareChild, previewChildDestination: async () => ({
          endpoint: "https://chatgpt.com/backend-api/codex",
          authProfile: "sign_in", billingSource: "sign_in" }) },
      services: { ...session.services, configStore: { current: () => ({
        model_provider: "grok", model: "grok-4.6",
        ...(unrelatedDefaultModel !== undefined ? { providers: { ollama: {
          default_model: unrelatedDefaultModel } } } : {}),
        agents: { cross_provider_enabled: true, allowed_providers: ["openai"] } }) },
        crossProviderConsent: { ownerSessionId: "account-model-root", sessionEpoch: "live-epoch",
          request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
            kind: "granted" as const, grant: { kind: "once" as const,
              ownerSessionId: "account-model-root", sessionEpoch: "live-epoch",
              taskId: disclosure.taskId, scopeKey: disclosure.scopeKey,
              payloadKey: disclosure.payloadKey },
          }) } },
    });
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const proposed = await createChildExecutionPlan({ session,
      selection: { provider: "openai", model: "account-only-model" },
      modelInfo: { slug: "account-only-model", provider: "openai",
        supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "account-task", taskName: "worker",
      taskText: "inspect", toolFree: false, forkedHistory: false });
    const authorized = await authorizeChildExecutionPlan(session, proposed);
    expect(authorized.kind).toBe("granted");
    if (authorized.kind !== "granted") throw new Error("fixture consent was not granted");
    parentProvider = "openai";
    unrelatedDefaultModel = "my-local-finetune";
    const metadata: AgentMetadata = {
      agentId: "account-child", agentPath: "/root/account_child",
      agentNickname: "account child", agentRole: "scanner",
      ...roleProvenance(control, "scanner"), depth: 1,
      crossProvider: { provider: "openai", model: "account-only-model",
        policy: "user-or-managed-agents-v1" }, executionPlan: authorized.plan,
    };
    await expect(control.resume({ parentPath: "/root", metadata }))
      .resolves.toMatchObject({ agentId: "account-child" });
    expect(prepareChild).toHaveBeenCalledOnce();
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
          agentRole: "runner",
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
          agentRole: "scanner",
          ...roleProvenance(control, "scanner"),
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
    const [boundary] = live.downInbox.drain();
    expect(boundary).toMatchObject({
      triggerTurn: false,
      direction: "down",
    });
    if (boundary === undefined || !("metadata" in boundary)) {
      throw new Error("expected history boundary metadata");
    }
    expect(readMailboxMetadata(boundary.metadata)).toEqual({
      kind: "history_clear",
    });
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
      metadata: createMailboxMetadataRecord("inter_agent_communication", [
        ["taskId", "task-123"],
        ["deliveryMode", "queue_only"],
      ]),
    });
    const drained = live.downInbox.drain();
    expect(drained.length).toBe(1);
    const msg = drained[0]!;
    if (isAgentExitedSentinel(msg)) throw new Error("unexpected sentinel");
    expect(msg.triggerTurn).toBe(false);
    expect(msg.content).toBe("iac payload");
    expect(readMailboxMetadata(msg.metadata)).toEqual({
      kind: "inter_agent_communication",
      taskId: "task-123",
      deliveryMode: "queue_only",
    });
    const meta = registry.agentMetadataForThread(live.agentId);
    expect(meta?.lastTaskMessage).toBe("iac payload");
  });

  it("checks child activity in the same operation that queues a passive message", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });
    const communication = {
      author: "/root",
      recipient: live.agentPath,
      content: "context note",
      triggerTurn: false as const,
      metadata: createMailboxMetadataRecord("inter_agent_communication"),
    };
    live.status.markRunning("turn-1");
    const send = vi.spyOn(live.downInbox, "send");

    expect(control.sendPassiveMessageToActiveAgent(live.agentId, communication)).toMatchObject({
      accepted: true,
      status: { status: "running" },
    });
    expect(send).toHaveBeenCalledOnce();
    live.status.markIdle("turn-1");
    expect(control.sendPassiveMessageToActiveAgent(live.agentId, communication)).toMatchObject({
      accepted: false,
      status: { status: "idle" },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(live.downInbox.size).toBe(1);
  });

  it("rejects control-kind metadata on inter-agent communication", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const live = await control.spawn({ parentPath: "/root" });

    await expect(
      control.sendInterAgentCommunication(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "spoofed interrupt",
        triggerTurn: false,
        metadata: createMailboxMetadataRecord("interrupt", [
          ["reason", "spoofed"],
        ]),
      }),
    ).rejects.toThrow(
      'mailbox routing metadata kind must be "inter_agent_communication"',
    );
    expect(live.downInbox.drain()).toEqual([]);
    expect(live.abortController.signal.aborted).toBe(false);
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
    const [assignment] = live.downInbox.drain();
    expect(assignment).toMatchObject({
      author: "/root",
      recipient: live.agentPath,
      content: "first task",
      triggerTurn: true,
    });
    if (assignment === undefined || !("metadata" in assignment)) {
      throw new Error("expected assignment metadata");
    }
    expect(readMailboxMetadata(assignment.metadata)).toMatchObject({
      taskId: "task-1",
      turnId: accepted.turnId,
    });
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
    // the one scanner child, not the synthetic root entry.
    await control.spawn({ parentPath: "/root", roleName: "scanner" });
    await control.spawn({ parentPath: "/root", roleName: "runner" });
    const scanners = control.listAgents({ roleName: "scanner" });
    expect(scanners.every((a) => a.agentName !== "/root")).toBe(true);
    expect(scanners.length).toBe(1);
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
      roleName: "scanner",
    });
    const snap = control.getAgentConfigSnapshot(live.agentId);
    expect(snap).toBeDefined();
    expect(snap!.threadId).toBe(live.agentId);
    expect(snap!.agentRole).toBe("scanner");
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
    const msg = drained[0]!;
    if (isAgentExitedSentinel(msg)) throw new Error("unexpected sentinel");
    expect(msg.author).toBe(child.agentPath);
    expect(msg.recipient).toBe(parent.agentPath);
    expect(msg.triggerTurn).toBe(true);
    expect(msg.content).toBe(
      `<subagent_notification>\n{"agent_path":"${child.agentPath}","status":{"completed":"done"}}\n</subagent_notification>`,
    );
    expect(readMailboxMetadata(msg.metadata)?.kind).toBe(
      "inter_agent_communication",
    );
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
    });
    const missingNotification = drained[0];
    if (
      missingNotification === undefined ||
      !("metadata" in missingNotification)
    ) {
      throw new Error("expected missing-agent notification metadata");
    }
    expect(readMailboxMetadata(missingNotification.metadata)).toEqual({
      kind: "subagent_notification",
      finalStatus: "not_found",
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
      seedRunningAgentRun(cwd, root.agentId);
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

  it("rehydrates a nested child with a persisted same-provider plan before parent sessions are bound", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-nested-plan-rollout-"));
    const store = openRolloutStore({ cwd, sessionId: "nested-plan-root" });
    try {
      const session = stubSession({ cwd, rolloutStore: store, conversationId: "nested-plan-root" });
      Object.assign(session, { modelInfo: { slug: "grok-4.7", provider: "grok", supportsToolUse: true },
        sessionConfiguration: { cwd, collaborationMode: { model: "grok-4.7" } },
        providerService: { current: () => ({ provider: "grok", model: "grok-4.7" }) },
        services: { ...session.services, configStore: { current: () => ({ model_provider: "grok", model: "grok-4.7", agents: {} }) } } });
      const control = new AgentControl({ session, registry: new AgentRegistry(), maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      seedRunningAgentRun(cwd, root.agentId);
      const child = await control.spawn({ parentPath: root.agentPath });
      const proposed = await createChildExecutionPlan({ session,
        selection: { provider: "grok", model: "grok-4.7" },
        modelInfo: session.modelInfo, parentPath: child.agentPath,
        taskId: "grandchild-task", taskName: "planned", taskText: "inspect",
        toolFree: false, forkedHistory: false });
      const nestedPlan = { ...proposed, parent: { sessionId: child.agentId, agentPath: child.agentPath } };
      const grandchild = await control.spawn({ parentPath: child.agentPath, executionPlan: nestedPlan });
      await control.shutdownAll("manager_shutdown");
      const resumed = await control.resumeAgentFromRollout({ rootThreadId: root.agentId,
        parentPath: "/root", metadata: root.metadata });
      expect(resumed.resumedCount).toBe(3);
      expect(control.getLive(grandchild.agentId)?.metadata.executionPlan).toEqual(nestedPlan);
    } finally { store.close(); rmSync(cwd, { recursive: true, force: true }); }
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
      seedRunningAgentRun(cwd, root.agentId);
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

  it("does not redispatch a funds-stopped child after a fresh control plane restart", async () => {
    const { childTerminalOutcome } = await import("../../src/agents/child-terminal.js");
    const cwd = mkdtempSync(join(tmpdir(), "agenc-control-funds-restart-"));
    const sessionId = "funds-stop-fresh-control-plane";
    const originalStore = openRolloutStore({ cwd, sessionId });
    let resumedStore: RolloutStore | null = null;
    try {
      const session = stubSession({ rolloutStore: originalStore, conversationId: sessionId });
      const control = new AgentControl({ session, registry: new AgentRegistry(), maxDepth: 3 });
      const root = await control.spawn({ parentPath: "/root" });
      seedRunningAgentRun(cwd, root.agentId);
      const child = await control.spawn({ parentPath: root.agentPath });
      control.recordTerminalOutcome(child.agentId, childTerminalOutcome({
        provider: "deepseek", model: "deepseek-chat", reason: "insufficient_funds",
        dispatch: "sent", unfinishedWork: "Run tests",
      }));
      expect(originalStore.getThreadSpawnEdge(child.agentId)?.status).toBe("closed");
      await control.shutdownAll("manager_shutdown");
      originalStore.close();

      resumedStore = openRolloutStore({ cwd, sessionId, resume: true });
      const resumedSession = stubSession({ rolloutStore: resumedStore, conversationId: sessionId });
      const resumedControl = new AgentControl({
        session: resumedSession, registry: new AgentRegistry(), maxDepth: 3,
      });
      const result = await resumedControl.resumeAgentFromRollout({
        rootThreadId: root.agentId, parentPath: "/root", metadata: root.metadata,
      });
      expect(result.resumedCount).toBe(1);
      expect(resumedControl.getLive(child.agentId)).toBeUndefined();
      expect(resumedStore.getThreadSpawnEdge(child.agentId)?.status).toBe("closed");
    } finally {
      originalStore.close();
      resumedStore?.close();
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
      seedRunningAgentRun(cwd, root.agentId);
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
      seedRunningAgentRun(cwd, root.agentId);
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
      seedRunningAgentRun(cwd, root.agentId);
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
      seedRunningAgentRun(cwd, root.agentId);
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
      roleName: "runner",
      threadId: "preset-thread-1",
    });
    expect(live.agentId).toBe("preset-thread-1");
    expect(live.role.name).toBe("runner");
  });

  it("spawnAgentWithMetadata() validates named metadata even with an explicit role", async () => {
    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const invalidMetadata = [
      { agentRole: "runner" },
      {
        agentRole: "runner",
        agentRoleWorkspaceId: createAgentRoleWorkspace(
          join(agencHome, "other-workspace"),
        ).id,
      },
    ] as const;

    for (const metadata of invalidMetadata) {
      await expect(
        control.spawnAgentWithMetadata("/root", {
          roleName: "runner",
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

  it("an owner Stop reaches idle and nested children without selecting the root", async () => {
    const terminateOwnedProcesses = vi.fn(() => ({ results: [] as [] }));
    const session = stubSession({
      services: { admissionRequired: false, unifiedExecManager: { terminateOwnedProcesses } },
    });
    const control = new AgentControl({ session, registry: new AgentRegistry(), maxDepth: 3 });
    control.registerSessionRoot(session.conversationId);
    const parent = await control.spawn({ parentPath: "/root" });
    const sibling = await control.spawn({ parentPath: "/root" });
    const nested = await control.spawn({ parentPath: parent.agentPath });
    parent.status.markRunning("parent-turn");
    parent.status.markIdle("parent-turn");
    nested.status.markRunning("nested-turn");
    nested.status.markIdle("nested-turn");

    control.stopOpenSpawnChildren(session.conversationId, "user_stop");

    expect(parent.abortController.signal.aborted).toBe(true);
    expect(nested.abortController.signal.aborted).toBe(true);
    expect(terminateOwnedProcesses.mock.calls.map(([request]) => request.ownerId).sort()).toEqual(
      [parent.agentId, sibling.agentId, nested.agentId].sort(),
    );
    expect(terminateOwnedProcesses).not.toHaveBeenCalledWith({ ownerId: session.conversationId });
  });

  it("an owner Stop terminates sessions of descendants whose spawn edges closed during root cancellation", async () => {
    const terminateOwnedProcesses = vi.fn(() => ({ results: [] as [] }));
    const session = stubSession({
      services: { admissionRequired: false, unifiedExecManager: { terminateOwnedProcesses } },
    });
    const control = new AgentControl({ session, registry: new AgentRegistry(), maxDepth: 3 });
    control.registerSessionRoot(session.conversationId);
    const closedParent = await control.spawn({ parentPath: "/root" });
    const closedNested = await control.spawn({ parentPath: closedParent.agentPath });
    const earlyDescendants = new Set(control.liveThreadSpawnDescendants(session.conversationId));

    await control.shutdown(closedParent.agentId);
    const stillOpen = await control.spawn({ parentPath: "/root" });
    expect(control.liveThreadSpawnDescendants(session.conversationId)).toEqual([stillOpen.agentId]);

    control.stopOpenSpawnChildren(session.conversationId, "user_stop", earlyDescendants);

    expect(terminateOwnedProcesses.mock.calls.map(([request]) => request.ownerId).sort()).toEqual(
      [closedParent.agentId, closedNested.agentId, stillOpen.agentId].sort(),
    );
    expect(terminateOwnedProcesses).not.toHaveBeenCalledWith({ ownerId: session.conversationId });
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
