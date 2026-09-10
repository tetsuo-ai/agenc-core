import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createSpawnAgentTool } from "../../src/agents/v2/spawn.js";
import type { MultiAgentV2Options } from "../../src/agents/v2/common.js";
import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { AgentRoleCatalog } from "../../src/agents/role-catalog.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import type { Tool } from "../../src/tools/types.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

it("a real unborn-worktree refusal does not poison the next admitted mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-spawn-admission-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  const workspace = createAgentRoleWorkspace(cwd);
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "spawn-test", ownerPid: process.pid });
  const admission = kernel.bindClient({ cwd, scope: { runId: "spawn-parent", sessionId: "spawn-parent", autonomous: false }, budget: { runMaxCostUsd: 1 } });
  const rolloutStore = new RolloutStore({ cwd, agencHome: home, sessionId: "spawn-parent", agencVersion: "0.17.0", sessionTempRoot: root });
  rolloutStore.open({ sessionId: "spawn-parent", cwd, timestamp: new Date().toISOString(), originator: "agenc", agencVersion: "0.17.0" });
  const eventLog = new EventLog();
  const events: Event[] = [];
  eventLog.subscribe((event) => {
    events.push(event);
    rolloutStore.append(event, { durable: true });
  });
  const control = {
    roleWorkspace: workspace,
    assertRoleWorkspace: () => {},
    getLive: () => undefined,
    spawn: vi.fn(),
    shutdownAgentTree: vi.fn(),
  };
  const session = {
    conversationId: "spawn-parent",
    abortController: new AbortController(),
    roleWorkspace: workspace,
    eventLog,
    rolloutStore,
    emit: (event: Event) => eventLog.emit(event),
    nextInternalSubId: () => `spawn-event-${events.length}`,
    snapshotHistoryMessages: () => [],
    modelInfo: { slug: "test-model" },
    sessionConfiguration: { cwd, collaborationMode: { model: "test-model" } },
    config: { cwd, multiAgentV2: { hideSpawnAgentMetadata: false } },
    services: {
      executionAdmission: admission,
      admissionRequired: true,
      agentControl: control,
      sandboxExecutionBroker: explicitDangerBroker.forkForCwd(cwd),
      modelsManager: {
        tryListModels: () => undefined,
        listModels: async () => [],
        getModelInfo: async () => ({ slug: "test-model" }),
      },
    },
    abortTerminal: vi.fn(),
  } as unknown as Session;
  const spawnTool = createSpawnAgentTool({
    getSession: () => session,
    workspace,
    roleCatalog: new AgentRoleCatalog(workspace),
    ensureAgentControl: () => ({ control, registry: {} }),
  } as unknown as MultiAgentV2Options);
  const spawnArgs = { message: "implement a feature", task_name: "worker", isolation: "worktree", __callId: "spawn-unborn" };
  try {
    const refused = await runAdmittedToolCall({
      session, turnId: "turn-1", callId: "spawn-unborn", tool: spawnTool, args: spawnArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return spawnTool.execute(spawnArgs);
      },
    });
    expect(refused).toMatchObject({ isError: true, effectDisposition: { disposition: "confirmed_no_effect" } });
    expect(control.spawn).not.toHaveBeenCalled();
    const file = join(cwd, "follow-up.txt");
    const writeTool = {
      name: "write.follow-up",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({ maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 }),
    } as unknown as Tool;
    await expect(runAdmittedToolCall({
      session, turnId: "turn-1", callId: "write-after-refusal", tool: writeTool, args: {},
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        writeFileSync(file, "completed");
        return { content: "completed" };
      },
    })).resolves.toMatchObject({ content: "completed" });
    expect(readFileSync(file, "utf8")).toBe("completed");
    expect(existsSync(join(cwd, ".agenc-worktrees"))).toBe(false);
    expect(admission.getUsageSummary?.()).toMatchObject({ costUsd: 0, hasUnknownCost: false });
    expect(events.some((event) => event.msg.type === "effect_result" && event.msg.payload.outcome === "unknown")).toBe(false);
  } finally {
    rolloutStore.close();
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
