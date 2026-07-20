import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VerifiedChangeWorkflowController,
  WorkflowIntakeError,
  type WorkflowAgentSpawner,
  type WorkflowChildInspection,
  type WorkflowChildOutcome,
  type WorkflowEvidenceLedger,
  type WorkflowRunJournal,
  type WorkflowSpawnKind,
  type WorkflowStartParams,
  type WorkflowWorktreeBroker,
} from "../../src/app-server/workflow/verified-change-controller.js";
import { AdmissionDeniedError, type ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
  WorkflowSpec,
} from "../../src/contracts/run-contracts.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";
import type { Sha256Digest } from "../../src/eval-contract/types.js";
import {
  StateRunDurabilityRepository,
} from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import type { ReviewerInvoker } from "../../src/workflow/independent-review.js";
import type {
  WorkflowCommandResult,
  WorkflowCommandRunner,
} from "../../src/workflow/verification.js";
import type {
  BaseMovementCheck,
  EvidenceArtifactSink,
  SealedEvidenceProof,
} from "../../src/workflow/worktree-lifecycle.js";
import type { WorktreeHandle } from "../../src/agents/worktree.js";
import { validateVerifiedChangeRecord, type VerifiedChangeRecord } from "../../src/workflow/evidence-record.js";

// ---------------------------------------------------------------------------
// Failpoint arming (throw action — simulated crash, nothing may be recorded)
// ---------------------------------------------------------------------------

function armFailpoint(name: string): void {
  process.env.AGENC_TEST_DURABILITY_FAILPOINT = name;
  process.env.AGENC_TEST_DURABILITY_FAILPOINT_TOKEN = "m5-workflow-child";
  process.env.AGENC_TEST_DURABILITY_FAILPOINT_ACTION = "throw";
}

function disarmFailpoint(): void {
  delete process.env.AGENC_TEST_DURABILITY_FAILPOINT;
  delete process.env.AGENC_TEST_DURABILITY_FAILPOINT_TOKEN;
  delete process.env.AGENC_TEST_DURABILITY_FAILPOINT_ACTION;
}

// ---------------------------------------------------------------------------
// Scripted seams
// ---------------------------------------------------------------------------

/**
 * Test journal writer: assigns event sequences from a per-run counter and
 * projects straight into the REAL StateRunDurabilityRepository, mirroring
 * RolloutStore.recordEffectEvent's journal-then-project contract.
 */
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
  readonly acquired: string[] = [];
  readonly reconciled: string[] = [];
  readonly heldUnknown: { id: string; reason: string }[] = [];
  readonly voided: { id: string; reason: string }[] = [];
  readonly denials: {
    match: (stepId: string) => boolean;
    error: AdmissionDeniedError;
  }[] = [];
  readonly abort = new AbortController();
  #n = 0;

  async acquire(input: { stepId: string }): Promise<AdmissionLease> {
    for (const denial of this.denials) {
      if (denial.match(input.stepId)) throw denial.error;
    }
    this.#n += 1;
    this.acquired.push(input.stepId);
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
  reconcile(reservationId: string) {
    this.reconciled.push(reservationId);
    return { applied: true, outcome: "reconciled" } as const;
  }
  holdUnknown(reservationId: string, reason: string): void {
    this.heldUnknown.push({ id: reservationId, reason });
  }
  cancelRun(): void {}
  void(reservationId: string, reason: string): void {
    this.voided.push({ id: reservationId, reason });
  }
  acknowledgeCompletion(): void {}
  recordFallback(): void {}
  forSession(): ExecutionAdmissionClient {
    return this;
  }
  subscribe(): () => void {
    return () => {};
  }
}

class MemoryLedger implements WorkflowEvidenceLedger {
  readonly payloads = new Map<string, Uint8Array>();
  readonly recordedRoles: string[] = [];
  readonly records: VerifiedChangeRecord[] = [];
  #eventIds = new Set<string>();
  #eventCount = 1;
  #headDigest: Sha256Digest;
  sealed = false;
  sealDigest?: string;
  corruptHead = false;

  constructor(runId: string) {
    this.#headDigest = sha256Digest(`genesis:${runId}`);
  }

