import { randomUUID } from "node:crypto";
import {
  MAX_RECOVERY_BLOCK_HISTORY_PER_RUN,
  MAX_RECOVERY_BLOCK_HISTORY_TOTAL,
  MAX_RECOVERY_CURSOR_UTF8_BYTES,
  MAX_RECOVERY_HISTORY_PAGE_SIZE,
  MAX_RECOVERY_QUARANTINE_INCIDENTS_PER_RUN,
  MAX_RECOVERY_QUARANTINE_INCIDENTS_TOTAL,
  MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT,
  MAX_RECOVERY_SOURCE_PATH_UTF8_BYTES,
  RECOVERY_MINIMUM_READER_RUNTIME,
  CanonicalJournalIntegrityError,
  assertRecoverySha256,
  boundedRecoveryDetail,
  boundedRecoveryNote,
  recoveryDeferredKey,
  recoveryIncidentFingerprint,
  requiredRecoveryText,
  type RecoveryDeferredReasonCode,
  type RecoveryDeferredState,
  type RecoveryIncidentState,
  type RecoveryIntegrityFacts,
  type RecoveryIntegrityReasonCode,
  type RecoverySourceKind,
} from "./recovery-contract.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export class RecoveryHistoryLimitError extends Error {
  constructor(readonly scope: "quarantine" | "deferred") {
    super(
      `durable ${scope} history is full and has no resolved evidence that may be pruned`,
    );
    this.name = "RecoveryHistoryLimitError";
  }
}

export class RecoveryCursorError extends Error {
  constructor(message = "recovery page cursor is invalid") {
    super(message);
    this.name = "RecoveryCursorError";
  }
}

export interface RecoveryQuarantineIncident extends RecoveryIntegrityFacts {
  readonly quarantineId: string;
  readonly incidentFingerprint: string;
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly reasonCode: RecoveryIntegrityReasonCode;
  readonly safeDetail: string;
  readonly sourceSizeBytes: number;
  readonly sourceMtimeMs: number;
  /** Immutable digest of the source bytes that originally caused quarantine. */
  readonly sourceSha256: string;
  /** Digest returned by the successful strict replay that cleared exclusion. */
  readonly confirmedSourceSha256?: string;
  readonly firstDetectedAtMs: number;
  readonly lastDetectedAtMs: number;
  readonly detectionCount: number;
  readonly state: RecoveryIncidentState;
  readonly resolvedAtMs?: number;
  readonly resolutionActor?: string;
  readonly resolutionNote?: string;
  readonly supersedesQuarantineId?: string;
  readonly minimumReaderRuntime: string;
}

export interface RecoveryDeferredBlock {
  readonly blockId: string;
  readonly blockKey: string;
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly reasonCode: RecoveryDeferredReasonCode;
  readonly errorClass: string;
  readonly safeDetail: string;
  readonly attemptCount: number;
  readonly firstFailedAtMs: number;
  readonly lastFailedAtMs: number;
  readonly nextRetryMs: number;
  readonly state: RecoveryDeferredState;
  readonly resolvedAtMs?: number;
  readonly resolutionActor?: string;
  readonly resolutionNote?: string;
  readonly supersedesBlockId?: string;
  readonly minimumReaderRuntime: string;
}

export interface RecoveryAbandonment {
  readonly abandonmentId: string;
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly quarantineId?: string;
  readonly blockId?: string;
  readonly actor: string;
  readonly reason: string;
  readonly abandonedAtMs: number;
  readonly minimumReaderRuntime: string;
}

export interface RecoveryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface RecoveryStrictReplayConfirmation {
  /** SHA-256 computed from the descriptor-pinned bytes that were replayed. */
  readonly sourceSha256: string;
}

interface QuarantineRow {
  readonly quarantine_id: string;
  readonly incident_fingerprint: string;
  readonly run_id: string;
  readonly source_kind: RecoverySourceKind;
  readonly source_path: string;
  readonly reason_code: RecoveryIntegrityReasonCode;
  readonly safe_detail: string;
  readonly line_number: number | null;
  readonly byte_offset: number | null;
  readonly expected_sequence: number | null;
  readonly observed_sequence: number | null;
  readonly source_size_bytes: number;
  readonly source_mtime_ms: number;
  readonly source_sha256: string;
  readonly confirmed_source_sha256: string | null;
  readonly first_detected_at_ms: number;
  readonly last_detected_at_ms: number;
  readonly detection_count: number;
  readonly state: RecoveryIncidentState;
  readonly resolved_at_ms: number | null;
  readonly resolution_actor: string | null;
  readonly resolution_note: string | null;
  readonly supersedes_quarantine_id: string | null;
  readonly minimum_reader_runtime: string;
}

