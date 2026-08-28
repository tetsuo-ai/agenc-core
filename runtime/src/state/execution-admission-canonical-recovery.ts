import { join, resolve, sep } from "node:path";

import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import {
  withPinnedOfflineRolloutLease,
  type PinnedOfflineRollout,
} from "../durability/offline-rollout.js";
import {
  EFFECT_EVIDENCE_FORMAT_VERSION,
  EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
  type EffectBoundary,
  type EffectReviewResolution,
} from "../contracts/run-contracts.js";
import type { EffectAdmissionSettlement, Event } from "../session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
} from "../session/rollout-item.js";
import { stableStringify } from "../utils/stableStringify.js";
import { backfillPinnedRolloutContent } from "./backfill.js";
import {
  nanosToUsd,
  usdToNanos,
  type ExecutionAdmissionRepository,
  type PersistedAdmissionReservation,
} from "./execution-admission.js";
import {
  canonicalizeEffectReviewResolution,
  StateRunDurabilityRepository,
  type RunJournalBinding,
} from "./run-durability.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";
import { recoveryRunIsExecutableSql } from "./recovery-exclusions.js";
import { cancelRunTreeAndAdmission } from "./run-admission-cancellation.js";

const DEFAULT_MAX_RUNS = 4_096;
const DEFAULT_MAX_EVENTS_PER_RUN = 100_000;
const DEFAULT_MAX_SOURCES_PER_RUN = 32;
const JOURNAL_PAGE_SIZE = 1_000;

interface AdmissionRunRow {
  readonly run_id: string;
}

interface CanonicalEventRecord {
  readonly event: Event;
  readonly eventId: string;
  readonly sequence: number | undefined;
  readonly signature: string;
  readonly sourcePath: string;
}

type EffectIntentEvidence = Extract<
  Event["msg"],
  { readonly type: "effect_intent" }
>["payload"] & { readonly sequence: number };

interface PlannedEffectAdmissionSettlement {
  readonly runId: string;
  readonly stepId: string;
  readonly intentSequence: number;
  readonly eventId: string;
  readonly signature: string;
  readonly settlement: EffectAdmissionSettlement;
  readonly effectBoundary: EffectBoundary;
  readonly recordedAt: string;
}

export interface ExecutionAdmissionCanonicalRecoveryResult {
  readonly runsScanned: number;
  readonly sourcesScanned: number;
  readonly admissionEventsScanned: number;
  readonly admissionEventsAppended: number;
}

export interface ExecutionAdmissionEffectRecoveryResult {
  readonly runsScanned: number;
  readonly effectResultsScanned: number;
  readonly settlementsApplied: number;
  readonly settlementsAlreadyApplied: number;
}

/**
 * Replay fsync-committed effect-result/review accounting before generic
 * stale-owner recovery turns every dispatched reservation into `held_unknown`.
 *
 * The canonical result is authority only when its intent, run, step, and
 * reservation all agree.  Legacy results without the typed settlement remain
 * deliberately ineligible and are handled conservatively by `recover()`.
 */
