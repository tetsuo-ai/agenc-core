import type {
  ToolPairIntegrityFailure,
  ToolPairOperationalDeferral,
  ToolPairProjection,
  ToolPairProjectionRecord,
  ToolPairProjectionSummary,
} from "../session/tool-pair-validator.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export const MAX_TOOL_PAIR_PROJECTION_ID_BYTES = 4_096;
export const MAX_TOOL_PAIR_SOURCE_KEY_BYTES = 4_096;

interface ProjectionEntryRow {
  readonly call_id: string;
  readonly tool_name: string;
  readonly assistant_index: number;
  readonly result_index: number | null;
  readonly result_id: string | null;
  readonly original_result_digest: string | null;
}

/** SQLite implementation of the rebuildable exact tool-pair projection. */
export class StateToolPairProjection implements ToolPairProjection {
  constructor(
    private readonly driver: StateSqliteDriver,
    private readonly options: {
      /** Offline staging projections are deleted before their transaction commits. */
      readonly discardOnTerminal?: boolean;
    } = {},
  ) {}

  runAtomically<T>(operation: () => T): T {
    return this.driver.transactionImmediate(operation);
  }

  reset(params: {
    readonly projectionId: string;
    readonly sourceKey: string;
  }): void {
    requireBoundedText(
      params.projectionId,
      "projectionId",
      MAX_TOOL_PAIR_PROJECTION_ID_BYTES,
    );
    requireBoundedText(
      params.sourceKey,
      "sourceKey",
      MAX_TOOL_PAIR_SOURCE_KEY_BYTES,
    );
    this.driver
      .prepareState<[string]>(
        "DELETE FROM tool_pair_projection_runs WHERE projection_id = ?",
      )
      .run(params.projectionId);
    this.driver
      .prepareState<[string, string]>(
        `INSERT INTO tool_pair_projection_runs (
           projection_id, source_key, status
         ) VALUES (?, ?, 'building')`,
      )
      .run(params.projectionId, params.sourceKey);
  }

  find(
    projectionId: string,
    callId: string,
  ): ToolPairProjectionRecord | undefined {
    const row = this.driver
      .prepareState<[string, string], ProjectionEntryRow>(
        `SELECT call_id, tool_name, assistant_index, result_index,
                result_id, original_result_digest
         FROM tool_pair_projection_entries
         WHERE projection_id = ? AND call_id = ?`,
      )
      .get(projectionId, callId);
    return row === undefined ? undefined : recordFromRow(row);
  }

  insertCall(
    projectionId: string,
    record: ToolPairProjectionRecord,
  ): boolean {
    const result = this.driver
      .prepareState<[string, string, string, number]>(
        `INSERT OR IGNORE INTO tool_pair_projection_entries (
           projection_id, call_id, tool_name, assistant_index
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        projectionId,
        record.callId,
        record.toolName,
        record.assistantIndex,
      );
    return result.changes === 1;
  }

  resolveCall(params: {
    readonly projectionId: string;
    readonly callId: string;
    readonly resultIndex: number;
    readonly resultId?: string;
    readonly originalResultDigest?: string;
  }): "resolved" | "already_resolved" | "missing" {
    const result = this.driver
      .prepareState<
        [number, string | null, string | null, string, string]
      >(
        `UPDATE tool_pair_projection_entries
         SET result_index = ?, result_id = ?, original_result_digest = ?
         WHERE projection_id = ? AND call_id = ? AND result_index IS NULL`,
      )
      .run(
        params.resultIndex,
        params.resultId ?? null,
        params.originalResultDigest ?? null,
        params.projectionId,
        params.callId,
      );
    if (result.changes === 1) return "resolved";
    const existing = this.find(params.projectionId, params.callId);
    if (existing === undefined) return "missing";
    return existing.resultIndex === undefined ? "missing" : "already_resolved";
  }

  complete(
    projectionId: string,
    summary: ToolPairProjectionSummary,
  ): void {
    this.updateTerminalStatus(projectionId, "valid", summary);
  }

  completeDangling(
    projectionId: string,
    summary: ToolPairProjectionSummary,
  ): void {
    this.updateTerminalStatus(projectionId, "dangling", summary);
  }

  fail(
    projectionId: string,
    summary: ToolPairProjectionSummary,
    failure: ToolPairIntegrityFailure | ToolPairOperationalDeferral,
  ): void {
    const status =
      failure.kind === "integrity_failure" ? "invalid" : "deferred";
    const result = this.driver
      .prepareState<
        [string, number, number, number, number, number, string, string, number | null, string, string]
      >(
        `UPDATE tool_pair_projection_runs
         SET status = ?, call_count = ?, resolved_count = ?,
             open_call_count = ?, maximum_open_call_count = ?,
             logical_index_bytes = ?, failure_kind = ?, failure_code = ?,
             failure_index = ?, failure_reason = ?
         WHERE projection_id = ? AND status = 'building'`,
      )
      .run(
        status,
        summary.callCount,
        summary.resolvedCount,
        summary.openCallCount,
        summary.maximumOpenCallCount,
        summary.logicalIndexBytes,
        failure.kind,
        failure.code,
        failure.index,
        failure.reason,
        projectionId,
      );
    if (result.changes !== 1) {
      throw new Error(`tool-pair projection ${projectionId} is not building`);
    }
    this.discardIfEphemeral(projectionId);
  }

  private updateTerminalStatus(
    projectionId: string,
    status: "valid" | "dangling",
    summary: ToolPairProjectionSummary,
  ): void {
    const result = this.driver
      .prepareState<
        [string, number, number, number, number, number, string]
      >(
        `UPDATE tool_pair_projection_runs
         SET status = ?, call_count = ?, resolved_count = ?,
             open_call_count = ?, maximum_open_call_count = ?,
             logical_index_bytes = ?
         WHERE projection_id = ? AND status = 'building'`,
      )
      .run(
        status,
        summary.callCount,
        summary.resolvedCount,
        summary.openCallCount,
        summary.maximumOpenCallCount,
        summary.logicalIndexBytes,
        projectionId,
      );
    if (result.changes !== 1) {
      throw new Error(`tool-pair projection ${projectionId} is not building`);
    }
    this.discardIfEphemeral(projectionId);
  }

  private discardIfEphemeral(projectionId: string): void {
    if (this.options.discardOnTerminal !== true) return;
    this.driver
      .prepareState<[string]>(
        "DELETE FROM tool_pair_projection_runs WHERE projection_id = ?",
      )
      .run(projectionId);
  }
}

function recordFromRow(row: ProjectionEntryRow): ToolPairProjectionRecord {
  return {
    callId: row.call_id,
    toolName: row.tool_name,
    assistantIndex: row.assistant_index,
    ...(row.result_index === null ? {} : { resultIndex: row.result_index }),
    ...(row.result_id === null ? {} : { resultId: row.result_id }),
    ...(row.original_result_digest === null
      ? {}
      : { originalResultDigest: row.original_result_digest }),
  };
}

function requireBoundedText(
  value: string,
  field: string,
  maxBytes: number,
): void {
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
}
