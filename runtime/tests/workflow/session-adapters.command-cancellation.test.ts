import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkflowSessionSeams, type WorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { WorkflowSpec } from "../../src/contracts/run-contracts.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { EventLog } from "../../src/session/event-log.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";

const RUN_ID = "wf-command-cancellation";
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
let scratch: string;
let cwd: string;
let seams: WorkflowSessionSeams;
let driver: StateSqliteDriver;

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
  const permissions = new PermissionModeRegistry({ mode: "default", additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: true });
  const events = new EventLog();
  seams = createWorkflowSessionSeams({ agencHome: home, env: process.env, argv: [process.execPath, "agenc"],
    kernel: {} as ExecutionAdmissionKernel, durability: () => repo, resolveRunRepoPath: () => cwd,
    resolveRunPolicy: () => undefined, fallbackCwd: cwd, warn: () => {},
    bootstrap: async () => ({ session: { conversationId: RUN_ID, permissionModeRegistry: permissions,
      emit: events.emit.bind(events), services: { sandboxExecutionBroker: broker } },
      rolloutStore: { runEpoch: 1 }, shutdown: async () => {} }) as never });
  await seams.journal.open(RUN_ID, { repoPath: cwd });
  const handle = await seams.worktrees.provision({ runId: RUN_ID, repoPath: cwd, baseCommit } as WorkflowSpec);
  cwd = handle.path;
});

afterEach(async () => {
  await seams?.close();
  driver?.close();
  rmSync(scratch, { recursive: true, force: true });
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