export function recoverExecutionAdmissionEffectSettlements(
  driver: StateSqliteDriver,
  admissions: ExecutionAdmissionRepository,
  options: {
    readonly maxRuns?: number;
    readonly maxSourcesPerRun?: number;
  } = {},
): ExecutionAdmissionEffectRecoveryResult {
  const maxRuns = positiveBound(options.maxRuns ?? DEFAULT_MAX_RUNS, "maxRuns");
  const maxSources = positiveBound(
    options.maxSourcesPerRun ?? DEFAULT_MAX_SOURCES_PER_RUN,
    "maxSourcesPerRun",
  );
  const runs = driver
    .prepareState<[number], AdmissionRunRow>(
      `SELECT DISTINCT reservation.run_id
       FROM execution_admission_reservations AS reservation
       JOIN run_journal_bindings AS binding
         ON binding.run_id = reservation.run_id
       WHERE ${recoveryRunIsExecutableSql("reservation.run_id")}
       ORDER BY reservation.run_id ASC
       LIMIT ?`,
    )
    .all(maxRuns + 1);
  if (runs.length > maxRuns) {
    throw new Error(
      `canonical effect admission recovery exceeds the bounded run limit (${maxRuns})`,
    );
  }

  const durability = new StateRunDurabilityRepository(driver);
  const plannedSettlements: PlannedEffectAdmissionSettlement[] = [];
  const settlementByIntent = new Map<
    string,
    PlannedEffectAdmissionSettlement
  >();
  let effectResultsScanned = 0;
  for (const row of runs) {
    const bindings = retainedBindings(
      durability.listJournalBindings(row.run_id),
      driver.projectDir,
    );
    if (bindings.length === 0) continue;
    if (bindings.length > maxSources) {
      throw new Error(
        `run ${row.run_id} canonical effect admission recovery exceeds the bounded source limit (${maxSources})`,
      );
    }
    withPinnedBindings(
      driver.projectDir,
      uniqueSourceBindings(bindings),
      new Map(),
      (leases) => {
        const canonical = bindings.flatMap((binding) =>
          readCanonicalEvents(
            leases.get(binding.sourcePath)!.readUtf8(),
            binding.sourcePath,
          ),
        );
        const ordered = validateCanonicalEvents(canonical, row.run_id).ordered;
        const intents = new Map<string, EffectIntentEvidence>();
        const effectResults = new Map<string, CanonicalEventRecord[]>();
        const unknownOutcomes = new Map<string, CanonicalEventRecord[]>();
        const effectReviews = new Map<string, CanonicalEventRecord[]>();
        for (const record of ordered) {
          const message = record.event.msg;
          if (message.type === "effect_intent") {
            if (message.payload.runId !== row.run_id) continue;
            if (intents.has(message.payload.stepId)) {
              throw new Error(
                `run ${row.run_id} canonical effect admission recovery found duplicate intent for step ${message.payload.stepId}`,
              );
            }
            intents.set(message.payload.stepId, {
              ...message.payload,
              sequence: record.sequence!,
            });
          } else if (message.type === "effect_unknown_outcome") {
            const evidence = unknownOutcomes.get(message.payload.stepId) ?? [];
            evidence.push(record);
            unknownOutcomes.set(message.payload.stepId, evidence);
          } else if (message.type === "effect_result") {
            const evidence = effectResults.get(message.payload.stepId) ?? [];
            evidence.push(record);
            effectResults.set(message.payload.stepId, evidence);
          } else if (message.type === "effect_review_resolved") {
            const evidence = effectReviews.get(message.payload.stepId) ?? [];
            evidence.push(record);
            effectReviews.set(message.payload.stepId, evidence);
          }
        }
        for (const record of ordered) {
          const message = record.event.msg;
          let planned: PlannedEffectAdmissionSettlement | undefined;
          if (message.type === "effect_result") {
            const settlement = message.payload.admissionSettlement;
            if (settlement === undefined) continue;
            effectResultsScanned += 1;
            assertEffectSettlementTopology({
              runId: row.run_id,
              stepId: message.payload.stepId,
              settlementRecord: record,
              expected: "result",
              effectResults: effectResults.get(message.payload.stepId) ?? [],
              unknownOutcomes:
                unknownOutcomes.get(message.payload.stepId) ?? [],
              effectReviews: effectReviews.get(message.payload.stepId) ?? [],
            });
            const intent = intents.get(message.payload.stepId);
            assertEffectSettlementEvidence({
              runId: row.run_id,
              event: record.event,
              intent,
              settlement,
            });
            planned = {
              runId: row.run_id,
              stepId: message.payload.stepId,
              intentSequence: intent!.sequence,
              eventId: record.eventId,
              signature: record.signature,
              settlement,
              effectBoundary: message.payload.effectBoundary!,
              recordedAt: message.payload.recordedAt,
            };
          } else if (message.type === "effect_review_resolved") {
            const settlement =
              "admissionSettlement" in message.payload
                ? message.payload.admissionSettlement
                : undefined;
            if (settlement === undefined) continue;
            effectResultsScanned += 1;
            assertEffectSettlementTopology({
              runId: row.run_id,
              stepId: message.payload.stepId,
              settlementRecord: record,
              expected: "review",
              effectResults: effectResults.get(message.payload.stepId) ?? [],
              unknownOutcomes:
                unknownOutcomes.get(message.payload.stepId) ?? [],
              effectReviews: effectReviews.get(message.payload.stepId) ?? [],
            });
            const intent = intents.get(message.payload.stepId);
            const resolution = assertEffectReviewSettlementEvidence({
              runId: row.run_id,
              event: record.event,
              intent,
              unknownOutcomes:
                unknownOutcomes.get(message.payload.stepId) ?? [],
              settlement,
            });
            planned = {
              runId: row.run_id,
              stepId: message.payload.stepId,
              intentSequence: intent!.sequence,
              eventId: record.eventId,
              signature: record.signature,
              settlement,
              effectBoundary: "crossed",
              recordedAt: resolution.reviewedAt,
            };
          }
          if (planned === undefined) continue;
          const intentKey = `${planned.runId}\u0000${planned.stepId}\u0000${planned.intentSequence}`;
          const prior = settlementByIntent.get(intentKey);
          if (prior !== undefined) {
            if (
              prior.eventId === planned.eventId &&
              prior.signature === planned.signature
            ) {
              continue;
            }
            throw new Error(
              `run ${planned.runId} canonical effect admission recovery found multiple settlement events for step ${planned.stepId}`,
            );
          }
          settlementByIntent.set(intentKey, planned);
          plannedSettlements.push(planned);
        }
      },
    );
  }

  // Validate every canonical decision against the same pre-recovery snapshot.
  // No reservation may be changed until cardinality and identity checks for the
  // complete bounded scan have succeeded.
  for (const planned of plannedSettlements) {
    const before = admissions.getReservation(planned.settlement.reservationId);
    if (before === undefined) {
      throw new Error(
        `run ${planned.runId} effect settlement names unknown reservation ${planned.settlement.reservationId}`,
      );
    }
    assertSettlementReservationIdentity(
      planned.runId,
      planned.stepId,
      before,
      planned.settlement,
      planned.effectBoundary,
    );
  }

  let settlementsApplied = 0;
  let settlementsAlreadyApplied = 0;
  driver.transactionImmediate(() => {
    const providerOverrunCascades = new Map<string, string>();
    for (const planned of plannedSettlements) {
      const before = admissions.getReservation(
        planned.settlement.reservationId,
      );
      if (before === undefined) {
        throw new Error(
          `run ${planned.runId} effect settlement lost reservation ${planned.settlement.reservationId}`,
        );
      }
      assertSettlementReservationIdentity(
        planned.runId,
        planned.stepId,
        before,
        planned.settlement,
        planned.effectBoundary,
      );
      const wasFinal =
        before.status !== "reserved" &&
        before.status !== "dispatched" &&
        before.status !== "held_unknown";
      applyRecoveredEffectSettlement(
        admissions,
        before,
        planned.settlement,
        planned.recordedAt,
      );
      const after = admissions.getReservation(planned.settlement.reservationId);
      if (after === undefined) {
        throw new Error(
          `run ${planned.runId} effect settlement lost reservation ${planned.settlement.reservationId}`,
        );
      }
      assertRecoveredSettlement(after, planned.settlement);
      if (
        planned.settlement.decision === "reconcile" &&
        expectedRecoveredReconcileStatus(before, planned.settlement) ===
          "provider_overrun"
      ) {
        if (!providerOverrunCascades.has(planned.runId)) {
          providerOverrunCascades.set(planned.runId, planned.recordedAt);
        }
      }
      if (wasFinal || sameRecoveredSettlement(before, planned.settlement)) {
        settlementsAlreadyApplied += 1;
      } else {
        settlementsApplied += 1;
      }
    }
    // Every exact canonical settlement is final before any overrun cascade can
    // void/hold the remaining active subtree. This preserves the journal order
    // without letting an earlier overrun erase a later fsync-committed result.
    for (const [runId, cancelledAt] of providerOverrunCascades) {
      cancelRunTreeAndAdmission(driver, admissions, {
        runId,
        reason: "provider_overrun",
        cancelledAt,
      });
    }
    for (const planned of plannedSettlements) {
      const afterCascade = admissions.getReservation(
        planned.settlement.reservationId,
      );
      if (afterCascade === undefined) {
        throw new Error(
          `run ${planned.runId} effect settlement lost reservation ${planned.settlement.reservationId}`,
        );
      }
      assertRecoveredSettlement(afterCascade, planned.settlement);
    }
  });
  return {
    runsScanned: runs.length,
    effectResultsScanned,
    settlementsApplied,
    settlementsAlreadyApplied,
  };
}

