import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CompactionRetentionRepository,
  type CompactionPinRecord,
} from "../../src/state/compaction-retention.js";
import {
  COMPACTION_RECONCILIATION_PAGE_SIZE,
} from "../../src/services/compact/transaction-types.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const DIGEST = "a".repeat(64);
const SESSION_ID = "retention-query-plan";
const INVALID_PAGE_LIMITS = [
  { label: "negative integer", value: -1 },
  { label: "negative fraction", value: -1.5 },
  { label: "zero", value: 0 },
  { label: "positive fraction", value: 1.5 },
  { label: "NaN", value: Number.NaN },
  { label: "positive infinity", value: Number.POSITIVE_INFINITY },
  { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
  { label: "non-safe integer", value: Number.MAX_SAFE_INTEGER + 1 },
] as const;
const OVERSIZED_SAFE_PAGE_LIMITS = [
  COMPACTION_RECONCILIATION_PAGE_SIZE + 1,
  Number.MAX_SAFE_INTEGER,
] as const;

let root = "";
let driver: StateSqliteDriver;
let repository: CompactionRetentionRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-compaction-retention-plan-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  driver = openStateDatabases({
    cwd,
    agencHome: join(root, "agenc-home"),
  });
  repository = new CompactionRetentionRepository(driver);
});

afterEach(() => {
  driver.close();
  rmSync(root, { recursive: true, force: true });
});

