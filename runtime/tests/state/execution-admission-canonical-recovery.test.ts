import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import type { Event } from "../../src/session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
} from "../../src/session/rollout-item.js";
import {
  recoverExecutionAdmissionCanonicalJournals,
  recoverExecutionAdmissionEffectSettlements,
} from "../../src/state/execution-admission-canonical-recovery.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { StateRecoveryIncidentRepository } from "../../src/state/recovery-incidents.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const RUN_ID = "admission-recovery-run";
const T0 = "2026-07-18T00:00:00.000Z";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let admissions: ExecutionAdmissionRepository;
let nextId = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-admission-canonical-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-admission-canonical-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  admissions = new ExecutionAdmissionRepository(driver, {
    now: () => new Date(T0),
    id: () => `admission-recovery-id-${++nextId}`,
    ownerId: "crashed-daemon",
    ownerPid: process.pid,
  });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function request(stepId: string): RuntimeAdmissionRequest {
  return {
    step: { runId: RUN_ID, stepId },
    kind: "model_turn",
    estimate: {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0,
    },
    model: "test-model",
    provider: "test-provider",
    workspaceId: "workspace",
    sessionId: RUN_ID,
    parentScopeId: RUN_ID,
    autonomous: false,
  };
}

function reserveToolReservation(
  stepId: string,
  options: {
    readonly kind?: RuntimeAdmissionRequest["kind"];
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
    readonly maxCostUsd?: number;
  } = {},
): string {
  const queued = admissions.enqueue({
    ...request(stepId),
    kind: options.kind ?? "tool_exec",
    estimate: {
      maxInputTokens: options.maxInputTokens ?? 20,
      maxOutputTokens: options.maxOutputTokens ?? 20,
      maxCostUsd: options.maxCostUsd ?? 1,
    },
  });
  const claimed = admissions.claim({ key: queued.record.key });
  if (claimed.kind !== "claimed") {
    throw new Error(`expected claimed admission, got ${claimed.kind}`);
  }
  return claimed.lease.reservation.reservationId;
}

function dispatchToolReservation(
  stepId: string,
  options: {
    readonly kind?: RuntimeAdmissionRequest["kind"];
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
    readonly maxCostUsd?: number;
  } = {},
): string {
  const reservationId = reserveToolReservation(stepId, options);
  admissions.markDispatched(reservationId, { boundary: "tool_effect" });
  return reservationId;
}

function effectEvidence(options: {
  readonly stepId: string;
  readonly reservationId: string;
  readonly payloadRunId?: string;
  readonly includeResult?: boolean;
  readonly includeSettlement?: boolean;
  readonly effectBoundary?: "crossed" | "not_crossed";
  readonly settlementDecision?: "reconcile" | "void" | "hold_unknown";
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
}): Event[] {
  const payloadRunId = options.payloadRunId ?? RUN_ID;
  const base = {
    formatVersion: 2 as const,
    minimumReaderRuntime: "0.14.0" as const,
    runId: payloadRunId,
    stepId: options.stepId,
    callId: "call-1",
    toolName: "metered.tool",
    recoveryCategory: "side-effecting" as const,
  };
  const intent: Event = {
    eventId: "effect-intent-event",
    id: "effect-intent-event",
    seq: 1,
    msg: {
      type: "effect_intent",
      payload: {
        ...base,
        intentDigest: "intent-digest",
        attempt: 1,
        recordedAt: T0,
      },
    },
  };
  if (options.includeResult === false) return [intent];
  const admissionSettlement =
    options.settlementDecision === "void"
      ? {
          reservationId: options.reservationId,
          decision: "void" as const,
          reason: "fixture_no_effect",
        }
      : options.settlementDecision === "hold_unknown"
        ? {
            reservationId: options.reservationId,
            decision: "hold_unknown" as const,
            reason: "fixture_unknown",
          }
        : {
            reservationId: options.reservationId,
            decision: "reconcile" as const,
            usage: options.usage ?? {
              inputTokens: 3,
              outputTokens: 4,
              costUsd: 0.25,
            },
          };
  const result: Event = {
    eventId: "effect-result-event",
    id: "effect-result-event",
    seq: 2,
    msg: {
      type: "effect_result",
      payload: {
        ...base,
        intentEventSeq: 1,
        outcome: "committed",
        effectBoundary: options.effectBoundary ?? "crossed",
        ...(options.includeSettlement === false
          ? {}
          : {
              admissionSettlement,
            }),
        recordedAt: "2026-07-18T00:00:01.000Z",
      },
    },
  };
  return [intent, result];
}

