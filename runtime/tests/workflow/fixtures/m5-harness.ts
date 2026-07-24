/**
 * Shared M5 exit-proof harness.
 *
 * A daemon-like assembly of the verified-change workflow with REAL durable
 * machinery and scripted model seams only:
 *
 *   - real per-project SQLite state database + StateRunDurabilityRepository,
 *   - real execution-admission kernel (reservations, admission journal),
 *   - real per-run evidence ledger (hash chain, CAS payloads, local anchor
 *     seal) via the daemon factory,
 *   - real git worktree lifecycle over a SandboxExecutionBroker,
 *   - real verification-command execution (`bash -lc` in the worktree),
 *   - SCRIPTED plan/implement/verify-agent children and reviewer (no model,
 *     no network). The "implement" child applies a real fix in the worktree
 *     and its terminal outcome is durably recorded through the PRODUCTION
 *     A1 helper (`recordWorkflowChildTerminal`); post-restart adoption goes
 *     through the production durable inspection helper.
 *
 * Used by the hermetic exit test's crash/resume child process, by the
 * evidence-reconstruction test (in-process, no crash), and by the opt-in
 * acceptance lane (through the real daemon wiring).
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createDaemonWorkflowController,
  createDaemonWorkflowEvidenceLedgerFactory,
  type DaemonWorkflowWiring,
} from "../../../src/app-server/workflow/daemon-wiring.js";
import {
  VerifiedChangeWorkflowController,
  type WorkflowAgentSpawner,
  type WorkflowChildInspection,
  type WorkflowChildOutcome,
  type WorkflowRunJournal,
  type WorkflowSpawnKind,
  type WorkflowWorktreeBroker,
} from "../../../src/app-server/workflow/verified-change-controller.js";
import {
  inspectWorkflowChildTerminal,
  recordWorkflowChildTerminal,
  type WorkflowSessionSeams,
} from "../../../src/app-server/workflow/session-adapters.js";
import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import { SandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { StateRunDurabilityRepository } from "../../../src/state/run-durability.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "../../../src/state/sqlite-driver.js";
import type { ReviewerInvoker } from "../../../src/workflow/independent-review.js";
import type {
  WorkflowCommandResult,
  WorkflowCommandRunner,
} from "../../../src/workflow/verification.js";
import {
  captureBaseState,
  checkBaseMovement,
  cleanupAfterEvidence,
  exportPatchArtifacts,
  provisionWorkflowWorktree,
} from "../../../src/workflow/worktree-lifecycle.js";

export const M5_EXIT_RUN_ID = "wf-m5-exit";
export const M5_APPROVING_REVIEW = JSON.stringify({
  findings: [],
  overallCorrectness: "correct",
  overallExplanation: "the one-line fix is exactly what the goal demands",
  overallConfidenceScore: 0.92,
});

/** Test journal writer projecting straight into the real repository. */
class HarnessJournal implements WorkflowRunJournal {
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

function runBash(
  script: string,
  cwd: string,
  timeoutMs?: number,
): Promise<WorkflowCommandResult> {
  const startedAt = performance.now();
  return new Promise((resolvePromise) => {
    execFile(
      "bash",
      ["-lc", script],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      },
      (error, stdout, stderr) => {
        const durationMs = Math.round(performance.now() - startedAt);
        const killed =
          error !== null && (error as { killed?: boolean }).killed === true;
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : 1;
        resolvePromise({
          exitCode: code,
          stdout: new Uint8Array(stdout),
          stderr: new Uint8Array(stderr),
          timedOut: killed,
          truncated: false,
          durationMs,
        });
      },
    );
  });
}

export interface M5HarnessOptions {
  /** AGENC home for state DBs, admission kernel, and evidence ledgers. */
  readonly home: string;
  /** Fixture git repository (the "user checkout"). */
  readonly repoPath: string;
  /** Physical receipts directory (spawn/provision counters survive kills). */
  readonly receiptsDir: string;
  /** Relative file + contents the scripted implement child writes. */
  readonly implementFix: { readonly file: string; readonly contents: string };
  /** Build through the real daemon wiring instead of a bare controller. */
  readonly throughDaemonWiring?: boolean;
  /**
   * Called synchronously right AFTER the implement child's terminal is
   * durably recorded and right BEFORE the spawner returns to the
   * controller — i.e. immediately before the parent effect_result would
   * commit. The exit test arms the SIGKILL failpoint here so the crash
   * window objectively contains a durable child terminal and no parent
   * result.
   */
  readonly onImplementSettled?: () => void;
}