describe("compaction retention ordered query plans", () => {
  it("uses bounded ordered indexes without temporary B-trees", () => {
    const plans = [
      {
        expectedSearch:
          /SEARCH compaction_retention_pins USING (?:COVERING )?INDEX idx_compaction_pins_reconcile \(session_id=\? AND \(created_at_ms,attempt_id\)>\(\?,\?\)\)/,
        sql: `SELECT attempt_id FROM compaction_retention_pins
          INDEXED BY idx_compaction_pins_reconcile
          WHERE session_id = ? AND state != 'released'
            AND (created_at_ms, attempt_id) > (?, ?)
          ORDER BY created_at_ms ASC, attempt_id ASC
          LIMIT ?`,
        parameters: [SESSION_ID, 0, "", 256],
      },
      {
        expectedSearch:
          /SEARCH compaction_retention_pins USING (?:COVERING )?INDEX idx_compaction_pins_release_pending \(session_id=\?\)/,
        sql: `SELECT attempt_id FROM compaction_retention_pins
          INDEXED BY idx_compaction_pins_release_pending
          WHERE session_id = ? AND state = 'release_pending'
          ORDER BY retention_deadline_ms ASC, attempt_id ASC
          LIMIT ?`,
        parameters: [SESSION_ID, 256],
      },
      {
        expectedSearch:
          /SEARCH compaction_retention_pins USING (?:COVERING )?INDEX idx_compaction_pins_release_eligible \(session_id=\? AND <expr><\?\)/,
        sql: `SELECT attempt_id FROM compaction_retention_pins
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
        parameters: [SESSION_ID, 500, 256],
      },
      {
        expectedSearch:
          /SEARCH compaction_retention_pins USING (?:COVERING )?INDEX idx_compaction_pins_released_gc \(released_at_ms>\?\)/,
        sql: `SELECT attempt_id FROM compaction_retention_pins
          INDEXED BY idx_compaction_pins_released_gc
          WHERE state = 'released' AND released_at_ms IS NOT NULL
          ORDER BY released_at_ms ASC, attempt_id ASC
          LIMIT ?`,
        parameters: [256],
      },
      {
        expectedSearch:
          /SEARCH compaction_retention_references USING (?:COVERING )?INDEX idx_compaction_references_active_descendant \(reference_id=\?\)/,
        sql: `SELECT attempt_id FROM compaction_retention_references
          INDEXED BY idx_compaction_references_active_descendant
          WHERE reference_kind = 'descendant_compaction'
            AND reference_id = ? AND released_at_ms IS NULL`,
        parameters: ["child"],
      },
      {
        expectedSearch:
          /SEARCH compaction_retention_references USING (?:COVERING )?INDEX idx_compaction_references_active_descendant \(reference_id=\?\)/,
        sql: `UPDATE compaction_retention_references
          INDEXED BY idx_compaction_references_active_descendant
          SET released_at_ms = ?
          WHERE reference_kind = 'descendant_compaction'
            AND reference_id = ? AND released_at_ms IS NULL`,
        parameters: [500, "child"],
      },
    ];

    for (const entry of plans) {
      const detail = explainQueryPlan(entry.sql, entry.parameters);
      expect(detail).toMatch(entry.expectedSearch);
      expect(detail).not.toContain("USE TEMP B-TREE");
    }
  });

  it("preserves release priority and fills the committed-candidate remainder", () => {
    insertPin({
      attemptId: "pending-late",
      state: "release_pending",
      retentionDeadlineMs: 300,
      releaseTombstoneAtMs: 300,
    });
    insertPin({
      attemptId: "pending-early",
      state: "release_pending",
      retentionDeadlineMs: 100,
      releaseTombstoneAtMs: 100,
    });
    insertPin({
      attemptId: "eligible-early",
      state: "committed_reference",
      retentionDeadlineMs: 50,
    });
    insertPin({
      attemptId: "eligible-a",
      state: "committed_reference",
      retentionDeadlineMs: 150,
    });
    insertPin({
      attemptId: "eligible-b",
      state: "committed_reference",
      retentionDeadlineMs: 150,
    });
    insertPin({
      attemptId: "blocked-extension",
      state: "committed_reference",
      retentionDeadlineMs: 10,
      rollbackExtendedUntilMs: 600,
    });
    insertPin({
      attemptId: "blocked-future",
      state: "committed_reference",
      retentionDeadlineMs: 700,
    });
    insertPin({
      attemptId: "other-session-pending",
      sessionId: "other-session",
      state: "release_pending",
      retentionDeadlineMs: 1,
      releaseTombstoneAtMs: 1,
    });
    driver.transactionImmediate(() => {
      for (let index = 0; index < 2_048; index += 1) {
        insertPin({
          attemptId: `deferred-${index.toString().padStart(4, "0")}`,
          state: "committed_reference",
          retentionDeadlineMs: 1,
          rollbackExtendedUntilMs: 10_000,
        });
      }
    });

    expect(candidateIds(repository.listReleaseCandidates(SESSION_ID, 500, 3)))
      .toEqual(["pending-early", "pending-late", "eligible-early"]);
    expect(candidateIds(repository.listReleaseCandidates(SESSION_ID, 500, 1)))
      .toEqual(["pending-early"]);
    for (const { label, value } of INVALID_PAGE_LIMITS) {
      expect(
        repository.listReleaseCandidates(SESSION_ID, 500, value),
        label,
      ).toEqual([]);
    }

    driver.prepareState(
      "DELETE FROM compaction_retention_pins WHERE state = 'release_pending'",
    ).run();
    expect(candidateIds(repository.listReleaseCandidates(SESSION_ID, 500, 3)))
      .toEqual(["eligible-early", "eligible-a", "eligible-b"]);
    for (const limit of OVERSIZED_SAFE_PAGE_LIMITS) {
      expect(
        repository.listReleaseCandidates(SESSION_ID, 20_000, limit),
      ).toHaveLength(COMPACTION_RECONCILIATION_PAGE_SIZE);
    }
  });

  it("advances reconciliation with a stable tuple cursor", () => {
    insertPin({ attemptId: "active-a", state: "preparing", createdAtMs: 10 });
    insertPin({ attemptId: "active-b", state: "preparing", createdAtMs: 10 });
    insertPin({ attemptId: "active-c", state: "preparing", createdAtMs: 20 });
    insertPin({
      attemptId: "released-before-cursor",
      state: "released",
      createdAtMs: 1,
      retentionDeadlineMs: 2,
      releaseTombstoneAtMs: 3,
      releasedAtMs: 4,
    });
    insertPin({
      attemptId: "other-session-active",
      sessionId: "other-session",
      state: "preparing",
      createdAtMs: 1,
    });

    const first = repository.listReconciliationPage(SESSION_ID);
    expect(candidateIds(first)).toEqual(["active-a", "active-b", "active-c"]);
    repository.persistReconciliationCursor(SESSION_ID, first[0]!, 30);
    expect(candidateIds(repository.listReconciliationPage(SESSION_ID))).toEqual([
      "active-b",
      "active-c",
    ]);
  });

  it("deletes released history in stable bounded pages", () => {
    insertPin({
      attemptId: "released-a",
      state: "released",
      retentionDeadlineMs: 50,
      releaseTombstoneAtMs: 75,
      releasedAtMs: 100,
    });
    insertPin({
      attemptId: "released-b",
      state: "released",
      retentionDeadlineMs: 50,
      releaseTombstoneAtMs: 75,
      releasedAtMs: 100,
    });
    insertPin({
      attemptId: "released-newer",
      state: "released",
      retentionDeadlineMs: 100,
      releaseTombstoneAtMs: 150,
      releasedAtMs: 200,
    });
    insertReference("released-a", "checkpoint", "retained-a", 10);

    for (const { label, value } of INVALID_PAGE_LIMITS) {
      expect(repository.deleteReleasedHistory(value), label).toBe(0);
      expect(repository.listSession(SESSION_ID), label).toHaveLength(3);
      expect(referenceCount("released-a"), label).toBe(1);
    }

    expect(repository.deleteReleasedHistory(1)).toBe(1);
    expect(repository.get("released-a")).toBeUndefined();
    expect(referenceCount("released-a")).toBe(0);
    expect(repository.get("released-b")).toBeDefined();
    expect(repository.deleteReleasedHistory(1)).toBe(1);
    expect(repository.get("released-b")).toBeUndefined();
    expect(repository.get("released-newer")).toBeDefined();

    driver.transactionImmediate(() => {
      for (let index = 0; index < 300; index += 1) {
        insertPin({
          attemptId: `released-bulk-${index.toString().padStart(3, "0")}`,
          state: "released",
          retentionDeadlineMs: 300,
          releaseTombstoneAtMs: 400,
          releasedAtMs: 500,
        });
      }
    });
    expect(
      repository.deleteReleasedHistory(
        COMPACTION_RECONCILIATION_PAGE_SIZE + 1,
      ),
    ).toBe(COMPACTION_RECONCILIATION_PAGE_SIZE);
    expect(
      driver.prepareState<[], { readonly count: number }>(
        `SELECT COUNT(*) AS count FROM compaction_retention_pins
         WHERE state = 'released'`,
      ).get()?.count,
    ).toBe(301 - COMPACTION_RECONCILIATION_PAGE_SIZE);
  });

  it("releases only active reverse descendant references", () => {
    insertPin({
      attemptId: "ancestor",
      state: "committed_reference",
      retentionDeadlineMs: 100,
      referenceCount: 1,
    });
    insertPin({
      attemptId: "child",
      state: "release_pending",
      retentionDeadlineMs: 100,
      releaseTombstoneAtMs: 200,
      referenceScanGeneration: 1,
      pruneCursor: 1,
    });
    insertReference("ancestor", "descendant_compaction", "child", 50);
    insertReference("ancestor", "descendant_compaction", "other-child", 50);
    driver.prepareState<[number, string, string]>(
      `UPDATE compaction_retention_references
       SET released_at_ms = ?
       WHERE attempt_id = ? AND reference_kind = 'descendant_compaction'
         AND reference_id = ?`,
    ).run(75, "ancestor", "other-child");

    repository.markReleased({
      attemptId: "child",
      releasedAtMs: 500,
      sourceBinding: "binding:child",
      sourceSha256: DIGEST,
      completedCursor: 1,
      referenceScanGeneration: 1,
    });

    expect(repository.require("child").state).toBe("released");
    expect(repository.require("ancestor").referenceCount).toBe(0);
    expect(referenceRelease("ancestor", "child")).toBe(500);
    expect(referenceRelease("ancestor", "other-child")).toBe(75);
  });
});

type SeedState = CompactionPinRecord["state"];

interface PinSeed {
  readonly attemptId: string;
  readonly sessionId?: string;
  readonly state: SeedState;
  readonly createdAtMs?: number;
  readonly retentionDeadlineMs?: number;
  readonly rollbackExtendedUntilMs?: number;
  readonly releaseTombstoneAtMs?: number;
  readonly releasedAtMs?: number;
  readonly referenceScanGeneration?: number;
  readonly referenceCount?: number;
  readonly pruneCursor?: number;
}

function insertPin(seed: PinSeed): void {
  const createdAtMs = seed.createdAtMs ?? 0;
  const committed = seed.state === "committed_reference" ||
    seed.state === "release_pending" || seed.state === "released";
  const releasePending = seed.state === "release_pending" ||
    seed.state === "released";
  const retentionDeadlineMs = committed
    ? seed.retentionDeadlineMs ?? createdAtMs + 1
    : null;
  const releaseTombstoneAtMs = releasePending
    ? seed.releaseTombstoneAtMs ?? retentionDeadlineMs
    : null;
  const sourceBinding = `binding:${seed.attemptId}`;
  const sourceManifest = JSON.stringify([{
    kind: "rollout_span",
    ref_id: `${seed.attemptId}:source`,
    source_binding: sourceBinding,
    first_sequence: 1,
    last_sequence: 1,
    sha256: DIGEST,
    history_index: 0,
    record_message_index: 0,
    encoded_bytes: 1,
  }]);
  driver.state.prepare(
    `INSERT INTO compaction_retention_pins (
       attempt_id, format_version, session_id, epoch, source_binding,
       first_sequence, last_sequence, source_sha256, source_bytes,
       history_digest, source_manifest_json, selected_history_indexes_json,
       policy_digest, configuration_digest, accounting_ref, automatic,
       admission_required, planned_provider_calls, state, reference_count,
       created_at_ms, intent_at_ms, committed_at_ms, retention_deadline_ms,
       rollback_extended_until_ms, release_tombstone_at_ms, released_at_ms,
       commit_sha256, reference_scan_generation, cleanup_state,
       projection_state, prune_cursor
     ) VALUES (
       @attemptId, 1, @sessionId, 1, @sourceBinding,
       1, 1, @digest, 1,
       @digest, @sourceManifest, '[0]',
       @digest, @digest, @digest, 0,
       1, 1, @state, @referenceCount,
       @createdAtMs, @intentAtMs, @committedAtMs, @retentionDeadlineMs,
       @rollbackExtendedUntilMs, @releaseTombstoneAtMs, @releasedAtMs,
       @commitSha256, @referenceScanGeneration, @cleanupState,
       @projectionState, @pruneCursor
     )`,
  ).run({
    attemptId: seed.attemptId,
    sessionId: seed.sessionId ?? SESSION_ID,
    sourceBinding,
    digest: DIGEST,
    sourceManifest,
    state: seed.state,
    referenceCount: seed.referenceCount ?? 0,
    createdAtMs,
    intentAtMs: seed.state === "preparing" ? null : createdAtMs,
    committedAtMs: committed ? createdAtMs : null,
    retentionDeadlineMs,
    rollbackExtendedUntilMs: seed.rollbackExtendedUntilMs ?? null,
    releaseTombstoneAtMs,
    releasedAtMs: seed.state === "released"
      ? seed.releasedAtMs ?? releaseTombstoneAtMs
      : null,
    commitSha256: committed ? DIGEST : null,
    referenceScanGeneration: releasePending
      ? seed.referenceScanGeneration ?? 1
      : null,
    cleanupState: committed ? "complete" : "not_started",
    projectionState: committed ? "complete" : "not_committed",
    pruneCursor: seed.pruneCursor ?? 0,
  });
}

function insertReference(
  attemptId: string,
  kind: "checkpoint" | "descendant_compaction",
  referenceId: string,
  createdAtMs: number,
): void {
  driver.prepareState<[string, string, string, number]>(
    `INSERT INTO compaction_retention_references (
       attempt_id, reference_kind, reference_id, created_at_ms
     ) VALUES (?, ?, ?, ?)`,
  ).run(attemptId, kind, referenceId, createdAtMs);
}

function explainQueryPlan(
  sql: string,
  parameters: readonly unknown[],
): string {
  return driver.state
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => String((row as { readonly detail?: unknown }).detail ?? ""))
    .join("\n");
}

function candidateIds(
  pins: readonly CompactionPinRecord[],
): readonly string[] {
  return pins.map((pin) => pin.attemptId);
}

function referenceCount(attemptId: string): number {
  return driver.prepareState<[string], { readonly count: number }>(
    `SELECT COUNT(*) AS count FROM compaction_retention_references
     WHERE attempt_id = ?`,
  ).get(attemptId)?.count ?? 0;
}

function referenceRelease(attemptId: string, referenceId: string): number | null {
  return driver.prepareState<
    [string, string],
    { readonly released_at_ms: number | null }
  >(
    `SELECT released_at_ms FROM compaction_retention_references
     WHERE attempt_id = ? AND reference_id = ?`,
  ).get(attemptId, referenceId)?.released_at_ms ?? null;
}
