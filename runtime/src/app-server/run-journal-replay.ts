import type BetterSqlite3 from "better-sqlite3";

import type {
  JsonObject,
  JsonValue,
  RunJournalCategory,
  RunJournalEvent,
  RunReplayResult,
} from "./protocol/index.js";
import type { StateDatabasePaths } from "../state/sqlite-driver.js";
import { isRecord } from "../utils/record.js";

interface RolloutEventRow {
  readonly event_seq: number;
  readonly event_id: string | null;
  readonly payload_json: string;
  readonly variant_count: number;
}

interface CanonicalRolloutEventRow extends RolloutEventRow {
  readonly event_id: string;
}

interface ReplayableRolloutEventRow extends CanonicalRolloutEventRow {
  readonly envelope: JsonObject;
}

interface BoundsRow {
  readonly first_sequence: number | null;
  readonly last_sequence: number | null;
}

interface IdentityConflictRow {
  readonly event_id: string;
}

interface ThreadSourceRow {
  readonly rollout_path: string | null;
  readonly archived_rollout_path: string | null;
}

interface JournalSourceScope {
  readonly predicate: string;
  readonly params: readonly unknown[];
  readonly known: boolean;
  readonly firstAvailableSequence?: number;
  readonly lastSequence?: number;
  readonly retiredThroughSequence?: number;
  readonly gapReason?: "retention" | "corruption_truncated" | "compaction";
}

/**
 * Serve one contiguous page from the SQLite projection of the canonical JSONL
 * rollout. The projection can be rebuilt at any time; it never becomes a
 * second journal authority.
 */