  async recordArtifact(input: {
    step: RunStepIdentity;
    role: RunArtifactPointer["role"];
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<RunArtifactPointer> {
    const digest = sha256Digest(input.bytes);
    const hex = digest.slice("sha256:".length);
    this.payloads.set(hex, input.bytes);
    const eventId = `${input.step.stepId}:${input.role}:${hex}`;
    if (!this.#eventIds.has(eventId)) {
      this.#eventIds.add(eventId);
      this.#eventCount += 1;
      this.#headDigest = sha256Digest(`${this.#headDigest}|${eventId}`);
      this.recordedRoles.push(input.role);
    }
    return {
      step: input.step,
      role: input.role,
      digest: digest as `sha256:${string}`,
      bytes: input.bytes.byteLength,
      storagePath: `cas://sha256/${hex}`,
      recordedAt: new Date().toISOString(),
    };
  }

  head() {
    return {
      eventCount: this.corruptHead ? 0 : this.#eventCount,
      headEventDigest: this.#headDigest,
      sealed: this.sealed,
    };
  }

  async readArtifact(pointer: RunArtifactPointer): Promise<Uint8Array> {
    const bytes = this.payloads.get(pointer.digest.slice("sha256:".length));
    if (bytes === undefined) throw new Error(`missing payload ${pointer.digest}`);
    return bytes;
  }

  async seal(): Promise<{ sealDigest: string }> {
    this.sealed = true;
    this.sealDigest ??= sha256Digest(`seal:${this.#headDigest}`);
    return { sealDigest: this.sealDigest };
  }

  async persistRecord(record: VerifiedChangeRecord): Promise<void> {
    this.records.push(record);
  }
}

const BASE_COMMIT = "c".repeat(40);
const HEAD_COMMIT = "d".repeat(40);

class FakeWorktrees implements WorkflowWorktreeBroker {
  dirty = false;
  movement: BaseMovementCheck = { kind: "unmoved" };
  patchText = "diff --git a/f b/f\n--- a/f\n+++ b/f\n+x\n";
  provisions = 0;
  readonly cleanups: { proof: SealedEvidenceProof; handle: WorktreeHandle }[] =
    [];

  async captureBaseState() {
    return {
      baseCommit: BASE_COMMIT,
      dirty: this.dirty,
      fileCount: this.dirty ? 3 : 0,
      summaryDigest: sha256Digest("status") as `sha256:${string}`,
    };
  }

  async provision(
    spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit">,
  ): Promise<WorktreeHandle> {
    this.provisions += 1;
    return {
      path: `/wt/${spec.runId}`,
      branch: "agenc/m5",
      gitRoot: spec.repoPath,
      created: this.provisions === 1,
    };
  }

  async exportPatch(input: {
    handle: WorktreeHandle;
    baseCommit: string;
    step: RunStepIdentity;
    sink: EvidenceArtifactSink;
  }) {
    const patchBytes = new TextEncoder().encode(this.patchText);
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
      treeHash: sha256Digest(this.patchText).slice("sha256:".length),
      patchBytes,
    };
  }

  async checkBaseMovement() {
    return this.movement;
  }

  async cleanup(input: {
    proof: SealedEvidenceProof;
    handle: WorktreeHandle;
  }): Promise<void> {
    this.cleanups.push(input);
  }
}

const DEFAULT_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  costUsd: 0.02,
};

class FakeSpawner implements WorkflowAgentSpawner {
  readonly spawns: {
    kind: WorkflowSpawnKind;
    childRunId: string;
    prompt: string;
  }[] = [];
  readonly queues = new Map<WorkflowSpawnKind, WorkflowChildOutcome[]>();
  readonly inspections = new Map<string, WorkflowChildInspection>();
  beforeReturn?: (input: { kind: WorkflowSpawnKind }) => void;

  queue(kind: WorkflowSpawnKind, outcome: WorkflowChildOutcome): void {
    const queue = this.queues.get(kind) ?? [];
    queue.push(outcome);
    this.queues.set(kind, queue);
  }

