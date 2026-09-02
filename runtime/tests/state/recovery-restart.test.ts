import {
  mkdirSync,
  mkdtempSync,
  fstatSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverDaemonStateOnStartup } from "./recovery.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type Event,
} from "../../src/session/event-log.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { StateRecoveryIncidentRepository } from "../../src/state/recovery-incidents.js";
import { StartupRecoveryBudget } from "../../src/state/recovery-cutover.js";
import {
  recoverCanonicalRunJournalForRun,
  recoverCanonicalRunJournalsOnStartup,
  StartupResumeSourceBudget,
} from "../../src/state/startup-run-journal-recovery.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { openFndFixtureCatalog } from "../helpers/fnd-fixtures.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-recovery-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-recovery-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("recoverDaemonStateOnStartup", () => {
  it("fails closed when a canonical cancel request committed before its terminal", () => {
    insertAgentRun({
      id: "run-cancel-request-crash",
      objective: "must not resume after cancellation intent",
      status: "running",
      currentSessionId: "run-cancel-request-crash",
    });
    const rolloutPath = writeRunJournal("run-cancel-request-crash", [
      {
        eventId: "run-cancel-request:run-cancel-request-crash:1",
        id: "run-cancel-request:run-cancel-request-crash:1",
        seq: 1,
        msg: {
          type: "run_cancel_requested",
          payload: {
            runId: "run-cancel-request-crash",
            epoch: 1,
            reason: "operator",
            requestedAt: "2026-05-01T00:06:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-cancel-request-crash", rolloutPath);

    const resumeBudget = new StartupResumeSourceBudget(1);
    const report = recoverDaemonStateOnStartup(driver, {
      retainRuntimeResumeSources: true,
      startupResumeSourceBudget: resumeBudget,
    });

    expect(report.recoveredRuns).toEqual([]);
    expect(resumeBudget.retainedSources).toBe(0);
    expect(agentRunStatus("run-cancel-request-crash")).toBe("cancelled");
    expect(
      new StateRunDurabilityRepository(driver).getCurrentTerminalResult(
        "run-cancel-request-crash",
      ),
    ).toBeUndefined();
  });

  it("fails closed when admission cancellation committed before the canonical terminal", () => {
    insertAgentRun({
      id: "run-admission-cancel-crash",
      objective: "must not regain execution authority",
      status: "running",
      currentSessionId: "run-admission-cancel-crash",
    });
    driver
      .prepareState(
        `INSERT INTO execution_admission_cancellations (
           run_id, reason, cancelled_at
         ) VALUES (?, ?, ?)`,
      )
      .run(
        "run-admission-cancel-crash",
        "operator",
        "2026-05-01T00:06:00.000Z",
      );

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(agentRunStatus("run-admission-cancel-crash")).toBe("cancelled");
  });

  // Review P1-7: desktop run.status/run.replay on a live run hit the writer's
  // rollout lease, persisted a source_not_quiescent deferral, and that active
  // row excluded the run from recovery at the next daemon start ("pending
  // operator recovery action") even though nothing was wrong with the source.
  describe("source_not_quiescent deferrals", () => {
    const failedAtMs = Date.parse("2026-05-01T00:10:00.000Z");

    function seedLiveSourceDeferral(
      runId: string,
      reasonCode: "source_not_quiescent" | "database_io" = "source_not_quiescent",
    ): string {
      insertAgentRun({
        id: runId,
        objective: "recover after a stale live-source deferral",
        status: "running",
        currentSessionId: runId,
      });
      const rolloutPath = writeRuntimeResumeJournal(runId);
      bindRunJournal(runId, rolloutPath);
      new StateRecoveryIncidentRepository(driver).recordDeferred({
        runId,
        sourceKind: "run_journal",
        sourcePath: rolloutPath,
        reasonCode,
        errorClass: "RECOVERY_SOURCE_LIVE",
        safeDetail: { message: "canonical recovery source is not quiescent" },
        failedAtMs,
        nextRetryMs: failedAtMs + 60_000,
      });
      return rolloutPath;
    }

    function deferredStates(runId: string): readonly string[] {
      return driver
        .prepareState<[string], { readonly state: string }>(
          "SELECT state FROM run_recovery_deferred WHERE run_id = ? ORDER BY block_id",
        )
        .all(runId)
        .map((row) => row.state);
    }

    it("resolves an expired source_not_quiescent deferral at startup and recovers the run", () => {
      const runId = "run-stale-live-deferral";
      const rolloutPath = seedLiveSourceDeferral(runId);

      const report = recoverDaemonStateOnStartup(driver, {
        now: () => "2026-05-01T00:11:01.000Z",
      });

      expect(report.recoveryExclusions).toEqual([]);
      expect(report.recoveredRuns).toEqual([
        expect.objectContaining({ id: runId, status: "running" }),
      ]);
      expect(projectedRolloutRows(rolloutPath)).toBe(1);
      expect(deferredStates(runId)).toEqual(["resolved"]);
    });

    it("keeps an unexpired source_not_quiescent deferral in force", () => {
      const runId = "run-fresh-live-deferral";
      seedLiveSourceDeferral(runId);

      const report = recoverDaemonStateOnStartup(driver, {
        now: () => "2026-05-01T00:10:30.000Z",
      });

      expect(report.recoveredRuns).toEqual([]);
      expect(report.recoveryExclusions).toEqual([
        expect.objectContaining({
          runId,
          kind: "deferred",
          reasonCode: "source_not_quiescent",
        }),
      ]);
      expect(deferredStates(runId)).toEqual(["active"]);
    });

    it("leaves expired deferrals with other reason codes to the operator", () => {
      const runId = "run-expired-io-deferral";
      seedLiveSourceDeferral(runId, "database_io");

      const report = recoverDaemonStateOnStartup(driver, {
        now: () => "2026-05-01T00:11:01.000Z",
      });

      expect(report.recoveredRuns).toEqual([]);
      expect(report.recoveryExclusions).toEqual([
        expect.objectContaining({
          runId,
          kind: "deferred",
          reasonCode: "database_io",
        }),
      ]);
      expect(deferredStates(runId)).toEqual(["active"]);
    });

    it("serves an on-demand read of a live source without persisting a deferral", () => {
      const runId = "run-live-on-demand";
      insertAgentRun({
        id: runId,
        objective: "read while running",
        status: "running",
        currentSessionId: runId,
      });
      const rolloutPath = writeRuntimeResumeJournal(runId);
      bindRunJournal(runId, rolloutPath);
      writeFileSync(
        `${rolloutPath}.lock`,
        `${JSON.stringify({
          pid: process.pid,
          startNs: "live-writer",
          acquiredAtIso: "2026-05-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      const served = recoverCanonicalRunJournalForRun(driver, runId, {
        strict: { liveSourceDeferral: "skip" },
      });
      expect(served.exclusion).toMatchObject({
        runId,
        kind: "deferred",
        reasonCode: "source_not_quiescent",
        permanent: false,
      });
      expect(served.exclusion?.evidenceId).toBeUndefined();
      expect(deferredStates(runId)).toEqual([]);

      // The default (startup) contract still records the retryable block.
      const recorded = recoverCanonicalRunJournalForRun(driver, runId);
      expect(recorded.exclusion).toMatchObject({
        runId,
        kind: "deferred",
        reasonCode: "source_not_quiescent",
      });
      expect(recorded.exclusion?.evidenceId).toBeDefined();
      expect(deferredStates(runId)).toEqual(["active"]);
    });
  });

  it("keeps a canonically projected run listable when live cwd authority is unavailable", () => {
    const runId = "run-runtime-cwd-unavailable";
    insertAgentRun({
      id: runId,
      objective: "remain cold and listable",
      status: "running",
      currentSessionId: runId,
    });
    const rolloutPath = writeRuntimeResumeJournal(
      runId,
      join(cwd, "missing-workspace"),
    );
    bindRunJournal(runId, rolloutPath);
    const resumeBudget = new StartupResumeSourceBudget(1);

    const report = recoverDaemonStateOnStartup(driver, {
      retainRuntimeResumeSources: true,
      startupResumeSourceBudget: resumeBudget,
    });

    expect(report.recoveryExclusions).toEqual([]);
    expect(report.recoveredRuns).toEqual([
      expect.objectContaining({ id: runId, status: "running" }),
    ]);
    expect(report.recoveredRuns[0]?.resumeSource).toBeUndefined();
    expect(projectedRolloutRows(rolloutPath)).toBe(1);
    expect(agentRunStatus(runId)).toBe("running");
    expect(resumeBudget.retainedSources).toBe(0);
  });

  it("retains append authority from the active root binding instead of a longer historical source", () => {
    const runId = "run-active-short-source";
    insertAgentRun({
      id: runId,
      objective: "resume only the active source",
      status: "running",
      currentSessionId: runId,
    });
    const directory = join(driver.projectDir, "sessions", runId);
    mkdirSync(directory, { recursive: true });
    const oldPath = join(directory, `rollout-old-${runId}.jsonl`);
    const activePath = join(directory, `rollout-new-${runId}.jsonl`);
    const meta = (model: string) =>
      serializeRolloutItem({
        type: "session_meta",
        payload: {
          sessionId: runId,
          timestamp: "2026-05-01T00:00:00.000Z",
          cwd,
          originator: "recovery-restart-test",
          source: "interactive-root",
          agencVersion: "0.16.1",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
          model,
          modelProvider: "test-provider",
        },
      });
    writeFileSync(oldPath, meta("historical-" + "x".repeat(2_048)), {
      mode: 0o600,
    });
    writeFileSync(activePath, meta("active"), { mode: 0o600 });
    const repository = new StateRunDurabilityRepository(driver);
    repository.ensureInitialEpoch({
      runId,
      openedAt: "2026-05-01T00:00:00.000Z",
    });
    repository.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: oldPath,
      boundAt: "2026-05-01T00:01:00.000Z",
    });
    repository.bindJournalSource({
      runId,
      epoch: 1,
      childRunId: runId,
      sessionId: runId,
      sourcePath: activePath,
      boundAt: "2026-05-01T00:02:00.000Z",
    });

    const report = recoverDaemonStateOnStartup(driver, {
      retainRuntimeResumeSources: true,
      startupResumeSourceBudget: new StartupResumeSourceBudget(1),
    });

    expect(report.recoveryExclusions).toEqual([]);
    expect(report.recoveredRuns[0]?.resumeSource?.rolloutPath).toBe(activePath);
    report.recoveredRuns[0]?.resumeSource?.close();
  });

  it("projects a fsynced terminal event before a stale running row can be restored", () => {
    insertAgentRun({
      id: "run-terminal-journal",
      objective: "must stay finished",
      status: "running",
      currentSessionId: "run-terminal-journal",
    });
    const rolloutPath = writeRunJournal("run-terminal-journal", [
      {
        id: "run-terminal:run-terminal-journal:1",
        seq: 1,
        msg: {
          type: "run_terminal",
          payload: {
            runId: "run-terminal-journal",
            epoch: 1,
            status: "completed",
            exitCode: 0,
            stopReason: "completed",
            finalMessage: "durable answer",
            usage: null,
            lastSequenceBeforeTerminal: null,
            finishedAt: "2026-05-01T00:06:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-terminal-journal", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:20:00.000Z",
    });

    expect(report.recoveredRuns).toEqual([]);
    expect(agentRunStatus("run-terminal-journal")).toBe("completed");
    expect(
      new StateRunDurabilityRepository(driver).getCurrentTerminalResult(
        "run-terminal-journal",
      ),
    ).toMatchObject({
      eventId: "legacy-event:1:run-terminal:run-terminal-journal:1",
      status: "completed",
      finalMessage: "durable answer",
      lastSequence: 1,
    });

    // Once repaired, a second daemon start does not even classify the row as
    // recoverable. Removing the startup projection makes the first assertion
    // fail red with a resurrected run.
    expect(recoverDaemonStateOnStartup(driver).recoveredRuns).toEqual([]);
  });

  it("repairs a legacy DB-first cancellation when its canonical terminal landed before the crash", () => {
    insertAgentRun({
      id: "run-legacy-db-first-cancel",
      objective: "repair cancelled terminal projection",
      status: "cancelled",
      currentSessionId: "run-legacy-db-first-cancel",
    });
    const rolloutPath = writeRunJournal("run-legacy-db-first-cancel", [
      {
        id: "run-terminal:run-legacy-db-first-cancel:1",
        seq: 1,
        msg: {
          type: "run_terminal",
          payload: {
            runId: "run-legacy-db-first-cancel",
            epoch: 1,
            status: "cancelled",
            exitCode: null,
            stopReason: "operator",
            finalMessage: null,
            usage: null,
            lastSequenceBeforeTerminal: null,
            finishedAt: "2026-05-01T00:06:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-legacy-db-first-cancel", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:20:00.000Z",
    });

    expect(report.recoveredRuns).toEqual([]);
    expect(agentRunStatus("run-legacy-db-first-cancel")).toBe("cancelled");
    expect(
      new StateRunDurabilityRepository(driver).getCurrentTerminalResult(
        "run-legacy-db-first-cancel",
      ),
    ).toMatchObject({
      eventId: "legacy-event:1:run-terminal:run-legacy-db-first-cancel:1",
      status: "cancelled",
      stopReason: "operator",
      lastSequence: 1,
    });
  });

  it("does not invent terminal output for an offline cancelled run with no canonical journal", () => {
    insertAgentRun({
      id: "run-offline-cancel-no-writer",
      objective: "remain honestly unavailable",
      status: "cancelled",
      currentSessionId: "run-offline-cancel-no-writer",
    });

    expect(() => recoverDaemonStateOnStartup(driver)).not.toThrow();
    expect(
      new StateRunDurabilityRepository(driver).getCurrentTerminalResult(
        "run-offline-cancel-no-writer",
      ),
    ).toBeUndefined();
    expect(agentRunStatus("run-offline-cancel-no-writer")).toBe("cancelled");
  });

  it("projects an acknowledged effect before stale-call recovery can replay it", () => {
    insertAgentRun({
      id: "run-effect-journal",
      objective: "do not duplicate the acknowledged read",
      status: "running",
      currentSessionId: "run-effect-journal",
    });
    insertToolCall({
      sessionId: "run-effect-journal",
      toolCallId: "call-acknowledged",
      toolName: "ReadOnce",
      args: { path: "evidence.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    const rolloutPath = writeRunJournal("run-effect-journal", [
      {
        id: "intent-call-acknowledged",
        seq: 1,
        msg: {
          type: "effect_intent",
          payload: {
            runId: "run-effect-journal",
            stepId: "tool:turn-1:call-acknowledged",
            callId: "call-acknowledged",
            toolName: "ReadOnce",
            recoveryCategory: "idempotent",
            idempotencyKey: "sha256:stable-read",
            intentDigest: "sha256:intent",
            attempt: 1,
            recordedAt: "2026-05-01T00:05:00.000Z",
          },
        },
      },
      {
        id: "result-call-acknowledged",
        seq: 2,
        msg: {
          type: "effect_result",
          payload: {
            runId: "run-effect-journal",
            stepId: "tool:turn-1:call-acknowledged",
            callId: "call-acknowledged",
            toolName: "ReadOnce",
            recoveryCategory: "idempotent",
            idempotencyKey: "sha256:stable-read",
            intentEventSeq: 1,
            outcome: "committed",
            resultDigest: "sha256:result",
            recordedAt: "2026-05-01T00:05:01.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-effect-journal", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredToolCalls).toEqual([]);
    expect(toolCallStatus("run-effect-journal", "call-acknowledged")).toBe(
      "completed",
    );
    expect(
      new StateRunDurabilityRepository(driver).getEffect(
        "run-effect-journal",
        "tool:turn-1:call-acknowledged",
      ),
    ).toMatchObject({
      outcome: "committed",
      resultEventId: "legacy-event:2:result-call-acknowledged",
      resultSequence: 2,
    });
  });

  it("rebuilds pre-reopen effects into their historical epoch from a partial projection", () => {
    insertAgentRun({
      id: "run-partial-reopen",
      objective: "preserve historical effect epoch",
      status: "running",
      currentSessionId: "run-partial-reopen",
    });
    insertToolCall({
      sessionId: "run-partial-reopen",
      toolCallId: "call-before-reopen",
      toolName: "ReadOnce",
      args: { path: "before.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    const repository = new StateRunDurabilityRepository(driver);
    repository.ensureInitialEpoch({
      runId: "run-partial-reopen",
      openedAt: "2026-05-01T00:00:00.000Z",
    });
    repository.recordTerminalResult({
      epoch: 1,
      eventId: "legacy-event:3:terminal-before-reopen",
      result: {
        runId: "run-partial-reopen",
        status: "completed",
        exitCode: 0,
        stopReason: "completed",
        finalMessage: "epoch one",
        usage: null,
        lastSequence: 3,
        finishedAt: "2026-05-01T00:06:00.000Z",
      },
    });
    repository.reopenRun({
      runId: "run-partial-reopen",
      fromEpoch: 1,
      openedAt: "2026-05-01T00:07:00.000Z",
      eventId: "legacy-event:4:reopen-epoch-two",
      reason: "operator_review",
    });
    const rolloutPath = writeRunJournal("run-partial-reopen", [
      {
        id: "intent-before-reopen",
        seq: 1,
        msg: {
          type: "effect_intent",
          payload: {
            runId: "run-partial-reopen",
            stepId: "tool:turn-1:call-before-reopen",
            callId: "call-before-reopen",
            toolName: "ReadOnce",
            recoveryCategory: "idempotent",
            idempotencyKey: "sha256:historical-read",
            intentDigest: "sha256:historical-intent",
            attempt: 1,
            recordedAt: "2026-05-01T00:04:00.000Z",
          },
        },
      },
      {
        id: "result-before-reopen",
        seq: 2,
        msg: {
          type: "effect_result",
          payload: {
            runId: "run-partial-reopen",
            stepId: "tool:turn-1:call-before-reopen",
            callId: "call-before-reopen",
            toolName: "ReadOnce",
            recoveryCategory: "idempotent",
            idempotencyKey: "sha256:historical-read",
            intentEventSeq: 1,
            outcome: "committed",
            recordedAt: "2026-05-01T00:05:00.000Z",
          },
        },
      },
      {
        id: "terminal-before-reopen",
        seq: 3,
        msg: {
          type: "run_terminal",
          payload: {
            runId: "run-partial-reopen",
            epoch: 1,
            status: "completed",
            exitCode: 0,
            stopReason: "completed",
            finalMessage: "epoch one",
            usage: null,
            lastSequenceBeforeTerminal: 2,
            finishedAt: "2026-05-01T00:06:00.000Z",
          },
        },
      },
      {
        id: "reopen-epoch-two",
        seq: 4,
        msg: {
          type: "run_reopened",
          payload: {
            runId: "run-partial-reopen",
            previousEpoch: 1,
            epoch: 2,
            reason: "operator_review",
            reopenedAt: "2026-05-01T00:07:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-partial-reopen", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredToolCalls).toEqual([]);
    expect(
      repository.getEffect(
        "run-partial-reopen",
        "tool:turn-1:call-before-reopen",
      ),
    ).toMatchObject({ epoch: 1, outcome: "committed" });
    expect(repository.currentEpoch("run-partial-reopen")?.epoch).toBe(2);
  });

  it("projects suspension and resume crash windows in the same epoch", () => {
    insertAgentRun({
      id: "run-suspension-restart",
      objective: "resume after daemon restart",
      status: "running",
      currentSessionId: "run-suspension-restart",
    });
    const suspendedEvent: Event = {
      eventId: "suspend-cycle-1",
      id: "suspend-cycle-1",
      seq: 1,
      msg: {
        type: "run_suspended",
        payload: {
          runId: "run-suspension-restart",
          epoch: 1,
          reason: "daemon_shutdown_idle",
          suspendedAt: "2026-05-01T00:06:00.000Z",
        },
      },
    };
    const rolloutPath = writeRunJournal("run-suspension-restart", [
      suspendedEvent,
    ]);
    bindRunJournal("run-suspension-restart", rolloutPath);

    const first = recoverDaemonStateOnStartup(driver);
    const repository = new StateRunDurabilityRepository(driver);
    expect(first.recoveryExclusions).toEqual([]);
    expect(agentRunStatus("run-suspension-restart")).toBe("suspended");
    expect(
      repository.getActiveSuspension("run-suspension-restart"),
    ).toMatchObject({ epoch: 1, eventId: "suspend-cycle-1" });

    const resumedEvent: Event = {
      eventId: "resume-cycle-1",
      id: "resume-cycle-1",
      seq: 2,
      msg: {
        type: "run_resumed",
        payload: {
          runId: "run-suspension-restart",
          epoch: 1,
          suspensionEventId: "suspend-cycle-1",
          reason: "daemon_startup_restore",
          resumedAt: "2026-05-01T00:07:00.000Z",
        },
      },
    };
    writeFileSync(
      rolloutPath,
      [suspendedEvent, resumedEvent]
        .map((event) =>
          serializeRolloutItem({ type: "event_msg", payload: event }),
        )
        .join(""),
      { mode: 0o600 },
    );
    const resumed = recoverCanonicalRunJournalForRun(
      driver,
      "run-suspension-restart",
    );
    expect(resumed.exclusion).toBeUndefined();
    expect(agentRunStatus("run-suspension-restart")).toBe("running");
    expect(repository.currentEpoch("run-suspension-restart")?.epoch).toBe(1);
    expect(
      repository.getActiveSuspension("run-suspension-restart"),
    ).toBeUndefined();
  });

  it("bounds retained startup resume descriptor pairs without hiding projected runs", () => {
    for (const runId of ["run-resume-budget-a", "run-resume-budget-b"]) {
      insertAgentRun({
        id: runId,
        objective: "retain exact startup source",
        status: "running",
        currentSessionId: runId,
      });
      bindRunJournal(runId, writeRuntimeResumeJournal(runId));
    }
    const budget = new StartupResumeSourceBudget(1);

    const report = recoverDaemonStateOnStartup(driver, {
      retainRuntimeResumeSources: true,
      startupResumeSourceBudget: budget,
    });

    expect(report.recoveredRuns.map(({ id }) => id)).toEqual([
      "run-resume-budget-a",
      "run-resume-budget-b",
    ]);
    expect(report.recoveryExclusions).toEqual([]);
    const source = report.recoveredRuns[0]?.resumeSource;
    expect(source).toBeDefined();
    expect(report.recoveredRuns[1]?.resumeSource).toBeUndefined();
    expect(budget.retainedSources).toBe(1);
    expect(() => fstatSync(source!.cwdFd)).not.toThrow();

    source!.close();
    source!.close();
    expect(budget.retainedSources).toBe(0);
    expect(() => fstatSync(source!.cwdFd)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => source!.rolloutLease.claim()).toThrow(/already consumed/);
  });

  it("retains the recovery generation when a descriptor rewrite crashed after moving the normal path", () => {
    const runId = "run-rewrite-old-moved";
    insertAgentRun({
      id: runId,
      objective: "resume the exact moved generation",
      status: "running",
      currentSessionId: runId,
    });
    const normalPath = writeRuntimeResumeJournal(runId);
    bindRunJournal(runId, normalPath);
    const recoveryPath = join(
      dirname(normalPath),
      `rollout-recovery-1-crash-${runId}.jsonl`,
    );
    renameSync(normalPath, recoveryPath);
    const budget = new StartupResumeSourceBudget(1);

    const report = recoverDaemonStateOnStartup(driver, {
      retainRuntimeResumeSources: true,
      startupResumeSourceBudget: budget,
    });

    expect(report.recoveryExclusions).toEqual([]);
    expect(report.recoveredRuns).toHaveLength(1);
    const source = report.recoveredRuns[0]?.resumeSource;
    expect(source?.rolloutPath).toBe(recoveryPath);
    expect(source?.sessionId).toBe(runId);
    expect(source?.lifecycleState).toBe("open");
    source?.close();
    expect(budget.retainedSources).toBe(0);
  });

  it("keeps the pinned startup cwd valid while a child changes directory nlink", () => {
    const runId = "run-resume-cwd-child-race";
    insertAgentRun({
      id: runId,
      objective: "retain cwd identity across child mutation",
      status: "running",
      currentSessionId: runId,
    });
    bindRunJournal(runId, writeRuntimeResumeJournal(runId));
    const budget = new StartupResumeSourceBudget(1);
    const mutateChild = vi.fn(() => {
      mkdirSync(join(cwd, "concurrent-child"));
    });

    const report = recoverDaemonStateOnStartup(driver, {
      retainRuntimeResumeSources: true,
      startupResumeSourceBudget: budget,
      afterStartupResumeCwdOpenForTestingOnly: mutateChild,
    });

    expect(mutateChild).toHaveBeenCalledOnce();
    expect(report.recoveryExclusions).toEqual([]);
    expect(report.recoveredRuns[0]?.resumeSource?.cwd).toBe(cwd);
    report.recoveredRuns[0]?.resumeSource?.close();
    expect(budget.retainedSources).toBe(0);
  });

  it("releases a retained startup source when its delivery callback fails", () => {
    const runId = "run-resume-delivery-failure";
    insertAgentRun({
      id: runId,
      objective: "fail while delivering exact startup source",
      status: "running",
      currentSessionId: runId,
    });
    bindRunJournal(runId, writeRuntimeResumeJournal(runId));
    const budget = new StartupResumeSourceBudget(1);
    let retainedCwdFd: number | undefined;
    let retainedLease: { claim(): number; closeUnclaimed(): void } | undefined;
    const delivered = vi.fn(
      (source: {
        readonly cwdFd: number;
        readonly rolloutLease: {
          claim(): number;
          closeUnclaimed(): void;
        };
      }) => {
        retainedCwdFd = source.cwdFd;
        retainedLease = source.rolloutLease;
        throw new Error("delivery failed after descriptor creation");
      },
    );

    const projection = recoverCanonicalRunJournalsOnStartup(driver, {
      recoverableStatuses: ["running"],
      resumeSourceBudget: budget,
      onResumeSource: delivered,
    });

    expect(delivered).toHaveBeenCalledOnce();
    expect(projection.exclusions).toEqual([
      expect.objectContaining({ runId, kind: "deferred" }),
    ]);
    expect(budget.retainedSources).toBe(0);
    expect(retainedCwdFd).toBeTypeOf("number");
    expect(() => fstatSync(retainedCwdFd!)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => retainedLease!.claim()).toThrow(/already consumed/);
  });

  it("quarantines SQLite lifecycle state ahead of pinned canonical history", () => {
    insertAgentRun({
      id: "run-sqlite-ahead",
      objective: "never trust a phantom reopen",
      status: "running",
      currentSessionId: "run-sqlite-ahead",
    });
    const repository = new StateRunDurabilityRepository(driver);
    repository.ensureInitialEpoch({
      runId: "run-sqlite-ahead",
      openedAt: "2026-05-01T00:00:00.000Z",
    });
    driver
      .prepareState(
        `INSERT INTO run_lifecycle_epochs (
           run_id, epoch, opened_at, opened_event_id,
           reopened_from_epoch, reopen_reason
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "run-sqlite-ahead",
        2,
        "2026-05-01T00:07:00.000Z",
        "phantom-reopen",
        1,
        "stale_projection",
      );
    const rolloutPath = writeRunJournal("run-sqlite-ahead", [
      {
        eventId: "canonical-turn-complete",
        id: "canonical-turn-complete",
        seq: 1,
        msg: {
          type: "turn_complete",
          payload: { turnId: "turn-1" },
        },
      },
    ]);
    bindRunJournal("run-sqlite-ahead", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({ runId: "run-sqlite-ahead" }),
    ]);
    expect(repository.currentEpoch("run-sqlite-ahead")?.epoch).toBe(2);
  });

  it("fails closed instead of restoring a run whose active canonical journal is missing", () => {
    insertAgentRun({
      id: "run-missing-journal",
      objective: "do not guess past missing evidence",
      status: "running",
      currentSessionId: "run-missing-journal",
    });
    bindRunJournal(
      "run-missing-journal",
      join(
        driver.projectDir,
        "sessions",
        "run-missing-journal",
        "missing.jsonl",
      ),
    );

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId: "run-missing-journal",
        kind: "deferred",
        reasonCode: "recovery_storage_unavailable",
      }),
    ]);
    expect(agentRunStatus("run-missing-journal")).toBe("running");
  });

  it("keeps an in-memory exclusion when operational evidence storage is unavailable", () => {
    const runId = "run-recovery-storage-unavailable";
    insertAgentRun({
      id: runId,
      objective: "never execute without durable recovery evidence",
      status: "running",
      currentSessionId: runId,
    });
    insertToolCall({
      sessionId: runId,
      toolCallId: "tool-storage-unavailable",
      toolName: "FileRead",
      args: { path: "evidence.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    bindRunJournal(
      runId,
      join(driver.projectDir, "sessions", runId, "missing.jsonl"),
    );
    driver.state.exec(`
      CREATE TEMP TRIGGER refuse_recovery_deferred_insert
      BEFORE INSERT ON run_recovery_deferred
      BEGIN
        SELECT RAISE(ABORT, 'recovery evidence storage unavailable');
      END;
    `);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveredToolCalls).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId,
        kind: "storage_unavailable",
        reasonCode: "recovery_storage_unavailable",
      }),
    ]);
    expect(
      new StateRecoveryIncidentRepository(driver).listDeferred().items,
    ).toEqual([]);
    expect(toolCallStatus(runId, "tool-storage-unavailable")).toBe("running");
  });

  it("quarantines the A2b malformed-interior fixture before any source in the run is projected", async () => {
    const runId = "run-atomic-corrupt-journal";
    insertAgentRun({
      id: runId,
      objective: "never execute a partially projected run",
      status: "running",
      currentSessionId: runId,
    });
    const validPath = writeRunJournal(runId, [
      {
        eventId: "valid-before-corruption",
        id: "valid-before-corruption",
        seq: 1,
        msg: { type: "agent_message", payload: { message: "valid" } },
      },
    ]);
    bindRunJournal(runId, validPath);
    const corruptPath = join(
      dirname(validPath),
      `rollout-2026-05-01T00-01-00-000Z-${runId}.jsonl`,
    );
    const corrupt = await (
      await openFndFixtureCatalog()
    ).text("journal.malformed-interior.v1");
    writeFileSync(corruptPath, corrupt, { mode: 0o600 });
    bindRunJournal(runId, corruptPath);

    const first = recoverDaemonStateOnStartup(driver);

    expect(first.recoveredRuns).toEqual([]);
    expect(first.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId,
        kind: "quarantine",
        reasonCode: "malformed_json",
        sourcePath: corruptPath,
      }),
    ]);
    expect(projectedRolloutRows(validPath)).toBe(0);
    expect(projectedRolloutRows(corruptPath)).toBe(0);

    const second = recoverDaemonStateOnStartup(driver);
    expect(second.recoveredRuns).toEqual([]);
    expect(second.recoveryExclusions).toEqual([
      expect.objectContaining({ runId, kind: "quarantine" }),
    ]);
    expect(
      new StateRecoveryIncidentRepository(driver).listQuarantines().items,
    ).toHaveLength(1);
    expect(projectedRolloutRows(validPath)).toBe(0);
  });

  it("rolls back strict source rows when semantic run projection fails", () => {
    const runId = "run-atomic-projection-failure";
    insertAgentRun({
      id: runId,
      objective: "never retain a partial semantic projection",
      status: "running",
      currentSessionId: runId,
    });
    const sourcePath = writeRunJournal(runId, [
      {
        eventId: "effect-result-without-intent",
        id: "effect-result-without-intent",
        seq: 1,
        msg: {
          type: "effect_result",
          payload: {
            runId,
            stepId: "tool:turn-1:missing-intent",
            callId: "missing-intent",
            toolName: "FileRead",
            recoveryCategory: "idempotent",
            idempotencyKey: "sha256:missing",
            intentEventSeq: 1,
            outcome: "committed",
            resultDigest: "sha256:result",
            recordedAt: "2026-05-01T00:05:01.000Z",
          },
        },
      },
    ]);
    bindRunJournal(runId, sourcePath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId,
        kind: "deferred",
        reasonCode: "projection_failure",
      }),
    ]);
    expect(projectedRolloutRows(sourcePath)).toBe(0);
    expect(
      new StateRunDurabilityRepository(driver).getEffect(
        runId,
        "tool:turn-1:missing-intent",
      ),
    ).toBeUndefined();
  });

  it("binds active quarantine, deferred, and permanent abandonment to every restored run", () => {
    const repository = new StateRecoveryIncidentRepository(driver);
    for (const runId of [
      "run-excluded-abandoned",
      "run-excluded-deferred",
      "run-excluded-quarantine",
    ]) {
      insertAgentRun({
        id: runId,
        objective: "must remain non-executable",
        status: "running",
        currentSessionId: runId,
      });
      insertToolCall({
        sessionId: runId,
        toolCallId: `tool-${runId}`,
        toolName: "FileRead",
        args: { path: "evidence.txt" },
        status: "running",
        recoveryCategory: "idempotent",
      });
    }
    const abandonedIncident = repository.recordQuarantine({
      runId: "run-excluded-abandoned",
      sourceKind: "run_journal",
      sourcePath: join(driver.projectDir, "abandoned.jsonl"),
      reasonCode: "malformed_json",
      safeDetail: { message: "invalid" },
      sourceSizeBytes: 1,
      sourceMtimeMs: 1,
      sourceSha256: "a".repeat(64),
      detectedAtMs: 1,
    });
    repository.abandonQuarantine({
      quarantineId: abandonedIncident.quarantineId,
      expectedRunId: abandonedIncident.runId,
      expectedSourceSha256: abandonedIncident.sourceSha256,
      actor: "operator",
      reason: "source intentionally retired",
      abandonedAtMs: 2,
    });
    repository.recordDeferred({
      runId: "run-excluded-deferred",
      sourceKind: "run_journal",
      sourcePath: join(driver.projectDir, "deferred.jsonl"),
      reasonCode: "database_busy",
      errorClass: "SQLITE_BUSY",
      safeDetail: { message: "busy" },
      failedAtMs: 1,
      nextRetryMs: 2,
    });
    repository.recordQuarantine({
      runId: "run-excluded-quarantine",
      sourceKind: "run_journal",
      sourcePath: join(driver.projectDir, "quarantine.jsonl"),
      reasonCode: "identity_conflict",
      safeDetail: { message: "conflict" },
      sourceSizeBytes: 1,
      sourceMtimeMs: 1,
      sourceSha256: "b".repeat(64),
      detectedAtMs: 1,
    });

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveredToolCalls).toEqual([]);
    expect(report.recoveryExclusions.map(({ kind }) => kind)).toEqual([
      "abandoned",
      "deferred",
      "quarantine",
    ]);
    for (const runId of [
      "run-excluded-abandoned",
      "run-excluded-deferred",
      "run-excluded-quarantine",
    ]) {
      expect(toolCallStatus(runId, `tool-${runId}`)).toBe("running");
      expect(recoverCanonicalRunJournalForRun(driver, runId)).toEqual(
        expect.objectContaining({
          filesScanned: 0,
          eventsProjected: 0,
          exclusion: expect.objectContaining({ runId }),
        }),
      );
    }
  });

  it("shares the named aggregate startup byte ceiling across recovered runs", () => {
    const paths: string[] = [];
    for (const runId of ["run-budget-first", "run-budget-second"]) {
      insertAgentRun({
        id: runId,
        objective: "bounded startup recovery",
        status: "running",
        currentSessionId: runId,
      });
      const path = writeRunJournal(runId, [
        {
          eventId: `message-${runId}`,
          id: `message-${runId}`,
          seq: 1,
          msg: { type: "agent_message", payload: { message: runId } },
        },
      ]);
      bindRunJournal(runId, path);
      paths.push(path);
    }
    const startupBudget = new StartupRecoveryBudget({
      maxReadBytes: statSync(paths[0]!).size * 2,
      nowMilliseconds: () => 1,
    });

    expect(
      recoverCanonicalRunJournalForRun(driver, "run-budget-first", {
        strict: { startupBudget, nowMilliseconds: () => 1 },
      }),
    ).toMatchObject({ filesScanned: 1, eventsProjected: 0 });
    expect(
      recoverCanonicalRunJournalForRun(driver, "run-budget-second", {
        strict: { startupBudget, nowMilliseconds: () => 1 },
      }),
    ).toMatchObject({
      filesScanned: 0,
      exclusion: {
        runId: "run-budget-second",
        kind: "deferred",
        reasonCode: "startup_byte_budget",
      },
    });
    expect(projectedRolloutRows(paths[1]!)).toBe(0);
  });

  it("persists the named aggregate startup time ceiling as operational evidence", () => {
    const runId = "run-time-budget";
    insertAgentRun({
      id: runId,
      objective: "bounded startup time",
      status: "running",
      currentSessionId: runId,
    });
    const sourcePath = writeRunJournal(runId, [
      {
        eventId: "time-budget-message",
        id: "time-budget-message",
        seq: 1,
        msg: { type: "agent_message", payload: { message: "bounded" } },
      },
    ]);
    bindRunJournal(runId, sourcePath);
    let nowMilliseconds = 1;
    const startupBudget = new StartupRecoveryBudget({
      maxMilliseconds: 1,
      nowMilliseconds: () => nowMilliseconds,
    });
    nowMilliseconds = 2;

    expect(
      recoverCanonicalRunJournalForRun(driver, runId, {
        strict: { startupBudget, nowMilliseconds: () => nowMilliseconds },
      }),
    ).toMatchObject({
      filesScanned: 0,
      exclusion: {
        runId,
        kind: "deferred",
        reasonCode: "startup_time_budget",
      },
    });
    expect(projectedRolloutRows(sourcePath)).toBe(0);
  });

  it("fails closed when canonical event identities reuse one run sequence", () => {
    insertAgentRun({
      id: "run-sequence-conflict",
      objective: "reject ambiguous history",
      status: "running",
      currentSessionId: "run-sequence-conflict",
    });
    const rolloutPath = writeRunJournal("run-sequence-conflict", [
      {
        id: "intent-sequence-one",
        seq: 1,
        msg: {
          type: "effect_intent",
          payload: {
            runId: "run-sequence-conflict",
            stepId: "tool:turn-1:call-1",
            callId: "call-1",
            toolName: "ReadOnce",
            recoveryCategory: "idempotent",
            idempotencyKey: "sha256:key",
            intentDigest: "sha256:intent",
            attempt: 1,
            recordedAt: "2026-05-01T00:04:00.000Z",
          },
        },
      },
      {
        id: "terminal-sequence-one",
        seq: 1,
        msg: {
          type: "run_terminal",
          payload: {
            runId: "run-sequence-conflict",
            epoch: 1,
            status: "completed",
            exitCode: 0,
            stopReason: "completed",
            finalMessage: null,
            usage: null,
            lastSequenceBeforeTerminal: null,
            finishedAt: "2026-05-01T00:05:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-sequence-conflict", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId: "run-sequence-conflict",
        kind: "quarantine",
        reasonCode: "sequence_duplicate",
      }),
    ]);
    expect(agentRunStatus("run-sequence-conflict")).toBe("running");
  });

  it("rejects a terminal sequence also claimed by an unrelated user event", () => {
    insertAgentRun({
      id: "run-user-terminal-sequence-conflict",
      objective: "reject cross-category sequence ambiguity",
      status: "running",
      currentSessionId: "run-user-terminal-sequence-conflict",
    });
    const rolloutPath = writeRunJournal("run-user-terminal-sequence-conflict", [
      {
        eventId: "user-visible-event",
        id: "user-visible-event",
        seq: 1,
        msg: {
          type: "agent_message",
          payload: { message: "unrelated output" },
        },
      },
      {
        eventId: "terminal-at-user-sequence",
        id: "terminal-at-user-sequence",
        seq: 1,
        msg: {
          type: "run_terminal",
          payload: {
            runId: "run-user-terminal-sequence-conflict",
            epoch: 1,
            status: "completed",
            exitCode: 0,
            stopReason: "completed",
            finalMessage: "must not be selected",
            usage: null,
            lastSequenceBeforeTerminal: null,
            finishedAt: "2026-05-01T00:05:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-user-terminal-sequence-conflict", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId: "run-user-terminal-sequence-conflict",
        kind: "quarantine",
        reasonCode: "sequence_duplicate",
      }),
    ]);
    expect(agentRunStatus("run-user-terminal-sequence-conflict")).toBe(
      "running",
    );
  });

  it("rejects event ID reuse across unrelated and lifecycle event types", () => {
    insertAgentRun({
      id: "run-cross-type-id-conflict",
      objective: "reject cross-category identity reuse",
      status: "running",
      currentSessionId: "run-cross-type-id-conflict",
    });
    const rolloutPath = writeRunJournal("run-cross-type-id-conflict", [
      {
        eventId: "reused-cross-type-id",
        id: "reused-cross-type-id",
        seq: 1,
        msg: {
          type: "agent_message",
          payload: { message: "ordinary output" },
        },
      },
      {
        eventId: "reused-cross-type-id",
        id: "reused-cross-type-id",
        seq: 2,
        msg: {
          type: "run_terminal",
          payload: {
            runId: "run-cross-type-id-conflict",
            epoch: 1,
            status: "completed",
            exitCode: 0,
            stopReason: "completed",
            finalMessage: "must not be selected",
            usage: null,
            lastSequenceBeforeTerminal: 1,
            finishedAt: "2026-05-01T00:05:00.000Z",
          },
        },
      },
    ]);
    bindRunJournal("run-cross-type-id-conflict", rolloutPath);

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveryExclusions).toEqual([
      expect.objectContaining({
        runId: "run-cross-type-id-conflict",
        kind: "quarantine",
        reasonCode: "identity_conflict",
      }),
    ]);
    expect(agentRunStatus("run-cross-type-id-conflict")).toBe("running");
  });

  it("loads recoverable runs from their latest snapshot and applies stale tool recovery policy", () => {
    insertAgentRun({
      id: "run-1",
      objective: "continue work",
      status: "running",
      currentSessionId: "session-1",
      lastSnapshotAt: "2026-05-01T00:10:00.000Z",
    });
    insertAgentRun({
      id: "run-2",
      objective: "finished work",
      status: "completed",
      currentSessionId: "session-2",
    });
    insertSnapshot("session-1", "2026-05-01T00:00:00.000Z", {
      conversation: [{ role: "user", content: "old" }],
      toolState: { pending: [] },
      mcpConnectionState: { connected: false },
    });
    insertSnapshot("session-1", "2026-05-01T00:10:00.000Z", {
      conversation: [{ role: "assistant", content: "latest" }],
      toolState: { pending: ["tool-1"] },
      mcpConnectionState: { connected: true },
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "FileWrite",
      args: { path: "a.txt" },
      status: "running",
      outputPartial: "partial output",
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-3",
      toolName: "FileRead",
      args: { path: "c.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-4",
      toolName: "AskUserQuestion",
      args: { question: "Continue?" },
      status: "running",
      recoveryCategory: "interactive",
    });
    insertToolCall({
      sessionId: "session-1",
      toolCallId: "tool-2",
      toolName: "FileRead",
      args: { path: "b.txt" },
      status: "completed",
    });

    const report = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:20:00.000Z",
    });

    expect(report.recoveredAt).toBe("2026-05-01T00:20:00.000Z");
    expect(report.recoveredRuns).toHaveLength(1);
    expect(report.recoveredRuns[0]).toMatchObject({
      id: "run-1",
      objective: "continue work",
      status: "running",
      currentSessionId: "session-1",
      lastSnapshotAt: "2026-05-01T00:10:00.000Z",
      latestSnapshot: {
        sessionId: "session-1",
        snapshotAt: "2026-05-01T00:10:00.000Z",
        conversation: [{ role: "assistant", content: "latest" }],
        toolState: {
          pending: [],
          inFlight: {
            "tool-3": {
              status: "replay_pending",
              recoveryAction: "replay",
            },
          },
          completed: {
            "tool-1": {
              status: "poisoned",
              recoveryAction: "poison",
            },
            "tool-4": {
              status: "recovery_cancelled",
              recoveryAction: "cancel",
            },
          },
        },
        mcpConnectionState: { connected: true },
      },
    });
    expect(report.recoveredToolCalls).toEqual([
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "FileWrite",
        args: { path: "a.txt" },
        statusBefore: "running",
        statusAfter: "poisoned",
        recoveryCategory: "side-effecting",
        recoveryAction: "poison",
        startedAt: "2026-05-01T00:05:00.000Z",
        outputPartial: "partial output",
      },
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-3",
        toolName: "FileRead",
        args: { path: "c.txt" },
        statusBefore: "running",
        statusAfter: "replay_pending",
        recoveryCategory: "idempotent",
        recoveryAction: "replay",
        startedAt: "2026-05-01T00:05:00.000Z",
      },
      {
        projectDir: driver.projectDir,
        sessionId: "session-1",
        toolCallId: "tool-4",
        toolName: "AskUserQuestion",
        args: { question: "Continue?" },
        statusBefore: "running",
        statusAfter: "recovery_cancelled",
        recoveryCategory: "interactive",
        recoveryAction: "cancel",
        startedAt: "2026-05-01T00:05:00.000Z",
      },
    ]);
    expect(report.warnings).toEqual([]);
    expect(toolCallStatus("session-1", "tool-1")).toBe("poisoned");
    expect(toolCallStatus("session-1", "tool-2")).toBe("completed");
    expect(toolCallStatus("session-1", "tool-3")).toBe("replay_pending");
    expect(toolCallStatus("session-1", "tool-4")).toBe("recovery_cancelled");

    const secondReport = recoverDaemonStateOnStartup(driver, {
      now: () => "2026-05-01T00:25:00.000Z",
    });
    expect(secondReport.recoveredToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool-3",
        statusBefore: "replay_pending",
        statusAfter: "replay_pending",
        recoveryCategory: "idempotent",
        recoveryAction: "replay",
      }),
      expect.objectContaining({
        toolCallId: "tool-1",
        statusBefore: "poisoned",
        statusAfter: "poisoned",
        recoveryCategory: "side-effecting",
        recoveryAction: "poison",
      }),
      expect.objectContaining({
        toolCallId: "tool-4",
        statusBefore: "recovery_cancelled",
        statusAfter: "recovery_cancelled",
        recoveryCategory: "interactive",
        recoveryAction: "cancel",
      }),
    ]);
  });

  it("drops array-shaped agent metadata during startup recovery", () => {
    insertAgentRun({
      id: "run-array-metadata",
      objective: "recover metadata",
      status: "running",
    });
    driver
      .prepareState<[string, string]>(
        "UPDATE agent_runs SET metadata_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(["spoof"]), "run-array-metadata");

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toHaveLength(1);
    expect(report.recoveredRuns[0]).not.toHaveProperty("metadata");
  });

  it("drops array-shaped recovered tool-state maps before applying recovered tool calls", () => {
    insertAgentRun({
      id: "run-array-tool-state",
      objective: "recover tool state",
      status: "running",
      currentSessionId: "session-array-tool-state",
    });
    insertSnapshot("session-array-tool-state", "2026-05-01T00:00:00.000Z", {
      conversation: [],
      toolState: {
        pending: ["tool-replay", "tool-poison"],
        inFlight: ["spoof"],
        completed: ["spoof"],
      },
      mcpConnectionState: {},
    });
    insertToolCall({
      sessionId: "session-array-tool-state",
      toolCallId: "tool-replay",
      toolName: "FileRead",
      args: { path: "a.txt" },
      status: "running",
      recoveryCategory: "idempotent",
    });
    insertToolCall({
      sessionId: "session-array-tool-state",
      toolCallId: "tool-poison",
      toolName: "FileWrite",
      args: { path: "b.txt" },
      status: "running",
      recoveryCategory: "side-effecting",
    });

    const report = recoverDaemonStateOnStartup(driver);
    const toolState = report.recoveredRuns[0]?.latestSnapshot?.toolState as
      | {
          readonly pending?: unknown;
          readonly inFlight?: unknown;
          readonly completed?: unknown;
        }
      | undefined;

    expect(toolState?.pending).toEqual([]);
    expect(toolState?.inFlight).toEqual({
      "tool-replay": expect.objectContaining({
        status: "replay_pending",
        recoveryAction: "replay",
      }),
    });
    expect(toolState?.completed).toEqual({
      "tool-poison": expect.objectContaining({
        status: "poisoned",
        recoveryAction: "poison",
      }),
    });
  });

  it("keeps daemon startup recovery non-throwing when snapshot JSON is invalid", () => {
    insertAgentRun({
      id: "run-bad-snapshot",
      objective: "recover malformed snapshot",
      status: "running",
      currentSessionId: "session-bad",
    });
    driver
      .prepareState(
        `INSERT INTO session_state_snapshots (
          session_id,
          snapshot_at,
          conversation_json,
          tool_state_json,
          mcp_connection_state_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("session-bad", "2026-05-01T00:00:00.000Z", "{", "{}", "{}");

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toHaveLength(1);
    expect(report.recoveredRuns[0]?.latestSnapshot).toBeUndefined();
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "snapshot_json_invalid",
        runId: "run-bad-snapshot",
        sessionId: "session-bad",
      }),
    ]);
  });

  it("does not surface normally cancelled rows as startup recovery", () => {
    insertToolCall({
      sessionId: "session-cancelled",
      toolCallId: "tool-cancelled",
      toolName: "AskUserQuestion",
      args: { question: "Continue?" },
      status: "cancelled",
      recoveryCategory: "interactive",
    });

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredToolCalls).toEqual([]);
    expect(toolCallStatus("session-cancelled", "tool-cancelled")).toBe(
      "cancelled",
    );
  });

  it("poisons idempotent recovery rows with malformed arguments", () => {
    insertToolCall({
      sessionId: "session-bad-args",
      toolCallId: "tool-bad-args",
      toolName: "FileRead",
      args: null,
      argsJson: "{",
      status: "running",
      recoveryCategory: "idempotent",
    });

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool-bad-args",
        statusBefore: "running",
        statusAfter: "poisoned",
        recoveryCategory: "idempotent",
        recoveryAction: "poison",
      }),
    ]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "tool_args_json_invalid",
        sessionId: "session-bad-args",
        toolCallId: "tool-bad-args",
      }),
    ]);
    expect(toolCallStatus("session-bad-args", "tool-bad-args")).toBe(
      "poisoned",
    );
  });
});

function insertAgentRun(params: {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly currentSessionId?: string;
  readonly lastSnapshotAt?: string;
}): void {
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id,
        created_by_client,
        last_snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.objective,
      params.status,
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:05:00.000Z",
      params.currentSessionId ?? null,
      "client-1",
      params.lastSnapshotAt ?? null,
    );
}

function insertSnapshot(
  sessionId: string,
  snapshotAt: string,
  state: {
    readonly conversation: unknown;
    readonly toolState: unknown;
    readonly mcpConnectionState: unknown;
  },
): void {
  driver
    .prepareState(
      `INSERT INTO session_state_snapshots (
        session_id,
        snapshot_at,
        conversation_json,
        tool_state_json,
        mcp_connection_state_json
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      snapshotAt,
      JSON.stringify(state.conversation),
      JSON.stringify(state.toolState),
      JSON.stringify(state.mcpConnectionState),
    );
}

function insertToolCall(params: {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly argsJson?: string;
  readonly status: string;
  readonly recoveryCategory?: string;
  readonly outputPartial?: string;
}): void {
  driver
    .prepareState(
      `INSERT INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        recovery_category,
        output_partial,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.sessionId,
      params.toolCallId,
      params.toolName,
      params.argsJson ?? JSON.stringify(params.args),
      params.status,
      params.recoveryCategory ?? "side-effecting",
      params.outputPartial ?? null,
      "2026-05-01T00:05:00.000Z",
    );
}

function toolCallStatus(
  sessionId: string,
  toolCallId: string,
): string | undefined {
  return driver
    .prepareState<[string, string], { status: string }>(
      `SELECT status
       FROM in_flight_tool_calls
       WHERE session_id = ? AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId)?.status;
}

function agentRunStatus(runId: string): string | undefined {
  return driver
    .prepareState<[string], { status: string }>(
      "SELECT status FROM agent_runs WHERE id = ?",
    )
    .get(runId)?.status;
}

function projectedRolloutRows(sourcePath: string): number {
  return (
    driver
      .prepareState<[string], { readonly count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items WHERE source_path = ?",
      )
      .get(sourcePath)?.count ?? 0
  );
}

function writeRunJournal(runId: string, events: readonly Event[]): string {
  const directory = join(driver.projectDir, "sessions", runId);
  mkdirSync(directory, { recursive: true });
  const rolloutPath = join(
    directory,
    `rollout-2026-05-01T00-00-00-000Z-${runId}.jsonl`,
  );
  writeFileSync(
    rolloutPath,
    events
      .map((event) => {
        const canonical =
          event.seq !== undefined && event.eventId === undefined
            ? {
                ...event,
                eventId: `legacy-event:${event.seq}:${event.id}`,
              }
            : event;
        return serializeRolloutItem({ type: "event_msg", payload: canonical });
      })
      .join(""),
    { mode: 0o600 },
  );
  return rolloutPath;
}

function writeRuntimeResumeJournal(runId: string, resumeCwd = cwd): string {
  const directory = join(driver.projectDir, "sessions", runId);
  mkdirSync(directory, { recursive: true });
  const rolloutPath = join(
    directory,
    `rollout-2026-05-01T00-00-00-000Z-${runId}.jsonl`,
  );
  writeFileSync(
    rolloutPath,
    serializeRolloutItem({
      type: "session_meta",
      payload: {
        sessionId: runId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd: resumeCwd,
        originator: "recovery-restart-test",
        source: "interactive-root",
        agencVersion: "0.16.1",
        rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
        model: "test-model",
        modelProvider: "test-provider",
      },
    }),
    { mode: 0o600 },
  );
  return rolloutPath;
}

function bindRunJournal(runId: string, rolloutPath: string): void {
  const repository = new StateRunDurabilityRepository(driver);
  if (repository.currentEpoch(runId) === undefined) {
    repository.ensureInitialEpoch({
      runId,
      openedAt: "2026-05-01T00:00:00.000Z",
    });
  }
  repository.bindJournalSource({
    runId,
    epoch: 1,
    childRunId: runId,
    sessionId: runId,
    sourcePath: rolloutPath,
    boundAt: "2026-05-01T00:00:00.000Z",
  });
}