/**
 * Converge SQLite-committed admission decisions into the canonical rollout.
 *
 * SQLite remains the admission/budget authority. This is a bounded recovery
 * projection of those exact rows, carrying their existing event IDs and
 * payloads into the run's per-run sequence namespace. Every retained source
 * is leased with the same SessionLock used by live writers. Conflicts, a live
 * writer, missing source bytes, an exhausted bound, or a sealed terminal tail
 * all refuse startup instead of exposing silently incomplete replay.
 */
export function recoverExecutionAdmissionCanonicalJournals(
  driver: StateSqliteDriver,
  admissions: ExecutionAdmissionRepository,
  options: {
    readonly maxRuns?: number;
    readonly maxEventsPerRun?: number;
    readonly maxSourcesPerRun?: number;
  } = {},
): ExecutionAdmissionCanonicalRecoveryResult {
  const maxRuns = positiveBound(options.maxRuns ?? DEFAULT_MAX_RUNS, "maxRuns");
  const maxEvents = positiveBound(
    options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN,
    "maxEventsPerRun",
  );
  const maxSources = positiveBound(
    options.maxSourcesPerRun ?? DEFAULT_MAX_SOURCES_PER_RUN,
    "maxSourcesPerRun",
  );
  const unboundCanonicalRun = driver
    .prepareState<[], AdmissionRunRow>(
      `SELECT DISTINCT admission.run_id
       FROM execution_admission_journal AS admission
       JOIN run_lifecycle_epochs AS lifecycle
         ON lifecycle.run_id = admission.run_id
       WHERE NOT EXISTS (
         SELECT 1 FROM run_journal_bindings AS binding
         WHERE binding.run_id = admission.run_id
       )
       AND ${recoveryRunIsExecutableSql("admission.run_id")}
       ORDER BY admission.run_id ASC
       LIMIT 1`,
    )
    .get();
  if (unboundCanonicalRun !== undefined) {
    throw new Error(
      `run ${unboundCanonicalRun.run_id} has committed admission evidence and a canonical lifecycle but no journal binding`,
    );
  }
  const runs = driver
    .prepareState<[number], AdmissionRunRow>(
      `SELECT DISTINCT admission.run_id
       FROM execution_admission_journal AS admission
       JOIN run_journal_bindings AS binding
         ON binding.run_id = admission.run_id
       WHERE ${recoveryRunIsExecutableSql("admission.run_id")}
       ORDER BY admission.run_id ASC
       LIMIT ?`,
    )
    .all(maxRuns + 1);
  if (runs.length > maxRuns) {
    throw new Error(
      `canonical admission recovery exceeds the bounded run limit (${maxRuns})`,
    );
  }

  const durability = new StateRunDurabilityRepository(driver);
  const threads = new StateThreadRepository(driver);
  let sourcesScanned = 0;
  let admissionEventsScanned = 0;
  let admissionEventsAppended = 0;
  for (const row of runs) {
    const bindings = retainedBindings(
      durability.listJournalBindings(row.run_id),
      driver.projectDir,
    );
    if (bindings.length === 0) continue;
    if (bindings.length > maxSources) {
      throw new Error(
        `run ${row.run_id} canonical admission recovery exceeds the bounded source limit (${maxSources})`,
      );
    }
    const journal = readAdmissionJournal(admissions, row.run_id, maxEvents);
    admissionEventsScanned += journal.length;
    const result = convergeRun({
      runId: row.run_id,
      driver,
      bindings,
      journal,
      durability,
      threads,
    });
    sourcesScanned += bindings.length;
    admissionEventsAppended += result.appended;
  }
  return {
    runsScanned: runs.length,
    sourcesScanned,
    admissionEventsScanned,
    admissionEventsAppended,
  };
}

function assertEffectSettlementTopology(params: {
  readonly runId: string;
  readonly stepId: string;
  readonly settlementRecord: CanonicalEventRecord;
  readonly expected: "result" | "review";
  readonly effectResults: readonly CanonicalEventRecord[];
  readonly unknownOutcomes: readonly CanonicalEventRecord[];
  readonly effectReviews: readonly CanonicalEventRecord[];
}): void {
  const settlementReviews = params.effectReviews.filter((record) => {
    const message = record.event.msg;
    return (
      message.type === "effect_review_resolved" &&
      "admissionSettlement" in message.payload &&
      message.payload.admissionSettlement !== undefined
    );
  });
  const expectedRecords =
    params.expected === "result" ? params.effectResults : settlementReviews;
  const exactExpectedRecord =
    expectedRecords.length === 1 &&
    expectedRecords[0]!.eventId === params.settlementRecord.eventId &&
    expectedRecords[0]!.signature === params.settlementRecord.signature;
  const validShape =
    params.expected === "result"
      ? exactExpectedRecord &&
        params.unknownOutcomes.length === 0 &&
        params.effectReviews.length === 0
      : exactExpectedRecord &&
        params.effectResults.length === 0 &&
        params.unknownOutcomes.length === 1 &&
        validEffectReviewChain(params);
  if (!validShape) {
    throw new Error(
      `run ${params.runId} effect settlement for step ${params.stepId} has conflicting canonical effect evidence`,
    );
  }
}