  #default(kind: WorkflowSpawnKind): WorkflowChildOutcome {
    const finalMessage =
      kind === "plan"
        ? "PLAN: make the edit"
        : kind === "verify_agent"
          ? "checked everything\nVERDICT: PASS"
          : "done";
    return { status: "completed", finalMessage, usage: DEFAULT_USAGE };
  }

  async spawn(input: {
    kind: WorkflowSpawnKind;
    childRunId: string;
    prompt: string;
  }): Promise<WorkflowChildOutcome> {
    this.spawns.push({
      kind: input.kind,
      childRunId: input.childRunId,
      prompt: input.prompt,
    });
    const queue = this.queues.get(input.kind);
    const outcome =
      queue !== undefined && queue.length > 0
        ? queue.shift()!
        : this.#default(input.kind);
    this.beforeReturn?.(input);
    return outcome;
  }

  async inspect(childRunId: string): Promise<WorkflowChildInspection> {
    return this.inspections.get(childRunId) ?? { state: "unknown" };
  }
}

const APPROVING_REVIEW = JSON.stringify({
  findings: [],
  overallCorrectness: "correct",
  overallExplanation: "clean change",
  overallConfidenceScore: 0.9,
});

class FakeReviewer implements ReviewerInvoker {
  readonly invocations: { reviewerModel: string; userMessage: string }[] = [];
  readonly responses: string[] = [];

  async invoke(input: {
    reviewerModel: string;
    userMessage: string;
  }): Promise<string> {
    this.invocations.push({
      reviewerModel: input.reviewerModel,
      userMessage: input.userMessage,
    });
    return this.responses.shift() ?? APPROVING_REVIEW;
  }
}

class FakeCommands implements WorkflowCommandRunner {
  readonly byScript = new Map<string, Partial<WorkflowCommandResult>>();
  readonly executed: string[] = [];

  async run(input: { script: string }): Promise<WorkflowCommandResult> {
    this.executed.push(input.script);
    return {
      exitCode: 0,
      stdout: new TextEncoder().encode("ok\n"),
      stderr: new Uint8Array(0),
      timedOut: false,
      truncated: false,
      durationMs: 3,
      ...this.byScript.get(input.script),
    };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  home: string;
  cwd: string;
  driver: StateSqliteDriver;
  repo: StateRunDurabilityRepository;
  admission: FakeAdmission;
  worktrees: FakeWorktrees;
  spawner: FakeSpawner;
  reviewer: FakeReviewer;
  commands: FakeCommands;
  ledgers: Map<string, MemoryLedger>;
  warnings: string[];
  controller: VerifiedChangeWorkflowController;
  cleanup(): void;
}

const RUN_ID = "run-wf-1";

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "agenc-m5-controller-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agenc-m5-controller-cwd-"));
  mkdirSync(join(cwd, ".git"));
  const driver = openStateDatabases({ cwd, agencHome: home });
  const repo = new StateRunDurabilityRepository(driver);
  const admission = new FakeAdmission();
  const worktrees = new FakeWorktrees();
  const spawner = new FakeSpawner();
  const reviewer = new FakeReviewer();
  const commands = new FakeCommands();
  const ledgers = new Map<string, MemoryLedger>();
  const warnings: string[] = [];
  const controller = new VerifiedChangeWorkflowController({
    durability: () => repo,
    journal: { open: async (runId) => new TestJournal(repo, runId) },
    admission: ({ runId }) => {
      admission.scope.runId = runId;
      return admission;
    },
    worktrees,
    commands,
    spawner,
    reviewer,
    evidenceLedger: async (spec) => {
      let ledger = ledgers.get(spec.runId);
      if (ledger === undefined) {
        ledger = new MemoryLedger(spec.runId);
        ledgers.set(spec.runId, ledger);
      }
      return ledger;
    },
    warn: (message) => warnings.push(message),
  });
  return {
    home,
    cwd,
    driver,
    repo,
    admission,
    worktrees,
    spawner,
    reviewer,
    commands,
    ledgers,
    warnings,
    controller,
    cleanup: () => {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function startParams(
  harness: Harness,
  overrides: Partial<WorkflowStartParams> = {},
): WorkflowStartParams {
  return {
    goal: "Fix the reported bug",
    repoPath: harness.cwd,
    model: "test-model",
    reviewerModel: "test-reviewer",
    requiredVerification: [{ label: "unit", script: "run-tests" }],
    maxImplementAttempts: 2,
    runId: RUN_ID,
    ...overrides,
  };
}

async function runToTerminal(
  harness: Harness,
  overrides: Partial<WorkflowStartParams> = {},
): Promise<void> {
  const result = await harness.controller.start(startParams(harness, overrides));
  await harness.controller.awaitRun(result.runId);
}

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});