function effectReviewEvidence(options: {
  readonly stepId: string;
  readonly reservationId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
}): Event[] {
  const intent = effectEvidence({
    stepId: options.stepId,
    reservationId: options.reservationId,
    includeResult: false,
  })[0]!;
  if (intent.msg.type !== "effect_intent") {
    throw new Error("fixture effect intent missing");
  }
  const unknown: Event = {
    eventId: "effect-unknown-event",
    id: "effect-unknown-event",
    seq: 2,
    msg: {
      type: "effect_unknown_outcome",
      payload: {
        formatVersion: 2,
        minimumReaderRuntime: "0.14.0",
        runId: RUN_ID,
        stepId: options.stepId,
        callId: intent.msg.payload.callId,
        toolName: intent.msg.payload.toolName,
        recoveryCategory: intent.msg.payload.recoveryCategory,
        intentEventSeq: 1,
        outcome: "unknown_outcome",
        reason: "caller_timeout_after_effect_boundary",
        requiresReview: true,
        callerStop: "timeout",
        callerStoppedAt: T0,
        reservationId: options.reservationId,
        recordedAt: "2026-07-18T00:00:01.000Z",
      },
    },
  };
  const review: Event = {
    eventId: "effect-review-event",
    id: "effect-review-event",
    seq: 3,
    msg: {
      type: "effect_review_resolved",
      payload: {
        runId: RUN_ID,
        stepId: options.stepId,
        callId: intent.msg.payload.callId,
        resolution: {
          version: 1,
          kind: "effect_review_resolution",
          disposition: "confirmed_committed",
          actorKind: "system_settlement",
          actorId: "effect-settlement-supervisor",
          evidenceKind: "provider_receipt",
          evidenceRef: "physical-settlement:call-1",
          evidenceSha256: "a".repeat(64),
          reviewedAt: "2026-07-18T00:00:02.000Z",
          workflowStatus: "resolved",
          domainAction: "mark_completed",
        },
        admissionSettlement: {
          reservationId: options.reservationId,
          decision: "reconcile",
          usage: options.usage,
        },
      },
    },
  };
  return [intent, unknown, review];
}

function rebaseEffectEvidence(
  events: readonly Event[],
  firstSequence: number,
  identitySuffix: string,
): Event[] {
  return events.map((event, index) => {
    const sequence = firstSequence + index;
    let message: Event["msg"] = event.msg;
    if (event.msg.type === "effect_result") {
      message = {
        type: "effect_result",
        payload: {
          ...event.msg.payload,
          intentEventSeq: firstSequence,
        },
      };
    }
    const eventId = `${event.eventId ?? event.id}-${identitySuffix}`;
    return { eventId, id: eventId, seq: sequence, msg: message };
  });
}

function seedAgentRun(runId: string): void {
  upsertAgentRun(driver, {
    id: runId,
    objective: "effect settlement recovery",
    status: "running",
    startedAt: T0,
    lastActiveAt: T0,
  });
}

function agentRunStatus(runId: string): string | undefined {
  return driver
    .prepareState<[string], { readonly status: string }>(
      "SELECT status FROM agent_runs WHERE id = ?",
    )
    .get(runId)?.status;
}

function overwriteReservationStatus(
  reservationId: string,
  status: "reconciled" | "provider_overrun",
): void {
  driver
    .prepareState<[string, string]>(
      `UPDATE execution_admission_reservations
       SET status = ?
       WHERE reservation_id = ?`,
    )
    .run(status, reservationId);
}

function overwriteReservationActualTokens(
  reservationId: string,
  actualTokens: number,
): void {
  driver
    .prepareState<[number, string]>(
      `UPDATE execution_admission_reservations
       SET actual_tokens = ?
       WHERE reservation_id = ?`,
    )
    .run(actualTokens, reservationId);
}

function bindRollout(events: readonly Event[]): string {
  const directory = join(driver.projectDir, "sessions", RUN_ID);
  mkdirSync(directory, { recursive: true });
  const sourcePath = join(directory, `rollout-${RUN_ID}.jsonl`);
  writeFileSync(
    sourcePath,
    events
      .map((event) =>
        serializeRolloutItem({ type: "event_msg", payload: event }),
      )
      .join(""),
    { mode: 0o600 },
  );
  const durability = new StateRunDurabilityRepository(driver);
  durability.ensureInitialEpoch({ runId: RUN_ID, openedAt: T0 });
  durability.bindJournalSource({
    runId: RUN_ID,
    epoch: 1,
    childRunId: RUN_ID,
    sessionId: RUN_ID,
    sourcePath,
    boundAt: T0,
  });
  return sourcePath;
}