function validEffectReviewChain(params: {
  readonly runId: string;
  readonly stepId: string;
  readonly settlementRecord: CanonicalEventRecord;
  readonly unknownOutcomes: readonly CanonicalEventRecord[];
  readonly effectReviews: readonly CanonicalEventRecord[];
}): boolean {
  const unknown = params.unknownOutcomes[0]?.event;
  const settlementSequence = params.settlementRecord.event.seq;
  if (
    unknown?.msg.type !== "effect_unknown_outcome" ||
    !Number.isSafeInteger(unknown.seq) ||
    !Number.isSafeInteger(settlementSequence)
  ) {
    return false;
  }
  const callId = unknown.msg.payload.callId;
  let terminalSequence: number | undefined;
  let lastReviewSequence = 0;
  for (const record of params.effectReviews) {
    const review = record.event;
    const resolution =
      review.msg.type === "effect_review_resolved" &&
      typeof review.msg.payload.resolution !== "string"
        ? canonicalizeEffectReviewResolution(review.msg.payload.resolution)
        : undefined;
    if (
      review.msg.type !== "effect_review_resolved" ||
      resolution === undefined ||
      review.msg.payload.runId !== params.runId ||
      review.msg.payload.stepId !== params.stepId ||
      !Number.isSafeInteger(review.seq) ||
      review.seq! <= unknown.seq! ||
      review.msg.payload.callId !== callId ||
      (record.eventId !== params.settlementRecord.eventId &&
        (review.seq! <= settlementSequence! ||
          resolution.actorKind !== "operator"))
    ) {
      return false;
    }
    lastReviewSequence = Math.max(lastReviewSequence, review.seq!);
    if (resolution.workflowStatus !== "pending") {
      if (terminalSequence !== undefined) return false;
      terminalSequence = review.seq!;
    }
  }
  return (
    terminalSequence === undefined || terminalSequence === lastReviewSequence
  );
}

function assertEffectSettlementEvidence(params: {
  readonly runId: string;
  readonly event: Event;
  readonly intent: EffectIntentEvidence | undefined;
  readonly settlement: EffectAdmissionSettlement;
}): void {
  if (params.event.msg.type !== "effect_result") {
    throw new Error("effect admission recovery received a non-result event");
  }
  const payload = params.event.msg.payload;
  const sequence = params.event.seq;
  const intent = params.intent;
  if (
    !hasCurrentEffectEvidenceHeader(payload) ||
    payload.effectBoundary === undefined ||
    payload.runId !== params.runId ||
    intent === undefined ||
    !hasCurrentEffectEvidenceHeader(intent) ||
    payload.intentEventSeq !== intent.sequence ||
    !Number.isSafeInteger(sequence) ||
    sequence! <= intent.sequence ||
    payload.callId !== intent.callId ||
    payload.toolName !== intent.toolName ||
    payload.recoveryCategory !== intent.recoveryCategory ||
    payload.idempotencyKey !== intent.idempotencyKey
  ) {
    throw new Error(
      `run ${params.runId} effect settlement for step ${payload.stepId} has no exact canonical intent`,
    );
  }
  assertEffectSettlementDecision(
    params.runId,
    payload.stepId,
    params.settlement,
  );
}

function assertEffectReviewSettlementEvidence(params: {
  readonly runId: string;
  readonly event: Event;
  readonly intent: EffectIntentEvidence | undefined;
  readonly unknownOutcomes: readonly CanonicalEventRecord[];
  readonly settlement: EffectAdmissionSettlement;
}): EffectReviewResolution {
  if (params.event.msg.type !== "effect_review_resolved") {
    throw new Error("effect admission recovery received a non-review event");
  }
  const payload = params.event.msg.payload;
  const resolution =
    typeof payload.resolution === "string"
      ? undefined
      : canonicalizeEffectReviewResolution(payload.resolution);
  const reviewSequence = params.event.seq;
  const intent = params.intent;
  if (
    resolution === undefined ||
    resolution.actorKind !== "system_settlement" ||
    payload.runId !== params.runId ||
    intent === undefined ||
    !hasCurrentEffectEvidenceHeader(intent) ||
    payload.callId !== intent.callId ||
    !Number.isSafeInteger(reviewSequence) ||
    reviewSequence! <= intent.sequence ||
    params.unknownOutcomes.length !== 1
  ) {
    throw new Error(
      `run ${params.runId} effect review settlement for step ${payload.stepId} has no exact canonical unknown outcome`,
    );
  }
  const unknownEvent = params.unknownOutcomes[0]!.event;
  if (unknownEvent.msg.type !== "effect_unknown_outcome") {
    throw new Error(
      `run ${params.runId} effect review settlement for step ${payload.stepId} has invalid unknown evidence`,
    );
  }
  const unknown = unknownEvent.msg.payload;
  const unknownSequence = unknownEvent.seq;
  if (
    !hasCurrentEffectEvidenceHeader(unknown) ||
    unknown.runId !== params.runId ||
    unknown.stepId !== payload.stepId ||
    unknown.callId !== payload.callId ||
    unknown.toolName !== intent.toolName ||
    unknown.recoveryCategory !== intent.recoveryCategory ||
    unknown.idempotencyKey !== intent.idempotencyKey ||
    unknown.intentEventSeq !== intent.sequence ||
    (unknown.callerStop !== "timeout" && unknown.callerStop !== "abort") ||
    typeof unknown.callerStoppedAt !== "string" ||
    unknown.reservationId !== params.settlement.reservationId ||
    !Number.isSafeInteger(unknownSequence) ||
    unknownSequence! <= intent.sequence ||
    unknownSequence! >= reviewSequence!
  ) {
    throw new Error(
      `run ${params.runId} effect review settlement for step ${payload.stepId} has no exact canonical unknown outcome`,
    );
  }
  const isResolvedDisposition =
    resolution.workflowStatus === "resolved" &&
    (resolution.disposition === "confirmed_committed" ||
      resolution.disposition === "confirmed_no_effect");
  if (
    (!isResolvedDisposition && params.settlement.decision !== "hold_unknown") ||
    (resolution.workflowStatus === "resolved" && !isResolvedDisposition)
  ) {
    throw new Error(
      `run ${params.runId} effect review settlement for step ${payload.stepId} conflicts with review resolution`,
    );
  }
  assertEffectSettlementDecision(
    params.runId,
    payload.stepId,
    params.settlement,
  );
  return resolution;
}

