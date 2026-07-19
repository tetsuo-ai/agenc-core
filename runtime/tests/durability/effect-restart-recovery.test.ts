import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAgenCStateCli } from "../../src/bin/state-cli.js";
import { admissionRecordKey } from "../../src/budget/admission-types.js";
import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import type { Event } from "../../src/session/event-log.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { resolveDurableEffectReview } from "../../src/state/effect-review.js";
import { recoverDaemonStateOnStartup } from "../../src/state/recovery.js";
import { recordInFlightToolCallStart } from "../../src/state/tool-output-rotation.js";
import {
  openStateDatabasePaths,
  resolveStateDatabasePaths,
} from "../../src/state/sqlite-driver.js";
import { listUnresolvedUnknownOutcomeEffects } from "../../src/state/unknown-outcome-gate.js";

const OPENED_AT = "2026-07-18T00:00:00.000Z";
const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-m4-effect-recovery-"));
  created.push(cwd);
  return cwd;
}

function store(cwd: string, runId: string, resume = false): RolloutStore {
  const rollout = new RolloutStore({
    cwd,
    sessionId: runId,
    agencVersion: "0.6.2",
    autoStartScheduler: false,
    ...(resume ? { resume: true } : {}),
  });
  rollout.open({
    sessionId: runId,
    timestamp: OPENED_AT,
    cwd,
    originator: "m4-effect-recovery-test",
    agencVersion: "0.6.2",
  });
  return rollout;
}

function intent(
  runId: string,
  recoveryCategory: "idempotent" | "side-effecting",
): Event {
  return {
    id: `intent-${recoveryCategory}`,
    seq: 1,
    msg: {
      type: "effect_intent",
      payload: {
        runId,
        stepId: "tool:turn-1:call-1",
        callId: "call-1",
        toolName: "test-effect",
        recoveryCategory,
        ...(recoveryCategory === "idempotent"
          ? { idempotencyKey: "sha256:safe-retry" }
          : {}),
        intentDigest: "intent-digest",
        attempt: 1,
        recordedAt: OPENED_AT,
      },
    },
  };
}

function reserveToolStep(cwd: string, runId: string): void {
  const paths = resolveStateDatabasePaths({ cwd });
  const driver = openStateDatabasePaths(paths);
  try {
    const admissions = new ExecutionAdmissionRepository(driver, {
      ownerId: "effect-recovery-test",
      ownerPid: process.pid,
    });
    const request: RuntimeAdmissionRequest = {
      step: { runId, stepId: "tool:turn-1:call-1" },
      kind: "tool_exec",
      estimate: {
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      },
      workspaceId: "workspace-test",
      sessionId: runId,
      parentScopeId: "turn-1",
      autonomous: false,
      budgetScopes: [{ key: `run:${runId}`, maxTokens: 100, maxCostUsd: 1 }],
    };
    admissions.enqueue(request);
    expect(
      admissions.claim({ key: admissionRecordKey(request.step) }).kind,
    ).toBe("claimed");
  } finally {
    driver.close();
  }
}

function recoverAdmissionBeforeRollout(cwd: string): void {
  const paths = resolveStateDatabasePaths({ cwd });
  const driver = openStateDatabasePaths(paths);
  try {
    new ExecutionAdmissionRepository(driver, {
      ownerId: "effect-recovery-new-owner",
      ownerPid: process.pid,
    }).recover({
      activeOwnerIds: new Set(),
      now: "2026-07-18T00:00:30.000Z",
    });
  } finally {
    driver.close();
  }
}