export function buildCanonicalRunReplay(
  db: BetterSqlite3.Database,
  paths: StateDatabasePaths,
  runId: string,
  afterSequence: number,
  limit: number,
): RunReplayResult {
  if (!tableExists(db, "thread_rollout_items")) {
    return unavailableReplay(paths, runId, afterSequence, limit);
  }

  const sourceScope = journalSourceScope(db, runId);
  const bounds = db
    .prepare<unknown[], BoundsRow>(
      `SELECT MIN(event_seq) AS first_sequence,
              MAX(event_seq) AS last_sequence
       FROM thread_rollout_items
       WHERE ${sourceScope.predicate} AND item_type = 'event_msg'
         AND event_seq IS NOT NULL`,
    )
    .get(...sourceScope.params) ?? {
    first_sequence: null,
    last_sequence: null,
  };

  const sourceKnown =
    sourceScope.known ||
    bounds.first_sequence !== null ||
    threadExists(db, runId);
  if (!sourceKnown) {
    return unavailableReplay(paths, runId, afterSequence, limit);
  }

  const source = {
    kind: "run_journal" as const,
    available: true,
    sequenceScope: "run" as const,
    canonical: "rollout_jsonl" as const,
    projection: "thread_rollout_items" as const,
    projectDir: paths.projectDir,
  };
  if (bounds.first_sequence === null || bounds.last_sequence === null) {
    const retiredThrough = sourceScope.retiredThroughSequence;
    const lastAvailableSequence = Math.max(
      sourceScope.lastSequence ?? 0,
      retiredThrough ?? 0,
    );
    if (
      sourceScope.gapReason !== undefined &&
      retiredThrough !== undefined &&
      afterSequence < retiredThrough
    ) {
      const firstAvailableSequence =
        sourceScope.firstAvailableSequence ?? retiredThrough + 1;
      return {
        runId,
        afterSequence,
        limit,
        events: [],
        hasMore: false,
        nextAfterSequence: afterSequence,
        firstAvailableSequence,
        lastAvailableSequence,
        gap: {
          kind: "event_gap",
          runId,
          afterSequence,
          firstAvailableSequence,
          reason: sourceScope.gapReason,
        },
        source,
      };
    }
    if (afterSequence > lastAvailableSequence) {
      return {
        runId,
        afterSequence,
        limit,
        events: [],
        hasMore: false,
        nextAfterSequence: afterSequence,
        lastAvailableSequence,
        gap: {
          kind: "cursor_ahead",
          runId,
          afterSequence,
          lastAvailableSequence,
          reason: "cursor_ahead",
        },
        source,
      };
    }
    return {
      runId,
      afterSequence,
      limit,
      events: [],
      hasMore: false,
      nextAfterSequence: afterSequence,
      gap: null,
      source,
    };
  }

  if (afterSequence + 1 < bounds.first_sequence) {
    return {
      runId,
      afterSequence,
      limit,
      events: [],
      hasMore: true,
      nextAfterSequence: afterSequence,
      firstAvailableSequence: bounds.first_sequence,
      lastAvailableSequence: bounds.last_sequence,
      gap: {
        kind: "event_gap",
        runId,
        afterSequence,
        firstAvailableSequence: bounds.first_sequence,
        reason:
          sourceScope.gapReason ??
          (sourceContainsCompaction(db, sourceScope)
            ? "compaction"
            : "corruption_truncated"),
      },
      source,
    };
  }

  if (afterSequence > bounds.last_sequence) {
    return {
      runId,
      afterSequence,
      limit,
      events: [],
      hasMore: false,
      nextAfterSequence: afterSequence,
      firstAvailableSequence: bounds.first_sequence,
      lastAvailableSequence: bounds.last_sequence,
      gap: {
        kind: "cursor_ahead",
        runId,
        afterSequence,
        lastAvailableSequence: bounds.last_sequence,
        reason: "cursor_ahead",
      },
      source,
    };
  }

  const rows = db
    .prepare<unknown[], RolloutEventRow>(
      `WITH variants AS (
         SELECT event_seq, event_id, payload_json,
                MIN(id) AS representative_id
         FROM thread_rollout_items
         WHERE ${sourceScope.predicate} AND item_type = 'event_msg'
           AND event_seq > ?
         GROUP BY event_seq, event_id, payload_json
       ), grouped AS (
         SELECT event_seq, MIN(representative_id) AS representative_id,
                COUNT(*) AS variant_count
         FROM variants
         GROUP BY event_seq
         ORDER BY event_seq ASC
         LIMIT ?
       )
       SELECT grouped.event_seq, grouped.variant_count,
              item.event_id, item.payload_json
       FROM grouped
       JOIN thread_rollout_items AS item
         ON item.id = grouped.representative_id
       ORDER BY grouped.event_seq ASC`,
    )
    .all(...sourceScope.params, afterSequence, limit + 1);

  // Identity reuse only needs to be checked for events this page could expose.
  // Looking up those bounded candidate ids through the replay identity indexes
  // retains the fail-closed contract without rescanning the complete journal on
  // every page.
  const conflictingIds = conflictingEventIds(db, sourceScope, rows);

  const contiguous: ReplayableRolloutEventRow[] = [];
  let expected = afterSequence + 1;
  let gapFirst: number | undefined;
  for (const row of rows) {
    if (row.event_seq > expected) {
      gapFirst = row.event_seq;
      break;
    }
    if (row.variant_count !== 1 || !hasCanonicalEventId(row)) {
      gapFirst = row.event_seq;
      break;
    }
    if (conflictingIds.has(row.event_id)) {
      gapFirst = row.event_seq;
      break;
    }
    const envelope = parseEventEnvelope(row.payload_json);
    if (envelope === undefined || !projectionMatchesEnvelope(row, envelope)) {
      gapFirst = row.event_seq;
      break;
    }
    contiguous.push({ ...row, envelope });
    expected += 1;
    if (contiguous.length === limit) break;
  }

  const events = contiguous.map((row) => rolloutEvent(row, runId));
  const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence;
  const gap = gapFirst === undefined
    ? null
    : {
        kind: "event_gap" as const,
        runId,
        afterSequence: nextAfterSequence,
        firstAvailableSequence: gapFirst,
        reason: "corruption_truncated" as const,
      };
  return {
    runId,
    afterSequence,
    limit,
    events,
    hasMore:
      gap !== null ||
      rows.length > contiguous.length ||
      nextAfterSequence < bounds.last_sequence,
    nextAfterSequence,
    firstAvailableSequence: gapFirst ?? bounds.first_sequence,
    lastAvailableSequence: bounds.last_sequence,
    gap,
    source,
  };
}

function hasCanonicalEventId(
  row: RolloutEventRow,
): row is CanonicalRolloutEventRow {
  return (
    Number.isSafeInteger(row.event_seq) &&
    row.event_seq > 0 &&
    typeof row.event_id === "string" &&
    row.event_id.length > 0
  );
}

function projectionMatchesEnvelope(
  row: CanonicalRolloutEventRow,
  envelope: JsonObject,
): boolean {
  if (envelope.seq !== row.event_seq) return false;
  const explicitEventId = stringValue(envelope.eventId);
  const legacyId = stringValue(envelope.id);
  const projectedEventId =
    explicitEventId ??
    (legacyId === undefined
      ? undefined
      : `legacy-event:${String(row.event_seq)}:${legacyId}`);
  return projectedEventId === row.event_id;
}

