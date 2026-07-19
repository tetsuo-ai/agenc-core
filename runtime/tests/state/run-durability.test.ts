import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunTerminalResult } from "../../src/contracts/run-contracts.js";
import {
  RunDurabilityConflictError,
  StateRunDurabilityRepository,
} from "../../src/state/run-durability.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

let home: string;
let cwd: string;
let driver: StateSqliteDriver;
let runs: StateRunDurabilityRepository;

const T0 = "2026-07-18T00:00:00.000Z";
const T1 = "2026-07-18T00:00:01.000Z";
const T2 = "2026-07-18T00:00:02.000Z";
const T3 = "2026-07-18T00:00:03.000Z";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-run-durability-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-run-durability-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  runs = new StateRunDurabilityRepository(driver);
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function terminal(
  overrides: Partial<RunTerminalResult> = {},
): RunTerminalResult {
  return {
    runId: "run-1",
    status: "completed",
    exitCode: 0,
    stopReason: "end_turn",
    finalMessage: "done",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
    },
    lastSequence: 10,
    finishedAt: T1,
    ...overrides,
  };
}

function beginSideEffect(stepId = "step-write", sequence = 1) {
  return runs.beginEffect({
    runId: "run-1",
    epoch: 1,
    stepId,
    childRunId: "child-1",
    sessionId: "session-1",
    toolName: "FileWrite",
    recoveryCategory: "side-effecting",
    intentDigest: `sha256:intent:${stepId}`,
    eventId: `event-intent-${stepId}`,
    eventSequence: sequence,
    intentAt: T0,
  });
}