interface DeferredRow {
  readonly block_id: string;
  readonly block_key: string;
  readonly run_id: string;
  readonly source_kind: RecoverySourceKind;
  readonly source_path: string;
  readonly reason_code: RecoveryDeferredReasonCode;
  readonly error_class: string;
  readonly safe_detail: string;
  readonly attempt_count: number;
  readonly first_failed_at_ms: number;
  readonly last_failed_at_ms: number;
  readonly next_retry_ms: number;
  readonly state: RecoveryDeferredState;
  readonly resolved_at_ms: number | null;
  readonly resolution_actor: string | null;
  readonly resolution_note: string | null;
  readonly supersedes_block_id: string | null;
  readonly minimum_reader_runtime: string;
}

interface AbandonmentRow {
  readonly abandonment_id: string;
  readonly run_id: string;
  readonly source_kind: RecoverySourceKind;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly quarantine_id: string | null;
  readonly block_id: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly abandoned_at_ms: number;
  readonly minimum_reader_runtime: string;
}

interface KeysetCursor {
  readonly v: 1;
  readonly scope: "quarantine" | "deferred";
  readonly state: RecoveryIncidentState | RecoveryDeferredState | "all";
  readonly timeMs: number;
  readonly id: string;
}

const QUARANTINE_COLUMNS = `
  quarantine_id, incident_fingerprint, run_id, source_kind, source_path,
  reason_code, safe_detail, line_number, byte_offset, expected_sequence,
  observed_sequence, source_size_bytes, source_mtime_ms, source_sha256,
  confirmed_source_sha256,
  first_detected_at_ms, last_detected_at_ms, detection_count, state,
  resolved_at_ms, resolution_actor, resolution_note,
  supersedes_quarantine_id, minimum_reader_runtime`;

const DEFERRED_COLUMNS = `
  block_id, block_key, run_id, source_kind, source_path, reason_code,
  error_class, safe_detail, attempt_count, first_failed_at_ms,
  last_failed_at_ms, next_retry_ms, state, resolved_at_ms, resolution_actor,
  resolution_note, supersedes_block_id, minimum_reader_runtime`;

const ABANDONMENT_COLUMNS = `
  abandonment_id, run_id, source_kind, source_path, source_sha256,
  quarantine_id, block_id, actor, reason, abandoned_at_ms,
  minimum_reader_runtime`;

