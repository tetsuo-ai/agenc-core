/**
 * M5 Phase 6 — A1/A2 unit coverage for the session adapters.
 *
 * A2: the frozen spec's permissionMode/unattendedAllow/unattendedDeny are
 * applied to the run's bootstrapped session exactly like the
 * background-agent runner applies them (`--permission-mode`/`--yolo`
 * bootstrap argv + unattended-policy install on the permission-mode
 * registry) — on start (explicit policy) AND on resume (policy re-resolved
 * from the durable intake spec).
 *
 * A1: workflow child terminals are durably recorded/inspected through the
 * existing run machinery keyed by the deterministic child run id, and
 * `spawner.inspect` adopts a durable terminal after the in-memory maps are
 * gone — while a child with no durable terminal stays honestly "unknown".
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgenCBootstrapFunction } from "../../src/app-server/background-agent-runner.js";
import {
  createWorkflowSessionSeams,
  inspectWorkflowChildTerminal,
  recordWorkflowChildTerminal,
  workflowPermissionModeArgv,
  type WorkflowSessionSeams,
} from "../../src/app-server/workflow/session-adapters.js";
import type { WorkflowRunSessionPolicy } from "../../src/app-server/workflow/verified-change-controller.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import type { ToolPermissionContext } from "../../src/permissions/types.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const RUN_ID = "wf-policy-run";

interface FakeBootstrapCall {
  readonly argv: readonly string[] | undefined;
  readonly registry: PermissionModeRegistry;
  readonly conversationId: string | undefined;
  readonly resumeConversation: boolean | undefined;
}

let home: string;
let cwd: string;
let driver: StateSqliteDriver;
let repo: StateRunDurabilityRepository;
let bootstrapCalls: FakeBootstrapCall[];
let resolvedPolicies: (WorkflowRunSessionPolicy | undefined)[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-m5-policy-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-m5-policy-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  repo = new StateRunDurabilityRepository(driver);
  bootstrapCalls = [];
  resolvedPolicies = [];
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function baseContext(mode: ToolPermissionContext["mode"]): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  };
}

/**
 * Minimal bootstrap double: derives the session's initial permission mode
 * from the argv the adapters hand it — the exact contract the real
 * bootstrap implements via startup-selection.
 */
const fakeBootstrap: AgenCBootstrapFunction = async (options) => {
  const argv = options.argv;
  let mode: ToolPermissionContext["mode"] = "default";
  if (argv !== undefined) {
    if (argv.includes("--yolo")) mode = "bypassPermissions";
    const flag = argv.indexOf("--permission-mode");
    if (flag >= 0 && typeof argv[flag + 1] === "string") {
      mode = argv[flag + 1] as ToolPermissionContext["mode"];
    }
  }
  const registry = new PermissionModeRegistry(baseContext(mode));
  bootstrapCalls.push({
    argv,
    registry,
    conversationId: options.conversationId,
    resumeConversation: options.resumeConversation,
  });
  return {
    session: {
      conversationId: options.conversationId ?? RUN_ID,
      permissionModeRegistry: registry,
      services: {},
    },
    rolloutStore: { runEpoch: 1 },
    shutdown: async () => {},
  } as never;
};

function makeSeams(
  resolveRunPolicy: (runId: string) => WorkflowRunSessionPolicy | undefined = () =>
    undefined,
): WorkflowSessionSeams {
  return createWorkflowSessionSeams({
    kernel: {} as ExecutionAdmissionKernel,
    durability: () => repo,
    resolveRunRepoPath: () => cwd,
    resolveRunPolicy: (runId) => {
      const policy = resolveRunPolicy(runId);
      resolvedPolicies.push(policy);
      return policy;
    },
    fallbackCwd: cwd,
    warn: () => {},
    bootstrap: fakeBootstrap,
  });
}