describe("StateRunDurabilityRepository", () => {
  it("keeps terminal results sticky and retains them across explicit reopen epochs", () => {
    const initial = runs.ensureInitialEpoch({
      runId: "run-1",
      openedAt: T0,
      openedEventId: "event-open-1",
    });
    expect(initial).toMatchObject({ applied: true, value: { epoch: 1 } });
    expect(
      runs.ensureInitialEpoch({
        runId: "run-1",
        // A later observer may not know the first writer's exact wall clock.
        openedAt: T1,
        openedEventId: "event-open-1",
      }).applied,
    ).toBe(false);

    const first = runs.recordTerminalResult({
      epoch: 1,
      result: terminal(),
      eventId: "event-terminal-1",
    });
    expect(first.applied).toBe(true);
    expect(first.value).toMatchObject({
      epoch: 1,
      eventId: "event-terminal-1",
      finalMessage: "done",
    });

    // Replaying the canonical event is an acknowledgement, but a competing
    // identity for the same logical terminal result is still a conflict.
    expect(
      runs.recordTerminalResult({
        epoch: 1,
        result: terminal(),
        eventId: "event-terminal-1",
      }).applied,
    ).toBe(false);
    expect(() =>
      runs.recordTerminalResult({
        epoch: 1,
        result: terminal(),
        eventId: "event-terminal-late-copy",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_TERMINAL_RESULT_CONFLICT" }),
    );
    expect(() =>
      runs.recordTerminalResult({
        epoch: 1,
        result: terminal({ finalMessage: "different" }),
        eventId: "event-terminal-conflict",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_TERMINAL_RESULT_CONFLICT" }),
    );
    expect(runs.getCurrentTerminalResult("run-1")?.finalMessage).toBe("done");
    expect(() =>
      driver
        .prepareState(
          "UPDATE run_terminal_results SET final_message = 'laundered' WHERE run_id = 'run-1'",
        )
        .run(),
    ).toThrow(/terminal result is immutable/);

    const reopened = runs.reopenRun({
      runId: "run-1",
      fromEpoch: 1,
      openedAt: T2,
      eventId: "event-reopen-2",
      reason: "operator_retry",
    });
    expect(reopened).toMatchObject({
      applied: true,
      value: { epoch: 2, reopenedFromEpoch: 1 },
    });
    expect(
      runs.ensureInitialEpoch({ runId: "run-1", openedAt: T3 }),
    ).toMatchObject({ applied: false, value: { epoch: 1, openedAt: T0 } });
    expect(runs.getCurrentTerminalResult("run-1")).toBeUndefined();
    expect(runs.listTerminalHistory("run-1")).toHaveLength(1);
    expect(
      runs.reopenRun({
        runId: "run-1",
        fromEpoch: 1,
        openedAt: T2,
        eventId: "event-reopen-2",
        reason: "operator_retry",
      }).applied,
    ).toBe(false);
    expect(() =>
      runs.reopenRun({
        runId: "run-1",
        fromEpoch: 2,
        openedAt: T3,
        eventId: "event-reopen-3",
        reason: "too_early",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_EPOCH_NOT_TERMINAL" }),
    );

    runs.recordTerminalResult({
      epoch: 2,
      result: terminal({
        status: "failed",
        exitCode: 1,
        stopReason: "error",
        finalMessage: null,
        lastSequence: 20,
        finishedAt: T3,
      }),
      eventId: "event-terminal-2",
    });
    expect(runs.getCurrentTerminalResult("run-1")).toMatchObject({
      epoch: 2,
      status: "failed",
    });
    expect(runs.listTerminalHistory("run-1").map((item) => item.epoch)).toEqual([
      1, 2,
    ]);
  });

  it("review-locks unknown mutations and rejects late outcome laundering", () => {
    runs.ensureInitialEpoch({ runId: "run-1", openedAt: T0 });
    const intent = beginSideEffect();
    expect(intent.applied).toBe(true);
    expect(beginSideEffect().applied).toBe(false);

    const unknown = runs.markEffectUnknown({
      runId: "run-1",
      stepId: "step-write",
      eventId: "event-unknown",
      eventSequence: 2,
      reason: "acknowledgement_lost",
      evidence: { processId: 42 },
      observedAt: T1,
    });
    expect(unknown.value).toMatchObject({
      outcome: "unknown_outcome",
      reviewStatus: "pending",
      unknownReason: "acknowledgement_lost",
    });
    expect(
      runs.markEffectUnknown({
        runId: "run-1",
        stepId: "step-write",
        eventId: "event-unknown",
        eventSequence: 2,
        reason: "acknowledgement_lost",
        evidence: { processId: 42 },
        observedAt: T1,
      }).applied,
    ).toBe(false);
    expect(() =>
      runs.completeEffect({
        runId: "run-1",
        stepId: "step-write",
        outcome: "committed",
        eventId: "event-late-success",
        eventSequence: 3,
        completedAt: T2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_EFFECT_OUTCOME_CONFLICT" }),
    );
    expect(() => beginSideEffect("step-dependent", 3)).toThrowError(
      expect.objectContaining({ code: "RUN_EFFECT_REVIEW_REQUIRED" }),
    );

    // Safe, contract-proven idempotent work is not a dependent mutation.
    expect(
      runs.beginEffect({
        runId: "run-1",
        epoch: 1,
        stepId: "step-read",
        sessionId: "session-1",
        toolName: "FileRead",
        recoveryCategory: "idempotent",
        idempotencyKey: "read:/workspace/file@digest",
        intentDigest: "sha256:read",
        eventId: "event-read",
        eventSequence: 3,
        intentAt: T2,
      }).applied,
    ).toBe(true);

    runs.recordTerminalResult({
      epoch: 1,
      result: terminal({
        status: "unknown_outcome",
        exitCode: null,
        stopReason: "uncertain_effect",
        finalMessage: null,
        usage: null,
        lastSequence: 4,
      }),
      eventId: "event-terminal-unknown",
    });
    expect(() =>
      runs.reopenRun({
        runId: "run-1",
        fromEpoch: 1,
        openedAt: T2,
        eventId: "event-reopen-blocked",
        reason: "retry",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_REOPEN_REVIEW_REQUIRED" }),
    );

    const reviewed = runs.resolveEffectReview({
      runId: "run-1",
      stepId: "step-write",
      reviewedAt: T2,
      reviewedBy: "operator-1",
      resolution: "manual_remediation",
      eventId: "event-review",
      evidence: { ticket: "INC-1" },
    });
    expect(reviewed.value).toMatchObject({
      outcome: "unknown_outcome",
      reviewStatus: "resolved",
      reviewedBy: "operator-1",
    });
    expect(
      runs.resolveEffectReview({
        runId: "run-1",
        stepId: "step-write",
        reviewedAt: T2,
        reviewedBy: "operator-1",
        resolution: "manual_remediation",
        eventId: "event-review",
        evidence: { ticket: "INC-1" },
      }).applied,
    ).toBe(false);
    expect(() =>
      runs.resolveEffectReview({
        runId: "run-1",
        stepId: "step-write",
        reviewedAt: T3,
        reviewedBy: "operator-2",
        resolution: "confirmed_committed",
        eventId: "event-review-conflict",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_EFFECT_REVIEW_CONFLICT" }),
    );
    expect(
      runs.reopenRun({
        runId: "run-1",
        fromEpoch: 1,
        openedAt: T3,
        eventId: "event-reopen-after-review",
        reason: "review_resolved",
      }).value.epoch,
    ).toBe(2);
    expect(runs.getEffect("run-1", "step-write")?.outcome).toBe(
      "unknown_outcome",
    );
  });

  it("requires durable idempotency keys and unique projected event sequences", () => {
    runs.ensureInitialEpoch({ runId: "run-1", openedAt: T0 });
    expect(() =>
      runs.beginEffect({
        runId: "run-1",
        epoch: 1,
        stepId: "read-no-key",
        sessionId: "session-1",
        toolName: "FileRead",
        recoveryCategory: "idempotent",
        intentDigest: "sha256:read",
        eventId: "event-read",
        eventSequence: 1,
        intentAt: T0,
      }),
    ).toThrow(/require idempotencyKey/);
    beginSideEffect("step-a", 1);
    expect(() => beginSideEffect("step-b", 1)).toThrowError(
      expect.objectContaining({ code: "RUN_EVENT_SEQUENCE_CONFLICT" }),
    );
    runs.completeEffect({
      runId: "run-1",
      stepId: "step-a",
      outcome: "committed",
      eventId: "event-result-a",
      eventSequence: 2,
      resultDigest: "sha256:result",
      result: { bytesWritten: 4 },
      completedAt: T1,
    });
    expect(() =>
      runs.recordTerminalResult({
        epoch: 1,
        result: terminal({ lastSequence: 2 }),
        eventId: "event-terminal-collision",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_EVENT_SEQUENCE_CONFLICT" }),
    );
  });

  it("tracks historical rollout sources and makes retirement gaps explicit", () => {
    runs.ensureInitialEpoch({ runId: "run-1", openedAt: T0 });
    const first = runs.bindJournalSource({
      runId: "run-1",
      epoch: 1,
      childRunId: "run-1",
      sessionId: "session-1",
      sourcePath: "/rollouts/run-1-a.jsonl",
      firstAvailableSequence: 1,
      lastSequence: 5,
      boundAt: T0,
    });
    expect(first.value.active).toBe(true);
    expect(
      runs.bindJournalSource({
        runId: "run-1",
        epoch: 1,
        childRunId: "run-1",
        sessionId: "session-1",
        sourcePath: "/rollouts/run-1-a.jsonl",
        firstAvailableSequence: 1,
        lastSequence: 5,
        boundAt: T0,
      }).applied,
    ).toBe(false);

    runs.bindJournalSource({
      runId: "run-1",
      epoch: 1,
      childRunId: "run-1",
      sessionId: "session-1",
      sourcePath: "/rollouts/run-1-b.jsonl",
      firstAvailableSequence: 6,
      lastSequence: 10,
      boundAt: T1,
    });
    const bindings = runs.listJournalBindings("run-1", 1);
    expect(bindings.map((binding) => [binding.sourcePath, binding.active])).toEqual([
      ["/rollouts/run-1-a.jsonl", false],
      ["/rollouts/run-1-b.jsonl", true],
    ]);

    expect(
      runs.updateJournalBounds({
        sourcePath: "/rollouts/run-1-b.jsonl",
        firstAvailableSequence: 6,
        lastSequence: 12,
        updatedAt: T2,
      }).lastSequence,
    ).toBe(12);
    expect(() =>
      runs.updateJournalBounds({
        sourcePath: "/rollouts/run-1-b.jsonl",
        firstAvailableSequence: 8,
        lastSequence: 12,
        updatedAt: T2,
      }),
    ).toThrow(/record an explicit gap/);

    const gap = runs.markJournalGap({
      sourcePath: "/rollouts/run-1-b.jsonl",
      retiredThroughSequence: 7,
      firstAvailableSequence: 8,
      lastSequence: 12,
      reason: "compaction",
      observedAt: T3,
    });
    expect(gap).toMatchObject({
      firstAvailableSequence: 8,
      lastSequence: 12,
      retiredThroughSequence: 7,
      gapReason: "compaction",
      gapObservedAt: T3,
    });
    expect(() =>
      runs.markJournalGap({
        sourcePath: "/rollouts/run-1-b.jsonl",
        retiredThroughSequence: 6,
        firstAvailableSequence: 8,
        lastSequence: 12,
        reason: "retention",
        observedAt: T3,
      }),
    ).toThrow(/cannot move backwards/);

    runs.ensureInitialEpoch({ runId: "run-2", openedAt: T0 });
    expect(() =>
      runs.bindJournalSource({
        runId: "run-2",
        epoch: 1,
        childRunId: "run-2",
        sessionId: "session-2",
        sourcePath: "/rollouts/run-1-b.jsonl",
        boundAt: T3,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_JOURNAL_BINDING_CONFLICT" }),
    );
  });

  it("retires journal bindings atomically and preserves the projected tail", () => {
    runs.ensureInitialEpoch({ runId: "run-1", openedAt: T0 });
    runs.bindJournalSource({
      runId: "run-1",
      epoch: 1,
      childRunId: "run-1",
      sessionId: "session-1",
      sourcePath: "/rollouts/retired.jsonl",
      firstAvailableSequence: 1,
      lastSequence: 4,
      boundAt: T0,
    });
    driver.prepareState(
      `INSERT INTO threads (thread_id, created_at, updated_at)
       VALUES ('run-1', ?, ?)`,
    ).run(T0, T0);
    driver.prepareState(
      `INSERT INTO thread_rollout_items (
         thread_id, source_path, line_number, byte_offset, item_index,
         item_type, event_id, event_seq, payload_json, line_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-1",
      "/rollouts/retired.jsonl",
      1,
      0,
      1,
      "event_msg",
      "event-9",
      9,
      "{}",
      "sha256:line",
    );

    expect(() =>
      driver.transactionImmediate(() => {
        runs.retireJournalSource({
          sourcePath: "/rollouts/retired.jsonl",
          reason: "retention",
          observedAt: T2,
        });
        throw new Error("roll back outer prune transaction");
      }),
    ).toThrow(/roll back outer prune transaction/);
    expect(runs.getJournalBinding("/rollouts/retired.jsonl")?.active).toBe(true);

    const retired = runs.retireJournalSource({
      sourcePath: "/rollouts/retired.jsonl",
      reason: "retention",
      observedAt: T2,
    });
    expect(retired).toMatchObject({
      applied: true,
      value: {
        active: false,
        lastSequence: 9,
        retiredThroughSequence: 9,
        gapReason: "retention",
        gapObservedAt: T2,
      },
    });
    expect(retired.value?.firstAvailableSequence).toBeUndefined();
    expect(
      runs.retireJournalSource({
        sourcePath: "/rollouts/retired.jsonl",
        reason: "retention",
        observedAt: T3,
      }).applied,
    ).toBe(false);
    expect(
      runs.retireJournalSource({
        sourcePath: "/rollouts/legacy-unbound.jsonl",
        reason: "retention",
        observedAt: T3,
      }),
    ).toEqual({ applied: false, value: undefined });
  });

  it("survives repository reopen without losing terminal, effect, or binding state", () => {
    runs.ensureInitialEpoch({ runId: "run-1", openedAt: T0 });
    beginSideEffect();
    runs.completeEffect({
      runId: "run-1",
      stepId: "step-write",
      outcome: "committed",
      eventId: "event-result",
      eventSequence: 2,
      completedAt: T1,
    });
    runs.bindJournalSource({
      runId: "run-1",
      epoch: 1,
      childRunId: "run-1",
      sessionId: "session-1",
      sourcePath: "/rollouts/run-1.jsonl",
      firstAvailableSequence: 1,
      lastSequence: 2,
      boundAt: T0,
    });
    runs.recordTerminalResult({
      epoch: 1,
      result: terminal({ lastSequence: 3 }),
      eventId: "event-terminal",
    });

    driver.close();
    driver = openStateDatabases({ cwd, agencHome: home });
    runs = new StateRunDurabilityRepository(driver);

    expect(runs.currentEpoch("run-1")?.epoch).toBe(1);
    expect(runs.getCurrentTerminalResult("run-1")?.status).toBe("completed");
    expect(runs.getEffect("run-1", "step-write")?.outcome).toBe("committed");
    expect(runs.listJournalBindings("run-1")).toMatchObject([
      { sourcePath: "/rollouts/run-1.jsonl", lastSequence: 2 },
    ]);
  });
});

it("exposes typed durability conflict errors", () => {
  const error = new RunDurabilityConflictError(
    "RUN_EFFECT_NOT_FOUND",
    "missing",
  );
  expect(error).toMatchObject({
    name: "RunDurabilityConflictError",
    code: "RUN_EFFECT_NOT_FOUND",
    message: "missing",
  });
});
