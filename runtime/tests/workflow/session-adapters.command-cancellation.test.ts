import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkflowSessionSeams, type WorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { WorkflowSpec } from "../../src/contracts/run-contracts.js";
import { applyUnattendedPermissionPolicyToContext } from "../../src/permissions/unattended-policy.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { mkSession } from "../fixtures.js";
import { ApprovalStore } from "../../src/permissions/approval-cache.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import type { WorktreeHandle } from "../../src/agents/worktree.js";
import { mintCancelledRunProof } from "../../src/workflow/worktree-lifecycle.js";

const RUN_ID = "wf-command-cancellation";
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
let scratch: string;
let cwd: string;
let seams: WorkflowSessionSeams;
let driver: StateSqliteDriver;
let handle: WorktreeHandle;
let permissions: PermissionModeRegistry;
let approvalRequest: ReturnType<typeof vi.fn>;

function alive(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "agenc-workflow-command-cancel-"));
  cwd = join(scratch, "project");
  mkdirSync(cwd);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "Tests");
  git("config", "user.email", "tests@example.com");
  writeFileSync(join(cwd, "README.md"), "owned command fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  const baseCommit = git("rev-parse", "HEAD");
  const home = join(scratch, "home");
  driver = openStateDatabases({ cwd, agencHome: home });
  const repo = new StateRunDurabilityRepository(driver);
  // Explicit host-process authority for this owned fixture only; production
  // still obtains its prepared command from the session's existing broker.
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd });
  permissions = new PermissionModeRegistry({ mode: "bypassPermissions", additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: true });
  approvalRequest = vi.fn(async () => ({ kind: "approved" as const }));
  seams = createWorkflowSessionSeams({ agencHome: home, env: process.env, argv: [process.execPath, "agenc"],
    kernel: {} as ExecutionAdmissionKernel, durability: () => repo, resolveRunRepoPath: () => cwd,
    resolveRunPolicy: () => undefined, fallbackCwd: cwd, warn: () => {},
    bootstrap: async () => ({ session: mkSession({ cwd, services: {
      permissionModeRegistry: permissions, sandboxExecutionBroker: broker,
      toolApprovals: new ApprovalStore() as never,
      approvalResolver: { request: (...args: unknown[]) => approvalRequest(...args) },
    } }).session, rolloutStore: { runEpoch: 1 }, shutdown: async () => {} }) as never });
  await seams.journal.open(RUN_ID, { repoPath: cwd });
  handle = await seams.worktrees.provision({ runId: RUN_ID, repoPath: cwd, baseCommit } as WorkflowSpec);
  cwd = handle.path;
});