function readEvents(sourcePath: string): Event[] {
  return readFileSync(sourcePath, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      const item = parseRolloutLine(line);
      return item?.type === "event_msg" ? [item.payload] : [];
    });
}

describe("canonical execution-admission recovery", () => {
  it("replays exact nonzero effect usage before generic stale-owner recovery", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    bindRollout(effectEvidence({ stepId, reservationId }));

    const first = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );
    const second = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );
    const staleOwnerRecovery = admissions.recover({
      activeOwnerIds: new Set(),
      now: "2026-07-18T00:00:02.000Z",
    });

    expect(first).toMatchObject({
      effectResultsScanned: 1,
      settlementsApplied: 1,
      settlementsAlreadyApplied: 0,
    });
    expect(second).toMatchObject({
      effectResultsScanned: 1,
      settlementsApplied: 0,
      settlementsAlreadyApplied: 1,
    });
    expect(staleOwnerRecovery.heldUnknownReservationIds).toEqual([]);
    expect(admissions.getReservation(reservationId)).toMatchObject({
      status: "reconciled",
      actualInputTokens: 3,
      actualOutputTokens: 4,
      actualCostUsd: 0.25,
    });
  });

  it("accepts an already-voided cancellation with a different diagnostic reason", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = reserveToolReservation(stepId);
    bindRollout(
      effectEvidence({
        stepId,
        reservationId,
        effectBoundary: "not_crossed",
        settlementDecision: "void",
      }),
    );
    admissions.void(
      reservationId,
      "cancelled_before_dispatch:operator_cancelled",
    );

    const recovery = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(recovery).toMatchObject({
      settlementsApplied: 0,
      settlementsAlreadyApplied: 1,
    });
    expect(admissions.getReservation(reservationId)).toMatchObject({
      status: "voided",
      resolutionReason: "cancelled_before_dispatch:operator_cancelled",
    });
  });

  it("accepts a legacy stale-owner hold with a different diagnostic reason", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    bindRollout(
      effectEvidence({
        stepId,
        reservationId,
        settlementDecision: "hold_unknown",
      }),
    );
    expect(
      admissions.recover({
        activeOwnerIds: new Set(),
        now: "2026-07-18T00:00:02.000Z",
      }).heldUnknownReservationIds,
    ).toEqual([reservationId]);

    const recovery = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(recovery).toMatchObject({
      settlementsApplied: 0,
      settlementsAlreadyApplied: 1,
    });
    expect(admissions.getReservation(reservationId)).toMatchObject({
      status: "held_unknown",
      resolutionReason: "daemon_restarted_after_dispatch",
    });
  });

  it("replays exact late-review usage and remains idempotent across restart", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const usage = { inputTokens: 8, outputTokens: 9, costUsd: 0.5 };
    bindRollout(effectReviewEvidence({ stepId, reservationId, usage }));

    const first = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );
    const second = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(first).toMatchObject({
      effectResultsScanned: 1,
      settlementsApplied: 1,
      settlementsAlreadyApplied: 0,
    });
    expect(second).toMatchObject({
      effectResultsScanned: 1,
      settlementsApplied: 0,
      settlementsAlreadyApplied: 1,
    });
    expect(admissions.getReservation(reservationId)).toMatchObject({
      status: "reconciled",
      actualInputTokens: 8,
      actualOutputTokens: 9,
      actualCostUsd: 0.5,
    });
  });

  it("allows a terminal operator review after a pending settlement review", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectReviewEvidence({
      stepId,
      reservationId,
      usage: { inputTokens: 8, outputTokens: 9, costUsd: 0.5 },
    });
    const systemReview = evidence[2];
    if (systemReview?.msg.type !== "effect_review_resolved") {
      throw new Error("fixture system review missing");
    }
    const pendingReview: Event = {
      ...systemReview,
      msg: {
        type: "effect_review_resolved",
        payload: {
          ...systemReview.msg.payload,
          resolution: {
            version: 1,
            kind: "effect_review_resolution",
            disposition: "remains_unknown",
            actorKind: "system_settlement",
            actorId: "effect-settlement-supervisor",
            evidenceKind: "provider_receipt",
            evidenceRef: "physical-settlement:unresolved:call-1",
            evidenceSha256: "c".repeat(64),
            reviewedAt: "2026-07-18T00:00:02.000Z",
            workflowStatus: "pending",
          },
          admissionSettlement: {
            reservationId,
            decision: "hold_unknown",
            reason: "tool_timeout_after_dispatch",
          },
        },
      },
    };
    const operatorReview: Event = {
      eventId: "effect-operator-review-event",
      id: "effect-operator-review-event",
      seq: 4,
      msg: {
        type: "effect_review_resolved",
        payload: {
          runId: RUN_ID,
          stepId,
          callId: "call-1",
          resolution: {
            version: 1,
            kind: "effect_review_resolution",
            disposition: "confirmed_no_effect",
            actorKind: "operator",
            actorId: "operator-1",
            evidenceKind: "operator_evidence",
            evidenceRef: "incident:late-review",
            evidenceSha256: "d".repeat(64),
            reviewedAt: "2026-07-18T00:00:03.000Z",
            workflowStatus: "resolved",
            domainAction: "retry_new_attempt",
          },
        },
      },
    };
    bindRollout([evidence[0]!, evidence[1]!, pendingReview, operatorReview]);

    const first = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );
    const second = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(first.settlementsApplied).toBe(1);
    expect(second.settlementsAlreadyApplied).toBe(1);
    expect(admissions.getReservation(reservationId)).toMatchObject({
      status: "held_unknown",
      resolutionReason: "tool_timeout_after_dispatch",
    });
  });

  it("rejects a schema-valid review with impossible cross-field semantics", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectReviewEvidence({
      stepId,
      reservationId,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
    const review = evidence[2];
    if (
      review?.msg.type !== "effect_review_resolved" ||
      typeof review.msg.payload.resolution === "string"
    ) {
      throw new Error("fixture review missing");
    }
    const invalidReview: Event = {
      ...review,
      msg: {
        type: "effect_review_resolved",
        payload: {
          ...review.msg.payload,
          resolution: {
            ...review.msg.payload.resolution,
            disposition: "confirmed_committed",
            workflowStatus: "pending",
            domainAction: "mark_completed",
          },
          admissionSettlement: {
            reservationId,
            decision: "hold_unknown",
            reason: "invalid_review_must_not_settle",
          },
        },
      },
    };
    bindRollout([evidence[0]!, evidence[1]!, invalidReview]);

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/pending effect review must remain unknown/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("dispatched");
  });

  it.each([
    { evidenceKind: "result", missing: "formatVersion" },
    { evidenceKind: "result", missing: "minimumReaderRuntime" },
    { evidenceKind: "review", missing: "formatVersion" },
    { evidenceKind: "review", missing: "minimumReaderRuntime" },
  ] as const)(
    "rejects a v2 $evidenceKind settlement linked to an intent missing $missing",
    ({ evidenceKind, missing }) => {
      const stepId = "tool:turn-1:call-1";
      const reservationId = dispatchToolReservation(stepId);
      const evidence =
        evidenceKind === "result"
          ? effectEvidence({ stepId, reservationId })
          : effectReviewEvidence({
              stepId,
              reservationId,
              usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.25 },
            });
      const intent = evidence[0];
      if (intent?.msg.type !== "effect_intent") {
        throw new Error("fixture effect intent missing");
      }
      const legacyPayload = { ...intent.msg.payload };
      delete legacyPayload[missing];
      const legacyIntent: Event = {
        ...intent,
        msg: { type: "effect_intent", payload: legacyPayload },
      };
      bindRollout([legacyIntent, ...evidence.slice(1)]);

      expect(() =>
        recoverExecutionAdmissionEffectSettlements(driver, admissions),
      ).toThrow(/no exact canonical/u);
      expect(admissions.getReservation(reservationId)?.status).toBe(
        "dispatched",
      );
    },
  );

  it("validates settlement cardinality before mutating any reservation", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectEvidence({
      stepId,
      reservationId,
      settlementDecision: "hold_unknown",
    });
    const firstResult = evidence[1];
    if (firstResult?.msg.type !== "effect_result") {
      throw new Error("fixture effect result missing");
    }
    const conflictingResult: Event = {
      eventId: "effect-result-conflict",
      id: "effect-result-conflict",
      seq: 3,
      msg: {
        type: "effect_result",
        payload: {
          ...firstResult.msg.payload,
          admissionSettlement: {
            reservationId,
            decision: "reconcile",
            usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.25 },
          },
        },
      },
    };
    bindRollout([...evidence, conflictingResult]);

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/conflicting canonical effect evidence/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("dispatched");
  });

  it("rejects a review settlement when a second unknown outcome follows it", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectReviewEvidence({
      stepId,
      reservationId,
      usage: { inputTokens: 8, outputTokens: 9, costUsd: 0.5 },
    });
    const firstUnknown = evidence[1];
    if (firstUnknown?.msg.type !== "effect_unknown_outcome") {
      throw new Error("fixture unknown outcome missing");
    }
    const secondUnknown: Event = {
      eventId: "effect-unknown-conflict",
      id: "effect-unknown-conflict",
      seq: 4,
      msg: {
        type: "effect_unknown_outcome",
        payload: {
          ...firstUnknown.msg.payload,
          reason: "second contradictory unknown outcome",
          recordedAt: "2026-07-18T00:00:03.000Z",
        },
      },
    };
    bindRollout([...evidence, secondUnknown]);

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/conflicting canonical effect evidence/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("dispatched");
  });

  it("rejects a settlementless result followed by a settlement result", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectEvidence({
      stepId,
      reservationId,
      includeSettlement: false,
    });
    const firstResult = evidence[1];
    if (firstResult?.msg.type !== "effect_result") {
      throw new Error("fixture effect result missing");
    }
    const settlementResult: Event = {
      eventId: "effect-result-with-settlement",
      id: "effect-result-with-settlement",
      seq: 3,
      msg: {
        type: "effect_result",
        payload: {
          ...firstResult.msg.payload,
          admissionSettlement: {
            reservationId,
            decision: "reconcile",
            usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.25 },
          },
        },
      },
    };
    bindRollout([...evidence, settlementResult]);

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/conflicting canonical effect evidence/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("dispatched");
  });

  it("rejects a typed settlement event without a canonical sequence", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectEvidence({ stepId, reservationId });
    const result = evidence[1];
    if (result?.msg.type !== "effect_result") {
      throw new Error("fixture effect result missing");
    }
    const { seq: _sequence, ...unsequenced } = result;
    bindRollout([evidence[0]!, unsequenced]);

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/canonical effect settlement .* has no sequence/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("dispatched");
  });

  it("deduplicates an exact repeated canonical settlement identity", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const evidence = effectEvidence({ stepId, reservationId });
    bindRollout([...evidence, evidence[1]!]);

    const recovery = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(recovery).toMatchObject({
      effectResultsScanned: 1,
      settlementsApplied: 1,
    });
    expect(admissions.getReservation(reservationId)?.status).toBe("reconciled");
  });

  it("repairs the run tree when exact durable usage was already recorded as an overrun", () => {
    const stepId = "tool:turn-1:call-1";
    const childRunId = "effect_settlement_child";
    seedAgentRun(RUN_ID);
    seedAgentRun(childRunId);
    new ThreadSpawnEdgeRepository(driver).create(
      {
        childThreadId: childRunId,
        parentThreadId: RUN_ID,
        parentPath: "/root",
        metadata: {
          agentId: childRunId,
          agentPath: `/root/${childRunId}`,
          depth: 1,
        },
        status: "open",
      },
      { admissionGate: "import" },
    );
    const reservationId = dispatchToolReservation(stepId, {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0.1,
    });
    const usage = { inputTokens: 3, outputTokens: 4, costUsd: 0.25 };
    expect(
      admissions.reconcile(reservationId, { kind: "reported", usage }),
    ).toMatchObject({ outcome: "provider_overrun" });
    expect(agentRunStatus(RUN_ID)).toBe("running");
    expect(agentRunStatus(childRunId)).toBe("running");
    bindRollout(effectEvidence({ stepId, reservationId, usage }));

    const first = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );
    const second = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(first.settlementsAlreadyApplied).toBe(1);
    expect(second.settlementsAlreadyApplied).toBe(1);
    expect(agentRunStatus(RUN_ID)).toBe("cancelled");
    expect(agentRunStatus(childRunId)).toBe("cancelled");
  });

  it("rejects over-bound usage mislabeled as reconciled", () => {
    const stepId = "tool:turn-1:call-1";
    seedAgentRun(RUN_ID);
    const reservationId = dispatchToolReservation(stepId, {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0.1,
    });
    const usage = { inputTokens: 3, outputTokens: 4, costUsd: 0.25 };
    expect(
      admissions.reconcile(reservationId, { kind: "reported", usage }),
    ).toMatchObject({ outcome: "provider_overrun" });
    overwriteReservationStatus(reservationId, "reconciled");
    bindRollout(effectEvidence({ stepId, reservationId, usage }));

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/status reconciled/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("reconciled");
    expect(agentRunStatus(RUN_ID)).toBe("running");
  });

  it("rejects in-bound usage mislabeled as a provider overrun", () => {
    const stepId = "tool:turn-1:call-1";
    seedAgentRun(RUN_ID);
    const reservationId = dispatchToolReservation(stepId);
    const usage = { inputTokens: 3, outputTokens: 4, costUsd: 0.25 };
    expect(
      admissions.reconcile(reservationId, { kind: "reported", usage }),
    ).toMatchObject({ outcome: "reconciled" });
    overwriteReservationStatus(reservationId, "provider_overrun");
    bindRollout(effectEvidence({ stepId, reservationId, usage }));

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/status provider_overrun/u);
    expect(admissions.getReservation(reservationId)?.status).toBe(
      "provider_overrun",
    );
    expect(agentRunStatus(RUN_ID)).toBe("running");
  });

  it("rejects reconciled usage whose persisted aggregate token count is corrupt", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    const usage = { inputTokens: 3, outputTokens: 2, costUsd: 0.25 };
    expect(
      admissions.reconcile(reservationId, { kind: "reported", usage }),
    ).toMatchObject({ outcome: "reconciled" });
    overwriteReservationActualTokens(reservationId, 0);
    bindRollout(effectEvidence({ stepId, reservationId, usage }));

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/status reconciled/u);
    expect(admissions.getReservation(reservationId)).toMatchObject({
      status: "reconciled",
      actualInputTokens: 3,
      actualOutputTokens: 2,
      actualTokens: 0,
    });
  });

  it("accepts a provider-overrun cancellation that settles a later planned hold", () => {
    const overrunStepId = "tool:turn-1:overrun";
    const cancelledStepId = "tool:turn-1:cancelled";
    seedAgentRun(RUN_ID);
    const overrunReservationId = dispatchToolReservation(overrunStepId, {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0.1,
    });
    const cancelledReservationId = dispatchToolReservation(cancelledStepId);
    const overrunEvidence = rebaseEffectEvidence(
      effectEvidence({
        stepId: overrunStepId,
        reservationId: overrunReservationId,
        usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.25 },
      }),
      1,
      "overrun",
    );
    const cancelledEvidence = rebaseEffectEvidence(
      effectEvidence({
        stepId: cancelledStepId,
        reservationId: cancelledReservationId,
        settlementDecision: "hold_unknown",
      }),
      3,
      "cancelled",
    );
    bindRollout([...overrunEvidence, ...cancelledEvidence]);

    const recovery = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(recovery).toMatchObject({
      settlementsApplied: 2,
      settlementsAlreadyApplied: 0,
    });
    expect(admissions.getReservation(overrunReservationId)?.status).toBe(
      "provider_overrun",
    );
    expect(admissions.getReservation(cancelledReservationId)).toMatchObject({
      status: "held_unknown",
      resolutionReason: "fixture_unknown",
    });
  });

  it("settles a later reserved call before applying an earlier overrun cascade", () => {
    const overrunStepId = "tool:turn-1:overrun";
    const reservedStepId = "tool:turn-1:not-started";
    seedAgentRun(RUN_ID);
    const overrunReservationId = dispatchToolReservation(overrunStepId, {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0.1,
    });
    const reservedReservationId = reserveToolReservation(reservedStepId);
    const overrunEvidence = rebaseEffectEvidence(
      effectEvidence({
        stepId: overrunStepId,
        reservationId: overrunReservationId,
        usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.25 },
      }),
      1,
      "overrun",
    );
    const reservedEvidence = rebaseEffectEvidence(
      effectEvidence({
        stepId: reservedStepId,
        reservationId: reservedReservationId,
        effectBoundary: "not_crossed",
        settlementDecision: "void",
      }),
      3,
      "reserved",
    );
    bindRollout([...overrunEvidence, ...reservedEvidence]);

    const recovery = recoverExecutionAdmissionEffectSettlements(
      driver,
      admissions,
    );

    expect(recovery.settlementsApplied).toBe(2);
    expect(admissions.getReservation(overrunReservationId)?.status).toBe(
      "provider_overrun",
    );
    expect(admissions.getReservation(reservedReservationId)).toMatchObject({
      status: "voided",
      resolutionReason: "fixture_no_effect",
    });
    expect(agentRunStatus(RUN_ID)).toBe("cancelled");
  });

  it("rejects a settlement that names a non-tool reservation", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId, {
      kind: "model_turn",
    });
    bindRollout(effectEvidence({ stepId, reservationId }));

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/is not a tool call/u);
  });

  it("rejects a settlement with an unknown reservation identity", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    bindRollout(
      effectEvidence({ stepId, reservationId: "different-reservation" }),
    );

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/unknown reservation different-reservation/u);
    expect(
      admissions.recover({
        activeOwnerIds: new Set(),
        now: "2026-07-18T00:00:02.000Z",
      }).heldUnknownReservationIds,
    ).toEqual([reservationId]);
  });

  it("rejects a void decision for a crossed effect", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = dispatchToolReservation(stepId);
    bindRollout(
      effectEvidence({
        stepId,
        reservationId,
        effectBoundary: "crossed",
        settlementDecision: "void",
      }),
    );

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/crossed effect settlement.+cannot be voided/u);
  });

  it("rejects a charged settlement for a pre-effect result", () => {
    const stepId = "tool:turn-1:call-1";
    const reservationId = reserveToolReservation(stepId);
    bindRollout(
      effectEvidence({
        stepId,
        reservationId,
        effectBoundary: "not_crossed",
      }),
    );

    expect(() =>
      recoverExecutionAdmissionEffectSettlements(driver, admissions),
    ).toThrow(/pre-effect settlement.+must be voided/u);
    expect(admissions.getReservation(reservationId)?.status).toBe("reserved");
  });

  it.each([
    { label: "a dangling intent", includeResult: false },
    { label: "a result without settlement evidence", includeResult: true },
  ])(
    "leaves $label for conservative held-unknown recovery",
    ({ includeResult }) => {
      const stepId = "tool:turn-1:call-1";
      const reservationId = dispatchToolReservation(stepId);
      bindRollout(
        effectEvidence({
          stepId,
          reservationId,
          includeResult,
          includeSettlement: false,
        }),
      );

      const exact = recoverExecutionAdmissionEffectSettlements(
        driver,
        admissions,
      );
      const conservative = admissions.recover({
        activeOwnerIds: new Set(),
        now: "2026-07-18T00:00:02.000Z",
      });

      expect(exact.settlementsApplied).toBe(0);
      expect(conservative.heldUnknownReservationIds).toEqual([reservationId]);
      expect(admissions.getReservation(reservationId)?.status).toBe(
        "held_unknown",
      );
    },
  );

  it.each([
    {
      label: "run",
      payloadRunId: "different-run",
      evidenceStepId: "tool:turn-1:call-1",
    },
    {
      label: "step",
      payloadRunId: RUN_ID,
      evidenceStepId: "tool:turn-1:different-call",
    },
  ])(
    "rejects effect settlement evidence from a different $label",
    ({ payloadRunId, evidenceStepId }) => {
      const reservationStepId = "tool:turn-1:call-1";
      const reservationId = dispatchToolReservation(reservationStepId);
      bindRollout(
        effectEvidence({
          stepId: evidenceStepId,
          reservationId,
          payloadRunId,
        }),
      );

      expect(() =>
        recoverExecutionAdmissionEffectSettlements(driver, admissions),
      ).toThrow(/no exact canonical intent|does not match step/u);
      expect(
        admissions.recover({
          activeOwnerIds: new Set(),
          now: "2026-07-18T00:00:02.000Z",
        }).heldUnknownReservationIds,
      ).toEqual([reservationId]);
    },
  );

  it("backfills the exact SQLite event under the run sequence lease", () => {
    const sourcePath = bindRollout([
      {
        eventId: "existing-event",
        id: "existing-event",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "fixture", message: "existing" },
        },
      },
    ]);
    const queued = admissions.enqueue(request("model-1"));
    const admission = admissions.listJournal({ runId: RUN_ID })[0]!;

    const first = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );
    const second = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );

    expect(queued.record.status).toBe("queued");
    expect(first.admissionEventsAppended).toBe(1);
    expect(second.admissionEventsAppended).toBe(0);
    expect(readEvents(sourcePath)).toMatchObject([
      { eventId: "existing-event", seq: 1 },
      {
        eventId: admission.eventId,
        id: admission.eventId,
        seq: 2,
        msg: { type: "execution_admission", payload: admission },
      },
    ]);
    expect(
      driver
        .prepareState<[string], { readonly event_id: string }>(
          `SELECT event_id FROM thread_rollout_items
           WHERE source_path = ? AND event_seq = 2`,
        )
        .get(sourcePath),
    ).toEqual({ event_id: admission.eventId });
  });

  it("does not mutate a canonical journal while its run is excluded", () => {
    const sourcePath = bindRollout([]);
    admissions.enqueue(request("model-excluded"));
    new StateRecoveryIncidentRepository(driver).recordQuarantine({
      runId: RUN_ID,
      sourceKind: "run_journal",
      sourcePath,
      reasonCode: "malformed_json",
      safeDetail: { message: "operator review required" },
      sourceSizeBytes: 0,
      sourceMtimeMs: 1,
      sourceSha256: "c".repeat(64),
      detectedAtMs: 1,
    });

    const result = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );

    expect(result).toEqual({
      runsScanned: 0,
      sourcesScanned: 0,
      admissionEventsScanned: 0,
      admissionEventsAppended: 0,
    });
    expect(readEvents(sourcePath)).toEqual([]);
  });

  it("refuses conflicting canonical identity evidence", () => {
    admissions.enqueue(request("model-conflict"));
    const admission = admissions.listJournal({ runId: RUN_ID })[0]!;
    bindRollout([
      {
        eventId: admission.eventId,
        id: admission.eventId,
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "conflict", message: "not admission evidence" },
        },
      },
    ]);
    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions),
    ).toThrow(/conflicting canonical evidence/);
  });

  it("tolerates distinct legacy-unsequenced events sharing a synthetic id", () => {
    // Legacy rollouts predate durable event identities: their `id` is not
    // unique (synthetic ids like "system" recur). Two DIFFERENT events
    // sharing it is the legacy format, not corruption — recovery must not
    // abort daemon startup (observed: daemon died on a pre-0.7.0 session).
    bindRollout([
      {
        id: "system",
        msg: { type: "warning", payload: { cause: "a", message: "first" } },
      } as Event,
      {
        id: "system",
        msg: { type: "warning", payload: { cause: "a", message: "first" } },
      } as Event,
      {
        id: "system",
        msg: { type: "warning", payload: { cause: "b", message: "second" } },
      } as Event,
    ]);
    const queued = admissions.enqueue(request("model-legacy"));
    expect(queued.record.status).toBe("queued");

    const result = recoverExecutionAdmissionCanonicalJournals(
      driver,
      admissions,
    );
    expect(result.admissionEventsAppended).toBe(1);
    // Idempotent on re-run despite the disambiguated ids.
    expect(
      recoverExecutionAdmissionCanonicalJournals(driver, admissions)
        .admissionEventsAppended,
    ).toBe(0);
  });

  it("refuses to append committed admission evidence after a terminal tail", () => {
    const otherRun = "terminal-admission-recovery-run";
    const directory = join(driver.projectDir, "sessions", otherRun);
    mkdirSync(directory, { recursive: true });
    const sourcePath = join(directory, `rollout-${otherRun}.jsonl`);
    writeFileSync(
      sourcePath,
      serializeRolloutItem({
        type: "event_msg",
        payload: {
          eventId: "terminal-event",
          id: "terminal-event",
          seq: 1,
          msg: {
            type: "run_terminal",
            payload: {
              runId: otherRun,
              epoch: 1,
              status: "completed",
              exitCode: 0,
              stopReason: "done",
              finalMessage: "done",
              usage: null,
              lastSequenceBeforeTerminal: null,
              finishedAt: T0,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const durability = new StateRunDurabilityRepository(driver);
    durability.ensureInitialEpoch({ runId: otherRun, openedAt: T0 });
    durability.bindJournalSource({
      runId: otherRun,
      epoch: 1,
      childRunId: otherRun,
      sessionId: otherRun,
      sourcePath,
      boundAt: T0,
    });
    admissions.enqueue({
      ...request("model-terminal"),
      step: { runId: otherRun, stepId: "model-terminal" },
      sessionId: otherRun,
      parentScopeId: otherRun,
    });

    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions),
    ).toThrow(/terminal tail precedes 1 committed admission event/);
  });

  it("fails closed when its configured event-work bound is exceeded", () => {
    bindRollout([]);
    admissions.enqueue(request("model-1"));
    const claimed = admissions.claim();
    expect(claimed.kind).toBe("claimed");

    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions, {
        maxEventsPerRun: 1,
      }),
    ).toThrow(/bounded event limit \(1\)/);
  });

  it("refuses a canonical lifecycle with committed admissions but no binding", () => {
    admissions.enqueue(request("model-unbound"));
    new StateRunDurabilityRepository(driver).ensureInitialEpoch({
      runId: RUN_ID,
      openedAt: T0,
    });

    expect(() =>
      recoverExecutionAdmissionCanonicalJournals(driver, admissions),
    ).toThrow(/canonical lifecycle but no journal binding/);
  });
});
