import type {
  RecoveryDeferredReasonCode,
  RecoveryIntegrityReasonCode,
  RecoverySourceKind,
} from "./recovery-contract.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export type RecoveryRunExclusionKind =
  "abandoned" | "quarantine" | "deferred" | "storage_unavailable";

export interface RecoveryRunExclusion {
  readonly runId: string;
  readonly kind: RecoveryRunExclusionKind;
  readonly evidenceId?: string;
  readonly sourceKind?: RecoverySourceKind;
  readonly sourcePath?: string;
  readonly reasonCode?:
    RecoveryIntegrityReasonCode | RecoveryDeferredReasonCode;
  readonly safeDetail: string;
  readonly permanent: boolean;
  readonly nextRetryMs?: number;
}

interface RecoveryRunExclusionRow {
  readonly run_id: string;
  readonly kind: Exclude<RecoveryRunExclusionKind, "storage_unavailable">;
  readonly evidence_id: string;
  readonly source_kind: RecoverySourceKind;
  readonly source_path: string;
  readonly reason_code:
    RecoveryIntegrityReasonCode | RecoveryDeferredReasonCode | null;
  readonly safe_detail: string;
  readonly next_retry_ms: number | null;
}

/**
 * One authoritative SQL predicate shared by every recoverable-run selector.
 * The expression is deliberately restricted to a column or qualified column;
 * callers cannot inject arbitrary SQL through this helper.
 */
export function recoveryRunIsExecutableSql(runIdExpression: string): string {
  assertSqlColumnExpression(runIdExpression, "run-id");
  return `
    NOT EXISTS (
      SELECT 1 FROM run_recovery_abandonments AS recovery_abandonment
      WHERE recovery_abandonment.run_id = ${runIdExpression}
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_recovery_quarantine AS recovery_quarantine
      WHERE recovery_quarantine.run_id = ${runIdExpression}
        AND recovery_quarantine.state = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_recovery_deferred AS recovery_deferred
      WHERE recovery_deferred.run_id = ${runIdExpression}
        AND recovery_deferred.state = 'active'
    )`;
}

/** Exclude tool restoration for any session owned by an excluded run. */
export function recoverySessionIsExecutableSql(
  sessionIdExpression: string,
): string {
  assertSqlColumnExpression(sessionIdExpression, "session-id");
  return `
    NOT EXISTS (
      SELECT 1 FROM agent_runs AS recovery_run_owner
      WHERE (recovery_run_owner.id = ${sessionIdExpression}
          OR recovery_run_owner.current_session_id = ${sessionIdExpression})
        AND NOT (${recoveryRunIsExecutableSql("recovery_run_owner.id")})
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_journal_bindings AS recovery_binding_owner
      WHERE recovery_binding_owner.session_id = ${sessionIdExpression}
        AND NOT (${recoveryRunIsExecutableSql("recovery_binding_owner.run_id")})
    )`;
}

/** Return the highest-priority durable reason a run must not execute. */
export function getRecoveryRunExclusion(
  driver: StateSqliteDriver,
  runId: string,
): RecoveryRunExclusion | undefined {
  const row = driver
    .prepareState<[string, string, string], RecoveryRunExclusionRow>(
      `SELECT run_id, kind, evidence_id, source_kind, source_path,
              reason_code, safe_detail, next_retry_ms
       FROM (
         SELECT abandonment.run_id AS run_id,
                'abandoned' AS kind,
                abandonment.abandonment_id AS evidence_id,
                abandonment.source_kind AS source_kind,
                abandonment.source_path AS source_path,
                NULL AS reason_code,
                abandonment.reason AS safe_detail,
                NULL AS next_retry_ms,
                1 AS priority
         FROM run_recovery_abandonments AS abandonment
         WHERE abandonment.run_id = ?
         UNION ALL
         SELECT quarantine.run_id, 'quarantine', quarantine.quarantine_id,
                quarantine.source_kind, quarantine.source_path,
                quarantine.reason_code, quarantine.safe_detail, NULL, 2
         FROM run_recovery_quarantine AS quarantine
         WHERE quarantine.run_id = ? AND quarantine.state = 'active'
         UNION ALL
         SELECT deferred.run_id, 'deferred', deferred.block_id,
                deferred.source_kind, deferred.source_path,
                deferred.reason_code, deferred.safe_detail,
                deferred.next_retry_ms, 3
         FROM run_recovery_deferred AS deferred
         WHERE deferred.run_id = ? AND deferred.state = 'active'
       )
       ORDER BY priority ASC, evidence_id ASC
       LIMIT 1`,
    )
    .get(runId, runId, runId);
  if (row === undefined) return undefined;
  return Object.freeze({
    runId: row.run_id,
    kind: row.kind,
    evidenceId: row.evidence_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    ...(row.reason_code !== null ? { reasonCode: row.reason_code } : {}),
    safeDetail: row.safe_detail,
    permanent: row.kind === "abandoned",
    ...(row.next_retry_ms !== null ? { nextRetryMs: row.next_retry_ms } : {}),
  });
}

export function storageUnavailableRecoveryExclusion(
  runId: string,
  safeDetail: string,
): RecoveryRunExclusion {
  return Object.freeze({
    runId,
    kind: "storage_unavailable",
    reasonCode: "recovery_storage_unavailable",
    safeDetail,
    permanent: false,
  });
}

function assertSqlColumnExpression(expression: string, label: string): void {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/u.test(expression)) {
    throw new TypeError(`recovery ${label} SQL expression is invalid`);
  }
}