function hasCurrentEffectEvidenceHeader(payload: {
  readonly formatVersion?: 2;
  readonly minimumReaderRuntime?: string;
}): boolean {
  return (
    payload.formatVersion === EFFECT_EVIDENCE_FORMAT_VERSION &&
    payload.minimumReaderRuntime === EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME
  );
}

function assertEffectSettlementDecision(
  runId: string,
  stepId: string,
  settlement: EffectAdmissionSettlement,
): void {
  if (
    typeof settlement.reservationId !== "string" ||
    settlement.reservationId.trim().length === 0
  ) {
    throw new Error(
      `run ${runId} effect settlement for step ${stepId} has no reservation identity`,
    );
  }
  if (settlement.decision === "reconcile") {
    const usage = settlement.usage;
    if (
      !Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      !Number.isSafeInteger(usage.inputTokens + usage.outputTokens) ||
      !Number.isFinite(usage.costUsd) ||
      usage.costUsd < 0
    ) {
      throw new Error(
        `run ${runId} effect settlement for step ${stepId} has invalid usage`,
      );
    }
    usdToNanos(usage.costUsd);
  } else if (
    (settlement.decision !== "void" &&
      settlement.decision !== "hold_unknown") ||
    typeof settlement.reason !== "string" ||
    settlement.reason.trim().length === 0
  ) {
    throw new Error(
      `run ${runId} effect settlement for step ${stepId} has an invalid decision`,
    );
  }
}

function assertSettlementReservationIdentity(
  runId: string,
  stepId: string,
  reservation: PersistedAdmissionReservation,
  settlement: EffectAdmissionSettlement,
  effectBoundary: EffectBoundary | undefined,
): void {
  if (
    reservation.reservationId !== settlement.reservationId ||
    reservation.reservation.step.runId !== runId ||
    reservation.reservation.step.stepId !== stepId
  ) {
    throw new Error(
      `run ${runId} effect settlement reservation ${settlement.reservationId} does not match step ${stepId}`,
    );
  }
  if (reservation.kind !== "tool_exec") {
    throw new Error(
      `run ${runId} effect settlement reservation ${settlement.reservationId} is not a tool call`,
    );
  }
  if (effectBoundary === undefined) {
    throw new Error(
      `run ${runId} effect settlement for step ${stepId} has no effect boundary`,
    );
  }
  if (settlement.decision === "void" && effectBoundary !== "not_crossed") {
    throw new Error(
      `run ${runId} crossed effect settlement for step ${stepId} cannot be voided`,
    );
  }
  if (effectBoundary === "not_crossed" && settlement.decision !== "void") {
    throw new Error(
      `run ${runId} pre-effect settlement for step ${stepId} must be voided`,
    );
  }
  const canApplyFromCurrentState =
    effectBoundary === "crossed"
      ? reservation.status === "dispatched" ||
        reservation.status === "held_unknown"
      : reservation.status === "reserved";
  if (
    !canApplyFromCurrentState &&
    !sameRecoveredSettlement(reservation, settlement)
  ) {
    throw new Error(
      `run ${runId} effect settlement boundary ${effectBoundary} conflicts with reservation ${settlement.reservationId} status ${reservation.status}`,
    );
  }
}

function applyRecoveredEffectSettlement(
  admissions: ExecutionAdmissionRepository,
  reservation: PersistedAdmissionReservation,
  settlement: EffectAdmissionSettlement,
  recordedAt: string,
): void {
  const alreadyExact = sameRecoveredSettlement(reservation, settlement);
  if (alreadyExact && settlement.decision !== "reconcile") return;
  if (settlement.decision === "void") {
    if (reservation.status !== "reserved") {
      throw new Error(
        `effect settlement cannot void ${reservation.reservationId} from ${reservation.status}`,
      );
    }
    admissions.void(settlement.reservationId, settlement.reason, {
      at: recordedAt,
    });
    return;
  }
  if (settlement.decision === "hold_unknown") {
    if (
      reservation.status !== "reserved" &&
      reservation.status !== "dispatched"
    ) {
      throw new Error(
        `effect settlement cannot hold ${reservation.reservationId} from ${reservation.status}`,
      );
    }
    admissions.holdUnknown(settlement.reservationId, settlement.reason, {
      at: recordedAt,
    });
    return;
  }
  if (
    reservation.status !== "reserved" &&
    reservation.status !== "dispatched" &&
    reservation.status !== "held_unknown" &&
    !alreadyExact
  ) {
    throw new Error(
      `effect settlement cannot reconcile ${reservation.reservationId} from ${reservation.status}`,
    );
  }
  admissions.reconcileBeforeDeferredProviderOverrunCancellation(
    settlement.reservationId,
    { kind: "reported", usage: settlement.usage },
    { at: recordedAt },
  );
}