describe("A2 — spec permission policy on the run session", () => {
  it("bypassPermissions rides --yolo on the bootstrap argv", async () => {
    const seams = makeSeams();
    await seams.journal.open(RUN_ID, {
      repoPath: cwd,
      policy: { permissionMode: "bypassPermissions" },
    });
    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0].argv).toContain("--yolo");
    expect(bootstrapCalls[0].argv).not.toContain("--permission-mode");
    expect(bootstrapCalls[0].registry.current().mode).toBe(
      "bypassPermissions",
    );
    await seams.close();
  });

  it("non-bypass modes ride --permission-mode and unattended lists install on the registry", async () => {
    const seams = makeSeams();
    await seams.journal.open(RUN_ID, {
      repoPath: cwd,
      policy: {
        permissionMode: "acceptEdits",
        unattendedAllow: ["Bash", "FileRead"],
        unattendedDeny: ["Edit"],
      },
    });
    const call = bootstrapCalls[0];
    const argv = call.argv!;
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    const context = call.registry.current();
    // Explicit acceptEdits is preserved; the declared lists are installed
    // (canonicalized: bash → system.bash).
    expect(context.mode).toBe("acceptEdits");
    expect(context.unattendedPolicy).toMatchObject({
      allowlist: ["system.bash", "FileRead"],
      denylist: ["Edit"],
    });
    await seams.close();
  });

  it("default mode with declared lists becomes unattended", async () => {
    const seams = makeSeams();
    await seams.journal.open(RUN_ID, {
      repoPath: cwd,
      policy: { permissionMode: "default", unattendedAllow: ["Grep"] },
    });
    const context = bootstrapCalls[0].registry.current();
    expect(context.mode).toBe("unattended");
    expect(context.unattendedPolicy).toMatchObject({ allowlist: ["Grep"] });
    await seams.close();
  });

  it("a resumed run re-resolves the policy from the durable intake spec", async () => {
    const seams = makeSeams(() => ({
      permissionMode: "plan",
      unattendedDeny: ["Bash"],
    }));
    // No explicit policy → the resume path (journal.open without context).
    await seams.journal.open(RUN_ID);
    expect(resolvedPolicies).toEqual([
      { permissionMode: "plan", unattendedDeny: ["Bash"] },
    ]);
    const call = bootstrapCalls[0];
    expect(call.resumeConversation).toBe(true);
    const argv = call.argv!;
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    const context = call.registry.current();
    expect(context.mode).toBe("plan");
    expect(context.unattendedPolicy).toMatchObject({
      denylist: ["system.bash"],
    });
    await seams.close();
  });

  it("workflowPermissionModeArgv never duplicates flags already present", () => {
    expect(
      workflowPermissionModeArgv("bypassPermissions", ["node", "agenc", "--yolo"]),
    ).toEqual(["node", "agenc", "--yolo"]);
    expect(
      workflowPermissionModeArgv("acceptEdits", [
        "node",
        "agenc",
        "--permission-mode",
        "plan",
      ]),
    ).toEqual(["node", "agenc", "--permission-mode", "plan"]);
    expect(workflowPermissionModeArgv("plan", ["node", "agenc"])).toEqual([
      "node",
      "agenc",
      "--permission-mode",
      "plan",
    ]);
  });
});

describe("A1 — durable child terminals for cross-restart adoption", () => {
  it("records and inspects a child terminal through the existing run machinery", () => {
    const childRunId = `${RUN_ID}:implement#1`;
    expect(inspectWorkflowChildTerminal(repo, childRunId)).toBeUndefined();
    recordWorkflowChildTerminal(repo, childRunId, {
      status: "completed",
      finalMessage: "applied the fix",
      usage: null,
    });
    // Idempotent re-record.
    recordWorkflowChildTerminal(repo, childRunId, {
      status: "completed",
      finalMessage: "applied the fix",
      usage: null,
    });
    expect(inspectWorkflowChildTerminal(repo, childRunId)).toEqual({
      status: "completed",
      finalMessage: "applied the fix",
      usage: null,
    });
    // The durable record IS the existing run terminal machinery.
    expect(repo.getCurrentTerminalResult(childRunId)).toMatchObject({
      status: "completed",
      exitCode: 0,
      stopReason: null,
    });
  });

  it("spawner.inspect adopts a durable child terminal after the in-memory maps are gone", async () => {
    const seams = makeSeams();
    // Open the run session (as resume does) so the owner entry exists, but
    // with no live/settled children — the previous process died.
    await seams.journal.open(RUN_ID, { repoPath: cwd });
    const adopted = `${RUN_ID}:implement#1`;
    recordWorkflowChildTerminal(repo, adopted, {
      status: "failed",
      finalMessage: "implementer errored",
      usage: null,
    });
    await expect(seams.spawner.inspect(adopted)).resolves.toEqual({
      state: "terminal",
      outcome: {
        status: "failed",
        finalMessage: "implementer errored",
        usage: null,
      },
    });
    // A child that died mid-flight left no durable terminal: honestly
    // unknown, never a respawn.
    await expect(
      seams.spawner.inspect(`${RUN_ID}:verify-agent#1`),
    ).resolves.toEqual({ state: "unknown" });
    await seams.close();
  });
});