afterEach(() => {
  disarmFailpoint();
  harness.cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VerifiedChangeWorkflowController — happy path", () => {
  it("drives the full pipeline to a completed terminal with sealed evidence", async () => {
    // One non-blocking finding: it must land in the risk register and the
    // final message, never block completion (D6).
    harness.reviewer.responses.push(
      JSON.stringify({
        findings: [
          {
            title: "Consider renaming",
            body: "cosmetic",
            confidenceScore: 0.8,
            priority: 3,
            codeLocation: {
              absolutePath: "/f",
              lineRange: { start: 1, end: 1 },
            },
          },
        ],
        overallCorrectness: "correct",
        overallExplanation: "good",
        overallConfidenceScore: 0.9,
      }),
    );
    const started = await harness.controller.start(startParams(harness));
    expect(started.runId).toBe(RUN_ID);
    expect(started.baseCommit).toBe(BASE_COMMIT);
    expect(started.specDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await harness.controller.awaitRun(RUN_ID);

    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID);
    expect(terminal).toMatchObject({
      status: "completed",
      exitCode: 0,
      stopReason: null,
    });
    expect(terminal!.finalMessage).toContain(HEAD_COMMIT);
    expect(terminal!.finalMessage).toContain("Consider renaming");
    expect(terminal!.usage).not.toBeNull();

    // Admission gated EVERY step, exactly once each.
    expect(harness.admission.acquired).toEqual([
      "workflow.intake",
      "workflow.worktree",
      "workflow.plan",
      "workflow.implement",
      "workflow.verify.cmd.1",
      "workflow.verify.agent",
      "workflow.review",
      "workflow.finalize",
    ]);

    // The evidence record self-validated, was persisted, and is complete.
    const ledger = harness.ledgers.get(RUN_ID)!;
    expect(ledger.sealed).toBe(true);
    expect(ledger.records).toHaveLength(1);
    const record = ledger.records[0];
    expect(validateVerifiedChangeRecord(record).valid).toBe(true);
    expect(record.terminal.status).toBe("completed");
    expect(record.unresolvedRisks).toEqual([
      "non-blocking review finding: Consider renaming",
    ]);
    expect(ledger.recordedRoles).toContain("patch");
    expect(ledger.recordedRoles).toContain("changed_files");
    expect(ledger.recordedRoles).toContain("test_result");
    expect(ledger.recordedRoles).toContain("independent_review");
    expect(ledger.recordedRoles).toContain("risk_register");

    // Cleanup ran only after the seal, with the minted proof.
    expect(harness.worktrees.cleanups).toHaveLength(1);
    expect(harness.worktrees.cleanups[0].proof.sealDigest).toBe(
      ledger.sealDigest,
    );

    // Status projection: every stage committed, verify verdict PASS.
    const status = harness.controller.status(RUN_ID)!;
    expect(status.steps.every((step) => step.status === "committed")).toBe(
      true,
    );
    expect(status.steps[4].verdict).toBe("PASS");
    expect(status.terminal?.status).toBe("completed");

    // The reviewer saw the pinned model and the exported patch.
    expect(harness.reviewer.invocations[0].reviewerModel).toBe("test-reviewer");
    expect(harness.reviewer.invocations[0].userMessage).toContain(
      harness.worktrees.patchText.trim(),
    );
  });

  it("resumeOpenWorkflows skips runs that are already terminal", async () => {
    await runToTerminal(harness);
    await expect(harness.controller.resumeOpenWorkflows()).resolves.toEqual([]);
  });
});

