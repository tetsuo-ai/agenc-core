import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import { Session } from "../../src/session/session.js";
import { trustProjectSync } from "../../src/permissions/trust/project-trust.js";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { AgenCDaemonSnapshotPolicyRegistry } from "../../src/app-server/daemon-cli.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { CsvAgentJobsRepositoryAuthority } from "../../src/app-server/csv-agent-jobs-authority.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

function openDescriptors(): number {
  return readdirSync("/dev/fd").length;
}

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), "agenc-fd-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "agenc-fd-workspace-"));
  trustProjectSync({ agencHome: home, cwd: workspace, env: { HOME: home } });
  return {
    home,
    workspace,
    async dispose() {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function boot(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  conversationId: string,
  shared?: {
    executionAdmissionKernel: ExecutionAdmissionKernel;
    csvAgentJobsRepositories: CsvAgentJobsRepositoryAuthority;
  },
) {
  return bootstrapLocalRuntimeSession({
    apiKey: "test-key",
    conversationId,
    cwd: fixture.workspace,
    ...(shared ?? {}),
    env: {
      ...process.env,
      AGENC_HOME: fixture.home,
      AGENC_WORKSPACE: fixture.workspace,
      HOME: fixture.home,
    },
  });
}

/** Record one run and its completed terminal result, as the runner does. */
function recordCompletedRun(
  registry: AgenCDaemonSnapshotPolicyRegistry,
  cwd: string,
  id: string,
  eventId: string,
  at: string,
): void {
  registry.recordAgentRun({
    id, objective: id, status: "running",
    startedAt: at, lastActiveAt: at, currentSessionId: id, cwd,
  });
  registry.recordRunTerminal({
    agentId: id, sessionId: id, cwd,
    openedAt: at, epoch: 1, eventId,
    rolloutPath: join(cwd, `${id}-rollout.jsonl`),
    result: {
      runId: id, status: "completed", exitCode: 0,
      stopReason: null, finalMessage: "done", usage: null,
      lastSequence: null, finishedAt: at,
    },
  });
}

/** Daemon-shared admission and CSV authorities, with a stub provider and no MCP. */
async function sharedDaemonServices(home: string) {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  const csv = new CsvAgentJobsRepositoryAuthority({ agencHome: home });
  const providerModule = await import("../../src/llm/provider.js");
  vi.spyOn(providerModule, "createProvider").mockReturnValue({
    name: "stub",
    chat: async () => ({ content: "ok", toolCalls: [] }),
  } as never);
  vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
  return { kernel, csv };
}

describe.skipIf(process.platform === "win32")("session descriptor ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns to baseline as daemon discovery visits ended projects", async () => {
    const fixture = await makeFixture();
    const providerModule = await import("../../src/llm/provider.js");
    vi.spyOn(providerModule, "createProvider").mockReturnValue({
      name: "stub",
      chat: async () => ({ content: "ok", toolCalls: [] }),
    } as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const store = new MultiProjectFileThreadStore({
      primaryCwd: fixture.workspace,
      agencHome: fixture.home,
    });
    const projects: string[] = [];
    const baseline = openDescriptors();
    const counts: number[] = [];
    try {
      for (let index = 0; index < 20; index++) {
        const workspace = await mkdtemp(join(tmpdir(), "agenc-fd-project-"));
        projects.push(workspace);
        trustProjectSync({ agencHome: fixture.home, cwd: workspace, env: { HOME: fixture.home } });
        const session = await boot({ ...fixture, workspace }, `fd-project-${index}`);
        try {
          for await (const _event of session.session.runTurn("hello", {
            ctx: session.session.newDefaultTurn(),
            systemPrompt: "",
          })) { /* drain */ }
        } finally {
          await session.shutdown();
        }
        store.listThreads({ pageSize: 50, archived: false, useStateDbOnly: true });
        counts.push(openDescriptors());
      }
      console.info(`project fd counts: baseline=${baseline} closed=${counts.join(",")}`);
      expect(counts).toEqual(Array.from({ length: 20 }, () => baseline));
    } finally {
      store.close();
      await Promise.all(projects.map((path) => rm(path, { recursive: true, force: true })));
      await fixture.dispose();
    }
  }, 120_000);

  it("keeps one project's snapshot handles until its final session ends", async () => {
    const fixture = await makeFixture();
    const workspace = await mkdtemp(join(tmpdir(), "agenc-fd-shared-"));
    const registry = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: fixture.home,
      defaultCwd: fixture.workspace,
      onError: (error) => { throw error; },
    });
    const baseline = openDescriptors();
    try {
      registry.registerSession({ sessionId: "fd-a", agentId: "fd-a", cwd: workspace });
      registry.registerSession({ sessionId: "fd-b", agentId: "fd-b", cwd: workspace });
      const bothLive = openDescriptors();
      registry.releaseSession("fd-a");
      expect(openDescriptors()).toBe(bothLive);
      registry.recordSessionEvent("fd-b", { type: "turn_started" });
      registry.flushSession("fd-b");
      registry.releaseSession("fd-b");
      registry.releaseSession("fd-b");
      registry.recordSessionEvent("fd-b", { type: "late_event" });
      registry.flushSession("fd-b");
      expect(openDescriptors()).toBeLessThanOrEqual(baseline + 2);
    } finally {
      registry.close();
      await rm(workspace, { recursive: true, force: true });
      await fixture.dispose();
    }
  });

  it("projects terminal status before releasing the session snapshot, including a write retry", async () => {
    const fixture = await makeFixture();
    const registry = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: fixture.home,
      defaultCwd: fixture.workspace,
      onError: () => undefined,
    });
    const at = new Date().toISOString();
    const driver = openStateDatabases({ cwd: fixture.workspace, agencHome: fixture.home });
    try {
      recordCompletedRun(registry, fixture.workspace, "terminal-fd-run", "terminal-fd-event", at);
      driver.state.exec(`CREATE TRIGGER reject_terminal_snapshot BEFORE INSERT ON session_state_snapshots
        BEGIN SELECT RAISE(ABORT, 'retry terminal snapshot'); END`);
      const transition = {
        sessionId: "terminal-fd-run", agentId: "terminal-fd-run", cwd: fixture.workspace,
        status: "stopped" as const, transitionAt: at, reason: "runner_terminated",
      };
      expect(() => registry.recordAgentStatusTransition(transition)).toThrow("retry terminal snapshot");
      driver.state.exec("DROP TRIGGER reject_terminal_snapshot");
      registry.flushSession("terminal-fd-run");
      registry.releaseSession("terminal-fd-run");
      const row = driver.prepareState<[string], { tool_state_json: string }>(
        `SELECT tool_state_json FROM session_state_snapshots
         WHERE session_id = ? ORDER BY snapshot_at DESC LIMIT 1`,
      ).get("terminal-fd-run");
      expect(JSON.parse(row!.tool_state_json).statusTransitions).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "stopped" })]),
      );
    } finally {
      driver.close();
      registry.close();
      await fixture.dispose();
    }
  });

  it("preserves both snapshots when a new session starts before the old terminal projection", async () => {
    const fixture = await makeFixture();
    const registry = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: fixture.home, defaultCwd: fixture.workspace,
      onError: () => undefined,
    });
    const driver = openStateDatabases({ cwd: fixture.workspace, agencHome: fixture.home });
    const baseline = openDescriptors();
    const at = new Date().toISOString();
    try {
      recordCompletedRun(registry, fixture.workspace, "old", "old-terminal", at);
      registry.registerSession({ sessionId: "new", agentId: "new", cwd: fixture.workspace });
      registry.recordAgentStatusTransition({
        sessionId: "old", agentId: "old", cwd: fixture.workspace,
        status: "stopped", transitionAt: at,
      });
      registry.releaseSession("old");
      registry.recordAgentStatusTransition({
        sessionId: "new", agentId: "new", cwd: fixture.workspace,
        status: "running", transitionAt: at,
      });
      registry.releaseSession("new");
      for (const [sessionId, status] of [["old", "stopped"], ["new", "running"]]) {
        const row = driver.prepareState<[string], { tool_state_json: string }>(
          `SELECT tool_state_json FROM session_state_snapshots
           WHERE session_id = ? ORDER BY snapshot_at DESC LIMIT 1`,
        ).get(sessionId);
        expect(JSON.parse(row!.tool_state_json).statusTransitions).toEqual(
          expect.arrayContaining([expect.objectContaining({ status })]),
        );
      }
      expect(openDescriptors()).toBeLessThanOrEqual(baseline + 2);
    } finally {
      driver.close();
      registry.close();
      await fixture.dispose();
    }
  });

  it("releases shared admission and CSV databases as projects end", async () => {
    const fixture = await makeFixture();
    const { kernel, csv } = await sharedDaemonServices(fixture.home);
    const projects: string[] = [];
    const baseline = openDescriptors();
    const counts: number[] = [];
    try {
      for (let index = 0; index < 20; index++) {
        const workspace = await mkdtemp(join(tmpdir(), "agenc-fd-shared-project-"));
        projects.push(workspace);
        trustProjectSync({ agencHome: fixture.home, cwd: workspace, env: { HOME: fixture.home } });
        const session = await boot({ ...fixture, workspace }, `shared-fd-${index}`, {
          executionAdmissionKernel: kernel,
          csvAgentJobsRepositories: csv,
        });
        try {
          await csv.withRepository(workspace, () => undefined);
          for await (const _event of session.session.runTurn("hello", {
            ctx: session.session.newDefaultTurn(),
            systemPrompt: "",
          })) { /* drain */ }
        } finally {
          await session.shutdown();
        }
        counts.push(openDescriptors());
      }
      console.info(`shared fd counts: baseline=${baseline} closed=${counts.join(",")}`);
      expect(counts).toEqual(Array.from({ length: 20 }, () => baseline));
    } finally {
      kernel.close();
      await csv.close();
      await Promise.all(projects.map((path) => rm(path, { recursive: true, force: true })));
      await fixture.dispose();
    }
  }, 120_000);

  it("keeps shared project databases usable until both live sessions close", async () => {
    const fixture = await makeFixture();
    const { kernel, csv } = await sharedDaemonServices(fixture.home);
    const shared = { executionAdmissionKernel: kernel, csvAgentJobsRepositories: csv };
    const baseline = openDescriptors();
    let first: Awaited<ReturnType<typeof boot>> | undefined;
    let second: Awaited<ReturnType<typeof boot>> | undefined;
    try {
      first = await boot(fixture, "shared-first", shared);
      second = await boot(fixture, "shared-second", shared);
      await csv.withRepository(fixture.workspace, () => undefined);
      await first.shutdown();
      first = undefined;
      await csv.withRepository(fixture.workspace, () => undefined);
      for await (const _event of second.session.runTurn("still live", {
        ctx: second.session.newDefaultTurn(),
        systemPrompt: "",
      })) { /* drain */ }
      await second.shutdown();
      second = undefined;
      expect(openDescriptors()).toBeLessThanOrEqual(baseline + 2);
    } finally {
      await first?.shutdown();
      await second?.shutdown();
      kernel.close();
      await csv.close();
      await fixture.dispose();
    }
  }, 120_000);

  it("keeps a child admission client usable after its parent releases", async () => {
    const fixture = await makeFixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: fixture.home });
    const baseline = openDescriptors();
    try {
      const parent = kernel.bindClient({
        cwd: fixture.workspace,
        scope: { runId: "fd-parent", sessionId: "fd-parent", autonomous: false },
      });
      const child = parent.forSession({
        runId: "fd-child",
        sessionId: "fd-child",
        parentRunId: "fd-parent",
      });
      parent.release?.();
      child.getUsageSummary();
      const lease = await child.acquire({
        stepId: "fd-child-turn",
        kind: "model_turn",
        model: "stub",
        provider: "stub",
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxCostUsd: 0,
      });
      child.reconcile(lease.reservation.reservationId, {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      });
      child.release?.();
      expect(kernel.sumReconciledUsageByRunId("fd-child").totalTokens).toBe(2);
      expect(openDescriptors()).toBeLessThanOrEqual(baseline + 2);
    } finally {
      kernel.close();
      await fixture.dispose();
    }
  });

});
