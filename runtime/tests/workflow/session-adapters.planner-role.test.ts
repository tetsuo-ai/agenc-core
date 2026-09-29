import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgenCBootstrapFunction } from "../../src/app-server/background-agent-runner.js";
import { createWorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import { listBuiltInAgentRoles } from "../../src/agents/role.js";
import type { WorkflowSpec } from "../../src/contracts/run-contracts.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { EventLog } from "../../src/session/event-log.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

const calls = vi.hoisted(() => [] as { role?: string; parentMessagesOverride?: unknown[]; isolation?: string; inspectionWorktree?: { path: string; created: boolean } }[]);
vi.mock("../../src/bin/delegate-tool.js", () => ({ ensureAgentControl: () => ({ control: {}, registry: {} }) }));
vi.mock("../../src/agents/delegate.js", () => ({
  delegate: async (input: { role?: string; parentMessagesOverride?: unknown[] }) => {
    calls.push(input);
    return { kind: "sync_completed", result: { outcome: "completed", finalMessage: "done", threadId: "child" } };
  },
}));

it("delegates Goal planning through the read-only Plan role even when the run allows writes", async () => {
  const home = mkdtempSync(join(tmpdir(), "workflow-plan-role-"));
  const driver = openStateDatabases({ cwd: home, agencHome: home });
  const repo = new StateRunDurabilityRepository(driver);
  const bootstrap: AgenCBootstrapFunction = async (options) => {
    const eventLog = new EventLog();
    return {
      session: {
        conversationId: options.conversationId,
        abortController: new AbortController(),
        services: {},
        permissionModeRegistry: new PermissionModeRegistry({ mode: "bypassPermissions",
          additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {},
          alwaysAskRules: {}, isBypassPermissionsModeAvailable: true }),
        emit: eventLog.emit.bind(eventLog),
      },
      rolloutStore: { runEpoch: 1 }, shutdown: async () => {},
    } as never;
  };
  const seams = createWorkflowSessionSeams({
    agencHome: home, env: {}, argv: ["node", "agenc"], kernel: {} as never,
    durability: () => repo, resolveRunRepoPath: () => home,
    resolveRunPolicy: () => ({ permissionMode: "bypassPermissions" }),
    fallbackCwd: home, warn: () => {}, bootstrap,
  });
  const spec: WorkflowSpec = {
    runId: "wf-plan-role", goal: "Plan then implement a change", repoPath: home,
    baseCommit: "a".repeat(40), baseDirty: { dirty: false, fileCount: 0, summaryDigest: "sha256:empty" },
    reviewerModel: "test-model", permissionMode: "bypassPermissions", budget: {},
    requiredVerification: [{ label: "test", script: "node --test" }], maxImplementAttempts: 2,
  };
  try {
    await seams.journal.open(spec.runId, { repoPath: home });
    for (const kind of ["plan", "implement", "verify_agent"] as const) {
      await seams.spawner.spawn({ kind, spec, childRunId: `${spec.runId}:${kind}#1`,
        worktreePath: home, prompt: "Work", signal: new AbortController().signal });
    }
    expect(calls.map((call) => call.role)).toEqual(["Plan", undefined, "verification"]);
    expect(calls.map((call) => call.isolation)).toEqual(["none", "worktree", "worktree"]);
    expect(calls[0]?.inspectionWorktree).toMatchObject({ path: home, created: false });
    expect(calls.every((call) => call.parentMessagesOverride?.length === 0)).toBe(true);
    const role = listBuiltInAgentRoles().find((candidate) => candidate.name === calls[0]?.role);
    expect(role?.config.executionConstraint).toBe("read-only");
    expect(role?.config.disallowlist).toEqual(expect.arrayContaining(["Write", "Edit", "apply_patch"]));
  } finally {
    await seams.close();
    driver.close();
    rmSync(home, { recursive: true, force: true });
    calls.splice(0);
  }
});
