import type {
  EffectOutcome,
  RunId,
  RunTerminalResult,
  RunUsageTotals,
} from "../contracts/run-contracts.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { stableStringify } from "../utils/stableStringify.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export type RunDurabilityConflictCode =
  | "RUN_EPOCH_CONFLICT"
  | "RUN_EPOCH_NOT_TERMINAL"
  | "RUN_REOPEN_REVIEW_REQUIRED"
  | "RUN_TERMINAL_RESULT_CONFLICT"
  | "RUN_EFFECT_INTENT_CONFLICT"
  | "RUN_EFFECT_OUTCOME_CONFLICT"
  | "RUN_EFFECT_NOT_FOUND"
  | "RUN_EFFECT_REVIEW_CONFLICT"
  | "RUN_EFFECT_REVIEW_REQUIRED"
  | "RUN_EVENT_SEQUENCE_CONFLICT"
  | "RUN_JOURNAL_BINDING_CONFLICT";

export class RunDurabilityConflictError extends Error {
  constructor(
    readonly code: RunDurabilityConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "RunDurabilityConflictError";
  }
}

export interface DurableWriteOutcome<T> {
  readonly applied: boolean;
  readonly value: T;
}

export interface RunLifecycleEpoch {
  readonly runId: RunId;
  readonly epoch: number;
  readonly openedAt: string;
  readonly openedEventId?: string;
  readonly reopenedFromEpoch?: number;
  readonly reopenReason?: string;
}

export interface DurableRunTerminalRecord extends RunTerminalResult {
  readonly epoch: number;
  readonly eventId: string;
}

export type EffectReviewStatus = "none" | "pending" | "resolved";

export interface DurableRunEffect {
  readonly runId: RunId;
  readonly stepId: string;
  readonly epoch: number;
  readonly childRunId?: RunId;
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly idempotencyKey?: string;
  readonly intentDigest: string;
  readonly intentEventId: string;
  readonly intentSequence: number;
  readonly intentAt: string;
  readonly outcome?: EffectOutcome;
  readonly resultEventId?: string;
  readonly resultSequence?: number;
  readonly resultDigest?: string;
  readonly result?: unknown;
  readonly evidence?: unknown;
  readonly unknownReason?: string;
  readonly completedAt?: string;
  readonly reviewStatus: EffectReviewStatus;
  readonly reviewedAt?: string;
  readonly reviewedBy?: string;
  readonly reviewResolution?: string;
  readonly reviewEventId?: string;
  readonly reviewEvidence?: unknown;
}

export type RunJournalGapReason =
  | "retention"
  | "corruption_truncated"
  | "compaction";

export interface RunJournalBinding {
  readonly runId: RunId;
  readonly epoch: number;
  readonly childRunId: RunId;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly active: boolean;
  readonly firstAvailableSequence?: number;
  readonly lastSequence?: number;
  readonly retiredThroughSequence?: number;
  readonly gapReason?: RunJournalGapReason;
  readonly gapObservedAt?: string;
  readonly boundAt: string;
  readonly updatedAt: string;
}

interface EpochRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly opened_at: string;
  readonly opened_event_id: string | null;
  readonly reopened_from_epoch: number | null;
  readonly reopen_reason: string | null;
}

interface TerminalRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly status: RunTerminalResult["status"];
  readonly exit_code: number | null;
  readonly stop_reason: string | null;
  readonly final_message: string | null;
  readonly usage_json: string | null;
  readonly last_sequence: number | null;
  readonly finished_at: string;
  readonly event_id: string;
}

interface EffectRow {
  readonly run_id: string;
  readonly step_id: string;
  readonly epoch: number;
  readonly child_run_id: string | null;
  readonly session_id: string;
  readonly call_id: string;
  readonly tool_name: string;
  readonly recovery_category: ToolRecoveryCategory;
  readonly idempotency_key: string | null;
  readonly intent_digest: string;
  readonly intent_event_id: string;
  readonly intent_sequence: number;
  readonly intent_at: string;
  readonly outcome: EffectOutcome | null;
  readonly result_event_id: string | null;
  readonly result_sequence: number | null;
  readonly result_digest: string | null;
  readonly result_json: string | null;
  readonly evidence_json: string | null;
  readonly unknown_reason: string | null;
  readonly completed_at: string | null;
  readonly review_status: EffectReviewStatus;
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
  readonly review_resolution: string | null;
  readonly review_event_id: string | null;
  readonly review_evidence_json: string | null;
}

interface JournalBindingRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly child_run_id: string;
  readonly session_id: string;
  readonly source_path: string;
  readonly active: number;
  readonly first_available_sequence: number | null;
  readonly last_sequence: number | null;
  readonly retired_through_sequence: number | null;
  readonly gap_reason: RunJournalGapReason | null;
  readonly gap_observed_at: string | null;
  readonly bound_at: string;
  readonly updated_at: string;
}

const EFFECT_COLUMNS = `
  run_id, step_id, epoch, child_run_id, session_id, call_id, tool_name,
  recovery_category, idempotency_key, intent_digest, intent_event_id,
  intent_sequence, intent_at, outcome, result_event_id, result_sequence,
  result_digest, result_json, evidence_json, unknown_reason, completed_at,
  review_status, reviewed_at, reviewed_by, review_resolution, review_event_id,
  review_evidence_json`;

