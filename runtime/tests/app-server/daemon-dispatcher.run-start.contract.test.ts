/**
 * M5 Phase 5 — `run.start` dispatcher contract.
 *
 * Drives the REAL dispatcher validate/route path (initialize → run.start)
 * into the real `DaemonWorkflowStartService` + `VerifiedChangeWorkflowController`
 * over scripted seams (the Phase 4 harness pattern) in a temp git repo.
 * Nothing here touches a network or spawns a model.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import {
  DaemonWorkflowStartService,
  workflowRunObjective,
  type WorkflowStartedRunRecord,
} from "../../src/app-server/workflow/run-start-service.js";
import {
  VerifiedChangeWorkflowController,
  type WorkflowAgentSpawner,
  type WorkflowChildOutcome,
  type WorkflowEvidenceLedger,
  type WorkflowRunJournal,
  type WorkflowSpawnKind,
  type WorkflowWorktreeBroker,
} from "../../src/app-server/workflow/verified-change-controller.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
  WorkflowSpec,
} from "../../src/contracts/run-contracts.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";
import type { Sha256Digest } from "../../src/eval-contract/types.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import type { ReviewerInvoker } from "../../src/workflow/independent-review.js";
import type { WorkflowCommandRunner } from "../../src/workflow/verification.js";
import type { WorktreeHandle } from "../../src/agents/worktree.js";
import {
  JSON_RPC_VERSION,
  type JsonObject,
  type RunStartResult,
} from "../../src/app-server/protocol/index.js";
import type { VerifiedChangeRecord } from "../../src/workflow/evidence-record.js";

const BASE_COMMIT = "c".repeat(40);
const HEAD_COMMIT = "d".repeat(40);

// ---------------------------------------------------------------------------
// Scripted seams (Phase 4 harness shape, happy-path defaults)
// ---------------------------------------------------------------------------

class TestJournal implements WorkflowRunJournal {
  readonly sessionId: string;
  readonly epoch: number;
  #seq = 0;

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

class MemoryLedger implements WorkflowEvidenceLedger {
  readonly payloads = new Map<string, Uint8Array>();
  #eventCount = 1;
  #headDigest: Sha256Digest;
  sealed = false;

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
    this.#eventCount += 1;
    this.#headDigest = sha256Digest(`${this.#headDigest}|${hex}`);
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
      eventCount: this.#eventCount,
      headEventDigest: this.#headDigest,
      sealed: this.sealed,
    };
  }

  async readArtifact(pointer: RunArtifactPointer): Promise<Uint8Array> {
    const bytes = this.payloads.get(pointer.digest.slice("sha256:".length));
    if (bytes === undefined) {
      throw new Error(`missing payload ${pointer.digest}`);
    }
    return bytes;
  }

  async seal(): Promise<{ sealDigest: string }> {
    this.sealed = true;
    return { sealDigest: sha256Digest(`seal:${this.#headDigest}`) };
  }

  async persistRecord(_record: VerifiedChangeRecord): Promise<void> {}
}

class FakeWorktrees implements WorkflowWorktreeBroker {
  provisions = 0;
  readonly patchText = "diff --git a/f b/f\n--- a/f\n+++ b/f\n+x\n";

  async captureBaseState() {
    return {
      baseCommit: BASE_COMMIT,
      dirty: false,
      fileCount: 0,
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
    sink: WorkflowEvidenceLedger;
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
    return { kind: "unmoved" } as const;
  }

  async cleanup(): Promise<void> {}
}

class FakeSpawner implements WorkflowAgentSpawner {
  readonly spawns: WorkflowSpawnKind[] = [];

  async spawn(input: { kind: WorkflowSpawnKind }): Promise<WorkflowChildOutcome> {
    this.spawns.push(input.kind);
    const finalMessage =
      input.kind === "verify_agent"
        ? "checked everything\nVERDICT: PASS"
        : input.kind === "plan"
          ? "PLAN: make the edit"
          : "done";
    return {
      status: "completed",
      finalMessage,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.02,
      },
    };
  }

  async inspect() {
    return { state: "unknown" } as const;
  }
}

const APPROVING_REVIEW = JSON.stringify({
  findings: [],
  overallCorrectness: "correct",
  overallExplanation: "clean change",
  overallConfidenceScore: 0.9,
});

const reviewer: ReviewerInvoker = {
  invoke: async () => APPROVING_REVIEW,
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  home: string;
  repoDir: string;
  nonGitDir: string;
  driver: StateSqliteDriver;
  repo: StateRunDurabilityRepository;
  controller: VerifiedChangeWorkflowController;
  spawner: FakeSpawner;
  recorded: WorkflowStartedRunRecord[];
  warnings: string[];
  dispatcher: AgenCDaemonJsonRpcDispatcher;
  cleanup(): void;
}

let harness: Harness;

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "agenc-m5-run-start-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "agenc-m5-run-start-repo-"));
  const nonGitDir = mkdtempSync(join(tmpdir(), "agenc-m5-run-start-plain-"));
  mkdirSync(join(repoDir, ".git"));
  const driver = openStateDatabases({ cwd: repoDir, agencHome: home });
  const repo = new StateRunDurabilityRepository(driver);
  const admission = new FakeAdmission();
  const spawner = new FakeSpawner();
  const worktrees = new FakeWorktrees();
  const ledgers = new Map<string, MemoryLedger>();
  const warnings: string[] = [];
  const recorded: WorkflowStartedRunRecord[] = [];
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
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: new AgenCDaemonAgentManager(),
    workflow: new DaemonWorkflowStartService({
      controller,
      primaryCwd: repoDir,
      recordAgentRun: (run) => {
        recorded.push(run);
      },
      warn: (message) => warnings.push(message),
    }),
  });
  return {
    home,
    repoDir,
    nonGitDir,
    driver,
    repo,
    controller,
    spawner,
    recorded,
    warnings,
    dispatcher,
    cleanup: () => {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(nonGitDir, { recursive: true, force: true });
    },
  };
}

async function initializedConnection() {
  const connection = harness.dispatcher.createConnection();
  const initialize = await connection.dispatch({
    jsonrpc: JSON_RPC_VERSION,
    id: "init",
    method: "initialize",
    params: { protocol: { version: "1.0.0" } },
  } as unknown as JsonObject);
  return { connection, initialize };
}

function startParams(overrides: JsonObject = {}): JsonObject {
  return {
    goal: "Fix the reported bug",
    cwd: harness.repoDir,
    reviewerModel: "test-reviewer",
    requiredVerification: [{ label: "unit", script: "run-tests" }],
    ...overrides,
  };
}

async function dispatchRunStart(
  params: JsonObject,
): Promise<{ result?: RunStartResult; error?: JsonObject }> {
  const { connection } = await initializedConnection();
  const response = (await connection.dispatch({
    jsonrpc: JSON_RPC_VERSION,
    id: "start",
    method: "run.start",
    params,
  } as unknown as JsonObject)) as unknown as {
    result?: RunStartResult;
    error?: JsonObject;
  };
  return response;
}

beforeEach(() => {
  harness = makeHarness();
});

afterEach(() => {
  harness.cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon dispatcher — run.start", () => {
  it("advertises the run.start capability exactly when the workflow seam exists", async () => {
    const { initialize } = await initializedConnection();
    const capabilities = (
      initialize as unknown as {
        result: { capabilities: { "daemon.methods": Record<string, boolean> } };
      }
    ).result.capabilities["daemon.methods"];
    expect(capabilities["run.start"]).toBe(true);

    const bare = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const bareConnection = bare.createConnection();
    const bareInitialize = (await bareConnection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocol: { version: "1.0.0" } },
    } as unknown as JsonObject)) as unknown as {
      result: { capabilities: { "daemon.methods": Record<string, boolean> } };
    };
    expect(
      bareInitialize.result.capabilities["daemon.methods"]["run.start"],
    ).toBe(false);
    const unimplemented = (await bareConnection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      method: "run.start",
      params: startParams(),
    } as unknown as JsonObject)) as unknown as {
      error?: { code: number };
    };
    expect(unimplemented.error?.code).toBe(-32601);
  });

  it("routes a valid run.start through validation into the controller and returns the intake result", async () => {
    const { result, error } = await dispatchRunStart(startParams());
    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      baseCommit: BASE_COMMIT,
      baseDirty: { dirty: false, fileCount: 0 },
    });
    expect(result!.specDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Intake committed durably under the returned run id; the async pipeline
    // completes over the scripted seams.
    await harness.controller.awaitRun(result!.runId);
    expect(harness.repo.getCurrentTerminalResult(result!.runId)).toMatchObject({
      status: "completed",
    });
    expect(harness.spawner.spawns).toEqual([
      "plan",
      "implement",
      "verify_agent",
    ]);

    // The run reached the agents rail with a readable verified-change name.
    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]).toMatchObject({
      id: result!.runId,
      objective: workflowRunObjective("Fix the reported bug"),
      status: "running",
      cwd: harness.repoDir,
    });
  });

  it("rejects a missing or empty goal with a typed INVALID_ARGUMENT error", async () => {
    const missing = await dispatchRunStart({
      cwd: harness.repoDir,
    });
    expect(missing.error).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT" },
    });
    const empty = await dispatchRunStart(startParams({ goal: "   " }));
    expect(empty.error).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT" },
    });
  });

  it("rejects a nonexistent cwd before touching the controller", async () => {
    const { error } = await dispatchRunStart(
      startParams({ cwd: join(harness.nonGitDir, "does-not-exist") }),
    );
    expect(error).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT" },
    });
    expect(harness.recorded).toHaveLength(0);
  });

  it("rejects a cwd outside any git repository with a clean protocol error", async () => {
    const { error } = await dispatchRunStart(
      startParams({ cwd: harness.nonGitDir }),
    );
    expect(error).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT" },
    });
    expect(String((error as { message?: unknown }).message)).toContain(
      "not inside a git repository",
    );
  });

  it("surfaces the controller's at-least-one-verification policy faithfully", async () => {
    const omitted = await dispatchRunStart(
      startParams({ requiredVerification: undefined }),
    );
    expect(omitted.error).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT" },
    });
    expect(String((omitted.error as { message?: unknown }).message)).toContain(
      "at least one verification command",
    );
    const empty = await dispatchRunStart(
      startParams({ requiredVerification: [] }),
    );
    expect(empty.error).toMatchObject({
      code: -32602,
      data: { code: "INVALID_ARGUMENT" },
    });
  });

  it("rejects malformed verification entries and unknown params at the validator", async () => {
    const badEntry = await dispatchRunStart(
      startParams({ requiredVerification: [{ label: "unit" }] }),
    );
    expect(badEntry.error).toMatchObject({ code: -32602 });
    const unknownParam = await dispatchRunStart(
      startParams({ nonsense: true }),
    );
    expect(unknownParam.error).toMatchObject({ code: -32602 });
    const badMode = await dispatchRunStart(
      startParams({ permissionMode: "yolo" }),
    );
    expect(badMode.error).toMatchObject({ code: -32602 });
  });
});