function assertRecoveredSettlement(
  reservation: PersistedAdmissionReservation,
  settlement: EffectAdmissionSettlement,
): void {
  if (!sameRecoveredSettlement(reservation, settlement)) {
    throw new Error(
      `reservation ${reservation.reservationId} conflicts with its canonical effect settlement`,
    );
  }
}

function sameRecoveredSettlement(
  reservation: PersistedAdmissionReservation,
  settlement: EffectAdmissionSettlement,
): boolean {
  if (settlement.decision === "void") {
    // Cancellation and legacy stale-owner recovery may win the race after the
    // canonical decision was fsynced.  The reason is diagnostic; `voided`
    // always carries the same zero charge and cannot be upgraded later.
    return reservation.status === "voided";
  }
  if (settlement.decision === "hold_unknown") {
    // Any held-unknown resolution retains the full reservation. Preserve the
    // first writer's diagnostic reason while treating the accounting state as
    // equivalent. A later exact usage settlement remains allowed separately.
    return reservation.status === "held_unknown";
  }
  const normalizedCost = nanosToUsd(usdToNanos(settlement.usage.costUsd));
  const actualTokens = checkedRecoveredTokenTotal(settlement.usage);
  const expectedStatus = expectedRecoveredReconcileStatus(
    reservation,
    settlement,
  );
  return (
    reservation.status === expectedStatus &&
    reservation.actualInputTokens === settlement.usage.inputTokens &&
    reservation.actualOutputTokens === settlement.usage.outputTokens &&
    reservation.actualTokens === actualTokens &&
    reservation.actualCostUsd === normalizedCost
  );
}

function expectedRecoveredReconcileStatus(
  reservation: PersistedAdmissionReservation,
  settlement: Extract<EffectAdmissionSettlement, { decision: "reconcile" }>,
): "reconciled" | "provider_overrun" {
  const actualTokens = checkedRecoveredTokenTotal(settlement.usage);
  return actualTokens > reservation.reservation.reservedTokens ||
    usdToNanos(settlement.usage.costUsd) >
      usdToNanos(reservation.reservation.reservedCostUsd)
    ? "provider_overrun"
    : "reconciled";
}

function checkedRecoveredTokenTotal(
  usage: Extract<EffectAdmissionSettlement, { decision: "reconcile" }>["usage"],
): number {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  ) {
    throw new RangeError("effect settlement token usage is out of range");
  }
  const total = usage.inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("effect settlement token total is out of range");
  }
  return total;
}

function convergeRun(params: {
  readonly runId: string;
  readonly driver: StateSqliteDriver;
  readonly bindings: readonly RunJournalBinding[];
  readonly journal: readonly AdmissionJournalEvent[];
  readonly durability: StateRunDurabilityRepository;
  readonly threads: StateThreadRepository;
}): { readonly appended: number } {
  const bindings = uniqueSourceBindings(params.bindings);
  return withPinnedBindings(
    params.driver.projectDir,
    bindings,
    new Map(),
    (leases) => {
      const canonical = bindings.flatMap((binding) =>
        readCanonicalEvents(
          leases.get(binding.sourcePath)!.readUtf8(),
          binding.sourcePath,
        ),
      );
      const index = validateCanonicalEvents(canonical, params.runId);
      const missing: AdmissionJournalEvent[] = [];
      for (const event of params.journal) {
        const envelopeMatches = index.byEventId.get(event.eventId) ?? [];
        const payloadMatches =
          index.byAdmissionEventId.get(event.eventId) ?? [];
        const matches = [...new Set([...envelopeMatches, ...payloadMatches])];
        if (matches.length === 0) {
          missing.push(event);
          continue;
        }
        for (const match of matches) assertAdmissionMatch(match.event, event);
      }

      const target = selectTargetBinding(params.bindings);
      const targetRecords = canonical.filter(
        (record) => record.sourcePath === target.sourcePath,
      );
      const targetHasLegacyEvents = targetRecords.some(
        (record) => record.sequence === undefined,
      );
      const targetHasSequencedEvents = targetRecords.some(
        (record) => record.sequence !== undefined,
      );
      if (targetHasLegacyEvents && targetHasSequencedEvents) {
        throw new Error(
          `run ${params.runId} canonical admission recovery found mixed legacy and sequenced event lanes`,
        );
      }
      if (
        missing.length > 0 &&
        canonicalTailIsTerminal(index.ordered, params.runId)
      ) {
        throw new Error(
          `run ${params.runId} canonical admission recovery refused: terminal tail precedes ${missing.length} committed admission event(s)`,
        );
      }
      let lastSequence = index.lastSequence;
      const appended = missing.map((payload): CanonicalEventRecord => {
        // A legacy source cannot acquire a sequenced suffix. Until E1a can
        // upgrade the whole source under its writer lease, recovery appends a
        // legacy envelope whose payload still carries the durable admission
        // identity. A new/empty or sequenced source uses canonical sequence.
        const event: Event = targetHasLegacyEvents
          ? {
              id: payload.eventId,
              msg: { type: "execution_admission", payload },
            }
          : {
              eventId: payload.eventId,
              id: payload.eventId,
              seq: (lastSequence += 1),
              msg: { type: "execution_admission", payload },
            };
        const sequence = canonicalSequence(event);
        return {
          event,
          eventId: canonicalEventId(event, sequence),
          sequence,
          signature: stableStringify(event),
          sourcePath: target.sourcePath,
        };
      });
      if (appended.length > 0) {
        leases
          .get(target.sourcePath)!
          .appendAndSync(
            appended
              .map(({ event }) =>
                serializeRolloutItem({ type: "event_msg", payload: event }),
              )
              .join(""),
          );
      } else {
        // Existing identical evidence may have survived an ambiguous fsync.
        leases.get(target.sourcePath)!.sync();
      }

      const targetEvents = readCanonicalEvents(
        leases.get(target.sourcePath)!.readUtf8(),
        target.sourcePath,
      );
      const targetSequences = targetEvents.flatMap((record) =>
        record.sequence === undefined ? [] : [record.sequence],
      );
      params.driver.transactionImmediate(() => {
        for (const binding of bindings) {
          const lease = leases.get(binding.sourcePath)!;
          const raw = lease.readUtf8();
          const source = lease.stat();
          if (source.size !== Buffer.byteLength(raw)) {
            throw new Error(
              `canonical admission source ${binding.sourcePath} changed while preparing its projection`,
            );
          }
          backfillPinnedRolloutContent({
            rolloutPath: binding.sourcePath,
            raw,
            archived: binding.sourcePath.includes("/archived_sessions/"),
            threads: params.threads,
            mtimeMs: source.mtimeMs,
            validateCanonical: () => lease.sync(),
          });
        }
        if (targetSequences.length > 0) {
          params.durability.updateJournalBounds({
            sourcePath: target.sourcePath,
            firstAvailableSequence: Math.min(...targetSequences),
            lastSequence: Math.max(...targetSequences),
            updatedAt: new Date().toISOString(),
          });
        }
      });
      return { appended: appended.length };
    },
  );
}

