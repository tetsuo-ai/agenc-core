/**
 * M5 Phase 5 — daemon wiring: per-run durability resolution and the
 * multi-project resume sweep.
 *
 * A workflow run journals into ITS repository's project state database, not
 * necessarily the daemon's primary one. These tests pin that the wiring
 * resolves the right database per run and that `resumeOpenWorkflows()`
 * sweeps every known project database — all through injected scripted
 * session seams (no bootstraps, no network).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDaemonWorkflowController } from "../../src/app-server/workflow/daemon-wiring.js";
import type {
  WorkflowAgentSpawner,
  WorkflowChildOutcome,
  WorkflowRunJournal,
  WorkflowSpawnKind,
  WorkflowWorktreeBroker,
} from "../../src/app-server/workflow/verified-change-controller.js";
import type { WorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
  WorkflowSpec,
} from "../../src/contracts/run-contracts.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import type { WorkflowCommandRunner } from "../../src/workflow/verification.js";
import type { ReviewerInvoker } from "../../src/workflow/independent-review.js";
import type { WorktreeHandle } from "../../src/agents/worktree.js";

const BASE_COMMIT = "c".repeat(40);
const HEAD_COMMIT = "d".repeat(40);
const APPROVING_REVIEW = JSON.stringify({
  findings: [],
  overallCorrectness: "correct",
  overallExplanation: "clean change",
  overallConfidenceScore: 0.9,
});

class TestJournal implements WorkflowRunJournal {
  readonly sessionId: string;
  readonly epoch: number;
  #seq: number;

  constructor(
    private readonly repo: StateRunDurabilityRepository,
    readonly runId: string,
  ) {
    this.sessionId = `${runId}-session`;
    this.repo.ensureInitialEpoch({
      runId,
      openedAt: new Date().toISOString(),
    });
    this.epoch = this.repo.currentEpoch(runId)!.epoch;
    let max = 0;
    for (const effect of this.repo.listEffects(runId)) {
      max = Math.max(max, effect.intentSequence, effect.resultSequence ?? 0);
    }
    this.#seq = max;
  }

  #next(): { eventId: string; sequence: number } {
    this.#seq += 1;
    return { eventId: `evt-${this.runId}-${this.#seq}`, sequence: this.#seq };
  }

  appendIntent(input: Parameters<WorkflowRunJournal["appendIntent"]>[0]) {
    const ref = this.#next();
    this.repo.beginEffect({
      runId: this.runId,
      epoch: this.epoch,
      stepId: input.stepId,
      ...(input.childRunId !== undefined
        ? { childRunId: input.childRunId }
        : {}),
      sessionId: this.sessionId,
      callId: input.callId ?? input.stepId,
      toolName: input.toolName,
      recoveryCategory: input.recoveryCategory,
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
      intentDigest: input.intentDigest,
      eventId: ref.eventId,
      eventSequence: ref.sequence,
      intentAt: input.intentAt,
    });
    return ref;
  }

  appendResult(input: Parameters<WorkflowRunJournal["appendResult"]>[0]) {
    const ref = this.#next();
    this.repo.completeEffect({
      runId: this.runId,
      stepId: input.stepId,
      outcome: input.outcome,
      eventId: ref.eventId,
      eventSequence: ref.sequence,
      ...(input.resultDigest !== undefined
        ? { resultDigest: input.resultDigest }
        : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      completedAt: input.completedAt,
    });
    return ref;
  }

  appendUnknown(input: Parameters<WorkflowRunJournal["appendUnknown"]>[0]) {
    const ref = this.#next();
    this.repo.markEffectUnknown({
      runId: this.runId,
      stepId: input.stepId,
      eventId: ref.eventId,
      eventSequence: ref.sequence,
      reason: input.reason,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      observedAt: input.observedAt,
    });
    return ref;
  }

  appendTerminal() {
    return this.#next();
  }

  async close(): Promise<void> {}
}

class FakeAdmission implements ExecutionAdmissionClient {
  readonly scope = {
    runId: "unbound",
    workspaceId: "ws",
    sessionId: "session",
    budgetIdentity: "budget",
    autonomous: true,
  };
  readonly abort = new AbortController();
  #n = 0;

  async acquire(input: { stepId: string }): Promise<AdmissionLease> {
    this.#n += 1;
    return {
      decision: "allow",
      reservation: {
        reservationId: `res-${this.#n}`,
        step: { runId: this.scope.runId, stepId: input.stepId },
        reservedCostUsd: 0,
        reservedTokens: 0,
        reservedAt: new Date().toISOString(),
      },
      request: {} as AdmissionLease["request"],
      signal: this.abort.signal,
    };
  }

  markDispatched(): void {}
  reconcile() {
    return { applied: true, outcome: "reconciled" } as const;
  }
  holdUnknown(): void {}
  cancelRun(): void {}
  void(): void {}
  acknowledgeCompletion(): void {}
  recordFallback(): void {}
  forSession(): ExecutionAdmissionClient {
    return this;
  }
  subscribe(): () => void {
    return () => {};
  }
}

const worktrees: WorkflowWorktreeBroker = {
  captureBaseState: async () => ({
    baseCommit: BASE_COMMIT,
    dirty: false,
    fileCount: 0,
    summaryDigest: sha256Digest("status") as `sha256:${string}`,
  }),
  provision: async (
    spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit">,
  ): Promise<WorktreeHandle> => ({
    path: `/wt/${spec.runId}`,
    branch: "agenc/m5",
    gitRoot: spec.repoPath,
    created: true,
  }),
  exportPatch: async (input) => {
    const patchText = "diff --git a/f b/f\n--- a/f\n+++ b/f\n+x\n";
    const patchBytes = new TextEncoder().encode(patchText);
    const patch = await input.sink.recordArtifact({
      step: input.step,
      role: "patch",
      bytes: patchBytes,
      mediaType: "text/x-patch",
    });
    const changedFiles = await input.sink.recordArtifact({
      step: input.step,
      role: "changed_files",
      bytes: new TextEncoder().encode("M\tf\n"),
      mediaType: "text/plain",
    });
    return {
      patch,
      changedFiles,
      headCommit: HEAD_COMMIT,
      treeHash: sha256Digest(patchText).slice("sha256:".length),
      patchBytes,
    };
  },
  checkBaseMovement: async () => ({ kind: "unmoved" }) as const,
  cleanup: async () => {},
};

const commands: WorkflowCommandRunner = {
  run: async () => ({
    exitCode: 0,
    stdout: new TextEncoder().encode("ok\n"),
    stderr: new Uint8Array(0),
    timedOut: false,
    truncated: false,
    durationMs: 3,
  }),
};

const reviewer: ReviewerInvoker = {
  invoke: async () => APPROVING_REVIEW,
};

interface ProjectFixture {
  readonly cwd: string;
  readonly driver: StateSqliteDriver;
  readonly repo: StateRunDurabilityRepository;
}

let home: string;
let projectA: ProjectFixture;
let projectB: ProjectFixture;

function makeProject(prefix: string): ProjectFixture {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(cwd, ".git"));
  const driver = openStateDatabases({ cwd, agencHome: home });
  return { cwd, driver, repo: new StateRunDurabilityRepository(driver) };
}

function makeSeams(): WorkflowSessionSeams & {
  readonly spawns: WorkflowSpawnKind[];
} {
  const spawns: WorkflowSpawnKind[] = [];
  const repoForRun = (runId: string): StateRunDurabilityRepository => {
    for (const project of [projectA, projectB]) {
      if (
        project.repo.getEffect(runId, "workflow.intake") !== undefined ||
        project.repo.currentEpoch(runId) !== undefined
      ) {
        return project.repo;
      }
    }
    return projectA.repo;
  };
  const spawner: WorkflowAgentSpawner = {
    spawn: async (input): Promise<WorkflowChildOutcome> => {
      spawns.push(input.kind);
      return {
        status: "completed",
        finalMessage:
          input.kind === "verify_agent"
            ? "checked\nVERDICT: PASS"
            : input.kind === "plan"
              ? "PLAN: edit"
              : "done",
        usage: null,
      };
    },
    inspect: async () => ({ state: "unknown" }) as const,
  };
  return {
    spawns,
    journal: {
      open: async (runId, context) => {
        const repo =
          context?.repoPath === projectB.cwd
            ? projectB.repo
            : context?.repoPath === projectA.cwd
              ? projectA.repo
              : repoForRun(runId);
        return new TestJournal(repo, runId);
      },
    },
    worktrees,
    commands,
    spawner,
    reviewer,
    close: async () => {},
  };
}

function makeWiring() {
  const admission = new FakeAdmission();
  const kernel = {
    bindClient: ({ scope }: { scope: { runId: string } }) => {
      admission.scope.runId = scope.runId;
      return admission;
    },
  } as unknown as ExecutionAdmissionKernel;
  const seams = makeSeams();
  const wiring = createDaemonWorkflowController({
    agencHome: home,
    primaryCwd: projectA.cwd,
    kernel,
    warn: () => {},
    stateDatabasePaths: () => [
      resolveStateDatabasePaths({ cwd: projectA.cwd, agencHome: home }),
      resolveStateDatabasePaths({ cwd: projectB.cwd, agencHome: home }),
    ],
    sessionSeams: seams,
  });
  return { wiring, seams };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-m5-wiring-home-"));
  projectA = makeProject("agenc-m5-wiring-a-");
  projectB = makeProject("agenc-m5-wiring-b-");
});

afterEach(() => {
  projectA.driver.close();
  projectB.driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(projectA.cwd, { recursive: true, force: true });
  rmSync(projectB.cwd, { recursive: true, force: true });
});

describe("createDaemonWorkflowController — per-run durability resolution", () => {
  it("journals a run into its own repository's project database and resolves status across projects", async () => {
    const { wiring } = makeWiring();
    const started = await wiring.controller.start({
      goal: "fix a bug in project B",
      repoPath: projectB.cwd,
      reviewerModel: "test-reviewer",
      requiredVerification: [{ label: "unit", script: "run-tests" }],
      runId: "wf-project-b",
    });
    await wiring.controller.awaitRun(started.runId);

    // The run's durable rows live in project B's database only.
    expect(
      projectB.repo.getCurrentTerminalResult("wf-project-b"),
    ).toMatchObject({ status: "completed" });
    expect(
      projectA.repo.getCurrentTerminalResult("wf-project-b"),
    ).toBeUndefined();

    // status() resolves the run by searching known project databases.
    const status = wiring.controller.status("wf-project-b");
    expect(status?.terminal?.status).toBe("completed");
    wiring.close();
  });

  it("resumeOpenWorkflows sweeps every known project database", async () => {
    // Leave an intake-interrupted run in project B (spec never durable):
    // the sweep must find it in the non-primary database and fail it closed.
    {
      const journal = new TestJournal(projectB.repo, "wf-resume-b");
      journal.appendIntent({
        stepId: "workflow.intake",
        toolName: "workflow.intake",
        recoveryCategory: "idempotent",
        idempotencyKey: "sha256:intake",
        intentDigest: sha256Digest("intent"),
        intentAt: new Date().toISOString(),
      });
    }
    const { wiring } = makeWiring();
    const resumed = await wiring.resumeOpenWorkflows();
    expect(resumed).toEqual(["wf-resume-b"]);
    expect(
      projectB.repo.getCurrentTerminalResult("wf-resume-b"),
    ).toMatchObject({ status: "failed" });
    wiring.close();
  });
});
