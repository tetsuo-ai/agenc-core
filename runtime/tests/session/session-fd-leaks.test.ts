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
      expect(counts.at(-1)).toBeLessThanOrEqual(baseline + 3);
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

  it("releases shared admission and CSV databases as projects end", async () => {
    const fixture = await makeFixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: fixture.home });
    const csv = new CsvAgentJobsRepositoryAuthority({ agencHome: fixture.home });
    const providerModule = await import("../../src/llm/provider.js");
    vi.spyOn(providerModule, "createProvider").mockReturnValue({
      name: "stub",
      chat: async () => ({ content: "ok", toolCalls: [] }),
    } as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
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
      expect(counts.at(-1)).toBeLessThanOrEqual(baseline + 3);
    } finally {
      kernel.close();
      await csv.close();
      await Promise.all(projects.map((path) => rm(path, { recursive: true, force: true })));
      await fixture.dispose();
    }
  }, 120_000);

  it("keeps shared project databases usable until both live sessions close", async () => {
    const fixture = await makeFixture();
    const kernel = new ExecutionAdmissionKernel({ agencHome: fixture.home });
    const csv = new CsvAgentJobsRepositoryAuthority({ agencHome: fixture.home });
    const providerModule = await import("../../src/llm/provider.js");
    vi.spyOn(providerModule, "createProvider").mockReturnValue({
      name: "stub",
      chat: async () => ({ content: "ok", toolCalls: [] }),
    } as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
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