function uniqueSourceBindings(
  bindings: readonly RunJournalBinding[],
): readonly RunJournalBinding[] {
  const byPath = new Map<string, RunJournalBinding>();
  for (const binding of bindings) {
    const existing = byPath.get(binding.sourcePath);
    if (existing !== undefined && existing.sessionId !== binding.sessionId) {
      throw new Error(
        `canonical admission source ${binding.sourcePath} has conflicting session bindings`,
      );
    }
    byPath.set(binding.sourcePath, binding);
  }
  return [...byPath.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
}

function withPinnedBindings<T>(
  projectDir: string,
  bindings: readonly RunJournalBinding[],
  leases: Map<string, PinnedOfflineRollout>,
  operation: (leases: ReadonlyMap<string, PinnedOfflineRollout>) => T,
  index = 0,
): T {
  const binding = bindings[index];
  if (binding === undefined) return operation(leases);
  return withPinnedOfflineRolloutLease(
    {
      projectDir,
      sessionId: binding.sessionId,
      sourcePath: binding.sourcePath,
    },
    (lease) => {
      leases.set(binding.sourcePath, lease);
      try {
        return withPinnedBindings(
          projectDir,
          bindings,
          leases,
          operation,
          index + 1,
        );
      } finally {
        leases.delete(binding.sourcePath);
      }
    },
  );
}

function retainedBindings(
  bindings: readonly RunJournalBinding[],
  projectDir: string,
): readonly RunJournalBinding[] {
  return bindings.filter(
    (binding) =>
      isBindingInsideProject(binding, projectDir) &&
      !(
        !binding.active &&
        binding.gapReason !== undefined &&
        binding.retiredThroughSequence !== undefined &&
        binding.firstAvailableSequence === undefined
      ),
  );
}

/**
 * A binding may name a rollout in ANOTHER project: resuming one conversation
 * from a second cwd rebinds it there and leaves this project pointing at a
 * foreign path. Pinning it raises OfflineRolloutUnsafePathError, which is the
 * correct containment answer, but it aborts recovery for the whole workspace —
 * observed as every message failing with "unsafe offline canonical rollout …
 * path is outside this project's sessions/archived_sessions roots".
 *
 * The foreign rollout is not ours to read under any circumstance, so there is
 * nothing to recover from it and dropping the binding loses nothing this
 * project owns. The guard in `pinOfflineRollout` stays as the backstop.
 */
function isBindingInsideProject(
  binding: RunJournalBinding,
  projectDir: string,
): boolean {
  const root = resolve(projectDir);
  const source = resolve(binding.sourcePath);
  return (
    source.startsWith(join(root, "sessions") + sep) ||
    source.startsWith(join(root, "archived_sessions") + sep)
  );
}

function selectTargetBinding(
  bindings: readonly RunJournalBinding[],
): RunJournalBinding {
  const sorted = [...bindings].sort(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      right.epoch - left.epoch ||
      right.boundAt.localeCompare(left.boundAt) ||
      right.sourcePath.localeCompare(left.sourcePath),
  );
  return sorted[0]!;
}

function readAdmissionJournal(
  admissions: ExecutionAdmissionRepository,
  runId: string,
  maxEvents: number,
): readonly AdmissionJournalEvent[] {
  const result: AdmissionJournalEvent[] = [];
  let afterSequence = 0;
  while (true) {
    const page = admissions.listJournal({
      runId,
      afterSequence,
      limit: JOURNAL_PAGE_SIZE,
    });
    if (page.length === 0) return result;
    for (const event of page) {
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= afterSequence
      ) {
        throw new Error(
          `run ${runId} admission recovery made no monotonic progress after sequence ${afterSequence}`,
        );
      }
      if (result.length >= maxEvents) {
        throw new Error(
          `run ${runId} canonical admission recovery exceeds the bounded event limit (${maxEvents})`,
        );
      }
      result.push(event);
      afterSequence = event.sequence;
    }
    if (page.length < JOURNAL_PAGE_SIZE) return result;
  }
}