function conflictingEventIds(
  db: BetterSqlite3.Database,
  sourceScope: JournalSourceScope,
  rows: readonly RolloutEventRow[],
): ReadonlySet<string> {
  const candidateIds = [
    ...new Set(
      rows
        .map((row) => row.event_id)
        .filter((eventId): eventId is string =>
          typeof eventId === "string" && eventId.length > 0
        ),
    ),
  ];
  if (candidateIds.length === 0) return new Set();
  const candidatePlaceholders = candidateIds.map(() => "?").join(", ");
  const conflicts = db
    .prepare<unknown[], IdentityConflictRow>(
      `WITH variants AS (
         SELECT event_id, event_seq, payload_json
         FROM thread_rollout_items
         WHERE ${sourceScope.predicate} AND item_type = 'event_msg'
           AND event_seq IS NOT NULL
           AND event_id IN (${candidatePlaceholders})
         GROUP BY event_id, event_seq, payload_json
       )
       SELECT event_id
       FROM variants
       GROUP BY event_id
       HAVING COUNT(*) > 1`,
    )
    .all(...sourceScope.params, ...candidateIds);
  return new Set(conflicts.map((row) => row.event_id));
}

function unavailableReplay(
  paths: StateDatabasePaths,
  runId: string,
  afterSequence: number,
  limit: number,
): RunReplayResult {
  return {
    runId,
    afterSequence,
    limit,
    events: [],
    hasMore: false,
    nextAfterSequence: afterSequence,
    gap: {
      kind: "source_unavailable",
      reason: "run_journal_not_present",
    },
    source: {
      kind: "run_journal",
      available: false,
      sequenceScope: "run",
      canonical: "rollout_jsonl",
      projection: "thread_rollout_items",
      projectDir: paths.projectDir,
    },
  };
}