afterEach(async () => {
  await seams?.close();
  driver?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("workflow command permissions before broker execution", () => {
  it("runs npm test in acceptEdits after the registered resolver approves", async () => {
    await permissions.update({ ...permissions.current(), mode: "acceptEdits" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('CHECK_EXECUTED')\"" } }));
    const result = await seams.commands.run({ script: "npm test", cwd });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("CHECK_EXECUTED");
    expect(approvalRequest).toHaveBeenCalledOnce();
    expect(approvalRequest.mock.calls[0]?.[0]).toMatchObject({ toolName: "system.bash", cwd, command: ["bash", "-lc", "npm test"] });
  });

  it("preserves explicit approver refusal and does not execute", async () => {
    await permissions.update({ ...permissions.current(), mode: "acceptEdits" });
    approvalRequest.mockResolvedValue({ kind: "denied", reason: "operator refused" });
    const prepare = vi.spyOn(SandboxExecutionBroker.prototype, "prepareSpawn");
    await expect(seams.commands.run({ script: "npm test", cwd })).rejects.toMatchObject({ stopReason: "policy_denied" });
    expect(approvalRequest).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it.each(["exec_command", "system.bash"])("honors explicit %s denial even in bypass mode", async (tool) => {
    await permissions.update(applyUnattendedPermissionPolicyToContext(permissions.current(), {
      denylist: [tool],
    }));
    const prepare = vi.spyOn(SandboxExecutionBroker.prototype, "prepareSpawn");
    try {
      await expect(seams.commands.run({ script: "npm test", cwd })).rejects.toMatchObject({
        name: "WorkflowApprovalFailure", stopReason: "policy_denied",
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("requires shell approval before running unapproved commands", async () => {
    await permissions.update({ ...permissions.current(), mode: "default" });
    approvalRequest.mockResolvedValue({ kind: "timed_out" });
    const prepare = vi.spyOn(SandboxExecutionBroker.prototype, "prepareSpawn");
    try {
      await expect(seams.commands.run({ script: "npm test", cwd })).rejects.toMatchObject({
        name: "WorkflowApprovalFailure", stopReason: "approval_required",
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("honors shell content denials even in bypass mode", async () => {
    await permissions.update({ ...permissions.current(),
      alwaysDenyRules: { session: ["system.bash(npm test)"] },
    });
    const prepare = vi.spyOn(SandboxExecutionBroker.prototype, "prepareSpawn");
    try {
      await expect(seams.commands.run({ script: "npm test", cwd })).rejects.toMatchObject({
        name: "WorkflowApprovalFailure", stopReason: "policy_denied",
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("still enforces broker refusal after shell permission is allowed", async () => {
    const prepare = vi.spyOn(SandboxExecutionBroker.prototype, "prepareSpawn")
      .mockImplementation(() => { throw new Error("broker denied command"); });
    try {
      await expect(seams.commands.run({ script: "npm test", cwd })).rejects.toThrow("broker denied command");
      expect(prepare).toHaveBeenCalledWith("child_agent", expect.objectContaining({
        args: ["-lc", "npm test"], cwd,
      }));
    } finally {
      prepare.mockRestore();
    }
  });
});

describe("workflow command cancellation through the real process supervisor", () => {
  it("stops the command and its detached child before rejecting cancellation", async () => {
    const ready = join(cwd, "processes.json");
    const source = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled verification");
    const outcome = seams.commands.run({ script: `${quote(process.execPath)} -e ${quote(source)}`, cwd,
      timeoutMs: 2000, signal: controller.signal } as Parameters<WorkflowSessionSeams["commands"]["run"]>[0])
      .then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const pids = JSON.parse(readFileSync(ready, "utf8")) as { parent: number; child: number };
    expect(alive(pids.parent)).toBe(true);
    expect(alive(pids.child)).toBe(true);
    controller.abort(cancellation);
    const settled = await outcome;
    expect(settled.error).toBe(cancellation);
    expect(alive(pids.parent)).toBe(false);
    expect(alive(pids.child)).toBe(false);
  });

  it("does not spawn a command whose signal was already cancelled", async () => {
    const marker = join(cwd, "must-not-exist");
    const controller = new AbortController();
    const cancellation = new Error("already cancelled");
    controller.abort(cancellation);
    const outcome = seams.commands.run({ script: `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`)}`,
      cwd, signal: controller.signal } as Parameters<WorkflowSessionSeams["commands"]["run"]>[0]);
    await expect(outcome).rejects.toBe(cancellation);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a cancelled run's worktree through the daemon adapter", () => {
  it("goes with its branch through the run's session, and no command runs there afterwards", async () => {
    const project = join(scratch, "project");
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: project, encoding: "utf8" });
    await seams.worktrees.discard({ proof: mintCancelledRunProof({ runId: RUN_ID }), handle });
    expect(existsSync(handle.path)).toBe(false);
    expect(git("branch", "--list", handle.branch)).toBe("");
    expect(git("status", "--porcelain")).toBe("");
    await expect(seams.commands.run({ script: "true", cwd: handle.path } as Parameters<WorkflowSessionSeams["commands"]["run"]>[0]))
      .rejects.toThrow(/without a run id/);
  });
});