function readCanonicalEvents(
  raw: string,
  sourcePath: string,
): CanonicalEventRecord[] {
  const result: CanonicalEventRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const item = parseRolloutLine(line);
    if (item?.type !== "event_msg") continue;
    const event = item.payload;
    const sequence = canonicalSequence(event);
    const eventId = canonicalEventId(event, sequence);
    result.push({
      event,
      eventId,
      sequence,
      signature: stableStringify(event),
      sourcePath,
    });
  }
  return result;
}

function validateCanonicalEvents(
  records: readonly CanonicalEventRecord[],
  runId: string,
): {
  readonly byEventId: ReadonlyMap<string, readonly CanonicalEventRecord[]>;
  readonly byAdmissionEventId: ReadonlyMap<
    string,
    readonly CanonicalEventRecord[]
  >;
  readonly ordered: readonly CanonicalEventRecord[];
  readonly lastSequence: number;
} {
  const byEventId = new Map<string, CanonicalEventRecord[]>();
  const byAdmissionEventId = new Map<string, CanonicalEventRecord[]>();
  const bySequence = new Map<number, CanonicalEventRecord>();
  let lastSequence = 0;
  for (const record of records) {
    if (
      record.sequence === undefined &&
      canonicalEffectSettlement(record.event) !== undefined
    ) {
      throw new Error(
        `run ${runId} canonical effect settlement ${record.eventId} has no sequence`,
      );
    }
    let effective = record;
    const identities = byEventId.get(record.eventId) ?? [];
    if (
      identities.some(
        (prior) =>
          prior.sequence !== record.sequence ||
          prior.signature !== record.signature,
      )
    ) {
      if (!record.eventId.startsWith("legacy-unsequenced:")) {
        throw new Error(
          `run ${runId} canonical admission recovery found conflicting event ID ${record.eventId}`,
        );
      }
      // Legacy rollouts predate durable event identities — their `id` field
      // was never unique (synthetic ids like "system" recur across distinct
      // events). Two DIFFERENT events sharing such an id is the legacy
      // format, not corruption, so disambiguate instead of aborting the
      // entire daemon startup. Identical copies (same id + same signature)
      // still dedupe through the normal path above.
      effective = {
        ...record,
        eventId: `${record.eventId}~conflict-${identities.length}`,
      };
    }
    const effectiveIdentities = byEventId.get(effective.eventId) ?? [];
    effectiveIdentities.push(effective);
    byEventId.set(effective.eventId, effectiveIdentities);
    if (effective.sequence !== undefined) {
      const prior = bySequence.get(effective.sequence);
      if (
        prior !== undefined &&
        (prior.eventId !== effective.eventId ||
          prior.signature !== effective.signature)
      ) {
        throw new Error(
          `run ${runId} canonical admission recovery found sequence ${effective.sequence} claimed by both ${prior.eventId} and ${effective.eventId}`,
        );
      }
      bySequence.set(effective.sequence, effective);
      lastSequence = Math.max(lastSequence, effective.sequence);
    }
    if (effective.event.msg.type === "execution_admission") {
      const admissionId = effective.event.msg.payload.eventId;
      const admissionMatches = byAdmissionEventId.get(admissionId) ?? [];
      admissionMatches.push(effective);
      byAdmissionEventId.set(admissionId, admissionMatches);
    }
  }
  return {
    byEventId,
    byAdmissionEventId,
    ordered: [...bySequence.values()].sort(
      (left, right) => left.sequence! - right.sequence!,
    ),
    lastSequence,
  };
}

function canonicalEffectSettlement(
  event: Event,
): EffectAdmissionSettlement | undefined {
  if (event.msg.type === "effect_result") {
    return event.msg.payload.formatVersion === 2
      ? event.msg.payload.admissionSettlement
      : undefined;
  }
  if (event.msg.type === "effect_review_resolved") {
    return "admissionSettlement" in event.msg.payload
      ? event.msg.payload.admissionSettlement
      : undefined;
  }
  return undefined;
}

function assertAdmissionMatch(
  canonical: Event,
  admission: AdmissionJournalEvent,
): void {
  const envelopeIdentityMatches =
    canonical.eventId === admission.eventId ||
    (canonical.eventId === undefined && canonical.seq === undefined);
  if (
    !envelopeIdentityMatches ||
    canonical.id !== admission.eventId ||
    canonical.msg.type !== "execution_admission" ||
    stableStringify(canonical.msg.payload) !== stableStringify(admission)
  ) {
    throw new Error(
      `execution admission event ${admission.eventId} has conflicting canonical evidence`,
    );
  }
}

function canonicalTailIsTerminal(
  ordered: readonly CanonicalEventRecord[],
  runId: string,
): boolean {
  let sealed = false;
  for (const record of ordered) {
    if (
      record.event.msg.type === "run_terminal" &&
      record.event.msg.payload.runId === runId
    ) {
      sealed = true;
    } else if (
      record.event.msg.type === "run_reopened" &&
      record.event.msg.payload.runId === runId
    ) {
      sealed = false;
    }
  }
  return sealed;
}

function canonicalSequence(event: Event): number | undefined {
  if (event.seq === undefined) return undefined;
  if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
    throw new Error(
      `canonical admission recovery found invalid sequence ${String(event.seq)}`,
    );
  }
  return event.seq;
}

function canonicalEventId(event: Event, sequence: number | undefined): string {
  if (event.eventId !== undefined) {
    if (typeof event.eventId !== "string" || event.eventId.length === 0) {
      throw new Error("canonical admission recovery found invalid eventId");
    }
    return event.eventId;
  }
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new Error(
      "canonical admission recovery found event without identity",
    );
  }
  return sequence === undefined
    ? `legacy-unsequenced:${event.id}`
    : `legacy-event:${sequence}:${event.id}`;
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