function rolloutEvent(
  row: ReplayableRolloutEventRow,
  runId: string,
): RunJournalEvent {
  const envelope = row.envelope;
  const msg = asObject(envelope.msg) ?? {};
  const type = stringValue(msg.type) ?? "unknown";
  const payload = jsonValue(msg.payload);
  const payloadObject = asObject(payload) ?? {};
  const event = stringValue(payloadObject.event) ?? type;
  const timestamp = firstString(payloadObject, [
    "recordedAt",
    "timestamp",
    "transitionAt",
    "finishedAt",
    "acceptedAt",
  ]);
  const stepId = firstString(payloadObject, ["stepId", "turnId", "callId"]);
  const sessionId = firstString(payloadObject, ["sessionId"]);
  const childRunId = firstString(payloadObject, ["childRunId"]);
  const reason = firstString(payloadObject, ["reason"]);
  return {
    sequence: row.event_seq,
    eventId: row.event_id,
    runId,
    ...(childRunId !== undefined ? { childRunId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(stepId !== undefined ? { stepId } : {}),
    category: categoryFor(type),
    kind: type,
    event,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...legacyAdmissionFields(payloadObject),
  };
}

function legacyAdmissionFields(payload: JsonObject): Partial<RunJournalEvent> {
  return {
    ...(stringValue(payload.reservationId) !== undefined
      ? { reservationId: stringValue(payload.reservationId) }
      : {}),
    ...(stringValue(payload.model) !== undefined
      ? { model: stringValue(payload.model) }
      : {}),
    ...(stringValue(payload.provider) !== undefined
      ? { provider: stringValue(payload.provider) }
      : {}),
    ...(finiteNumber(payload.reservedTokens) !== undefined
      ? { reservedTokens: finiteNumber(payload.reservedTokens) }
      : {}),
    ...(finiteNumber(payload.reservedCostUsd) !== undefined
      ? { reservedCostUsd: finiteNumber(payload.reservedCostUsd) }
      : {}),
    ...(finiteNumber(payload.actualTokens) !== undefined
      ? { actualTokens: finiteNumber(payload.actualTokens) }
      : {}),
    ...(finiteNumber(payload.actualCostUsd) !== undefined
      ? { actualCostUsd: finiteNumber(payload.actualCostUsd) }
      : {}),
    ...(asObject(payload.details) !== undefined
      ? { details: asObject(payload.details) }
      : {}),
  };
}

function categoryFor(type: string): RunJournalCategory {
  if (type === "execution_admission") return "admission";
  if (type === "token_count") return "budget";
  if (type === "request_permissions" || type.startsWith("permission_")) {
    return "permission";
  }
  if (type.includes("approval")) return "approval";
  if (type.startsWith("effect_")) return "effect";
  if (type.startsWith("artifact_")) return "artifact";
  if (type.includes("cancel") || type === "turn_aborted") return "cancellation";
  if (type.includes("resum") || type.startsWith("recovery_")) return "recovery";
  if (type === "run_terminal") return "terminal";
  if (type.startsWith("turn_") || type.startsWith("collab_")) return "step";
  if (
    type.startsWith("agent_message") ||
    type.startsWith("agent_thinking") ||
    type.startsWith("assistant_thinking")
  ) {
    return "model";
  }
  return "session";
}

function selectedSourcePath(
  db: BetterSqlite3.Database,
  runId: string,
): string | undefined {
  if (!tableExists(db, "threads")) return undefined;
  const row = db
    .prepare<[string], ThreadSourceRow>(
      `SELECT rollout_path, archived_rollout_path
       FROM threads WHERE thread_id = ? LIMIT 1`,
    )
    .get(runId);
  return row?.rollout_path ?? row?.archived_rollout_path ?? undefined;
}

function journalSourceScope(
  db: BetterSqlite3.Database,
  runId: string,
): JournalSourceScope {
  if (tableExists(db, "run_journal_bindings")) {
    const binding = db
      .prepare<
        [string, string],
        {
          readonly source_count: number;
          readonly first_available_sequence: number | null;
          readonly last_sequence: number | null;
          readonly retired_through_sequence: number | null;
          readonly gap_reason:
            | "retention"
            | "corruption_truncated"
            | "compaction"
            | null;
        }
      >(
        `SELECT COUNT(*) AS source_count,
                MIN(first_available_sequence) AS first_available_sequence,
                MAX(last_sequence) AS last_sequence,
                MAX(retired_through_sequence) AS retired_through_sequence,
                (
                  SELECT gap_reason
                  FROM run_journal_bindings AS gap_binding
                  WHERE gap_binding.run_id = ?
                    AND gap_binding.gap_reason IS NOT NULL
                  ORDER BY retired_through_sequence DESC, epoch DESC
                  LIMIT 1
                ) AS gap_reason
         FROM run_journal_bindings
         WHERE run_id = ?`,
      )
      .get(runId, runId);
    if ((binding?.source_count ?? 0) > 0) {
      return {
        predicate:
          "source_path IN (SELECT source_path FROM run_journal_bindings WHERE run_id = ?)",
        params: [runId],
        known: true,
        ...(binding?.first_available_sequence !== null &&
        binding?.first_available_sequence !== undefined
          ? { firstAvailableSequence: binding.first_available_sequence }
          : {}),
        ...(binding?.last_sequence !== null &&
        binding?.last_sequence !== undefined
          ? { lastSequence: binding.last_sequence }
          : {}),
        ...(binding?.retired_through_sequence !== null &&
        binding?.retired_through_sequence !== undefined
          ? { retiredThroughSequence: binding.retired_through_sequence }
          : {}),
        ...(binding?.gap_reason !== null && binding?.gap_reason !== undefined
          ? { gapReason: binding.gap_reason }
          : {}),
      };
    }
  }

  const sourcePath = selectedSourcePath(db, runId);
  return sourcePath === undefined
    ? { predicate: "thread_id = ?", params: [runId], known: false }
    : {
        predicate: "thread_id = ? AND source_path = ?",
        params: [runId, sourcePath],
        known: true,
      };
}

function sourceContainsCompaction(
  db: BetterSqlite3.Database,
  sourceScope: JournalSourceScope,
): boolean {
  return db
    .prepare<unknown[], { readonly present: number }>(
      `SELECT 1 AS present FROM thread_rollout_items
       WHERE ${sourceScope.predicate} AND item_type = 'compacted'
       LIMIT 1`,
    )
    .get(...sourceScope.params) !== undefined;
}

function threadExists(db: BetterSqlite3.Database, runId: string): boolean {
  if (!tableExists(db, "threads")) return false;
  return db
    .prepare<[string], { readonly present: number }>(
      "SELECT 1 AS present FROM threads WHERE thread_id = ? LIMIT 1",
    )
    .get(runId) !== undefined;
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return db
    .prepare<[string], { readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) !== undefined;
}

function parseEventEnvelope(raw: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = asObject(parsed);
    const msg = asObject(envelope?.msg);
    if (
      envelope === undefined ||
      msg === undefined ||
      stringValue(msg.type) === undefined ||
      (msg.payload !== undefined && jsonValue(msg.payload) === undefined)
    ) {
      return undefined;
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? (value as JsonObject) : undefined;
}

function jsonValue(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(
  object: JsonObject | undefined,
  keys: readonly string[],
): string | undefined {
  if (object === undefined) return undefined;
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}
