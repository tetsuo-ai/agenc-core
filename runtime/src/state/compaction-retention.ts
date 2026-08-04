import type { StateSqliteDriver } from "./sqlite-driver.js";
import {
  MAX_COMPACTION_ACTIVE_PINS_GLOBAL,
  COMPACTION_RECONCILIATION_PAGE_SIZE,
  MAX_COMPACTION_FAILURES_PER_HISTORY_DIGEST,
  MAX_COMPACTION_PIN_HISTORY_TOTAL,
  MAX_COMPACTION_PINNED_BYTES_GLOBAL,
  MAX_COMPACTION_PINNED_BYTES_PER_SESSION,
  MAX_COMPACTION_PINS_PER_SESSION,
  type CompactionCommittedV1,
  type CompactionActiveHistoryRefV1,
  type CompactionIntentV1,
  type CompactionPinState,
  type CompactionSourceReleaseV1,
  CompactionTransactionError,
} from "../services/compact/transaction-types.js";
import {
  canonicalizeJson,
  sha256Hex,
} from "../services/compact/summary-v1.js";

const EMPTY_CURSOR_CREATED_AT_MS = 0;
const EMPTY_CURSOR_ATTEMPT_ID = "";
const FAILURE_ATTEMPT_HISTORY_LIMIT = MAX_COMPACTION_FAILURES_PER_HISTORY_DIGEST;

export type CompactionReferenceKind =
  | "active_history"
  | "checkpoint"
  | "branch"
  | "descendant_compaction"
  | "rollback_window"
  | "rollback_extension"
  | "provenance";

export interface CompactionActiveReference {
  readonly kind: CompactionReferenceKind;
  readonly referenceId: string;
}

export type CompactionRecoveryDeferralReason =
  | "pin_quota"
  | "pin_history_quota"
  | "pinned_bytes_quota"
  | "startup_page_budget"
  | "startup_time_budget"
  | "source_proof_unavailable"
  | "failure_append_unavailable"
  | "cleanup_pending"
  | "projection_reconstruction";

export interface CompactionPinRecord {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly sourceBinding: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly historyDigest: string;
  readonly activeHistoryRefs: readonly CompactionActiveHistoryRefV1[];
  readonly selectedHistoryIndexes: readonly number[];
  readonly policyDigest: string;
  readonly configurationDigest: string;
  readonly accountingRef: string;
  readonly automatic: boolean;
  readonly admissionRequired: boolean;
  readonly plannedProviderCalls: number;
  readonly state: CompactionPinState;
  readonly referenceCount: number;
  readonly createdAtMs: number;
  readonly intentAtMs?: number;
  readonly committedAtMs?: number;
  readonly retentionDeadlineMs?: number;
  readonly rollbackExtendedUntilMs?: number;
  readonly releaseTombstoneAtMs?: number;
  readonly releasedAtMs?: number;
  readonly commitSha256?: string;
  readonly referenceScanGeneration?: number;
  readonly cleanupState: "not_started" | "pending" | "complete";
  readonly projectionState:
    | "not_committed"
    | "pending"
    | "complete"
    | "reconstruction_required";
  readonly pruneCursor: number;
}

interface CompactionPinRow {
  readonly attempt_id: string;
  readonly session_id: string;
  readonly epoch: number;
  readonly source_binding: string;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly source_sha256: string;
  readonly source_bytes: number;
  readonly history_digest: string;
  readonly source_manifest_json: string;
  readonly selected_history_indexes_json: string;
  readonly policy_digest: string;
  readonly configuration_digest: string;
  readonly accounting_ref: string;
  readonly automatic: number;
  readonly admission_required: number;
  readonly planned_provider_calls: number;
  readonly state: CompactionPinState;
  readonly reference_count: number;
  readonly created_at_ms: number;
  readonly intent_at_ms: number | null;
  readonly committed_at_ms: number | null;
  readonly retention_deadline_ms: number | null;
  readonly rollback_extended_until_ms: number | null;
  readonly release_tombstone_at_ms: number | null;
  readonly released_at_ms: number | null;
  readonly commit_sha256: string | null;
  readonly reference_scan_generation: number | null;
  readonly cleanup_state: "not_started" | "pending" | "complete";
  readonly projection_state: CompactionPinRecord["projectionState"];
  readonly prune_cursor: number;
}

interface QuotaRow {
  readonly total_count: number;
  readonly active_count: number;
  readonly total_bytes: number;
}

interface FailureGuardRow {
  readonly failure_count: number;
  readonly attempt_ids_json: string;
}

interface CursorRow {
  readonly created_at_ms: number;
  readonly attempt_id: string;
}

export class CompactionPinQuotaError extends Error {
  constructor(
    readonly reason:
      | "pin_quota"
      | "pin_history_quota"
      | "pinned_bytes_quota",
    message: string,
  ) {
    super(message);
    this.name = "CompactionPinQuotaError";
  }
}