describe("VerifiedChangeWorkflowController — stop reasons", () => {
  it("verification_failed after the bounded re-implement budget is exhausted", async () => {
    harness.commands.byScript.set("run-tests", { exitCode: 1 });
    await runToTerminal(harness);
    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID)!;
    expect(terminal).toMatchObject({
      status: "failed",
      stopReason: "verification_failed",
    });
    // Two implement attempts, two verify attempts, all durably recorded.
    const stepIds = harness.repo.listEffects(RUN_ID).map((e) => e.stepId);
    expect(stepIds).toContain("workflow.implement");
    expect(stepIds).toContain("workflow.implement#2");
    expect(stepIds).toContain("workflow.verify.cmd.1");
    expect(stepIds).toContain("workflow.verify.cmd.1#2");
    expect(stepIds).toContain("workflow.verify.agent#2");
    expect(stepIds).not.toContain("workflow.review");
    // The re-implement prompt carried the failure evidence forward.
    const implementSpawns = harness.spawner.spawns.filter(
      (spawn) => spawn.kind === "implement",
    );
    expect(implementSpawns).toHaveLength(2);
    expect(implementSpawns[1].prompt).toContain("Previous verification failure");
  });

  it("review_rejected on blocking findings, with the review durably committed", async () => {
    harness.reviewer.responses.push(
      JSON.stringify({
        findings: [
          {
            title: "Breaks the API contract",
            body: "bad",
            confidenceScore: 0.9,
            priority: 0,
            codeLocation: {
              absolutePath: "/f",
              lineRange: { start: 1, end: 2 },
            },
          },
        ],
        overallCorrectness: "correct",
        overallExplanation: "found a blocker",
        overallConfidenceScore: 0.8,
      }),
    );
    await runToTerminal(harness);
    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID)!;
    expect(terminal).toMatchObject({
      status: "failed",
      stopReason: "review_rejected",
    });
    expect(terminal.finalMessage).toContain("Breaks the API contract");
    const review = harness.repo.getEffect(RUN_ID, "workflow.review")!;
    expect(review.outcome).toBe("committed");
    // finalize never started.
    expect(harness.repo.getEffect(RUN_ID, "workflow.finalize")).toBeUndefined();
  });

  it("base_moved_conflict when the base moved and the patch conflicts", async () => {
    harness.worktrees.movement = {
      kind: "conflict",
      newBaseCommit: "e".repeat(40),
      conflictFiles: ["src/f.ts"],
    };
    await runToTerminal(harness);
    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID)!;
    expect(terminal).toMatchObject({
      status: "failed",
      stopReason: "base_moved_conflict",
    });
    expect(terminal.finalMessage).toContain("src/f.ts");
    const finalize = harness.repo.getEffect(RUN_ID, "workflow.finalize")!;
    expect(finalize.outcome).toBe("failed");
    // No cleanup without sealed evidence.
    expect(harness.worktrees.cleanups).toHaveLength(0);
  });

  it("budget_exhausted on a mid-pipeline admission deny", async () => {
    harness.admission.denials.push({
      match: (stepId) => stepId.startsWith("workflow.implement"),
      error: new AdmissionDeniedError("run budget ceiling reached", "deny"),
    });
    await runToTerminal(harness);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
      status: "failed",
      stopReason: "budget_exhausted",
    });
  });

  it("policy_denied at intake terminates before any pipeline step", async () => {
    harness.admission.denials.push({
      match: (stepId) => stepId === "workflow.intake",
      error: new AdmissionDeniedError("policy refused unattended writes", "deny"),
    });
    await expect(
      harness.controller.start(startParams(harness)),
    ).rejects.toBeInstanceOf(WorkflowIntakeError);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
      status: "failed",
      stopReason: "policy_denied",
    });
    expect(harness.repo.listEffects(RUN_ID)).toHaveLength(0);
    expect(harness.spawner.spawns).toHaveLength(0);
  });

  it("approval_required mid-pipeline terminates failed — no parking (D5)", async () => {
    harness.admission.denials.push({
      match: (stepId) => stepId.startsWith("workflow.review"),
      error: new AdmissionDeniedError(
        "reviewer spawn needs interactive approval",
        "approval_required",
      ),
    });
    await runToTerminal(harness);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
      status: "failed",
      stopReason: "approval_required",
    });
  });

  it("evidence_invalid when the record fails mechanical self-validation", async () => {
    const ledger = new MemoryLedger(RUN_ID);
    ledger.corruptHead = true;
    harness.ledgers.set(RUN_ID, ledger);
    await runToTerminal(harness);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
      status: "failed",
      stopReason: "evidence_invalid",
    });
    // Sealed but never completed, never cleaned up.
    expect(harness.worktrees.cleanups).toHaveLength(0);
  });

  it("step_retries_exhausted when a stage fails terminally past its retry budget", async () => {
    harness.spawner.queue("plan", {
      status: "failed",
      finalMessage: "planner crashed",
      usage: null,
    });
    harness.spawner.queue("plan", {
      status: "failed",
      finalMessage: "planner crashed again",
      usage: null,
    });
    await runToTerminal(harness);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
      status: "failed",
      stopReason: "step_retries_exhausted",
    });
    const stepIds = harness.repo.listEffects(RUN_ID).map((e) => e.stepId);
    expect(stepIds).toContain("workflow.plan");
    expect(stepIds).toContain("workflow.plan#2");
  });

  it("cancellation observed mid-pipeline terminalizes cancelled", async () => {
    harness.admission.denials.push({
      match: (stepId) => stepId.startsWith("workflow.implement"),
      error: new AdmissionDeniedError("run.cancel cascade", "cancelled"),
    });
    await runToTerminal(harness);
    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID)!;
    expect(terminal.status).toBe("cancelled");
    expect(terminal.exitCode).toBe(1);
  });
});