describe("M4 effect restart recovery", () => {
  it("turns a dangling side effect into a journaled review lock without replay", () => {
    const cwd = workspace();
    const runId = "run-side-effect";
    const original = store(cwd, runId);
    expect(original.append(intent(runId, "side-effecting"), { durable: true })).toBe(
      true,
    );
    original.close();

    const resumed = store(cwd, runId, true);
    const events = resumed
      .readAll()
      .filter((item) => item.type === "event_msg")
      .map((item) => item.payload);
    expect(events.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_unknown_outcome",
    ]);
    expect(events[1]).toMatchObject({
      id: "effect-unknown-recovery:legacy-event:1:intent-side-effecting",
      seq: 2,
      msg: {
        payload: {
          reason: "daemon_recovered_without_effect_acknowledgement",
          requiresReview: true,
        },
      },
    });

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      const effect = new StateRunDurabilityRepository(driver).getEffect(
        runId,
        "tool:turn-1:call-1",
      );
      expect(effect).toMatchObject({
        outcome: "unknown_outcome",
        reviewStatus: "pending",
      });
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toMatchObject([
        { toolCallId: "call-1", toolName: "test-effect" },
      ]);
    } finally {
      driver.close();
      resumed.close();
      created.push(paths.projectDir);
    }
  });

  it("classifies every dangling intent when correlation ids are reused", () => {
    const cwd = workspace();
    const runId = "run-reused-effect-correlation";
    const original = store(cwd, runId);
    const effectIntent = (
      eventId: string,
      sequence: number,
      stepId: string,
      callId: string,
    ): Event => ({
      eventId,
      id: "shared-effect-correlation",
      seq: sequence,
      msg: {
        type: "effect_intent",
        payload: {
          runId,
          stepId,
          callId,
          toolName: "test-effect",
          recoveryCategory: "side-effecting",
          intentDigest: `digest:${callId}`,
          attempt: 1,
          recordedAt: OPENED_AT,
        },
      },
    });
    original.append(
      effectIntent("canonical-effect-intent-1", 1, "step-1", "call-1"),
      { durable: true },
    );
    original.append(
      effectIntent("canonical-effect-intent-2", 2, "step-2", "call-2"),
      { durable: true },
    );
    // Canonical identities are globally unique, but a pre-existing unrelated
    // event may legitimately occupy the preferred recovery id.
    original.append(
      {
        eventId: "effect-unknown-recovery:canonical-effect-intent-1",
        id: "another-reusable-correlation",
        seq: 3,
        msg: {
          type: "user_message",
          payload: { message: "unrelated canonical event" },
        },
      },
      { durable: true },
    );
    original.close();

    const resumed = store(cwd, runId, true);
    const unknowns = resumed
      .readAll()
      .filter(
        (item) =>
          item.type === "event_msg" &&
          item.payload.msg.type === "effect_unknown_outcome",
      )
      .map((item) => item.payload);
    expect(unknowns).toHaveLength(2);
    expect(unknowns.map((event) => event.msg.payload.stepId).sort()).toEqual([
      "step-1",
      "step-2",
    ]);
    expect(unknowns.map((event) => event.eventId)).toEqual([
      "effect-unknown-recovery:canonical-effect-intent-1:2",
      "effect-unknown-recovery:canonical-effect-intent-2",
    ]);

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(
        new StateRunDurabilityRepository(driver)
          .listEffects(runId)
          .map((effect) => [effect.stepId, effect.outcome]),
      ).toEqual([
        ["step-1", "unknown_outcome"],
        ["step-2", "unknown_outcome"],
      ]);
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toHaveLength(2);
    } finally {
      driver.close();
      resumed.close();
      created.push(paths.projectDir);
    }
  });

  it("cancels a dangling effect proven not dispatched by its reservation", () => {
    const cwd = workspace();
    const runId = "run-before-dispatch";
    const original = store(cwd, runId);
    reserveToolStep(cwd, runId);
    expect(original.append(intent(runId, "side-effecting"), { durable: true })).toBe(
      true,
    );
    original.close();

    const resumed = store(cwd, runId, true);
    const events = resumed
      .readAll()
      .filter((item) => item.type === "event_msg")
      .map((item) => item.payload);
    expect(events.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_result",
    ]);
    expect(events[1]).toMatchObject({
      id: "effect-cancelled-recovery:legacy-event:1:intent-side-effecting",
      msg: {
        payload: {
          outcome: "cancelled",
          evidence: {
            reason: "daemon_recovered_before_effect_dispatch",
            admissionStatus: "reserved",
          },
        },
      },
    });

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({ outcome: "cancelled", reviewStatus: "none" });
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toEqual([]);
    } finally {
      driver.close();
      resumed.close();
      created.push(paths.projectDir);
    }
  });

  it("accepts admission-recovered voided state as pre-dispatch proof", () => {
    const cwd = workspace();
    const runId = "run-before-dispatch-voided";
    const original = store(cwd, runId);
    reserveToolStep(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();

    recoverAdmissionBeforeRollout(cwd);
    const resumed = store(cwd, runId, true);
    expect(
      resumed
        .readAll()
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload)
        .at(-1),
    ).toMatchObject({
      msg: {
        type: "effect_result",
        payload: {
          outcome: "cancelled",
          evidence: { admissionStatus: "voided" },
        },
      },
    });
    resumed.close();
  });

  it("records that an idempotent retry is safe but never replays it implicitly", () => {
    const cwd = workspace();
    const runId = "run-idempotent";
    const original = store(cwd, runId);
    expect(original.append(intent(runId, "idempotent"), { durable: true })).toBe(
      true,
    );
    original.close();

    const resumed = store(cwd, runId, true);
    const events = resumed
      .readAll()
      .filter((item) => item.type === "event_msg")
      .map((item) => item.payload);
    expect(events.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "recovery_decision",
    ]);
    expect(events[1]).toMatchObject({
      id: "recovery-decision:legacy-event:1:intent-idempotent",
      msg: {
        payload: {
          decision: "retry_safe_deferred",
          evidenceEventSeq: 1,
        },
      },
    });

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      const effect = new StateRunDurabilityRepository(driver).getEffect(
        runId,
        "tool:turn-1:call-1",
      );
      expect(effect).toMatchObject({
        recoveryCategory: "idempotent",
        idempotencyKey: "sha256:safe-retry",
        reviewStatus: "none",
      });
      expect(effect?.outcome).toBeUndefined();
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toEqual([]);
    } finally {
      driver.close();
      resumed.close();
      created.push(paths.projectDir);
    }
  });

  it("journals human review evidence and lifts both unknown-outcome gates", () => {
    const cwd = workspace();
    const runId = "run-reviewed";
    const original = store(cwd, runId);
    expect(original.append(intent(runId, "side-effecting"), { durable: true })).toBe(
      true,
    );
    original.close();
    const recovered = store(cwd, runId, true);
    recovered.close();

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toMatchObject({
        kind: "resolved",
        durable: true,
        eventId: `effect-review:${runId}:tool:turn-1:call-1`,
        sequence: 3,
      });
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({
        reviewStatus: "resolved",
        reviewedBy: "operator-test",
        reviewResolution: "human_verified",
      });
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toEqual([]);
      expect(
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:30.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toMatchObject({
        kind: "already_resolved",
        durable: true,
        sequence: 3,
      });
      expect(() =>
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:31.000Z",
          reviewedBy: "different-operator",
          resolution: "human_verified",
        }),
      ).toThrow(/conflicting content/);
      expect(() =>
        recordInFlightToolCallStart(driver, {
          sessionId: runId,
          toolCallId: "call-2",
          toolName: "next-mutation",
          args: null,
          startedAt: "2026-07-18T00:02:00.000Z",
          recoveryCategory: "side-effecting",
        }),
      ).not.toThrow();
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }

    const replayed = store(cwd, runId, true);
    try {
      const types = replayed
        .readAll()
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload.msg.type);
      expect(types).toEqual([
        "effect_intent",
        "effect_unknown_outcome",
        "effect_review_resolved",
      ]);
    } finally {
      replayed.close();
    }
  });

  it("rejects an external active journal binding without mutating it", () => {
    const cwd = workspace();
    const runId = "run-review-external-binding";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    recovered.close();

    const paths = resolveStateDatabasePaths({ cwd });
    const externalPath = join(
      cwd,
      `rollout-2026-07-18T00-02-00-000Z-${runId}.jsonl`,
    );
    writeFileSync(externalPath, "external must remain unchanged\n", {
      mode: 0o600,
    });
    const driver = openStateDatabasePaths(paths);
    try {
      new StateRunDurabilityRepository(driver).bindJournalSource({
        runId,
        epoch: 1,
        childRunId: runId,
        sessionId: runId,
        sourcePath: externalPath,
        boundAt: "2026-07-18T00:02:00.000Z",
      });
      expect(() =>
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:03:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toThrow(/outside this project's sessions\/archived_sessions roots/);
      expect(readFileSync(externalPath, "utf8")).toBe(
        "external must remain unchanged\n",
      );
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({ reviewStatus: "pending" });
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("reprojects a post-terminal review after failure between journal fsync and both SQLite gates", () => {
    const cwd = workspace();
    const runId = "run-review-projection-crash";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    const rolloutPath = recovered.rolloutPath;
    const terminalEventId = `run-terminal:${runId}:1`;
    expect(
      recovered.append(
        {
          eventId: terminalEventId,
          id: terminalEventId,
          seq: 3,
          msg: {
            type: "run_terminal",
            payload: {
              runId,
              epoch: 1,
              status: "completed",
              exitCode: 0,
              stopReason: "completed",
              finalMessage: "terminal snapshot",
              usage: null,
              lastSequenceBeforeTerminal: 2,
              finishedAt: "2026-07-18T00:00:30.000Z",
            },
          },
        },
        { durable: true },
      ),
    ).toBe(true);
    recovered.close();

    const paths = resolveStateDatabasePaths({ cwd });
    let driver = openStateDatabasePaths(paths);
    try {
      const runs = new StateRunDurabilityRepository(driver);
      runs.recordTerminalResult({
        epoch: 1,
        eventId: terminalEventId,
        result: {
          runId,
          status: "completed",
          exitCode: 0,
          stopReason: "completed",
          finalMessage: "terminal snapshot",
          usage: null,
          lastSequence: 3,
          finishedAt: "2026-07-18T00:00:30.000Z",
        },
      });
      driver.prepareState(
        `CREATE TRIGGER test_abort_legacy_review_projection
         BEFORE UPDATE ON in_flight_tool_calls
         WHEN OLD.status = 'poisoned' AND NEW.status = 'unknown_resolved'
         BEGIN
           SELECT RAISE(ABORT, 'simulated crash before legacy gate projection');
         END`,
      ).run();

      expect(() =>
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toThrow(/simulated crash before legacy gate projection/);
      // The canonical append survives, while the outer SQLite transaction
      // rolls both projections back together instead of leaving a resolved
      // v15 review with a poisoned legacy gate.
      expect(
        readFileSync(rolloutPath, "utf8").match(
          /"type":"effect_review_resolved"/g,
        ),
      ).toHaveLength(1);
      expect(runs.getEffect(runId, "tool:turn-1:call-1")).toMatchObject({
        reviewStatus: "pending",
      });
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toHaveLength(1);
      driver
        .prepareState("DROP TRIGGER test_abort_legacy_review_projection")
        .run();
    } finally {
      driver.close();
    }

    driver = openStateDatabasePaths(paths);
    try {
      expect(() => recoverDaemonStateOnStartup(driver)).not.toThrow();
      const runs = new StateRunDurabilityRepository(driver);
      expect(runs.getEffect(runId, "tool:turn-1:call-1")).toMatchObject({
        reviewStatus: "resolved",
        reviewedBy: "operator-test",
        reviewEventId: `effect-review:${runId}:tool:turn-1:call-1`,
      });
      expect(listUnresolvedUnknownOutcomeEffects(driver, runId)).toEqual([]);
      expect(runs.getCurrentTerminalResult(runId)).toMatchObject({
        status: "completed",
        lastSequence: 3,
      });
      expect(() => recoverDaemonStateOnStartup(driver)).not.toThrow();
      expect(
        readFileSync(rolloutPath, "utf8").match(
          /"type":"effect_review_resolved"/g,
        ),
      ).toHaveLength(1);
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("appends review evidence to the superseded journal that owns the unknown outcome", () => {
    const cwd = workspace();
    const runId = "run-reviewed-superseded-source";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    const historicalPath = original.rolloutPath;
    original.close();
    const recovered = store(cwd, runId, true);
    recovered.close();

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    const activePath = join(
      paths.projectDir,
      "sessions",
      runId,
      `rollout-2026-07-18T00-02-00-000Z-${runId}.jsonl`,
    );
    writeFileSync(
      activePath,
      serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "new canonical source" },
      }),
    );
    try {
      const runs = new StateRunDurabilityRepository(driver);
      runs.bindJournalSource({
        runId,
        epoch: 1,
        childRunId: runId,
        sessionId: runId,
        sourcePath: activePath,
        boundAt: "2026-07-18T00:02:00.000Z",
      });
      expect(runs.getJournalBinding(historicalPath)).toMatchObject({
        active: false,
      });

      expect(
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:03:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toMatchObject({ kind: "resolved", durable: true, sequence: 3 });
      expect(readFileSync(historicalPath, "utf8")).toContain(
        '"type":"effect_review_resolved"',
      );
      expect(readFileSync(activePath, "utf8")).not.toContain(
        '"type":"effect_review_resolved"',
      );
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("discards an unterminated tail under the lease before appending review evidence", () => {
    const cwd = workspace();
    const runId = "run-reviewed-unterminated-tail";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    const rolloutPath = recovered.rolloutPath;
    recovered.close();

    const committed = readFileSync(rolloutPath, "utf8");
    const uncommitted = JSON.stringify({
      type: "response_item",
      payload: { role: "assistant", content: "must be discarded" },
    });
    expect(committed.endsWith("\n")).toBe(true);
    writeFileSync(rolloutPath, committed + uncommitted);

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toMatchObject({ kind: "resolved", durable: true, sequence: 3 });

      const repaired = readFileSync(rolloutPath, "utf8");
      expect(repaired.endsWith("\n")).toBe(true);
      expect(repaired).not.toContain("must be discarded");
      expect(() => {
        for (const line of repaired.trimEnd().split("\n")) JSON.parse(line);
      }).not.toThrow();
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({ reviewStatus: "resolved" });
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("does not review an unknown outcome whose only journal evidence was unterminated", () => {
    const cwd = workspace();
    const runId = "run-review-uncommitted-unknown";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    const rolloutPath = recovered.rolloutPath;
    recovered.close();
    const committed = readFileSync(rolloutPath, "utf8");
    writeFileSync(rolloutPath, committed.slice(0, -1));

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(() =>
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toThrow(/no retained canonical journal evidence/);
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({ reviewStatus: "pending" });
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("refuses to append review evidence after a duplicate journal sequence", () => {
    const cwd = workspace();
    const runId = "run-review-duplicate-sequence";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    const rolloutPath = recovered.rolloutPath;
    recovered.close();
    appendFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "event_msg",
        payload: {
          eventId: "duplicate-sequence-event",
          id: "reusable-correlation",
          seq: 2,
          msg: { type: "user_message", payload: { message: "ambiguous" } },
        },
      }),
    );

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(() =>
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toThrow(/invalid or non-monotonic sequence/);
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("refuses to append review evidence after canonical eventId reuse", () => {
    const cwd = workspace();
    const runId = "run-review-event-id-conflict";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    const rolloutPath = recovered.rolloutPath;
    recovered.close();
    appendFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "event_msg",
        payload: {
          eventId: "legacy-event:1:intent-side-effecting",
          id: "different-correlation",
          seq: 3,
          msg: { type: "user_message", payload: { message: "conflict" } },
        },
      }),
    );

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(() =>
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toThrow(/event id .* is duplicated/);
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("keys review idempotency by canonical eventId, not reusable correlation id", () => {
    const cwd = workspace();
    const runId = "run-review-correlation-collision";
    const reviewEventId = `effect-review:${runId}:tool:turn-1:call-1`;
    const original = store(cwd, runId);
    expect(original.append(intent(runId, "side-effecting"), { durable: true })).toBe(
      true,
    );
    expect(
      original.append(
        {
          eventId: "unrelated-canonical-event",
          id: reviewEventId,
          seq: 2,
          msg: {
            type: "user_message",
            payload: { message: "correlation ids are reusable" },
          },
        },
        { durable: true },
      ),
    ).toBe(true);
    original.close();
    const recovered = store(cwd, runId, true);
    recovered.close();

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:00.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toMatchObject({
        kind: "resolved",
        eventId: reviewEventId,
        sequence: 4,
      });
      expect(
        resolveDurableEffectReview(driver, {
          sessionId: runId,
          toolCallId: "call-1",
          reviewedAt: "2026-07-18T00:01:30.000Z",
          reviewedBy: "operator-test",
          resolution: "human_verified",
        }),
      ).toMatchObject({ kind: "already_resolved", sequence: 4 });
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }
  });

  it("resolves a durable review through the operator CLI exactly once", async () => {
    const cwd = workspace();
    const runId = "run-cli-reviewed";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const recovered = store(cwd, runId, true);
    recovered.close();

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const command = {
      kind: "resolve-tool-call" as const,
      sessionId: runId,
      toolCallId: "call-1",
    };
    const options = {
      driver,
      env: { AGENC_REVIEWER_ID: "cli-reviewer" },
      now: () => "2026-07-18T00:03:00.000Z",
      io: {
        stdout: { write: (text: string) => (stdout.push(text), true) },
        stderr: { write: (text: string) => (stderr.push(text), true) },
      },
    };
    try {
      expect(await runAgenCStateCli(command, options)).toBe(0);
      expect(await runAgenCStateCli(command, options)).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout.join("\n")).toContain("canonical review event");
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({
        reviewStatus: "resolved",
        reviewedBy: "cli-reviewer",
      });
    } finally {
      driver.close();
      created.push(paths.projectDir);
    }

    const replayed = store(cwd, runId, true);
    try {
      expect(
        replayed
          .readAll()
          .filter(
            (item) =>
              item.type === "event_msg" &&
              item.payload.msg.type === "effect_review_resolved",
          ),
      ).toHaveLength(1);
    } finally {
      replayed.close();
    }
  });

  it("refuses review while the canonical session writer lease is live", async () => {
    const cwd = workspace();
    const runId = "run-live-review";
    const original = store(cwd, runId);
    original.append(intent(runId, "side-effecting"), { durable: true });
    original.close();
    const live = store(cwd, runId, true);

    const paths = resolveStateDatabasePaths({ cwd });
    const driver = openStateDatabasePaths(paths);
    const errors: string[] = [];
    try {
      expect(
        await runAgenCStateCli(
          {
            kind: "resolve-tool-call",
            sessionId: runId,
            toolCallId: "call-1",
          },
          {
            driver,
            io: {
              stdout: { write: () => true },
              stderr: { write: (text: string) => (errors.push(text), true) },
            },
          },
        ),
      ).toBe(1);
      expect(errors.join("\n")).toContain("canonical journal is live");
      expect(
        new StateRunDurabilityRepository(driver).getEffect(
          runId,
          "tool:turn-1:call-1",
        ),
      ).toMatchObject({ reviewStatus: "pending" });
    } finally {
      driver.close();
      live.close();
      created.push(paths.projectDir);
    }
  });
});