const JOURNAL_BINDING_COLUMNS = `
  run_id, epoch, child_run_id, session_id, source_path, active,
  first_available_sequence, last_sequence, retired_through_sequence,
  gap_reason, gap_observed_at, bound_at, updated_at`;

/**
 * Durable run lifecycle/effect state plus bindings into the canonical rollout
 * JSONL projection. Event payload bytes belong only to the rollout store.
 */
export class StateRunDurabilityRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  ensureInitialEpoch(params: {
    readonly runId: RunId;
    readonly openedAt: string;
    readonly openedEventId?: string;
  }): DurableWriteOutcome<RunLifecycleEpoch> {
    return this.driver.transactionImmediate(() => {
      const existingRow = this.driver
        .prepareState<[string], EpochRow>(
          `SELECT run_id, epoch, opened_at, opened_event_id,
                  reopened_from_epoch, reopen_reason
           FROM run_lifecycle_epochs
           WHERE run_id = ? AND epoch = 1`,
        )
        .get(params.runId);
      const existing =
        existingRow === undefined ? undefined : epochFromRow(existingRow);
      if (existing !== undefined) {
        if (
          existing.epoch === 1 &&
          (params.openedEventId === undefined ||
            existing.openedEventId === params.openedEventId)
        ) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} initial lifecycle event conflicts with its durable epoch`,
        );
      }
      this.driver
        .prepareState<[string, number, string, string | null]>(
          `INSERT INTO run_lifecycle_epochs (
             run_id, epoch, opened_at, opened_event_id
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          1,
          required(params.openedAt, "openedAt"),
          optionalRequired(params.openedEventId, "openedEventId"),
        );
      return {
        applied: true,
        value: {
          runId: params.runId,
          epoch: 1,
          openedAt: params.openedAt,
          ...(params.openedEventId !== undefined
            ? { openedEventId: params.openedEventId }
            : {}),
        },
      };
    });
  }

  currentEpoch(runId: RunId): RunLifecycleEpoch | undefined {
    const row = this.driver
      .prepareState<[string], EpochRow>(
        `SELECT run_id, epoch, opened_at, opened_event_id,
                reopened_from_epoch, reopen_reason
         FROM run_lifecycle_epochs
         WHERE run_id = ?
         ORDER BY epoch DESC
         LIMIT 1`,
      )
      .get(runId);
    return row === undefined ? undefined : epochFromRow(row);
  }

  reopenRun(params: {
    readonly runId: RunId;
    readonly fromEpoch: number;
    readonly openedAt: string;
    readonly eventId: string;
    readonly reason: string;
  }): DurableWriteOutcome<RunLifecycleEpoch> {
    return this.driver.transactionImmediate(() => {
      const replayed = this.driver
        .prepareState<[string, string], EpochRow>(
          `SELECT run_id, epoch, opened_at, opened_event_id,
                  reopened_from_epoch, reopen_reason
           FROM run_lifecycle_epochs
           WHERE run_id = ? AND opened_event_id = ?`,
        )
        .get(params.runId, params.eventId);
      if (replayed !== undefined) {
        const epoch = epochFromRow(replayed);
        if (
          epoch.reopenedFromEpoch === params.fromEpoch &&
          epoch.openedAt === params.openedAt &&
          epoch.reopenReason === params.reason
        ) {
          return { applied: false, value: epoch };
        }
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `reopen event ${params.eventId} conflicts with its durable epoch`,
        );
      }

      const current = this.currentEpoch(params.runId);
      if (current === undefined || current.epoch !== params.fromEpoch) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} current epoch does not match ${params.fromEpoch}`,
        );
      }
      if (this.getTerminalResult(params.runId, params.fromEpoch) === undefined) {
        throw conflict(
          "RUN_EPOCH_NOT_TERMINAL",
          `run ${params.runId} epoch ${params.fromEpoch} is not terminal`,
        );
      }
      const pending = this.listPendingEffectReviews(params.runId);
      if (pending.length > 0) {
        throw conflict(
          "RUN_REOPEN_REVIEW_REQUIRED",
          `run ${params.runId} has ${pending.length} unresolved unknown-outcome effect(s)`,
        );
      }

      const nextEpoch = params.fromEpoch + 1;
      this.driver
        .prepareState<
          [string, number, string, string, number, string]
        >(
          `INSERT INTO run_lifecycle_epochs (
             run_id, epoch, opened_at, opened_event_id,
             reopened_from_epoch, reopen_reason
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          positiveInteger(nextEpoch, "epoch"),
          required(params.openedAt, "openedAt"),
          required(params.eventId, "eventId"),
          params.fromEpoch,
          required(params.reason, "reason"),
        );
      const value: RunLifecycleEpoch = {
        runId: params.runId,
        epoch: nextEpoch,
        openedAt: params.openedAt,
        openedEventId: params.eventId,
        reopenedFromEpoch: params.fromEpoch,
        reopenReason: params.reason,
      };
      return { applied: true, value };
    });
  }

  recordTerminalResult(params: {
    readonly epoch: number;
    readonly result: RunTerminalResult;
    readonly eventId: string;
  }): DurableWriteOutcome<DurableRunTerminalRecord> {
    return this.driver.transactionImmediate(() => {
      const epoch = this.requireEpoch(params.result.runId, params.epoch);
      if (epoch.epoch !== params.epoch) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.result.runId} epoch ${params.epoch} does not exist`,
        );
      }
      const existing = this.getTerminalResult(
        params.result.runId,
        params.epoch,
      );
      if (existing !== undefined) {
        if (
          existing.eventId === params.eventId &&
          terminalContent(existing) === terminalContent(params.result)
        ) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_TERMINAL_RESULT_CONFLICT",
          `run ${params.result.runId} epoch ${params.epoch} already has a different terminal result`,
        );
      }
      this.assertSequenceUnclaimed(
        params.result.runId,
        params.result.lastSequence,
      );
      const usageJson =
        params.result.usage === null
          ? null
          : stableStringify(params.result.usage);
      this.driver
        .prepareState(
          `INSERT INTO run_terminal_results (
             run_id, epoch, status, exit_code, stop_reason, final_message,
             usage_json, last_sequence, finished_at, event_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.result.runId, "runId"),
          positiveInteger(params.epoch, "epoch"),
          params.result.status,
          params.result.exitCode,
          params.result.stopReason,
          params.result.finalMessage,
          usageJson,
          nullablePositiveInteger(params.result.lastSequence, "lastSequence"),
          required(params.result.finishedAt, "finishedAt"),
          required(params.eventId, "eventId"),
        );
      return {
        applied: true,
        value: { ...params.result, epoch: params.epoch, eventId: params.eventId },
      };
    });
  }

  getTerminalResult(
    runId: RunId,
    epoch: number,
  ): DurableRunTerminalRecord | undefined {
    const row = this.driver
      .prepareState<[string, number], TerminalRow>(
        `SELECT run_id, epoch, status, exit_code, stop_reason, final_message,
                usage_json, last_sequence, finished_at, event_id
         FROM run_terminal_results
         WHERE run_id = ? AND epoch = ?`,
      )
      .get(runId, epoch);
    return row === undefined ? undefined : terminalFromRow(row);
  }

  getCurrentTerminalResult(
    runId: RunId,
  ): DurableRunTerminalRecord | undefined {
    const current = this.currentEpoch(runId);
    return current === undefined
      ? undefined
      : this.getTerminalResult(runId, current.epoch);
  }

  listTerminalHistory(runId: RunId): readonly DurableRunTerminalRecord[] {
    return this.driver
      .prepareState<[string], TerminalRow>(
        `SELECT run_id, epoch, status, exit_code, stop_reason, final_message,
                usage_json, last_sequence, finished_at, event_id
         FROM run_terminal_results
         WHERE run_id = ?
         ORDER BY epoch ASC`,
      )
      .all(runId)
      .map(terminalFromRow);
  }

  beginEffect(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly stepId: string;
    readonly childRunId?: RunId;
    readonly sessionId: string;
    readonly callId?: string;
    readonly toolName: string;
    readonly recoveryCategory: ToolRecoveryCategory;
    readonly idempotencyKey?: string;
    readonly intentDigest: string;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly intentAt: string;
    /** Internal rebuild path for already-terminal canonical history. */
    readonly projection?: "canonical_replay";
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.driver.transactionImmediate(() => {
      this.requireEpoch(params.runId, params.epoch);
      const existing = this.getEffect(params.runId, params.stepId);
      if (existing !== undefined) {
        if (effectIntentContent(existing) === effectIntentContent(params)) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EFFECT_INTENT_CONFLICT",
          `run ${params.runId} step ${params.stepId} already has a different effect intent`,
        );
      }
      const terminal = this.getTerminalResult(params.runId, params.epoch);
      if (
        terminal !== undefined &&
        (params.projection !== "canonical_replay" ||
          terminal.lastSequence === null ||
          params.eventSequence >= terminal.lastSequence)
      ) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is already terminal`,
        );
      }
      if (
        params.recoveryCategory === "side-effecting" &&
        params.projection !== "canonical_replay"
      ) {
        this.assertDependentMutationAllowed(params.runId);
      }
      if (
        params.recoveryCategory === "idempotent" &&
        params.idempotencyKey === undefined
      ) {
        throw new TypeError("idempotent effects require idempotencyKey");
      }
      if (
        params.recoveryCategory !== "idempotent" &&
        params.idempotencyKey !== undefined
      ) {
        throw new TypeError(
          "idempotencyKey is reserved for effects classified as idempotent",
        );
      }
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      this.driver
        .prepareState(
          `INSERT INTO run_effects (
             run_id, step_id, epoch, child_run_id, session_id, call_id, tool_name,
             recovery_category, idempotency_key, intent_digest,
             intent_event_id, intent_sequence, intent_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          required(params.stepId, "stepId"),
          positiveInteger(params.epoch, "epoch"),
          optionalRequired(params.childRunId, "childRunId"),
          required(params.sessionId, "sessionId"),
          required(params.callId ?? params.stepId, "callId"),
          required(params.toolName, "toolName"),
          params.recoveryCategory,
          optionalRequired(params.idempotencyKey, "idempotencyKey"),
          required(params.intentDigest, "intentDigest"),
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          required(params.intentAt, "intentAt"),
        );
      return {
        applied: true,
        value: this.getEffect(params.runId, params.stepId)!,
      };
    });
  }

  completeEffect(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly outcome: Exclude<EffectOutcome, "unknown_outcome">;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly resultDigest?: string;
    readonly result?: unknown;
    readonly evidence?: unknown;
    readonly completedAt: string;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.finishEffect({ ...params, unknownReason: undefined });
  }

  markEffectUnknown(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly reason: string;
    readonly evidence?: unknown;
    readonly observedAt: string;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.finishEffect({
      runId: params.runId,
      stepId: params.stepId,
      outcome: "unknown_outcome",
      eventId: params.eventId,
      eventSequence: params.eventSequence,
      evidence: params.evidence,
      completedAt: params.observedAt,
      unknownReason: params.reason,
    });
  }

  getEffect(runId: RunId, stepId: string): DurableRunEffect | undefined {
    const row = this.driver
      .prepareState<[string, string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ? AND step_id = ?`,
      )
      .get(runId, stepId);
    return row === undefined ? undefined : effectFromRow(row);
  }

  getEffectBySessionCall(
    sessionId: string,
    callId: string,
  ): DurableRunEffect | undefined {
    const row = this.driver
      .prepareState<[string, string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE session_id = ? AND call_id = ?
         LIMIT 1`,
      )
      .get(sessionId, callId);
    return row === undefined ? undefined : effectFromRow(row);
  }

  /**
   * Runs that recorded a specific durable step (e.g. `workflow.intake`).
   * Additive M5 helper: lets the workflow controller enumerate workflow runs
   * without a parallel registry table (D2).
   */
  listRunIdsWithStep(stepId: string): readonly RunId[] {
    return this.driver
      .prepareState<[string], { readonly run_id: string }>(
        `SELECT DISTINCT run_id
         FROM run_effects
         WHERE step_id = ?
         ORDER BY run_id ASC`,
      )
      .all(stepId)
      .map((row) => row.run_id);
  }

  listEffects(runId: RunId): readonly DurableRunEffect[] {
    return this.driver
      .prepareState<[string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ?
         ORDER BY intent_sequence ASC, step_id ASC`,
      )
      .all(runId)
      .map(effectFromRow);
  }

  listPendingEffectReviews(runId: RunId): readonly DurableRunEffect[] {
    return this.driver
      .prepareState<[string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ? AND review_status = 'pending'
         ORDER BY intent_sequence ASC, step_id ASC`,
      )
      .all(runId)
      .map(effectFromRow);
  }

  assertDependentMutationAllowed(runId: RunId): void {
    const pending = this.listPendingEffectReviews(runId);
    if (pending.length === 0) return;
    throw conflict(
      "RUN_EFFECT_REVIEW_REQUIRED",
      `run ${runId} has unresolved unknown-outcome effect(s): ${pending
        .map((effect) => effect.stepId)
        .join(", ")}`,
    );
  }

  resolveEffectReview(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly reviewedAt: string;
    readonly reviewedBy: string;
    readonly resolution: string;
    readonly eventId: string;
    readonly evidence?: unknown;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.driver.transactionImmediate(() => {
      const existing = this.getEffect(params.runId, params.stepId);
      if (existing === undefined) {
        throw conflict(
          "RUN_EFFECT_NOT_FOUND",
          `run ${params.runId} step ${params.stepId} has no durable effect`,
        );
      }
      const reviewContent = stableStringify({
        reviewedAt: params.reviewedAt,
        reviewedBy: params.reviewedBy,
        resolution: params.resolution,
        eventId: params.eventId,
        evidence: params.evidence ?? null,
      });
      if (existing.reviewStatus === "resolved") {
        const existingContent = stableStringify({
          reviewedAt: existing.reviewedAt,
          reviewedBy: existing.reviewedBy,
          resolution: existing.reviewResolution,
          eventId: existing.reviewEventId,
          evidence: existing.reviewEvidence ?? null,
        });
        if (reviewContent === existingContent) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EFFECT_REVIEW_CONFLICT",
          `run ${params.runId} step ${params.stepId} already has a different review resolution`,
        );
      }
      if (
        existing.outcome !== "unknown_outcome" ||
        existing.reviewStatus !== "pending"
      ) {
        throw conflict(
          "RUN_EFFECT_REVIEW_CONFLICT",
          `run ${params.runId} step ${params.stepId} is not awaiting review`,
        );
      }
      this.driver
        .prepareState(
          `UPDATE run_effects
           SET review_status = 'resolved', reviewed_at = ?, reviewed_by = ?,
               review_resolution = ?, review_event_id = ?,
               review_evidence_json = ?
           WHERE run_id = ? AND step_id = ? AND review_status = 'pending'`,
        )
        .run(
          required(params.reviewedAt, "reviewedAt"),
          required(params.reviewedBy, "reviewedBy"),
          required(params.resolution, "resolution"),
          required(params.eventId, "eventId"),
          serializeOptionalJson(params.evidence),
          params.runId,
          params.stepId,
        );
      return {
        applied: true,
        value: this.getEffect(params.runId, params.stepId)!,
      };
    });
  }

  bindJournalSource(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly childRunId: RunId;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly active?: boolean;
    readonly firstAvailableSequence?: number;
    readonly lastSequence?: number;
    readonly boundAt: string;
  }): DurableWriteOutcome<RunJournalBinding> {
    return this.driver.transactionImmediate(() => {
      this.requireEpoch(params.runId, params.epoch);
      const existing = this.getJournalBinding(params.sourcePath);
      const active = params.active !== false;
      if (existing !== undefined) {
        const same =
          existing.runId === params.runId &&
          existing.epoch === params.epoch &&
          existing.childRunId === params.childRunId &&
          existing.sessionId === params.sessionId &&
          existing.active === active &&
          existing.firstAvailableSequence === params.firstAvailableSequence &&
          existing.lastSequence === params.lastSequence &&
          existing.boundAt === params.boundAt;
        if (same) return { applied: false, value: existing };
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          `rollout source ${params.sourcePath} already has a different run binding`,
        );
      }
      validateBounds(
        params.firstAvailableSequence,
        params.lastSequence,
        undefined,
      );
      if (active) {
        this.driver
          .prepareState<[string, string, number]>(
            `UPDATE run_journal_bindings
             SET active = 0, updated_at = ?
             WHERE run_id = ? AND epoch = ? AND active = 1`,
          )
          .run(params.boundAt, params.runId, params.epoch);
      }
      this.driver
        .prepareState(
          `INSERT INTO run_journal_bindings (
             run_id, epoch, child_run_id, session_id, source_path, active,
             first_available_sequence, last_sequence, bound_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          positiveInteger(params.epoch, "epoch"),
          required(params.childRunId, "childRunId"),
          required(params.sessionId, "sessionId"),
          required(params.sourcePath, "sourcePath"),
          active ? 1 : 0,
          optionalPositiveInteger(
            params.firstAvailableSequence,
            "firstAvailableSequence",
          ),
          optionalPositiveInteger(params.lastSequence, "lastSequence"),
          required(params.boundAt, "boundAt"),
          params.boundAt,
        );
      return {
        applied: true,
        value: this.getJournalBinding(params.sourcePath)!,
      };
    });
  }

  updateJournalBounds(params: {
    readonly sourcePath: string;
    readonly firstAvailableSequence: number;
    readonly lastSequence: number;
    readonly updatedAt: string;
  }): RunJournalBinding {
    return this.driver.transactionImmediate(() => {
      const existing = this.requireJournalBinding(params.sourcePath);
      validateBounds(
        params.firstAvailableSequence,
        params.lastSequence,
        existing.retiredThroughSequence,
      );
      if (
        existing.firstAvailableSequence !== undefined &&
        params.firstAvailableSequence > existing.firstAvailableSequence
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          "journal bounds cannot silently advance past retained events; record an explicit gap",
        );
      }
      if (
        existing.lastSequence !== undefined &&
        params.lastSequence < existing.lastSequence
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          "journal bounds cannot silently truncate events; record an explicit gap",
        );
      }
      const first =
        existing.firstAvailableSequence === undefined
          ? params.firstAvailableSequence
          : Math.min(
              existing.firstAvailableSequence,
              params.firstAvailableSequence,
            );
      const last = Math.max(existing.lastSequence ?? 0, params.lastSequence);
      this.driver
        .prepareState<[number, number, string, string]>(
          `UPDATE run_journal_bindings
           SET first_available_sequence = ?, last_sequence = ?, updated_at = ?
           WHERE source_path = ?`,
        )
        .run(first, last, required(params.updatedAt, "updatedAt"), params.sourcePath);
      return this.requireJournalBinding(params.sourcePath);
    });
  }

  markJournalGap(params: {
    readonly sourcePath: string;
    readonly retiredThroughSequence: number;
    readonly firstAvailableSequence?: number;
    readonly lastSequence?: number;
    readonly reason: RunJournalGapReason;
    readonly observedAt: string;
  }): RunJournalBinding {
    return this.driver.transactionImmediate(() => {
      const existing = this.requireJournalBinding(params.sourcePath);
      const retired = nonNegativeInteger(
        params.retiredThroughSequence,
        "retiredThroughSequence",
      );
      if (
        existing.retiredThroughSequence !== undefined &&
        retired < existing.retiredThroughSequence
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          "journal retirement boundary cannot move backwards",
        );
      }
      validateBounds(
        params.firstAvailableSequence,
        params.lastSequence,
        retired,
      );
      this.driver
        .prepareState(
          `UPDATE run_journal_bindings
           SET first_available_sequence = ?, last_sequence = ?,
               retired_through_sequence = ?, gap_reason = ?,
               gap_observed_at = ?, updated_at = ?
           WHERE source_path = ?`,
        )
        .run(
          optionalPositiveInteger(
            params.firstAvailableSequence,
            "firstAvailableSequence",
          ),
          optionalPositiveInteger(params.lastSequence, "lastSequence"),
          retired,
          params.reason,
          required(params.observedAt, "observedAt"),
          params.observedAt,
          params.sourcePath,
        );
      return this.requireJournalBinding(params.sourcePath);
    });
  }

  /**
   * Fully retire one canonical rollout source before retention removes its
   * SQLite projection and JSONL file. The binding is deliberately preserved:
   * it is the durable explanation for why a once-known source is now missing.
   *
   * The tail is resolved inside the same write transaction from both the
   * binding and the current `thread_rollout_items` mirror. Callers may wrap
   * this method and mirror-row deletion in an outer immediate transaction;
   * nested driver transactions become savepoints, so retirement cannot commit
   * without the matching projection deletion.
   */
  retireJournalSource(params: {
    readonly sourcePath: string;
    readonly reason: RunJournalGapReason;
    readonly observedAt: string;
    /** Highest sequence parsed from the canonical source under its lease. */
    readonly canonicalLastSequence?: number;
  }): DurableWriteOutcome<RunJournalBinding | undefined> {
    return this.driver.transactionImmediate(() => {
      const existing = this.getJournalBinding(params.sourcePath);
      if (existing === undefined) {
        // Legacy rollout sources can predate M4 bindings. Retention remains
        // safe and idempotent for those sources; there is no identity to keep.
        return { applied: false, value: undefined };
      }
      const projectedTail = this.driver
        .prepareState<[string], { readonly last_sequence: number | null }>(
          `SELECT MAX(event_seq) AS last_sequence
           FROM thread_rollout_items
           WHERE source_path = ? AND event_seq IS NOT NULL`,
        )
        .get(params.sourcePath)?.last_sequence;
      const canonicalTail =
        params.canonicalLastSequence === undefined
          ? undefined
          : nonNegativeInteger(
              params.canonicalLastSequence,
              "canonicalLastSequence",
            );
      if (
        existing.lastSequence === undefined &&
        existing.retiredThroughSequence === undefined &&
        (projectedTail === null || projectedTail === undefined) &&
        canonicalTail === undefined
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          `rollout source ${params.sourcePath} cannot be retired without an authoritative sequence tail`,
        );
      }
      const tail = Math.max(
        existing.lastSequence ?? 0,
        existing.retiredThroughSequence ?? 0,
        projectedTail ?? 0,
        canonicalTail ?? 0,
      );
      if (
        !existing.active &&
        existing.firstAvailableSequence === undefined &&
        existing.retiredThroughSequence === tail &&
        existing.gapReason === params.reason
      ) {
        return { applied: false, value: existing };
      }
      const observedAt = required(params.observedAt, "observedAt");
      this.driver
        .prepareState(
          `UPDATE run_journal_bindings
           SET active = 0,
               first_available_sequence = NULL,
               last_sequence = ?,
               retired_through_sequence = ?,
               gap_reason = ?,
               gap_observed_at = ?,
               updated_at = ?
           WHERE source_path = ?`,
        )
        .run(
          tail > 0 ? tail : null,
          tail,
          params.reason,
          observedAt,
          observedAt,
          params.sourcePath,
        );
      return {
        applied: true,
        value: this.requireJournalBinding(params.sourcePath),
      };
    });
  }

  getJournalBinding(sourcePath: string): RunJournalBinding | undefined {
    const row = this.driver
      .prepareState<[string], JournalBindingRow>(
        `SELECT ${JOURNAL_BINDING_COLUMNS}
         FROM run_journal_bindings
         WHERE source_path = ?`,
      )
      .get(sourcePath);
    return row === undefined ? undefined : journalBindingFromRow(row);
  }

  listJournalBindings(
    runId: RunId,
    epoch?: number,
  ): readonly RunJournalBinding[] {
    const statement = this.driver.prepareState<unknown[], JournalBindingRow>(
      `SELECT ${JOURNAL_BINDING_COLUMNS}
       FROM run_journal_bindings
       WHERE run_id = ?${epoch === undefined ? "" : " AND epoch = ?"}
       ORDER BY epoch ASC, bound_at ASC, source_path ASC`,
    );
    const rows =
      epoch === undefined ? statement.all(runId) : statement.all(runId, epoch);
    return rows.map(journalBindingFromRow);
  }

  private finishEffect(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly outcome: EffectOutcome;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly resultDigest?: string;
    readonly result?: unknown;
    readonly evidence?: unknown;
    readonly completedAt: string;
    readonly unknownReason?: string;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.driver.transactionImmediate(() => {
      const existing = this.getEffect(params.runId, params.stepId);
      if (existing === undefined) {
        throw conflict(
          "RUN_EFFECT_NOT_FOUND",
          `run ${params.runId} step ${params.stepId} has no durable effect intent`,
        );
      }
      const incomingContent = effectOutcomeContent(params);
      if (existing.outcome !== undefined) {
        if (effectOutcomeContent(existing) === incomingContent) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EFFECT_OUTCOME_CONFLICT",
          `run ${params.runId} step ${params.stepId} already has a sticky ${existing.outcome} outcome`,
        );
      }
      if (
        params.outcome === "unknown_outcome" &&
        existing.recoveryCategory === "idempotent"
      ) {
        throw new TypeError(
          "an idempotent effect may not enter unknown_outcome",
        );
      }
      if (params.outcome === "unknown_outcome") {
        if (params.unknownReason === undefined) {
          throw new TypeError("unknownReason is required for unknown_outcome");
        }
        required(params.unknownReason, "unknownReason");
      } else if (params.unknownReason !== undefined) {
        throw new TypeError("unknownReason requires unknown_outcome");
      }
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      this.driver
        .prepareState(
          `UPDATE run_effects
           SET outcome = ?, result_event_id = ?, result_sequence = ?,
               result_digest = ?, result_json = ?, evidence_json = ?,
               unknown_reason = ?, completed_at = ?, review_status = ?
           WHERE run_id = ? AND step_id = ? AND outcome IS NULL`,
        )
        .run(
          params.outcome,
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          optionalRequired(params.resultDigest, "resultDigest"),
          serializeOptionalJson(params.result),
          serializeOptionalJson(params.evidence),
          optionalRequired(params.unknownReason, "unknownReason"),
          required(params.completedAt, "completedAt"),
          params.outcome === "unknown_outcome" ? "pending" : "none",
          params.runId,
          params.stepId,
        );
      return {
        applied: true,
        value: this.getEffect(params.runId, params.stepId)!,
      };
    });
  }

  private requireEpoch(runId: RunId, epoch: number): RunLifecycleEpoch {
    const row = this.driver
      .prepareState<[string, number], EpochRow>(
        `SELECT run_id, epoch, opened_at, opened_event_id,
                reopened_from_epoch, reopen_reason
         FROM run_lifecycle_epochs
         WHERE run_id = ? AND epoch = ?`,
      )
      .get(runId, positiveInteger(epoch, "epoch"));
    if (row === undefined) {
      throw conflict(
        "RUN_EPOCH_CONFLICT",
        `run ${runId} epoch ${epoch} does not exist`,
      );
    }
    return epochFromRow(row);
  }

  private requireJournalBinding(sourcePath: string): RunJournalBinding {
    const binding = this.getJournalBinding(sourcePath);
    if (binding === undefined) {
      throw conflict(
        "RUN_JOURNAL_BINDING_CONFLICT",
        `rollout source ${sourcePath} is not bound to a run`,
      );
    }
    return binding;
  }

  private assertSequenceUnclaimed(
    runId: RunId,
    sequence: number | null,
  ): void {
    if (sequence === null) return;
    const normalized = positiveInteger(sequence, "sequence");
    const effect = this.driver
      .prepareState<[string, number, number], { readonly step_id: string }>(
        `SELECT step_id
         FROM run_effects
         WHERE run_id = ?
           AND (intent_sequence = ? OR result_sequence = ?)
         LIMIT 1`,
      )
      .get(runId, normalized, normalized);
    const terminal = this.driver
      .prepareState<[string, number], { readonly epoch: number }>(
        `SELECT epoch
         FROM run_terminal_results
         WHERE run_id = ? AND last_sequence = ?
         LIMIT 1`,
      )
      .get(runId, normalized);
    if (effect === undefined && terminal === undefined) return;
    throw conflict(
      "RUN_EVENT_SEQUENCE_CONFLICT",
      `run ${runId} sequence ${normalized} is already projected`,
    );
  }
}

function epochFromRow(row: EpochRow): RunLifecycleEpoch {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    openedAt: row.opened_at,
    ...(row.opened_event_id !== null
      ? { openedEventId: row.opened_event_id }
      : {}),
    ...(row.reopened_from_epoch !== null
      ? { reopenedFromEpoch: row.reopened_from_epoch }
      : {}),
    ...(row.reopen_reason !== null ? { reopenReason: row.reopen_reason } : {}),
  };
}

function terminalFromRow(row: TerminalRow): DurableRunTerminalRecord {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    status: row.status,
    exitCode: row.exit_code,
    stopReason: row.stop_reason,
    finalMessage: row.final_message,
    usage: parseUsage(row.usage_json),
    lastSequence: row.last_sequence,
    finishedAt: row.finished_at,
    eventId: row.event_id,
  };
}

function effectFromRow(row: EffectRow): DurableRunEffect {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    epoch: row.epoch,
    ...(row.child_run_id !== null ? { childRunId: row.child_run_id } : {}),
    sessionId: row.session_id,
    callId: row.call_id,
    toolName: row.tool_name,
    recoveryCategory: row.recovery_category,
    ...(row.idempotency_key !== null
      ? { idempotencyKey: row.idempotency_key }
      : {}),
    intentDigest: row.intent_digest,
    intentEventId: row.intent_event_id,
    intentSequence: row.intent_sequence,
    intentAt: row.intent_at,
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    ...(row.result_event_id !== null
      ? { resultEventId: row.result_event_id }
      : {}),
    ...(row.result_sequence !== null
      ? { resultSequence: row.result_sequence }
      : {}),
    ...(row.result_digest !== null ? { resultDigest: row.result_digest } : {}),
    ...(row.result_json !== null ? { result: parseJson(row.result_json) } : {}),
    ...(row.evidence_json !== null
      ? { evidence: parseJson(row.evidence_json) }
      : {}),
    ...(row.unknown_reason !== null
      ? { unknownReason: row.unknown_reason }
      : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    reviewStatus: row.review_status,
    ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.reviewed_by !== null ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.review_resolution !== null
      ? { reviewResolution: row.review_resolution }
      : {}),
    ...(row.review_event_id !== null
      ? { reviewEventId: row.review_event_id }
      : {}),
    ...(row.review_evidence_json !== null
      ? { reviewEvidence: parseJson(row.review_evidence_json) }
      : {}),
  };
}

function journalBindingFromRow(row: JournalBindingRow): RunJournalBinding {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    childRunId: row.child_run_id,
    sessionId: row.session_id,
    sourcePath: row.source_path,
    active: row.active === 1,
    ...(row.first_available_sequence !== null
      ? { firstAvailableSequence: row.first_available_sequence }
      : {}),
    ...(row.last_sequence !== null
      ? { lastSequence: row.last_sequence }
      : {}),
    ...(row.retired_through_sequence !== null
      ? { retiredThroughSequence: row.retired_through_sequence }
      : {}),
    ...(row.gap_reason !== null ? { gapReason: row.gap_reason } : {}),
    ...(row.gap_observed_at !== null
      ? { gapObservedAt: row.gap_observed_at }
      : {}),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}

function effectIntentContent(
  effect:
    | DurableRunEffect
    | {
        readonly runId: RunId;
        readonly epoch: number;
        readonly stepId: string;
        readonly childRunId?: RunId;
        readonly sessionId: string;
        readonly callId?: string;
        readonly toolName: string;
        readonly recoveryCategory: ToolRecoveryCategory;
        readonly idempotencyKey?: string;
        readonly intentDigest: string;
        readonly eventId: string;
        readonly eventSequence: number;
        readonly intentAt: string;
      },
): string {
  return stableStringify({
    runId: effect.runId,
    epoch: effect.epoch,
    stepId: effect.stepId,
    childRunId: effect.childRunId ?? null,
    sessionId: effect.sessionId,
    callId: effect.callId ?? effect.stepId,
    toolName: effect.toolName,
    recoveryCategory: effect.recoveryCategory,
    idempotencyKey: effect.idempotencyKey ?? null,
    intentDigest: effect.intentDigest,
    eventId: "intentEventId" in effect ? effect.intentEventId : effect.eventId,
    eventSequence:
      "intentSequence" in effect ? effect.intentSequence : effect.eventSequence,
    intentAt: effect.intentAt,
  });
}

function effectOutcomeContent(
  effect:
    | DurableRunEffect
    | {
        readonly outcome: EffectOutcome;
        readonly eventId: string;
        readonly eventSequence: number;
        readonly resultDigest?: string;
        readonly result?: unknown;
        readonly evidence?: unknown;
        readonly completedAt: string;
        readonly unknownReason?: string;
      },
): string {
  const durable = "intentEventId" in effect;
  return stableStringify({
    outcome: effect.outcome,
    eventId: durable ? effect.resultEventId : effect.eventId,
    eventSequence: durable ? effect.resultSequence : effect.eventSequence,
    resultDigest: effect.resultDigest ?? null,
    result: effect.result ?? null,
    evidence: effect.evidence ?? null,
    completedAt: effect.completedAt,
    unknownReason: effect.unknownReason ?? null,
  });
}

function terminalContent(result: RunTerminalResult): string {
  return stableStringify({
    runId: result.runId,
    status: result.status,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    finalMessage: result.finalMessage,
    usage: result.usage,
    lastSequence: result.lastSequence,
    finishedAt: result.finishedAt,
  });
}

function parseUsage(value: string | null): RunUsageTotals | null {
  if (value === null) return null;
  const parsed = parseJson(value) as Partial<RunUsageTotals>;
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "costUsd",
  ] as const) {
    if (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field])) {
      throw new Error(`invalid durable terminal usage field: ${field}`);
    }
  }
  return parsed as RunUsageTotals;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function serializeOptionalJson(value: unknown): string | null {
  return value === undefined ? null : stableStringify(value);
}

function validateBounds(
  firstAvailableSequence: number | undefined,
  lastSequence: number | undefined,
  retiredThroughSequence: number | undefined,
): void {
  const first = optionalPositiveInteger(
    firstAvailableSequence,
    "firstAvailableSequence",
  );
  const last = optionalPositiveInteger(lastSequence, "lastSequence");
  if (first !== null && last !== null && last < first) {
    throw new RangeError("lastSequence must be >= firstAvailableSequence");
  }
  if (
    retiredThroughSequence !== undefined &&
    first !== null &&
    retiredThroughSequence >= first
  ) {
    throw new RangeError(
      "firstAvailableSequence must be after retiredThroughSequence",
    );
  }
}

function required(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function optionalRequired(
  value: string | undefined,
  name: string,
): string | null {
  return value === undefined ? null : required(value, name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function optionalPositiveInteger(
  value: number | undefined,
  name: string,
): number | null {
  return value === undefined ? null : positiveInteger(value, name);
}

function nullablePositiveInteger(
  value: number | null,
  name: string,
): number | null {
  return value === null ? null : positiveInteger(value, name);
}

function conflict(
  code: RunDurabilityConflictCode,
  message: string,
): RunDurabilityConflictError {
  return new RunDurabilityConflictError(code, message);
}