/** Durable metadata repository. It never reads or stores journal payloads. */
export class StateRecoveryIncidentRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  recordCanonicalJournalFailure(params: {
    readonly runId: string;
    readonly sourceKind: RecoverySourceKind;
    readonly sourcePath: string;
    readonly error: CanonicalJournalIntegrityError;
    readonly sourceSizeBytes: number;
    readonly sourceMtimeMs: number;
    readonly sourceSha256: string;
    readonly detectedAtMs: number;
  }): RecoveryQuarantineIncident {
    return this.recordQuarantine({
      runId: params.runId,
      sourceKind: params.sourceKind,
      sourcePath: params.sourcePath,
      reasonCode: params.error.reasonCode,
      safeDetail: { message: params.error.message },
      sourceSizeBytes: params.sourceSizeBytes,
      sourceMtimeMs: params.sourceMtimeMs,
      sourceSha256: params.sourceSha256,
      detectedAtMs: params.detectedAtMs,
      facts: params.error.facts,
    });
  }

  recordQuarantine(params: {
    readonly runId: string;
    readonly sourceKind: RecoverySourceKind;
    readonly sourcePath: string;
    readonly reasonCode: RecoveryIntegrityReasonCode;
    readonly safeDetail: unknown;
    readonly sourceSizeBytes: number;
    readonly sourceMtimeMs: number;
    readonly sourceSha256: string;
    readonly detectedAtMs: number;
    readonly facts?: RecoveryIntegrityFacts;
  }): RecoveryQuarantineIncident {
    const normalized = normalizeQuarantineInput(params);
    return this.driver.transactionImmediate(() => {
      const abandoned = this.getAbandonment(normalized.runId);
      if (abandoned !== undefined) {
        throw new Error(`run ${normalized.runId} is permanently abandoned`);
      }
      const active = this.driver
        .prepareState<[string, RecoverySourceKind, string], QuarantineRow>(
          `SELECT ${QUARANTINE_COLUMNS}
           FROM run_recovery_quarantine
           WHERE run_id = ? AND source_kind = ? AND source_path = ?
             AND state = 'active'`,
        )
        .get(normalized.runId, normalized.sourceKind, normalized.sourcePath);
      if (active !== undefined) {
        this.driver
          .prepareState<[number, string]>(
            `UPDATE run_recovery_quarantine
             SET last_detected_at_ms = MAX(last_detected_at_ms, ?),
                 detection_count = detection_count + 1
             WHERE quarantine_id = ?`,
          )
          .run(normalized.detectedAtMs, active.quarantine_id);
        if (active.incident_fingerprint !== normalized.fingerprint) {
          this.recordObservation(active.quarantine_id, normalized);
        }
        return this.requireQuarantine(active.quarantine_id);
      }

      this.makeQuarantineHistoryRoom(normalized.runId);
      const supersedes = this.driver
        .prepareState<
          [string, RecoverySourceKind, string],
          { quarantine_id: string }
        >(
          `SELECT quarantine_id
           FROM run_recovery_quarantine
           WHERE run_id = ? AND source_kind = ? AND source_path = ?
           ORDER BY first_detected_at_ms DESC, quarantine_id DESC
           LIMIT 1`,
        )
        .get(
          normalized.runId,
          normalized.sourceKind,
          normalized.sourcePath,
        )?.quarantine_id;
      const quarantineId = randomUUID();
      this.driver
        .prepareState(
          `INSERT INTO run_recovery_quarantine (
             quarantine_id, incident_fingerprint, run_id, source_kind,
             source_path, reason_code, safe_detail, line_number, byte_offset,
             expected_sequence, observed_sequence, source_size_bytes,
             source_mtime_ms, source_sha256, first_detected_at_ms,
             last_detected_at_ms, supersedes_quarantine_id,
             minimum_reader_runtime
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          quarantineId,
          normalized.fingerprint,
          normalized.runId,
          normalized.sourceKind,
          normalized.sourcePath,
          normalized.reasonCode,
          normalized.safeDetail,
          normalized.facts.lineNumber ?? null,
          normalized.facts.byteOffset ?? null,
          normalized.facts.expectedSequence ?? null,
          normalized.facts.observedSequence ?? null,
          normalized.sourceSizeBytes,
          normalized.sourceMtimeMs,
          normalized.sourceSha256,
          normalized.detectedAtMs,
          normalized.detectedAtMs,
          supersedes ?? null,
          RECOVERY_MINIMUM_READER_RUNTIME,
        );
      return this.requireQuarantine(quarantineId);
    });
  }

  getQuarantine(quarantineId: string): RecoveryQuarantineIncident | undefined {
    const row = this.driver
      .prepareState<[string], QuarantineRow>(
        `SELECT ${QUARANTINE_COLUMNS}
         FROM run_recovery_quarantine WHERE quarantine_id = ?`,
      )
      .get(requiredRecoveryText(quarantineId, "quarantineId"));
    return row === undefined ? undefined : quarantineFromRow(row);
  }

  listQuarantines(
    options: {
      readonly state?: RecoveryIncidentState | "all";
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): RecoveryPage<RecoveryQuarantineIncident> {
    const state = options.state ?? "active";
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor, "quarantine", state);
    const rows = this.driver
      .prepareState<unknown[], QuarantineRow>(
        `SELECT ${QUARANTINE_COLUMNS}
         FROM run_recovery_quarantine
         WHERE (? = 'all' OR state = ?)
           AND (? IS NULL OR last_detected_at_ms < ?
             OR (last_detected_at_ms = ? AND quarantine_id < ?))
         ORDER BY last_detected_at_ms DESC, quarantine_id DESC
         LIMIT ?`,
      )
      .all(
        state,
        state,
        cursor?.timeMs ?? null,
        cursor?.timeMs ?? null,
        cursor?.timeMs ?? null,
        cursor?.id ?? null,
        limit + 1,
      );
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(quarantineFromRow);
    return Object.freeze({
      items: Object.freeze(items),
      ...(rows.length > limit && pageRows.at(-1) !== undefined
        ? {
            nextCursor: encodeCursor({
              v: 1,
              scope: "quarantine",
              state,
              timeMs: pageRows.at(-1)!.last_detected_at_ms,
              id: pageRows.at(-1)!.quarantine_id,
            }),
          }
        : {}),
    });
  }

  repairQuarantine(
    params: {
      readonly quarantineId: string;
      readonly confirmedSourceSha256: string;
      readonly actor: string;
      readonly note: string;
      readonly resolvedAtMs: number;
    },
    strictReplayInTransaction: (
      incident: RecoveryQuarantineIncident,
    ) => RecoveryStrictReplayConfirmation,
  ): RecoveryQuarantineIncident {
    return this.driver.transactionImmediate(() => {
      const incident = this.requireActiveQuarantine(params.quarantineId);
      const confirmedSourceSha256 = assertRecoverySha256(
        params.confirmedSourceSha256,
        "confirmedSourceSha256",
      );
      const replay = strictReplayInTransaction(incident);
      if (replay === null || typeof replay !== "object") {
        throw new Error("strict replay did not return current source evidence");
      }
      const replayedSourceSha256 = assertRecoverySha256(
        replay.sourceSha256,
        "strictReplay.sourceSha256",
      );
      if (replayedSourceSha256 !== confirmedSourceSha256) {
        throw new Error(
          "confirmed current source digest does not match successful strict replay",
        );
      }
      this.resolveQuarantineRow(
        incident.quarantineId,
        "repaired",
        params.actor,
        params.note,
        params.resolvedAtMs,
        confirmedSourceSha256,
      );
      return this.requireQuarantine(incident.quarantineId);
    });
  }

  abandonQuarantine(params: {
    readonly quarantineId: string;
    readonly expectedRunId: string;
    readonly expectedSourceSha256: string;
    readonly actor: string;
    readonly reason: string;
    readonly abandonedAtMs: number;
  }): RecoveryAbandonment {
    return this.driver.transactionImmediate(() => {
      const incident = this.requireActiveQuarantine(params.quarantineId);
      if (
        incident.runId !==
        requiredRecoveryText(params.expectedRunId, "expectedRunId")
      ) {
        throw new Error("confirmed run id does not match quarantined evidence");
      }
      if (
        incident.sourceSha256 !==
        assertRecoverySha256(
          params.expectedSourceSha256,
          "expectedSourceSha256",
        )
      ) {
        throw new Error(
          "confirmed source digest does not match quarantined evidence",
        );
      }
      const abandonment = this.insertAbandonment({
        runId: incident.runId,
        sourceKind: incident.sourceKind,
        sourcePath: incident.sourcePath,
        sourceSha256: incident.sourceSha256,
        quarantineId: incident.quarantineId,
        actor: params.actor,
        reason: params.reason,
        abandonedAtMs: params.abandonedAtMs,
      });
      this.resolveQuarantineRow(
        incident.quarantineId,
        "abandoned",
        params.actor,
        params.reason,
        params.abandonedAtMs,
      );
      return abandonment;
    });
  }

  recordDeferred(params: {
    readonly runId: string;
    readonly sourceKind: RecoverySourceKind;
    readonly sourcePath: string;
    readonly reasonCode: RecoveryDeferredReasonCode;
    readonly errorClass: string;
    readonly safeDetail: unknown;
    readonly failedAtMs: number;
    readonly nextRetryMs: number;
  }): RecoveryDeferredBlock {
    const normalized = normalizeDeferredInput(params);
    return this.driver.transactionImmediate(() => {
      if (this.getAbandonment(normalized.runId) !== undefined) {
        throw new Error(`run ${normalized.runId} is permanently abandoned`);
      }
      const active = this.driver
        .prepareState<[string], DeferredRow>(
          `SELECT ${DEFERRED_COLUMNS}
           FROM run_recovery_deferred WHERE block_key = ? AND state = 'active'`,
        )
        .get(normalized.blockKey);
      if (active !== undefined) {
        this.driver
          .prepareState<[number, number, string]>(
            `UPDATE run_recovery_deferred
             SET attempt_count = attempt_count + 1,
                 last_failed_at_ms = MAX(last_failed_at_ms, ?),
                 next_retry_ms = MAX(next_retry_ms, ?)
             WHERE block_id = ?`,
          )
          .run(normalized.failedAtMs, normalized.nextRetryMs, active.block_id);
        return this.requireDeferred(active.block_id);
      }
      this.makeDeferredHistoryRoom(normalized.runId);
      const supersedes = this.driver
        .prepareState<[string], { block_id: string }>(
          `SELECT block_id FROM run_recovery_deferred
           WHERE block_key = ?
           ORDER BY first_failed_at_ms DESC, block_id DESC LIMIT 1`,
        )
        .get(normalized.blockKey)?.block_id;
      const blockId = randomUUID();
      this.driver
        .prepareState(
          `INSERT INTO run_recovery_deferred (
             block_id, block_key, run_id, source_kind, source_path,
             reason_code, error_class, safe_detail, first_failed_at_ms,
             last_failed_at_ms, next_retry_ms, supersedes_block_id,
             minimum_reader_runtime
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          blockId,
          normalized.blockKey,
          normalized.runId,
          normalized.sourceKind,
          normalized.sourcePath,
          normalized.reasonCode,
          normalized.errorClass,
          normalized.safeDetail,
          normalized.failedAtMs,
          normalized.failedAtMs,
          normalized.nextRetryMs,
          supersedes ?? null,
          RECOVERY_MINIMUM_READER_RUNTIME,
        );
      return this.requireDeferred(blockId);
    });
  }

  getDeferred(blockId: string): RecoveryDeferredBlock | undefined {
    const row = this.driver
      .prepareState<[string], DeferredRow>(
        `SELECT ${DEFERRED_COLUMNS} FROM run_recovery_deferred WHERE block_id = ?`,
      )
      .get(requiredRecoveryText(blockId, "blockId"));
    return row === undefined ? undefined : deferredFromRow(row);
  }

  listDeferred(
    options: {
      readonly state?: RecoveryDeferredState | "all";
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): RecoveryPage<RecoveryDeferredBlock> {
    const state = options.state ?? "active";
    const limit = pageLimit(options.limit);
    const cursor = decodeCursor(options.cursor, "deferred", state);
    const rows = this.driver
      .prepareState<unknown[], DeferredRow>(
        `SELECT ${DEFERRED_COLUMNS}
         FROM run_recovery_deferred
         WHERE (? = 'all' OR state = ?)
           AND (? IS NULL OR last_failed_at_ms < ?
             OR (last_failed_at_ms = ? AND block_id < ?))
         ORDER BY last_failed_at_ms DESC, block_id DESC
         LIMIT ?`,
      )
      .all(
        state,
        state,
        cursor?.timeMs ?? null,
        cursor?.timeMs ?? null,
        cursor?.timeMs ?? null,
        cursor?.id ?? null,
        limit + 1,
      );
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(deferredFromRow);
    return Object.freeze({
      items: Object.freeze(items),
      ...(rows.length > limit && pageRows.at(-1) !== undefined
        ? {
            nextCursor: encodeCursor({
              v: 1,
              scope: "deferred",
              state,
              timeMs: pageRows.at(-1)!.last_failed_at_ms,
              id: pageRows.at(-1)!.block_id,
            }),
          }
        : {}),
    });
  }

  retryDeferred(
    params: {
      readonly blockId: string;
      readonly actor: string;
      readonly note: string;
      readonly resolvedAtMs: number;
    },
    strictReplayInTransaction: (block: RecoveryDeferredBlock) => void,
  ): RecoveryDeferredBlock {
    return this.driver.transactionImmediate(() => {
      const block = this.requireActiveDeferred(params.blockId);
      strictReplayInTransaction(block);
      this.resolveDeferredRow(
        block.blockId,
        "resolved",
        params.actor,
        params.note,
        params.resolvedAtMs,
      );
      return this.requireDeferred(block.blockId);
    });
  }

  abandonDeferred(params: {
    readonly blockId: string;
    readonly expectedRunId: string;
    readonly confirmedSourceSha256: string;
    readonly actor: string;
    readonly reason: string;
    readonly abandonedAtMs: number;
  }): RecoveryAbandonment {
    return this.driver.transactionImmediate(() => {
      const block = this.requireActiveDeferred(params.blockId);
      if (
        block.runId !==
        requiredRecoveryText(params.expectedRunId, "expectedRunId")
      ) {
        throw new Error("confirmed run id does not match deferred evidence");
      }
      const abandonment = this.insertAbandonment({
        runId: block.runId,
        sourceKind: block.sourceKind,
        sourcePath: block.sourcePath,
        sourceSha256: assertRecoverySha256(
          params.confirmedSourceSha256,
          "confirmedSourceSha256",
        ),
        blockId: block.blockId,
        actor: params.actor,
        reason: params.reason,
        abandonedAtMs: params.abandonedAtMs,
      });
      this.resolveDeferredRow(
        block.blockId,
        "abandoned",
        params.actor,
        params.reason,
        params.abandonedAtMs,
      );
      return abandonment;
    });
  }

  getAbandonment(runId: string): RecoveryAbandonment | undefined {
    const row = this.driver
      .prepareState<[string], AbandonmentRow>(
        `SELECT ${ABANDONMENT_COLUMNS}
         FROM run_recovery_abandonments WHERE run_id = ?`,
      )
      .get(requiredRecoveryText(runId, "runId"));
    return row === undefined ? undefined : abandonmentFromRow(row);
  }

  private recordObservation(
    quarantineId: string,
    finding: ReturnType<typeof normalizeQuarantineInput>,
  ): void {
    const existing = this.driver
      .prepareState<[string, string], { observation_id: string }>(
        `SELECT observation_id
         FROM run_recovery_quarantine_observations
         WHERE quarantine_id = ? AND observation_fingerprint = ?`,
      )
      .get(quarantineId, finding.fingerprint);
    if (existing !== undefined) {
      this.driver
        .prepareState<[number, string]>(
          `UPDATE run_recovery_quarantine_observations
           SET observation_count = observation_count + 1,
               last_observed_at_ms = MAX(last_observed_at_ms, ?)
           WHERE observation_id = ?`,
        )
        .run(finding.detectedAtMs, existing.observation_id);
      return;
    }
    const count =
      this.driver
        .prepareState<[string], { count: number }>(
          `SELECT COUNT(*) AS count
         FROM run_recovery_quarantine_observations WHERE quarantine_id = ?`,
        )
        .get(quarantineId)?.count ?? 0;
    if (count >= MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT) return;
    this.driver
      .prepareState(
        `INSERT INTO run_recovery_quarantine_observations (
           observation_id, quarantine_id, observation_fingerprint,
           reason_code, safe_detail, line_number, byte_offset,
           expected_sequence, observed_sequence, first_observed_at_ms,
           last_observed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        quarantineId,
        finding.fingerprint,
        finding.reasonCode,
        finding.safeDetail,
        finding.facts.lineNumber ?? null,
        finding.facts.byteOffset ?? null,
        finding.facts.expectedSequence ?? null,
        finding.facts.observedSequence ?? null,
        finding.detectedAtMs,
        finding.detectedAtMs,
      );
  }

  private resolveQuarantineRow(
    quarantineId: string,
    state: "repaired" | "abandoned",
    actor: string,
    note: string,
    atMs: number,
    confirmedSourceSha256?: string,
  ): void {
    this.driver
      .prepareState<
        [RecoveryIncidentState, number, string, string, string | null, string]
      >(
        `UPDATE run_recovery_quarantine
         SET state = ?, resolved_at_ms = ?, resolution_actor = ?,
             resolution_note = ?, confirmed_source_sha256 = ?
         WHERE quarantine_id = ? AND state = 'active'`,
      )
      .run(
        state,
        nonNegativeSafeInteger(atMs, "resolvedAtMs"),
        requiredRecoveryText(actor, "actor"),
        boundedRecoveryNote(note),
        confirmedSourceSha256 ?? null,
        quarantineId,
      );
  }

  private resolveDeferredRow(
    blockId: string,
    state: "resolved" | "abandoned",
    actor: string,
    note: string,
    atMs: number,
  ): void {
    this.driver
      .prepareState<[RecoveryDeferredState, number, string, string, string]>(
        `UPDATE run_recovery_deferred
         SET state = ?, resolved_at_ms = ?, resolution_actor = ?,
             resolution_note = ?
         WHERE block_id = ? AND state = 'active'`,
      )
      .run(
        state,
        nonNegativeSafeInteger(atMs, "resolvedAtMs"),
        requiredRecoveryText(actor, "actor"),
        boundedRecoveryNote(note),
        blockId,
      );
  }

  private insertAbandonment(params: {
    readonly runId: string;
    readonly sourceKind: RecoverySourceKind;
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly quarantineId?: string;
    readonly blockId?: string;
    readonly actor: string;
    readonly reason: string;
    readonly abandonedAtMs: number;
  }): RecoveryAbandonment {
    const abandonmentId = randomUUID();
    this.driver
      .prepareState(
        `INSERT INTO run_recovery_abandonments (
           abandonment_id, run_id, source_kind, source_path, source_sha256,
           quarantine_id, block_id, actor, reason, abandoned_at_ms,
           minimum_reader_runtime
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        abandonmentId,
        params.runId,
        params.sourceKind,
        params.sourcePath,
        params.sourceSha256,
        params.quarantineId ?? null,
        params.blockId ?? null,
        requiredRecoveryText(params.actor, "actor"),
        boundedRecoveryNote(params.reason),
        nonNegativeSafeInteger(params.abandonedAtMs, "abandonedAtMs"),
        RECOVERY_MINIMUM_READER_RUNTIME,
      );
    return this.getAbandonment(params.runId)!;
  }

  private makeQuarantineHistoryRoom(runId: string): void {
    pruneResolvedHistory(this.driver, {
      table: "run_recovery_quarantine",
      idColumn: "quarantine_id",
      timeColumn: "first_detected_at_ms",
      resolvedState: "repaired",
      runId,
      perRunLimit: MAX_RECOVERY_QUARANTINE_INCIDENTS_PER_RUN,
      totalLimit: MAX_RECOVERY_QUARANTINE_INCIDENTS_TOTAL,
      scope: "quarantine",
    });
  }

  private makeDeferredHistoryRoom(runId: string): void {
    pruneResolvedHistory(this.driver, {
      table: "run_recovery_deferred",
      idColumn: "block_id",
      timeColumn: "first_failed_at_ms",
      resolvedState: "resolved",
      runId,
      perRunLimit: MAX_RECOVERY_BLOCK_HISTORY_PER_RUN,
      totalLimit: MAX_RECOVERY_BLOCK_HISTORY_TOTAL,
      scope: "deferred",
    });
  }

  private requireQuarantine(quarantineId: string): RecoveryQuarantineIncident {
    const incident = this.getQuarantine(quarantineId);
    if (incident === undefined)
      throw new Error(`recovery quarantine not found: ${quarantineId}`);
    return incident;
  }

  private requireActiveQuarantine(
    quarantineId: string,
  ): RecoveryQuarantineIncident {
    const incident = this.requireQuarantine(quarantineId);
    if (incident.state !== "active")
      throw new Error(`recovery quarantine is ${incident.state}`);
    return incident;
  }

  private requireDeferred(blockId: string): RecoveryDeferredBlock {
    const block = this.getDeferred(blockId);
    if (block === undefined)
      throw new Error(`recovery deferred block not found: ${blockId}`);
    return block;
  }

  private requireActiveDeferred(blockId: string): RecoveryDeferredBlock {
    const block = this.requireDeferred(blockId);
    if (block.state !== "active")
      throw new Error(`recovery deferred block is ${block.state}`);
    return block;
  }
}

function normalizeQuarantineInput(params: {
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly reasonCode: RecoveryIntegrityReasonCode;
  readonly safeDetail: unknown;
  readonly sourceSizeBytes: number;
  readonly sourceMtimeMs: number;
  readonly sourceSha256: string;
  readonly detectedAtMs: number;
  readonly facts?: RecoveryIntegrityFacts;
}) {
  const normalized = {
    runId: requiredRecoveryText(params.runId, "runId"),
    sourceKind: sourceKind(params.sourceKind),
    sourcePath: requiredRecoveryText(
      params.sourcePath,
      "sourcePath",
      MAX_RECOVERY_SOURCE_PATH_UTF8_BYTES,
    ),
    reasonCode: params.reasonCode,
    safeDetail: boundedRecoveryDetail(params.safeDetail),
    sourceSizeBytes: nonNegativeSafeInteger(
      params.sourceSizeBytes,
      "sourceSizeBytes",
    ),
    sourceMtimeMs: nonNegativeFiniteNumber(
      params.sourceMtimeMs,
      "sourceMtimeMs",
    ),
    sourceSha256: assertRecoverySha256(params.sourceSha256, "sourceSha256"),
    detectedAtMs: nonNegativeSafeInteger(params.detectedAtMs, "detectedAtMs"),
    facts: normalizeFacts(params.facts),
  };
  return {
    ...normalized,
    fingerprint: recoveryIncidentFingerprint(normalized),
  };
}

function normalizeDeferredInput(params: {
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly reasonCode: RecoveryDeferredReasonCode;
  readonly errorClass: string;
  readonly safeDetail: unknown;
  readonly failedAtMs: number;
  readonly nextRetryMs: number;
}) {
  const failedAtMs = nonNegativeSafeInteger(params.failedAtMs, "failedAtMs");
  const nextRetryMs = nonNegativeSafeInteger(params.nextRetryMs, "nextRetryMs");
  if (nextRetryMs < failedAtMs)
    throw new TypeError("nextRetryMs precedes failedAtMs");
  const normalized = {
    runId: requiredRecoveryText(params.runId, "runId"),
    sourceKind: sourceKind(params.sourceKind),
    sourcePath: requiredRecoveryText(
      params.sourcePath,
      "sourcePath",
      MAX_RECOVERY_SOURCE_PATH_UTF8_BYTES,
    ),
    reasonCode: params.reasonCode,
    errorClass: requiredRecoveryText(params.errorClass, "errorClass"),
    safeDetail: boundedRecoveryDetail(params.safeDetail),
    failedAtMs,
    nextRetryMs,
  };
  return {
    ...normalized,
    blockKey: recoveryDeferredKey(normalized),
  };
}

function normalizeFacts(
  facts: RecoveryIntegrityFacts | undefined,
): RecoveryIntegrityFacts {
  return Object.freeze({
    ...(facts?.lineNumber !== undefined
      ? { lineNumber: positiveSafeInteger(facts.lineNumber, "lineNumber") }
      : {}),
    ...(facts?.byteOffset !== undefined
      ? { byteOffset: nonNegativeSafeInteger(facts.byteOffset, "byteOffset") }
      : {}),
    ...(facts?.expectedSequence !== undefined
      ? {
          expectedSequence: positiveSafeInteger(
            facts.expectedSequence,
            "expectedSequence",
          ),
        }
      : {}),
    ...(facts?.observedSequence !== undefined
      ? {
          observedSequence: positiveSafeInteger(
            facts.observedSequence,
            "observedSequence",
          ),
        }
      : {}),
  });
}

function quarantineFromRow(row: QuarantineRow): RecoveryQuarantineIncident {
  return Object.freeze({
    quarantineId: row.quarantine_id,
    incidentFingerprint: row.incident_fingerprint,
    runId: row.run_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    reasonCode: row.reason_code,
    safeDetail: row.safe_detail,
    ...(row.line_number !== null ? { lineNumber: row.line_number } : {}),
    ...(row.byte_offset !== null ? { byteOffset: row.byte_offset } : {}),
    ...(row.expected_sequence !== null
      ? { expectedSequence: row.expected_sequence }
      : {}),
    ...(row.observed_sequence !== null
      ? { observedSequence: row.observed_sequence }
      : {}),
    sourceSizeBytes: row.source_size_bytes,
    sourceMtimeMs: row.source_mtime_ms,
    sourceSha256: row.source_sha256,
    ...(row.confirmed_source_sha256 !== null
      ? { confirmedSourceSha256: row.confirmed_source_sha256 }
      : {}),
    firstDetectedAtMs: row.first_detected_at_ms,
    lastDetectedAtMs: row.last_detected_at_ms,
    detectionCount: row.detection_count,
    state: row.state,
    ...(row.resolved_at_ms !== null
      ? { resolvedAtMs: row.resolved_at_ms }
      : {}),
    ...(row.resolution_actor !== null
      ? { resolutionActor: row.resolution_actor }
      : {}),
    ...(row.resolution_note !== null
      ? { resolutionNote: row.resolution_note }
      : {}),
    ...(row.supersedes_quarantine_id !== null
      ? { supersedesQuarantineId: row.supersedes_quarantine_id }
      : {}),
    minimumReaderRuntime: row.minimum_reader_runtime,
  });
}

function deferredFromRow(row: DeferredRow): RecoveryDeferredBlock {
  return Object.freeze({
    blockId: row.block_id,
    blockKey: row.block_key,
    runId: row.run_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    reasonCode: row.reason_code,
    errorClass: row.error_class,
    safeDetail: row.safe_detail,
    attemptCount: row.attempt_count,
    firstFailedAtMs: row.first_failed_at_ms,
    lastFailedAtMs: row.last_failed_at_ms,
    nextRetryMs: row.next_retry_ms,
    state: row.state,
    ...(row.resolved_at_ms !== null
      ? { resolvedAtMs: row.resolved_at_ms }
      : {}),
    ...(row.resolution_actor !== null
      ? { resolutionActor: row.resolution_actor }
      : {}),
    ...(row.resolution_note !== null
      ? { resolutionNote: row.resolution_note }
      : {}),
    ...(row.supersedes_block_id !== null
      ? { supersedesBlockId: row.supersedes_block_id }
      : {}),
    minimumReaderRuntime: row.minimum_reader_runtime,
  });
}

function abandonmentFromRow(row: AbandonmentRow): RecoveryAbandonment {
  return Object.freeze({
    abandonmentId: row.abandonment_id,
    runId: row.run_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    sourceSha256: row.source_sha256,
    ...(row.quarantine_id !== null ? { quarantineId: row.quarantine_id } : {}),
    ...(row.block_id !== null ? { blockId: row.block_id } : {}),
    actor: row.actor,
    reason: row.reason,
    abandonedAtMs: row.abandoned_at_ms,
    minimumReaderRuntime: row.minimum_reader_runtime,
  });
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_RECOVERY_HISTORY_PAGE_SIZE;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_RECOVERY_HISTORY_PAGE_SIZE
  ) {
    throw new TypeError(
      `page limit must be between 1 and ${MAX_RECOVERY_HISTORY_PAGE_SIZE}`,
    );
  }
  return limit;
}

function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  encoded: string | undefined,
  scope: KeysetCursor["scope"],
  state: KeysetCursor["state"],
): KeysetCursor | undefined {
  if (encoded === undefined) return undefined;
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECOVERY_CURSOR_UTF8_BYTES) {
    throw new RecoveryCursorError();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new RecoveryCursorError();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RecoveryCursorError();
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "id,scope,state,timeMs,v" ||
    candidate.v !== 1 ||
    candidate.scope !== scope ||
    candidate.state !== state ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    !Number.isSafeInteger(candidate.timeMs) ||
    (candidate.timeMs as number) < 0
  ) {
    throw new RecoveryCursorError();
  }
  return candidate as unknown as KeysetCursor;
}

