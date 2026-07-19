import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverDaemonStateOnStartup } from "./recovery.js";
import type { Event } from "../../src/session/event-log.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

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

    const report = recoverDaemonStateOnStartup(driver);

    expect(report.recoveredRuns).toEqual([]);
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
        seq: 3,
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
            lastSequenceBeforeTerminal: 2,
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
      eventId:
        "legacy-event:3:run-terminal:run-legacy-db-first-cancel:1",
      status: "cancelled",
      stopReason: "operator",
      lastSequence: 3,
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

  it("fails closed instead of restoring a run whose active canonical journal is missing", () => {
    insertAgentRun({
      id: "run-missing-journal",
      objective: "do not guess past missing evidence",
      status: "running",
      currentSessionId: "run-missing-journal",
    });
    bindRunJournal(
      "run-missing-journal",
      join(driver.projectDir, "sessions", "run-missing-journal", "missing.jsonl"),
    );

    expect(() => recoverDaemonStateOnStartup(driver)).toThrow(
      /canonical rollout source is missing/,
    );
    expect(agentRunStatus("run-missing-journal")).toBe("running");
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

    expect(() => recoverDaemonStateOnStartup(driver)).toThrow(
      /sequence is also claimed by event legacy-event:1:intent-sequence-one/,
    );
    expect(agentRunStatus("run-sequence-conflict")).toBe("running");
  });

  it("rejects a terminal sequence also claimed by an unrelated user event", () => {
    insertAgentRun({
      id: "run-user-terminal-sequence-conflict",
      objective: "reject cross-category sequence ambiguity",
      status: "running",
      currentSessionId: "run-user-terminal-sequence-conflict",
    });
    const rolloutPath = writeRunJournal(
      "run-user-terminal-sequence-conflict",
      [
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
      ],
    );
    bindRunJournal("run-user-terminal-sequence-conflict", rolloutPath);

    expect(() => recoverDaemonStateOnStartup(driver)).toThrow(
      /sequence is also claimed by event user-visible-event/,
    );
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

    expect(() => recoverDaemonStateOnStartup(driver)).toThrow(
      /event ID has conflicting content/,
    );
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
      .map((event) =>
        serializeRolloutItem({ type: "event_msg", payload: event }),
      )
      .join(""),
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