export class CompactionRetentionRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  createPreparingPin(
    intent: CompactionIntentV1,
    provenanceAttemptIds: readonly string[] = [],
  ): CompactionPinRecord {
    return this.driver.transactionImmediate(() => {
      const existing = this.get(intent.attempt_id);
      if (existing !== undefined) {
        assertIntentMatchesPin(intent, existing);
        return existing;
      }
      const global = this.driver
        .prepareState<[], QuotaRow>(
          `SELECT
             COUNT(*) AS total_count,
             COALESCE(SUM(CASE WHEN state != 'released' THEN 1 ELSE 0 END), 0)
               AS active_count,
             COALESCE(SUM(CASE WHEN state != 'released' THEN source_bytes ELSE 0 END), 0)
               AS total_bytes
           FROM compaction_retention_pins`,
        )
        .get() ?? { total_count: 0, active_count: 0, total_bytes: 0 };
      const session = this.driver
        .prepareState<[string], QuotaRow>(
          `SELECT
             COUNT(*) AS total_count,
             COALESCE(SUM(CASE WHEN state != 'released' THEN 1 ELSE 0 END), 0)
               AS active_count,
             COALESCE(SUM(CASE WHEN state != 'released' THEN source_bytes ELSE 0 END), 0)
               AS total_bytes
           FROM compaction_retention_pins
           WHERE session_id = ?`,
        )
        .get(intent.source.session_id) ?? {
          total_count: 0,
          active_count: 0,
          total_bytes: 0,
        };
      if (
        global.active_count >= MAX_COMPACTION_ACTIVE_PINS_GLOBAL ||
        session.active_count >= MAX_COMPACTION_PINS_PER_SESSION
      ) {
        throw new CompactionPinQuotaError(
          "pin_quota",
          "compaction active-pin quota is exhausted; source remains unchanged",
        );
      }
      if (global.total_count >= MAX_COMPACTION_PIN_HISTORY_TOTAL) {
        throw new CompactionPinQuotaError(
          "pin_history_quota",
          "compaction pin-history quota is exhausted; retention GC must complete first",
        );
      }
      if (
        global.total_bytes >
          MAX_COMPACTION_PINNED_BYTES_GLOBAL - intent.source.source_bytes ||
        session.total_bytes >
          MAX_COMPACTION_PINNED_BYTES_PER_SESSION - intent.source.source_bytes
      ) {
        throw new CompactionPinQuotaError(
          "pinned_bytes_quota",
          "compaction pinned-byte quota is exhausted; source remains unchanged",
        );
      }
      this.driver
        .prepareState<
          [
            string,
            number,
            string,
            number,
            string,
            number,
            number,
            string,
            number,
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            number,
            number,
            number,
          ]
        >(
          `INSERT INTO compaction_retention_pins (
             attempt_id, format_version, session_id, epoch, source_binding,
             first_sequence, last_sequence, source_sha256, source_bytes,
             history_digest, source_manifest_json, selected_history_indexes_json,
             policy_digest, configuration_digest,
             accounting_ref, automatic, admission_required,
             planned_provider_calls, state, reference_count, created_at_ms,
             cleanup_state, projection_state, prune_cursor
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'preparing', 1, ?, 'not_started', 'not_committed', 0)`,
        )
        .run(
          intent.attempt_id,
          intent.format_version,
          intent.source.session_id,
          intent.source.epoch,
          intent.source.source_binding,
          intent.source.first_sequence,
          intent.source.last_sequence,
          intent.source.source_sha256,
          intent.source.source_bytes,
          intent.source.history_digest,
          canonicalSourceManifest(intent.source.active_history_refs),
          canonicalizeJson(intent.selected_history_indexes),
          intent.policy_digest,
          intent.configuration_digest,
          intent.accounting_ref,
          intent.automatic ? 1 : 0,
          intent.admission_required ? 1 : 0,
          intent.planned_provider_calls,
          intent.recorded_at_ms,
        );
      this.addReferenceLocked(
        intent.attempt_id,
        "active_history",
        intent.source.source_sha256,
        intent.recorded_at_ms,
      );
      for (const ancestorAttemptId of new Set(provenanceAttemptIds)) {
        if (ancestorAttemptId === intent.attempt_id) {
          throw new CompactionTransactionError(
            "pin_failed",
            "a compaction cannot retain itself as source provenance",
          );
        }
        const ancestor = this.get(ancestorAttemptId);
        if (ancestor === undefined || ancestor.state === "released") continue;
        if (ancestor.state !== "committed_reference") {
          throw new CompactionTransactionError(
            "pin_failed",
            `source provenance ${ancestorAttemptId} is no longer referenceable`,
          );
        }
        this.addReferenceLocked(
          ancestorAttemptId,
          "descendant_compaction",
          intent.attempt_id,
          intent.recorded_at_ms,
        );
        this.refreshReferenceCountLocked(ancestorAttemptId);
      }
      return this.require(intent.attempt_id);
    });
  }

  bindIntent(attemptId: string, recordedAtMs: number): CompactionPinRecord {
    return this.driver.transactionImmediate(() => {
      const pin = this.require(attemptId);
      if (pin.state === "preparing") {
        this.driver
          .prepareState<[number, string]>(
            `UPDATE compaction_retention_pins
             SET state = 'intent_bound', intent_at_ms = ?
             WHERE attempt_id = ? AND state = 'preparing'`,
          )
          .run(recordedAtMs, attemptId);
      }
      return this.require(attemptId);
    });
  }

  releaseOrphanPreparing(
    attemptId: string,
    releasedAtMs: number,
    sourceStillAuthoritative: boolean,
  ): void {
    if (!sourceStillAuthoritative) {
      throw new CompactionTransactionError(
        "pin_failed",
        "orphan compaction pin cannot release without authoritative source proof",
      );
    }
    this.driver.transactionImmediate(() => {
      const pin = this.require(attemptId);
      if (pin.state === "released") return;
      if (pin.state !== "preparing") {
        throw new CompactionTransactionError(
          "pin_failed",
          `orphan pin release requires preparing state, got ${pin.state}`,
        );
      }
      this.releaseReferenceLocked(
        attemptId,
        "active_history",
        pin.sourceSha256,
        releasedAtMs,
      );
      this.driver
        .prepareState<[number, number, string]>(
          `UPDATE compaction_retention_pins
           SET state = 'release_pending', release_tombstone_at_ms = ?,
               released_at_ms = ?, reference_count = 0
           WHERE attempt_id = ? AND state = 'preparing'`,
        )
        .run(releasedAtMs, releasedAtMs, attemptId);
      this.driver
        .prepareState<[string]>(
          `UPDATE compaction_retention_pins
           SET state = 'released'
           WHERE attempt_id = ? AND state = 'release_pending'`,
        )
        .run(attemptId);
      this.releaseDescendantReferencesLocked(attemptId, releasedAtMs);
    });
  }

  markCommitted(
    committed: CompactionCommittedV1,
    commitSha256: string,
  ): CompactionPinRecord {
    return this.driver.transactionImmediate(() => {
      const pin = this.require(committed.attempt_id);
      assertCommitMatchesPin(committed, pin);
      if (pin.state === "committed_reference") {
        if (pin.commitSha256 !== commitSha256) {
          throw new CompactionTransactionError(
            "commit_failed",
            "compaction attempt is already bound to another commit digest",
          );
        }
        return pin;
      }
      if (pin.state !== "intent_bound") {
        throw new CompactionTransactionError(
          "commit_failed",
          `compaction pin cannot commit from state ${pin.state}`,
        );
      }
      this.driver
        .prepareState<[number, number, string, string]>(
          `UPDATE compaction_retention_pins
           SET state = 'committed_reference', committed_at_ms = ?,
               retention_deadline_ms = ?, commit_sha256 = ?,
               cleanup_state = 'pending', projection_state = 'pending'
           WHERE attempt_id = ? AND state = 'intent_bound'`,
        )
        .run(
          committed.committed_at_ms,
          committed.rollback_retention_deadline_ms,
          commitSha256,
          committed.attempt_id,
        );
      return this.require(committed.attempt_id);
    });
  }

  recordFailure(params: {
    readonly attemptId: string;
    readonly sessionId: string;
    readonly historyDigest: string;
    readonly configurationDigest: string;
    readonly recordedAtMs: number;
    readonly sourceStillAuthoritative: boolean;
    readonly automatic: boolean;
  }): void {
    this.driver.transactionImmediate(() => {
      if (params.automatic) {
      const prior = this.driver
        .prepareState<[string, string, string], FailureGuardRow>(
          `SELECT failure_count, attempt_ids_json
           FROM compaction_failure_guards
           WHERE session_id = ? AND history_digest = ?
             AND configuration_digest = ?`,
        )
        .get(params.sessionId, params.historyDigest, params.configurationDigest);
      const attempts = prior === undefined
        ? []
        : parseAttemptIds(prior.attempt_ids_json);
      if (!attempts.includes(params.attemptId)) attempts.push(params.attemptId);
      const boundedAttempts = attempts.slice(-FAILURE_ATTEMPT_HISTORY_LIMIT);
      const count = Math.min(
        MAX_COMPACTION_FAILURES_PER_HISTORY_DIGEST,
        Math.max(prior?.failure_count ?? 0, boundedAttempts.length),
      );
      this.driver
        .prepareState<[string, string, string, number, string, number]>(
          `INSERT INTO compaction_failure_guards (
             session_id, history_digest, configuration_digest,
             failure_count, attempt_ids_json, last_failure_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, history_digest, configuration_digest)
           DO UPDATE SET
             failure_count = excluded.failure_count,
             attempt_ids_json = excluded.attempt_ids_json,
             last_failure_at_ms = excluded.last_failure_at_ms`,
        )
        .run(
          params.sessionId,
          params.historyDigest,
          params.configurationDigest,
          count,
          JSON.stringify(boundedAttempts),
          params.recordedAtMs,
        );
      }
      if (!params.sourceStillAuthoritative) return;
      const pin = this.get(params.attemptId);
      if (pin === undefined || pin.state === "released") return;
      if (pin.state === "preparing" || pin.state === "intent_bound") {
        this.releaseReferenceLocked(
          params.attemptId,
          "active_history",
          pin.sourceSha256,
          params.recordedAtMs,
        );
        this.driver
          .prepareState<[number, number, string]>(
            `UPDATE compaction_retention_pins
             SET state = 'release_pending', release_tombstone_at_ms = ?,
                 released_at_ms = ?, reference_count = 0
             WHERE attempt_id = ?
               AND state IN ('preparing', 'intent_bound')`,
          )
          .run(params.recordedAtMs, params.recordedAtMs, params.attemptId);
        this.driver
          .prepareState<[string]>(
            `UPDATE compaction_retention_pins
             SET state = 'released'
             WHERE attempt_id = ? AND state = 'release_pending'`,
          )
          .run(params.attemptId);
        this.releaseDescendantReferencesLocked(
          params.attemptId,
          params.recordedAtMs,
        );
      }
    });
  }

  failureCount(
    sessionId: string,
    historyDigest: string,
    configurationDigest: string,
  ): number {
    return (
      this.driver
        .prepareState<[string, string, string], { readonly failure_count: number }>(
          `SELECT failure_count
           FROM compaction_failure_guards
           WHERE session_id = ? AND history_digest = ?
             AND configuration_digest = ?`,
        )
        .get(sessionId, historyDigest, configurationDigest)?.failure_count ?? 0
    );
  }

  markProjectionComplete(attemptId: string, recordedAtMs: number): void {
    this.driver.transactionImmediate(() => {
      const pin = this.require(attemptId);
      if (pin.state !== "committed_reference") return;
      this.releaseReferenceLocked(
        attemptId,
        "active_history",
        pin.sourceSha256,
        recordedAtMs,
      );
      this.driver
        .prepareState<[string, string]>(
          `UPDATE compaction_retention_pins
           SET projection_state = 'complete',
               reference_count = (
                 SELECT COUNT(*) FROM compaction_retention_references
                 WHERE attempt_id = ? AND released_at_ms IS NULL
               )
           WHERE attempt_id = ? AND state = 'committed_reference'`,
        )
        .run(attemptId, attemptId);
    });
  }

  markProjectionReconstructionRequired(
    attemptId: string,
    recordedAtMs: number,
    detail: unknown,
  ): void {
    this.driver.transactionImmediate(() => {
      this.driver
        .prepareState<[string]>(
          `UPDATE compaction_retention_pins
           SET projection_state = 'reconstruction_required'
           WHERE attempt_id = ? AND state = 'committed_reference'`,
        )
        .run(attemptId);
      const pin = this.get(attemptId);
      this.createDeferralLocked({
        sessionId: pin?.sessionId,
        attemptId,
        reason: "projection_reconstruction",
        detail,
        createdAtMs: recordedAtMs,
      });
    });
  }

  markCleanupComplete(attemptId: string): void {
    this.driver
      .prepareState<[string]>(
        `UPDATE compaction_retention_pins
         SET cleanup_state = 'complete'
         WHERE attempt_id = ? AND state = 'committed_reference'`,
      )
      .run(attemptId);
  }

  markCleanupPending(attemptId: string, recordedAtMs: number, detail: unknown): void {
    this.driver.transactionImmediate(() => {
      this.driver
        .prepareState<[string]>(
          `UPDATE compaction_retention_pins
           SET cleanup_state = 'pending'
           WHERE attempt_id = ? AND state = 'committed_reference'`,
        )
        .run(attemptId);
      const pin = this.get(attemptId);
      this.createDeferralLocked({
        sessionId: pin?.sessionId,
        attemptId,
        reason: "cleanup_pending",
        detail,
        createdAtMs: recordedAtMs,
      });
    });
  }

  addReference(params: {
    readonly attemptId: string;
    readonly kind: CompactionReferenceKind;
    readonly referenceId: string;
    readonly createdAtMs: number;
  }): void {
    this.driver.transactionImmediate(() => {
      const pin = this.require(params.attemptId);
      if (pin.state === "release_pending" || pin.state === "released") {
        throw new CompactionTransactionError(
          "commit_failed",
          "compaction source cannot acquire a reference after its release tombstone",
        );
      }
      this.addReferenceLocked(
        params.attemptId,
        params.kind,
        params.referenceId,
        params.createdAtMs,
      );
      this.refreshReferenceCountLocked(params.attemptId);
    });
  }

  releaseReference(params: {
    readonly attemptId: string;
    readonly kind: CompactionReferenceKind;
    readonly referenceId: string;
    readonly releasedAtMs: number;
  }): void {
    this.driver.transactionImmediate(() => {
      this.releaseReferenceLocked(
        params.attemptId,
        params.kind,
        params.referenceId,
        params.releasedAtMs,
      );
      this.refreshReferenceCountLocked(params.attemptId);
    });
  }

  extendRollbackRetention(
    attemptId: string,
    extendedUntilMs: number,
  ): CompactionPinRecord {
    return this.driver.transactionImmediate(() => {
      const pin = this.require(attemptId);
      if (pin.retentionDeadlineMs === undefined || extendedUntilMs < pin.retentionDeadlineMs) {
        throw new CompactionTransactionError(
          "commit_failed",
          "rollback retention cannot be shortened below the durable minimum",
        );
      }
      const current = pin.rollbackExtendedUntilMs ?? pin.retentionDeadlineMs;
      if (extendedUntilMs < current) {
        throw new CompactionTransactionError(
          "commit_failed",
          "rollback retention extension cannot move backwards",
        );
      }
      this.driver
        .prepareState<[number, string]>(
          `UPDATE compaction_retention_pins
           SET rollback_extended_until_ms = ?
           WHERE attempt_id = ? AND state = 'committed_reference'`,
        )
        .run(extendedUntilMs, attemptId);
      return this.require(attemptId);
    });
  }

  assertReleaseEligible(attemptId: string, nowMs: number): CompactionPinRecord {
    const pin = this.require(attemptId);
    if (pin.state !== "committed_reference") {
      throw new CompactionTransactionError(
        "commit_failed",
        `compaction source cannot release from state ${pin.state}`,
      );
    }
    const deadline = Math.max(
      pin.retentionDeadlineMs ?? Number.MAX_SAFE_INTEGER,
      pin.rollbackExtendedUntilMs ?? 0,
    );
    if (nowMs < deadline) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction source remains inside its durable rollback window",
      );
    }
    const active = this.driver
      .prepareState<[string], { readonly count: number }>(
        `SELECT COUNT(*) AS count
         FROM compaction_retention_references
         WHERE attempt_id = ? AND released_at_ms IS NULL`,
      )
      .get(attemptId)?.count ?? 0;
    if (active !== 0 || pin.referenceCount !== 0) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction source still has active retention references",
      );
    }
    if (pin.projectionState !== "complete") {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction projection is not durably complete",
      );
    }
    return pin;
  }

  markReleasePending(release: CompactionSourceReleaseV1): CompactionPinRecord {
    return this.driver.transactionImmediate(() => {
      const pin = this.assertReleaseEligible(release.attempt_id, release.recorded_at_ms);
      if (
        pin.sourceSha256 !== release.source_sha256 ||
        pin.commitSha256 !== release.commit_sha256
      ) {
        throw new CompactionTransactionError(
          "commit_failed",
          "compaction release tombstone does not bind the pinned source and commit",
        );
      }
      this.driver
        .prepareState<[number, number, string]>(
          `UPDATE compaction_retention_pins
           SET state = 'release_pending', release_tombstone_at_ms = ?,
               reference_scan_generation = ?
           WHERE attempt_id = ? AND state = 'committed_reference'`,
        )
        .run(
          release.recorded_at_ms,
          release.reference_scan_generation,
          release.attempt_id,
        );
      return this.require(release.attempt_id);
    });
  }

  advancePruneCursor(params: {
    readonly attemptId: string;
    readonly cursor: number;
    readonly referenceScanGeneration: number;
  }): void {
    const result = this.driver
      .prepareState<[number, string, number, number]>(
        `UPDATE compaction_retention_pins
         SET prune_cursor = ?
         WHERE attempt_id = ? AND state = 'release_pending'
           AND prune_cursor <= ? AND reference_scan_generation = ?
           AND NOT EXISTS (
             SELECT 1 FROM compaction_retention_references
             WHERE attempt_id = compaction_retention_pins.attempt_id
               AND released_at_ms IS NULL
           )`,
      )
      .run(
        params.cursor,
        params.attemptId,
        params.cursor,
        params.referenceScanGeneration,
      );
    if (result.changes !== 1) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction source release lost its exact tombstone or acquired a reference",
      );
    }
  }

  markReleased(params: {
    readonly attemptId: string;
    readonly releasedAtMs: number;
    readonly sourceBinding: string;
    readonly sourceSha256: string;
    readonly completedCursor: number;
    readonly referenceScanGeneration: number;
  }): void {
    this.driver.transactionImmediate(() => {
      const pin = this.require(params.attemptId);
      if (pin.state === "released") return;
      if (
        pin.state !== "release_pending" ||
        pin.sourceBinding !== params.sourceBinding ||
        pin.sourceSha256 !== params.sourceSha256 ||
        pin.referenceScanGeneration !== params.referenceScanGeneration ||
        pin.pruneCursor !== params.completedCursor ||
        params.completedCursor !== pin.activeHistoryRefs.length ||
        this.listActiveReferences(params.attemptId).length !== 0
      ) {
        throw new CompactionTransactionError(
          "commit_failed",
          "compaction source cannot finalize before exact bounded pruning completes",
        );
      }
      this.driver
        .prepareState<[number, string]>(
          `UPDATE compaction_retention_pins
           SET state = 'released', released_at_ms = ?
           WHERE attempt_id = ? AND state = 'release_pending'`,
        )
        .run(params.releasedAtMs, params.attemptId);
      this.releaseDescendantReferencesLocked(
        params.attemptId,
        params.releasedAtMs,
      );
    });
  }

  get(attemptId: string): CompactionPinRecord | undefined {
    const row = this.driver
      .prepareState<[string], CompactionPinRow>(
        `${PIN_SELECT} WHERE attempt_id = ?`,
      )
      .get(attemptId);
    return row === undefined ? undefined : mapPin(row);
  }

  require(attemptId: string): CompactionPinRecord {
    const pin = this.get(attemptId);
    if (pin === undefined) throw new Error(`compaction pin ${attemptId} does not exist`);
    return pin;
  }

  listSession(sessionId: string): readonly CompactionPinRecord[] {
    return this.driver
      .prepareState<[string], CompactionPinRow>(
        `${PIN_SELECT}
         WHERE session_id = ?
         ORDER BY created_at_ms ASC, attempt_id ASC`,
      )
      .all(sessionId)
      .map(mapPin);
  }

  listReleaseCandidates(
    sessionId: string,
    nowMs: number,
    limit: number,
  ): readonly CompactionPinRecord[] {
    const boundedLimit = getCompactionRetentionPageSize(limit);
    if (boundedLimit === undefined) return [];
    // A release tombstone always resumes before a new release begins. Keeping
    // the two ordered streams separate avoids an OR/CASE sort over pin history.
    const releasePending = this.driver
      .prepareState<[string, number], CompactionPinRow>(
        `${PIN_SELECT}
         INDEXED BY idx_compaction_pins_release_pending
         WHERE session_id = ? AND state = 'release_pending'
         ORDER BY retention_deadline_ms ASC, attempt_id ASC
         LIMIT ?`,
      )
      .all(sessionId, boundedLimit);
    if (releasePending.length >= boundedLimit) {
      return releasePending.map(mapPin);
    }
    // Range and order by the same indexed effective deadline so rows with a
    // future rollback extension cannot occupy the scanned prefix.
    const committed = this.driver
      .prepareState<[string, number, number], CompactionPinRow>(
        `${PIN_SELECT}
         INDEXED BY idx_compaction_pins_release_eligible
         WHERE session_id = ? AND state = 'committed_reference'
           AND projection_state = 'complete' AND reference_count = 0
           AND retention_deadline_ms IS NOT NULL
           AND MAX(
             retention_deadline_ms,
             COALESCE(rollback_extended_until_ms, 0)
           ) <= ?
         ORDER BY MAX(
           retention_deadline_ms,
           COALESCE(rollback_extended_until_ms, 0)
         ) ASC, attempt_id ASC
         LIMIT ?`,
      )
      .all(
        sessionId,
        nowMs,
        boundedLimit - releasePending.length,
      );
    return [...releasePending, ...committed].map(mapPin);
  }

  listActiveForSourceBinding(sourceBinding: string): readonly CompactionPinRecord[] {
    return this.driver
      .prepareState<[string], CompactionPinRow>(
        `${PIN_SELECT}
         WHERE source_binding = ? AND state != 'released'
         ORDER BY created_at_ms ASC, attempt_id ASC`,
      )
      .all(sourceBinding)
      .map(mapPin);
  }

  listActiveReferences(attemptId: string): readonly CompactionActiveReference[] {
    return this.driver
      .prepareState<
        [string],
        {
          readonly reference_kind: CompactionReferenceKind;
          readonly reference_id: string;
        }
      >(
        `SELECT reference_kind, reference_id
         FROM compaction_retention_references
         WHERE attempt_id = ? AND released_at_ms IS NULL
         ORDER BY reference_kind ASC, reference_id ASC`,
      )
      .all(attemptId)
      .map((row) => ({
        kind: row.reference_kind,
        referenceId: row.reference_id,
      }));
  }

  recordRollbackReference(params: {
    readonly attemptId: string;
    readonly mode: "same_session" | "reviewed_branch";
    readonly targetSessionId: string;
    readonly recordedAtMs: number;
  }): void {
    this.driver.transactionImmediate(() => {
      const pin = this.require(params.attemptId);
      if (pin.state !== "committed_reference") {
        throw new CompactionTransactionError(
          "commit_failed",
          `compaction rollback cannot bind a source in state ${pin.state}`,
        );
      }
      this.addReferenceLocked(
        params.attemptId,
        params.mode === "same_session" ? "active_history" : "branch",
        params.targetSessionId,
        params.recordedAtMs,
      );
      this.refreshReferenceCountLocked(params.attemptId);
    });
  }

  listReconciliationPage(sessionId: string): readonly CompactionPinRecord[] {
    const cursor = this.driver
      .prepareState<[string], CursorRow>(
        `SELECT created_at_ms, attempt_id
         FROM compaction_reconciliation_cursors
         WHERE cursor_name = ?`,
      )
      .get(sessionId) ?? {
        created_at_ms: EMPTY_CURSOR_CREATED_AT_MS,
        attempt_id: EMPTY_CURSOR_ATTEMPT_ID,
      };
    return this.driver
      .prepareState<[string, number, string, number], CompactionPinRow>(
        `${PIN_SELECT}
         INDEXED BY idx_compaction_pins_reconcile
         WHERE session_id = ? AND state != 'released'
           AND (created_at_ms, attempt_id) > (?, ?)
         ORDER BY created_at_ms ASC, attempt_id ASC
         LIMIT ?`,
      )
      .all(
        sessionId,
        cursor.created_at_ms,
        cursor.attempt_id,
        COMPACTION_RECONCILIATION_PAGE_SIZE,
      )
      .map(mapPin);
  }

  persistReconciliationCursor(
    sessionId: string,
    pin: CompactionPinRecord,
    updatedAtMs: number,
  ): void {
    this.driver
      .prepareState<[string, number, string, number]>(
        `INSERT INTO compaction_reconciliation_cursors (
           cursor_name, created_at_ms, attempt_id, updated_at_ms
        ) VALUES (?, ?, ?, ?)
         ON CONFLICT(cursor_name) DO UPDATE SET
           created_at_ms = excluded.created_at_ms,
           attempt_id = excluded.attempt_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(sessionId, pin.createdAtMs, pin.attemptId, updatedAtMs);
  }

  resetReconciliationCursor(sessionId: string, updatedAtMs: number): void {
    this.driver
      .prepareState<[string, number]>(
        `INSERT INTO compaction_reconciliation_cursors (
           cursor_name, created_at_ms, attempt_id, updated_at_ms
         ) VALUES (?, 0, '', ?)
         ON CONFLICT(cursor_name) DO UPDATE SET
           created_at_ms = 0, attempt_id = '', updated_at_ms = excluded.updated_at_ms`,
      )
      .run(sessionId, updatedAtMs);
  }

  createDeferral(params: {
    readonly sessionId?: string;
    readonly attemptId?: string;
    readonly reason: CompactionRecoveryDeferralReason;
    readonly detail: unknown;
    readonly createdAtMs: number;
  }): void {
    this.driver.transactionImmediate(() => this.createDeferralLocked(params));
  }

  deleteReleasedHistory(limit: number): number {
    const boundedLimit = getCompactionRetentionPageSize(limit);
    if (boundedLimit === undefined) return 0;
    return this.driver.transactionImmediate(() => {
      const attempts = this.driver
        .prepareState<[number], { readonly attempt_id: string }>(
          `SELECT attempt_id FROM compaction_retention_pins
           INDEXED BY idx_compaction_pins_released_gc
           WHERE state = 'released' AND released_at_ms IS NOT NULL
           ORDER BY released_at_ms ASC, attempt_id ASC
           LIMIT ?`,
        )
        .all(boundedLimit)
        .map((row: { readonly attempt_id: string }) => row.attempt_id);
      const removeReferences = this.driver.prepareState<[string]>(
        "DELETE FROM compaction_retention_references WHERE attempt_id = ?",
      );
      const removePin = this.driver.prepareState<[string]>(
        "DELETE FROM compaction_retention_pins WHERE attempt_id = ? AND state = 'released'",
      );
      let deleted = 0;
      for (const attemptId of attempts) {
        removeReferences.run(attemptId);
        deleted += removePin.run(attemptId).changes;
      }
      return deleted;
    });
  }

  private addReferenceLocked(
    attemptId: string,
    kind: CompactionReferenceKind,
    referenceId: string,
    createdAtMs: number,
  ): void {
    this.driver
      .prepareState<[string, CompactionReferenceKind, string, number]>(
        `INSERT INTO compaction_retention_references (
           attempt_id, reference_kind, reference_id, created_at_ms
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(attempt_id, reference_kind, reference_id) DO NOTHING`,
      )
      .run(attemptId, kind, referenceId, createdAtMs);
  }

  private releaseReferenceLocked(
    attemptId: string,
    kind: CompactionReferenceKind,
    referenceId: string,
    releasedAtMs: number,
  ): void {
    this.driver
      .prepareState<[number, string, CompactionReferenceKind, string]>(
        `UPDATE compaction_retention_references
         SET released_at_ms = COALESCE(released_at_ms, ?)
         WHERE attempt_id = ? AND reference_kind = ? AND reference_id = ?`,
      )
      .run(releasedAtMs, attemptId, kind, referenceId);
  }

  private refreshReferenceCountLocked(attemptId: string): void {
    this.driver
      .prepareState<[string, string]>(
        `UPDATE compaction_retention_pins
         SET reference_count = (
           SELECT COUNT(*) FROM compaction_retention_references
           WHERE attempt_id = ? AND released_at_ms IS NULL
         )
         WHERE attempt_id = ?`,
      )
      .run(attemptId, attemptId);
  }

  private releaseDescendantReferencesLocked(
    descendantAttemptId: string,
    releasedAtMs: number,
  ): void {
    const ancestors = this.driver
      .prepareState<
        [string],
        { readonly attempt_id: string }
      >(
        `SELECT attempt_id
         FROM compaction_retention_references
         INDEXED BY idx_compaction_references_active_descendant
         WHERE reference_kind = 'descendant_compaction'
           AND reference_id = ? AND released_at_ms IS NULL`,
      )
      .all(descendantAttemptId)
      .map((row) => row.attempt_id);
    this.driver
      .prepareState<[number, string]>(
        `UPDATE compaction_retention_references
         INDEXED BY idx_compaction_references_active_descendant
         SET released_at_ms = ?
         WHERE reference_kind = 'descendant_compaction'
           AND reference_id = ? AND released_at_ms IS NULL`,
      )
      .run(releasedAtMs, descendantAttemptId);
    for (const ancestorAttemptId of ancestors) {
      this.refreshReferenceCountLocked(ancestorAttemptId);
    }
  }

  private createDeferralLocked(params: {
    readonly sessionId?: string;
    readonly attemptId?: string;
    readonly reason: CompactionRecoveryDeferralReason;
    readonly detail: unknown;
    readonly createdAtMs: number;
  }): void {
    this.driver
      .prepareState<[string | null, string | null, CompactionRecoveryDeferralReason, string, number]>(
        `INSERT INTO compaction_recovery_deferrals (
           session_id, attempt_id, reason, detail_digest, created_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId ?? null,
        params.attemptId ?? null,
        params.reason,
        sha256Hex(safeDetail(params.detail)),
        params.createdAtMs,
      );
  }
}

function getCompactionRetentionPageSize(limit: number): number | undefined {
  if (!Number.isSafeInteger(limit) || limit <= 0) return undefined;
  return Math.min(COMPACTION_RECONCILIATION_PAGE_SIZE, limit);
}

const PIN_SELECT = `SELECT
  attempt_id, session_id, epoch, source_binding, first_sequence,
  last_sequence, source_sha256, source_bytes, history_digest,
  source_manifest_json, selected_history_indexes_json, policy_digest,
  configuration_digest, accounting_ref,
  automatic, admission_required, planned_provider_calls, state,
  reference_count, created_at_ms, intent_at_ms, committed_at_ms,
  retention_deadline_ms, rollback_extended_until_ms,
  release_tombstone_at_ms, released_at_ms, commit_sha256,
  reference_scan_generation, cleanup_state, projection_state, prune_cursor
FROM compaction_retention_pins`;

function mapPin(row: CompactionPinRow): CompactionPinRecord {
  return {
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    epoch: row.epoch,
    sourceBinding: row.source_binding,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    sourceSha256: row.source_sha256,
    sourceBytes: row.source_bytes,
    historyDigest: row.history_digest,
    activeHistoryRefs: parseSourceManifest(row.source_manifest_json),
    selectedHistoryIndexes: parseSelectedHistoryIndexes(
      row.selected_history_indexes_json,
    ),
    policyDigest: row.policy_digest,
    configurationDigest: row.configuration_digest,
    accountingRef: row.accounting_ref,
    automatic: row.automatic === 1,
    admissionRequired: row.admission_required === 1,
    plannedProviderCalls: row.planned_provider_calls,
    state: row.state,
    referenceCount: row.reference_count,
    createdAtMs: row.created_at_ms,
    ...(row.intent_at_ms !== null ? { intentAtMs: row.intent_at_ms } : {}),
    ...(row.committed_at_ms !== null ? { committedAtMs: row.committed_at_ms } : {}),
    ...(row.retention_deadline_ms !== null
      ? { retentionDeadlineMs: row.retention_deadline_ms }
      : {}),
    ...(row.rollback_extended_until_ms !== null
      ? { rollbackExtendedUntilMs: row.rollback_extended_until_ms }
      : {}),
    ...(row.release_tombstone_at_ms !== null
      ? { releaseTombstoneAtMs: row.release_tombstone_at_ms }
      : {}),
    ...(row.released_at_ms !== null ? { releasedAtMs: row.released_at_ms } : {}),
    ...(row.commit_sha256 !== null ? { commitSha256: row.commit_sha256 } : {}),
    ...(row.reference_scan_generation !== null
      ? { referenceScanGeneration: row.reference_scan_generation }
      : {}),
    cleanupState: row.cleanup_state,
    projectionState: row.projection_state,
    pruneCursor: row.prune_cursor,
  };
}

function assertIntentMatchesPin(
  intent: CompactionIntentV1,
  pin: CompactionPinRecord,
): void {
  if (
    pin.sessionId !== intent.source.session_id ||
    pin.epoch !== intent.source.epoch ||
    pin.sourceBinding !== intent.source.source_binding ||
    pin.firstSequence !== intent.source.first_sequence ||
    pin.lastSequence !== intent.source.last_sequence ||
    pin.sourceSha256 !== intent.source.source_sha256 ||
    pin.sourceBytes !== intent.source.source_bytes ||
    pin.historyDigest !== intent.source.history_digest ||
    canonicalSourceManifest(pin.activeHistoryRefs) !==
      canonicalSourceManifest(intent.source.active_history_refs) ||
    canonicalizeJson(pin.selectedHistoryIndexes) !==
      canonicalizeJson(intent.selected_history_indexes) ||
    pin.policyDigest !== intent.policy_digest ||
    pin.configurationDigest !== intent.configuration_digest ||
    pin.accountingRef !== intent.accounting_ref ||
    pin.automatic !== intent.automatic ||
    pin.admissionRequired !== intent.admission_required ||
    pin.plannedProviderCalls !== intent.planned_provider_calls
  ) {
    throw new CompactionTransactionError(
      "pin_failed",
      "compaction attempt ID is already bound to different immutable input",
    );
  }
}

function assertCommitMatchesPin(
  committed: CompactionCommittedV1,
  pin: CompactionPinRecord,
): void {
  if (
    committed.source.session_id !== pin.sessionId ||
    committed.source.epoch !== pin.epoch ||
    committed.source.source_binding !== pin.sourceBinding ||
    committed.source.first_sequence !== pin.firstSequence ||
    committed.source.last_sequence !== pin.lastSequence ||
    committed.source.source_sha256 !== pin.sourceSha256 ||
    committed.source.source_bytes !== pin.sourceBytes ||
    committed.source.history_digest !== pin.historyDigest ||
    canonicalSourceManifest(committed.source.active_history_refs) !==
      canonicalSourceManifest(pin.activeHistoryRefs) ||
    canonicalizeJson(committed.selected_history_indexes) !==
      canonicalizeJson(pin.selectedHistoryIndexes) ||
    committed.policy_digest !== pin.policyDigest ||
    committed.configuration_digest !== pin.configurationDigest ||
    committed.accounting.accounting_ref !== pin.accountingRef
  ) {
    throw new CompactionTransactionError(
      "commit_failed",
      "compaction commit does not match its immutable retention pin",
    );
  }
}

function canonicalSourceManifest(
  refs: readonly CompactionActiveHistoryRefV1[],
): string {
  return canonicalizeJson(refs);
}

function parseSourceManifest(value: string): readonly CompactionActiveHistoryRefV1[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("compaction source manifest is invalid");
  }
  return parsed as unknown as readonly CompactionActiveHistoryRefV1[];
}

function parseSelectedHistoryIndexes(value: string): readonly number[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 0)
  ) {
    throw new Error("compaction selected-history manifest is invalid");
  }
  return parsed as number[];
}

function parseAttemptIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function safeDetail(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}:${value.message}`;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