export interface M5Harness {
  readonly controller: VerifiedChangeWorkflowController;
  readonly repo: StateRunDurabilityRepository;
  readonly kernel: ExecutionAdmissionKernel;
  readonly warnings: readonly string[];
  /** Spawn kinds dispatched by THIS process (physical receipts persist). */
  readonly spawnKinds: readonly WorkflowSpawnKind[];
  resumeOpenWorkflows(): Promise<readonly string[]>;
  close(): void;
}

export function buildM5Harness(options: M5HarnessOptions): M5Harness {
  mkdirSync(options.receiptsDir, { recursive: true });
  const implementReceipt = join(options.receiptsDir, "implement-attempts.jsonl");
  const provisionReceipt = join(options.receiptsDir, "worktree-provisions.jsonl");

  const driver: StateSqliteDriver = openStateDatabases({
    cwd: options.repoPath,
    agencHome: options.home,
  });
  const repo = new StateRunDurabilityRepository(driver);
  const kernel = new ExecutionAdmissionKernel({
    agencHome: options.home,
    ownerId: `m5-exit-harness:${process.pid}`,
    ownerPid: process.pid,
  });
  const broker = new SandboxExecutionBroker({
    mode: "danger_full_access",
    cwd: options.repoPath,
  });
  const warnings: string[] = [];
  const spawnKinds: WorkflowSpawnKind[] = [];

  const worktrees: WorkflowWorktreeBroker = {
    captureBaseState: async (repoPath) => captureBaseState(repoPath, broker),
    provision: async (spec) => {
      const handle = await provisionWorkflowWorktree(spec, broker);
      appendFileSync(
        provisionReceipt,
        `${JSON.stringify({ path: handle.path, created: handle.created })}\n`,
      );
      return handle;
    },
    exportPatch: async (input) =>
      exportPatchArtifacts({
        handle: input.handle,
        baseCommit: input.baseCommit,
        step: input.step,
        sink: input.sink,
        broker,
      }),
    checkBaseMovement: async (input) =>
      checkBaseMovement({
        spec: input.spec,
        patchBytes: input.patchBytes,
        broker,
      }),
    cleanup: async (input) =>
      cleanupAfterEvidence({
        proof: input.proof,
        handle: input.handle,
        broker,
        warn: (message) => warnings.push(message),
      }),
  };

  const commands: WorkflowCommandRunner = {
    run: (input) => runBash(input.script, input.cwd, input.timeoutMs),
  };

  const spawner: WorkflowAgentSpawner = {
    spawn: async (input): Promise<WorkflowChildOutcome> => {
      spawnKinds.push(input.kind);
      let outcome: WorkflowChildOutcome;
      if (input.kind === "plan") {
        outcome = {
          status: "completed",
          finalMessage: "PLAN: apply the one-line fix and re-run the script.",
          usage: null,
        };
      } else if (input.kind === "implement") {
        // The implement child performs a REAL side effect in the worktree.
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          join(input.worktreePath, options.implementFix.file),
          options.implementFix.contents,
        );
        appendFileSync(
          implementReceipt,
          `${JSON.stringify({ childRunId: input.childRunId, pid: process.pid })}\n`,
        );
        outcome = {
          status: "completed",
          finalMessage: `applied the fix to ${options.implementFix.file}`,
          usage: null,
        };
      } else {
        outcome = {
          status: "completed",
          finalMessage: "re-ran the required script in the worktree\nVERDICT: PASS",
          usage: null,
        };
      }
      // A1: the child's terminal becomes durable through the PRODUCTION
      // helper BEFORE the controller can journal the parent effect_result.
      recordWorkflowChildTerminal(repo, input.childRunId, outcome);
      if (input.kind === "implement") options.onImplementSettled?.();
      return outcome;
    },
    inspect: async (childRunId): Promise<WorkflowChildInspection> => {
      // Post-restart adoption goes through the PRODUCTION durable
      // inspection: terminal when recorded, honestly unknown otherwise.
      const durable = inspectWorkflowChildTerminal(repo, childRunId);
      if (durable !== undefined) return { state: "terminal", outcome: durable };
      return { state: "unknown" };
    },
  };

  const reviewer: ReviewerInvoker = {
    invoke: async () => {
      // Physical receipt: reviewer invocations survive kills, so the resume
      // phase can prove adoption never re-ran the reviewer.
      appendFileSync(
        join(options.receiptsDir, "review-invocations.jsonl"),
        `${JSON.stringify({ pid: process.pid })}\n`,
      );
      return M5_APPROVING_REVIEW;
    },
  };

  const warn = (message: string): void => {
    warnings.push(message);
  };

  /**
   * Open the run journal AND bind a canonical journal source for the run —
   * the invariant the daemon's RolloutStore maintains in production. The
   * admission kernel's canonical recovery refuses a run that holds
   * committed admission evidence and a lifecycle epoch without a journal
   * binding, and it converges the SQLite admission journal into this bound
   * source so `run.replay` serves a canonical journal after restart.
   */
  const openJournal = (runId: string): HarnessJournal => {
    const journal = new HarnessJournal(repo, runId);
    // Canonical rollout sources must live at the exact daemon layout
    // (<projectDir>/sessions/<sessionId>/rollout-*.jsonl) or the offline
    // rollout safety checks refuse them.
    const paths = resolveStateDatabasePaths({
      cwd: options.repoPath,
      agencHome: options.home,
    });
    const sessionDir = join(paths.projectDir, "sessions", journal.sessionId);
    const sourcePath = join(sessionDir, `rollout-${runId}.jsonl`);
    if (repo.getJournalBinding(sourcePath) === undefined) {
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      if (!existsSync(sourcePath)) {
        writeFileSync(sourcePath, "", { mode: 0o600 });
      }
      repo.bindJournalSource({
        runId,
        epoch: journal.epoch,
        childRunId: runId,
        sessionId: journal.sessionId,
        sourcePath,
        active: true,
        boundAt: new Date().toISOString(),
      });
    }
    return journal;
  };

  if (options.throughDaemonWiring === true) {
    const seams: WorkflowSessionSeams = {
      journal: {
        open: async (runId) => openJournal(runId),
      },
      worktrees,
      commands,
      spawner,
      reviewer,
      close: async () => {},
    };
    const wiring: DaemonWorkflowWiring = createDaemonWorkflowController({
      agencHome: options.home,
      primaryCwd: options.repoPath,
      kernel,
      warn,
      stateDatabasePaths: () => [
        resolveStateDatabasePaths({
          cwd: options.repoPath,
          agencHome: options.home,
        }),
      ],
      sessionSeams: seams,
    });
    return {
      controller: wiring.controller,
      repo,
      kernel,
      warnings,
      spawnKinds,
      resumeOpenWorkflows: () => wiring.resumeOpenWorkflows(),
      close: () => {
        wiring.close();
        kernel.close();
        driver.close();
      },
    };
  }

  const controller = new VerifiedChangeWorkflowController({
    durability: () => repo,
    journal: { open: async (runId) => openJournal(runId) },
    admission: ({ runId, sessionId, spec }) =>
      kernel.bindClient({
        cwd: spec.repoPath,
        budgetIdentity: runId,
        scope: { runId, sessionId, autonomous: true },
      }),
    worktrees,
    commands,
    spawner,
    reviewer,
    evidenceLedger: createDaemonWorkflowEvidenceLedgerFactory({
      agencHome: options.home,
    }),
    warn,
  });
  return {
    controller,
    repo,
    kernel,
    warnings,
    spawnKinds,
    resumeOpenWorkflows: () => controller.resumeOpenWorkflows(),
    close: () => {
      kernel.close();
      driver.close();
    },
  };
}