function pruneResolvedHistory(
  driver: StateSqliteDriver,
  options: {
    readonly table: "run_recovery_quarantine" | "run_recovery_deferred";
    readonly idColumn: "quarantine_id" | "block_id";
    readonly timeColumn: "first_detected_at_ms" | "first_failed_at_ms";
    readonly resolvedState: "repaired" | "resolved";
    readonly runId: string;
    readonly perRunLimit: number;
    readonly totalLimit: number;
    readonly scope: "quarantine" | "deferred";
  },
): void {
  const runCount =
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${options.table} WHERE run_id = ?`,
      )
      .get(options.runId)?.count ?? 0;
  if (runCount >= options.perRunLimit) {
    const deleted = driver
      .prepareState<[string, string]>(
        `DELETE FROM ${options.table}
         WHERE ${options.idColumn} = (
           SELECT ${options.idColumn} FROM ${options.table}
           WHERE run_id = ? AND state = ?
           ORDER BY ${options.timeColumn} ASC, ${options.idColumn} ASC LIMIT 1
         )`,
      )
      .run(options.runId, options.resolvedState).changes;
    if (deleted === 0) throw new RecoveryHistoryLimitError(options.scope);
  }
  const total =
    driver
      .prepareState<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${options.table}`,
      )
      .get()?.count ?? 0;
  if (total >= options.totalLimit) {
    const deleted = driver
      .prepareState<[string]>(
        `DELETE FROM ${options.table}
         WHERE ${options.idColumn} = (
           SELECT ${options.idColumn} FROM ${options.table}
           WHERE state = ?
           ORDER BY ${options.timeColumn} ASC, ${options.idColumn} ASC LIMIT 1
         )`,
      )
      .run(options.resolvedState).changes;
    if (deleted === 0) throw new RecoveryHistoryLimitError(options.scope);
  }
}

function sourceKind(value: RecoverySourceKind): RecoverySourceKind {
  if (value !== "rollout" && value !== "run_journal") {
    throw new TypeError("recovery source kind is invalid");
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative finite number");
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