describe("VerifiedChangeWorkflowController — prerequisite gating", () => {
  it("verify never starts when implement failed terminally", async () => {
    harness.spawner.queue("implement", {
      status: "failed",
      finalMessage: "no",
      usage: null,
    });
    harness.spawner.queue("implement", {
      status: "failed",
      finalMessage: "still no",
      usage: null,
    });
    await runToTerminal(harness);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)).toMatchObject({
      status: "failed",
      stopReason: "step_retries_exhausted",
    });
    const stepIds = harness.repo.listEffects(RUN_ID).map((e) => e.stepId);
    expect(stepIds.some((id) => id.startsWith("workflow.verify"))).toBe(false);
    expect(harness.commands.executed).toHaveLength(0);
    expect(
      harness.spawner.spawns.filter((s) => s.kind === "verify_agent"),
    ).toHaveLength(0);
  });
});

describe("VerifiedChangeWorkflowController — crash recovery (D3)", () => {
  it("an interrupted idempotent step re-executes under the same durable key", async () => {
    armFailpoint("before_worktree_provision");
    const started = await harness.controller.start(startParams(harness));
    await expect(harness.controller.awaitRun(started.runId)).rejects.toThrow(
      /failpoint/,
    );
    const interrupted = harness.repo.getEffect(RUN_ID, "workflow.worktree")!;
    expect(interrupted.outcome).toBeUndefined();
    expect(interrupted.recoveryCategory).toBe("idempotent");
    const key = interrupted.idempotencyKey;
    expect(key).toContain(`@${BASE_COMMIT}`);

    disarmFailpoint();
    const resumed = await harness.controller.resumeOpenWorkflows();
    expect(resumed).toEqual([RUN_ID]);
    await harness.controller.awaitRun(RUN_ID);

    expect(harness.repo.getCurrentTerminalResult(RUN_ID)?.status).toBe(
      "completed",
    );
    const recovered = harness.repo.getEffect(RUN_ID, "workflow.worktree")!;
    expect(recovered.outcome).toBe("committed");
    expect(recovered.idempotencyKey).toBe(key);
    // Same step id — re-execution, not a new attempt.
    expect(
      harness.repo
        .listEffects(RUN_ID)
        .filter((e) => e.stepId.startsWith("workflow.worktree")),
    ).toHaveLength(1);
  });

  it("an interrupted side-effecting spawn ADOPTS its terminal child, never respawns", async () => {
    harness.spawner.beforeReturn = (input) => {
      if (input.kind === "implement") {
        armFailpoint("after_spawn_before_effect_result");
      }
    };
    const started = await harness.controller.start(startParams(harness));
    await expect(harness.controller.awaitRun(started.runId)).rejects.toThrow(
      /failpoint/,
    );
    harness.spawner.beforeReturn = undefined as never;
    disarmFailpoint();

    const interrupted = harness.repo.getEffect(RUN_ID, "workflow.implement")!;
    expect(interrupted.outcome).toBeUndefined();
    expect(interrupted.childRunId).toBe(`${RUN_ID}:implement#1`);

    harness.spawner.inspections.set(`${RUN_ID}:implement#1`, {
      state: "terminal",
      outcome: { status: "completed", finalMessage: "done", usage: null },
    });
    await harness.controller.resumeOpenWorkflows();
    await harness.controller.awaitRun(RUN_ID);

    expect(harness.repo.getCurrentTerminalResult(RUN_ID)?.status).toBe(
      "completed",
    );
    const adopted = harness.repo.getEffect(RUN_ID, "workflow.implement")!;
    expect(adopted.outcome).toBe("committed");
    // Exactly ONE implement spawn ever happened.
    expect(
      harness.spawner.spawns.filter((s) => s.kind === "implement"),
    ).toHaveLength(1);
  });

  it("a live child is re-awaited during adoption", async () => {
    harness.spawner.beforeReturn = (input) => {
      if (input.kind === "implement") {
        armFailpoint("after_spawn_before_effect_result");
      }
    };
    const started = await harness.controller.start(startParams(harness));
    await expect(harness.controller.awaitRun(started.runId)).rejects.toThrow(
      /failpoint/,
    );
    harness.spawner.beforeReturn = undefined as never;
    disarmFailpoint();

    harness.spawner.inspections.set(`${RUN_ID}:implement#1`, {
      state: "live",
      outcome: Promise.resolve({
        status: "completed",
        finalMessage: "late finish",
        usage: null,
      }),
    });
    await harness.controller.resumeOpenWorkflows();
    await harness.controller.awaitRun(RUN_ID);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)?.status).toBe(
      "completed",
    );
    expect(
      harness.spawner.spawns.filter((s) => s.kind === "implement"),
    ).toHaveLength(1);
  });

  it("an unknowable child marks the effect unknown and terminalizes unknown_outcome", async () => {
    harness.spawner.beforeReturn = (input) => {
      if (input.kind === "implement") {
        armFailpoint("after_spawn_before_effect_result");
      }
    };
    const started = await harness.controller.start(startParams(harness));
    await expect(harness.controller.awaitRun(started.runId)).rejects.toThrow(
      /failpoint/,
    );
    harness.spawner.beforeReturn = undefined as never;
    disarmFailpoint();

    // No inspection registered → the child's outcome is unknowable.
    await harness.controller.resumeOpenWorkflows();
    await harness.controller.awaitRun(RUN_ID);

    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID)!;
    expect(terminal).toMatchObject({
      status: "unknown_outcome",
      stopReason: "unknown_outcome_effect",
    });
    const effect = harness.repo.getEffect(RUN_ID, "workflow.implement")!;
    expect(effect.outcome).toBe("unknown_outcome");
    expect(effect.reviewStatus).toBe("pending");
    // Never respawned.
    expect(
      harness.spawner.spawns.filter((s) => s.kind === "implement"),
    ).toHaveLength(1);
  });

  it("an intake interrupted before its commit fails closed on resume", async () => {
    armFailpoint("before_intake_commit");
    await expect(
      harness.controller.start(startParams(harness)),
    ).rejects.toThrow(/failpoint/);
    disarmFailpoint();
    expect(
      harness.repo.getEffect(RUN_ID, "workflow.intake")?.outcome,
    ).toBeUndefined();

    const resumed = await harness.controller.resumeOpenWorkflows();
    expect(resumed).toEqual([RUN_ID]);
    const terminal = harness.repo.getCurrentTerminalResult(RUN_ID)!;
    expect(terminal.status).toBe("failed");
    expect(terminal.finalMessage).toContain("re-submit");
    expect(harness.repo.getEffect(RUN_ID, "workflow.intake")?.outcome).toBe(
      "failed",
    );
  });

  it("a crash after the verify commit resumes into review without re-running verification", async () => {
    armFailpoint("after_verify_commit");
    const started = await harness.controller.start(startParams(harness));
    await expect(harness.controller.awaitRun(started.runId)).rejects.toThrow(
      /failpoint/,
    );
    disarmFailpoint();
    expect(harness.commands.executed).toHaveLength(1);
    expect(harness.repo.getEffect(RUN_ID, "workflow.verify.agent")?.outcome).toBe(
      "committed",
    );

    await harness.controller.resumeOpenWorkflows();
    await harness.controller.awaitRun(RUN_ID);
    expect(harness.repo.getCurrentTerminalResult(RUN_ID)?.status).toBe(
      "completed",
    );
    // Commands and the verify agent were replayed from durable rows, not
    // re-executed: sticky (run_id, step_id) outcomes.
    expect(harness.commands.executed).toHaveLength(1);
    expect(
      harness.spawner.spawns.filter((s) => s.kind === "verify_agent"),
    ).toHaveLength(1);
  });
});
