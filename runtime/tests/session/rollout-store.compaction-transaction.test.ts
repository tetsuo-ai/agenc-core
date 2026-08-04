import {
  existsSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RolloutStore } from "../../src/session/rollout-store.js";
import {
  COMPACTION_EVENT_FORMAT_VERSION,
  COMPACTION_MINIMUM_READER_RUNTIME,
  COMPACTION_ROLLBACK_RETENTION_MS,
  COMPACTION_SOURCE_DIGEST_DOMAIN,
  COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
  type CompactionIntentV1,
  type CompactionCommittedV1,
  type CompactionActiveHistoryEntryV1,
  type CompactionCommitPayloadBundlesV1,
  type CompactionCommitInputV1,
  type CompactionPayloadBundleV1,
  type CompactionPayloadChunkV1,
  type CompactionPayloadKind,
  type CompactionPersistedCommittedV1,
  type CompactionPersistedIntentV1,
  type CompactionPreparedSourceV1,
  type CompactionProjectionMessageV1,
  type CompactionSourcePayloadBundlesV1,
  type CompactionSummaryDagV1,
  type CompactionSummaryRefV1,
  type CompactionSummaryV1,
  type RolloutSpanRefV1,
} from "../../src/services/compact/transaction-types.js";
import {
  createCompactionSummaryV1,
  digestWithDomain,
} from "../../src/services/compact/summary-v1.js";
import { readCompactionRolloutPayload } from "../../src/session/compaction-event-reader.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import {
  compactActiveHistoryEntries,
  createCompactionPayloadBundleV1,
  hydrateActiveHistoryRefs,
  reconstructCompactionPayloadV1,
} from "../../src/services/compact/payload-manifest.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import { validateCanonicalJournalBytes } from "../../src/state/recovery-journal-contract.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { SessionStore } from "../../src/session/session-store.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
} from "../../src/state/sqlite-driver.js";
import { CompactionRetentionRepository } from "../../src/state/compaction-retention.js";
import { compactConversationTransactionally } from "../../src/services/compact/transaction.js";
import { bindCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";

let temporaryHome = "";
let previousHome: string | undefined;
let temporaryWorkspaces: string[] = [];

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "agenc-c2-home-"));
  previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = temporaryHome;
  temporaryWorkspaces = [];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  rmSync(temporaryHome, { recursive: true, force: true });
  for (const workspace of temporaryWorkspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("RolloutStore transactional compaction", () => {
  it("fails fast on a concurrent compaction lease and releases idempotently", () => {
    const store = openStore("compaction-lease");
    try {
      const first = store.acquireCompactionLease("lease-a");
      expect(() => store.acquireCompactionLease("lease-b")).toThrow(
        /compaction already in progress/i,
      );
      first.release();
      first.release();
      const second = store.acquireCompactionLease("lease-c");
      second.release();
    } finally {
      store.close();
    }
  });

  it("rejects dynamically omitted source and commit payload bundles", () => {
    const store = openStore("manifest-bundles-required");
    try {
      const transaction = commitSmallCompaction(store, "required-bundles-attempt");
      const committedItem = store.readAll().find(
        (item) => item.type === "compaction_committed",
      );
      if (committedItem?.type !== "compaction_committed") {
        throw new Error("test compaction commit is missing");
      }
      const dynamicPin = store.pinAndRecordIntent as unknown as (
        intent: CompactionIntentV1,
        bundles?: CompactionSourcePayloadBundlesV1,
      ) => void;
      expect(() => dynamicPin(transaction.intent)).toThrow(
        /source payload bundles are required/i,
      );
      expect(() => store.commit({
        intent: transaction.intent,
        summary: committedItem.payload.summary,
        summary_dag: committedItem.payload.summary_dag,
        accounting: committedItem.payload.accounting,
        replacement_history: committedItem.payload.replacement_history,
        committed_at_ms: committedItem.payload.committed_at_ms,
        payload_bundles: undefined,
      } as unknown as CompactionCommitInputV1)).toThrow(
        /commit payload bundles are required/i,
      );
    } finally {
      store.close();
    }
  });

  it("writes only manifest-backed compaction payloads in canonical order", () => {
    const store = openStore("manifest-only-layout");
    try {
      commitSmallCompaction(store, "manifest-only-attempt");
      const rows = readTestRolloutRows(store.rolloutPath);
      const intentIndex = rows.findIndex((row) => row.type === "compaction_intent");
      const commitIndex = rows.findIndex((row) => row.type === "compaction_committed");
      const firstAdmissionIndex = rows.findIndex((row) => row.type === "event_msg");
      const sourceChunkIndexes = rows.flatMap((row, index) =>
        row.type === "compaction_payload_chunk" &&
          ["active_history_refs", "source_history"].includes(
            (row.payload as CompactionPayloadChunkV1).payload_kind,
          )
          ? [index]
          : []
      );
      const commitChunkIndexes = rows.flatMap((row, index) =>
        row.type === "compaction_payload_chunk" &&
          ["final_summary", "summary_dag", "replacement_history"].includes(
            (row.payload as CompactionPayloadChunkV1).payload_kind,
          )
          ? [index]
          : []
      );
      expect(sourceChunkIndexes.every((index) =>
        index > intentIndex && index < firstAdmissionIndex
      )).toBe(true);
      expect(commitChunkIndexes.every((index) => index < commitIndex)).toBe(true);

      const persistedIntent = rows[intentIndex]!.payload as CompactionPersistedIntentV1;
      const persistedCommit = rows[commitIndex]!
        .payload as CompactionPersistedCommittedV1;
      expect(persistedIntent.source).not.toHaveProperty("active_history_refs");
      expect(persistedIntent.source).toHaveProperty("active_history_refs_manifest");
      expect(persistedCommit).not.toHaveProperty("summary");
      expect(persistedCommit).not.toHaveProperty("summary_dag");
      expect(persistedCommit).not.toHaveProperty("replacement_history");
      expect(persistedCommit).toHaveProperty("final_summary_manifest");

      const hydratedCommit = store.readAll().find(
        (item) => item.type === "compaction_committed",
      );
      if (hydratedCommit?.type !== "compaction_committed") {
        throw new Error("hydrated test commit is missing");
      }
      expect(hydratedCommit.payload.replacement_history).toHaveLength(2);
      expect(() => serializeRolloutItem(hydratedCommit)).toThrow(
        /persist payload manifests/i,
      );
    } finally {
      store.close();
    }
  });

  for (const damage of ["missing", "duplicate", "commit-before-payload"] as const) {
    it(`fails closed on a ${damage} compaction payload chain`, () => {
      const fixture = committedStructuredFixture(`payload-${damage}`, 1, 8);
      const rows = readTestRolloutRows(fixture.rolloutPath);
      const sourceIndex = rows.findIndex((row) =>
        row.type === "compaction_payload_chunk" &&
        (row.payload as CompactionPayloadChunkV1).payload_kind === "source_history"
      );
      if (sourceIndex < 0) throw new Error("source-history chunk is missing");
      if (damage === "missing") {
        rows.splice(sourceIndex, 1);
      } else if (damage === "duplicate") {
        rows.splice(sourceIndex, 0, rows[sourceIndex]!);
      } else {
        const commitIndex = rows.findIndex((row) => row.type === "compaction_committed");
        const replacementIndex = rows.findIndex((row) =>
          row.type === "compaction_payload_chunk" &&
          (row.payload as CompactionPayloadChunkV1).payload_kind ===
            "replacement_history"
        );
        if (commitIndex < 0 || replacementIndex < 0) {
          throw new Error("commit payload rows are missing");
        }
        const [commitRow] = rows.splice(commitIndex, 1);
        rows.splice(replacementIndex, 0, commitRow!);
      }
      writeTestRolloutRows(fixture.rolloutPath, rows);
      expect(() =>
        openStore(fixture.sessionId, { resume: true }, fixture.cwd)
      ).toThrow(/payload|chunk|manifest|hydrated intent/i);
    });
  }

  it("pins only physical records that constitute current active history", () => {
    const store = openStore("active-manifest");
    try {
      for (let index = 0; index < 40; index += 1) {
        store.appendRollout(
          {
            type: "response_item",
            payload: { role: "user", content: `obsolete-${index}-${"x".repeat(200)}` },
          },
          { durable: true },
        );
      }
      store.appendRollout(
        {
          type: "compacted",
          payload: {
            message: "legacy replacement",
            replacementHistory: [
              { role: "developer", content: "prior summary policy" },
              { role: "user", content: "duplicate" },
              { role: "user", content: "duplicate" },
            ],
          },
        },
        { durable: true },
      );

      const prepared = store.prepareSource("attempt-manifest", []);
      expect(prepared.messages).toHaveLength(3);
      expect(prepared.source.active_history_refs).toHaveLength(3);
      expect(new Set(
        prepared.source.active_history_refs.map((ref) => ref.first_sequence),
      ).size).toBe(1);
      expect(
        prepared.source.active_history_refs.map((ref) => ref.record_message_index),
      ).toEqual([0, 1, 2]);
      expect(prepared.source.source_bytes).toBeLessThan(
        readFileSync(store.rolloutPath).byteLength,
      );
    } finally {
      store.close();
    }
  });

  it("fails preparation at the bounded scanner deadline", () => {
    let deadlineArmed = false;
    let tick = 0;
    const store = openStore("prepare-scan-deadline", {
      nowMilliseconds: () => deadlineArmed ? (tick += 20_000) : Date.now(),
    });
    try {
      for (let index = 0; index < 100; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "user", content: `deadline-source-${index}` },
        });
      }
      store.flushDurable();
      deadlineArmed = true;
      expect(() => store.prepareSource("deadline-attempt", [])).toThrow(
        /scan deadline/i,
      );
    } finally {
      store.close();
    }
  });

  it("writes rollback before projection and forces newer work to a reviewed branch", () => {
    const store = openStore("rollback");
    try {
      const transaction = commitSmallCompaction(store, "rollback-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);

      store.appendRollout(
        {
          type: "response_item",
          payload: { role: "user", content: "newer work" },
        },
        { durable: true },
      );
      expect(() =>
        store.rollbackCompaction({
          attemptId: transaction.intent.attempt_id,
          nowMs: transaction.committedAtMs + 1,
        }),
      ).toThrow(/reviewed branch/i);

      const rollback = store.rollbackCompaction({
        attemptId: transaction.intent.attempt_id,
        nowMs: transaction.committedAtMs + 2,
        reviewedBranchTargetSessionId: "reviewed-branch-target",
      });
      expect(rollback).toMatchObject({
        rollback_mode: "reviewed_branch",
        target_session_id: "reviewed-branch-target",
        source_session_id: store.sessionId,
        source_epoch: store.epoch,
        source_sha256: transaction.prepared.source.source_sha256,
      });
      expect(
        store.readAll().at(-1),
      ).toMatchObject({ type: "compaction_rollback_committed" });
    } finally {
      store.close();
    }
  });

  it("allows same-session rollback across exact automatic turn bookkeeping", () => {
    const store = openStore("automatic-bookkeeping-rollback");
    try {
      const transaction = commitSmallCompaction(
        store,
        "automatic-bookkeeping-attempt",
        undefined,
        [],
        true,
      );
      store.markProjectionComplete(transaction.intent.attempt_id);
      store.markCleanupComplete(transaction.intent.attempt_id);
      appendAutomaticCompactionBoundary(store, "turn-bookkeeping");
      store.store.reAppendSessionMetadata();

      const rollback = store.rollbackCompaction({
        attemptId: transaction.intent.attempt_id,
        nowMs: transaction.committedAtMs + 1,
      });
      expect(rollback.rollback_mode).toBe("same_session");
      expect(rollback.source_history.map((message) => message.content)).toEqual([
        "source one",
        "source two",
      ]);
    } finally {
      store.close();
    }
  });

  it("requires a reviewed branch after semantic work beyond automatic bookkeeping", () => {
    const store = openStore("automatic-bookkeeping-newer-work");
    try {
      const transaction = commitSmallCompaction(
        store,
        "automatic-newer-work-attempt",
        undefined,
        [],
        true,
      );
      store.markProjectionComplete(transaction.intent.attempt_id);
      store.markCleanupComplete(transaction.intent.attempt_id);
      appendAutomaticCompactionBoundary(store, "turn-newer-work");
      store.store.reAppendSessionMetadata();
      store.appendRollout(
        { type: "response_item", payload: { role: "user", content: "new work" } },
        { durable: true },
      );

      expect(() => store.rollbackCompaction({
        attemptId: transaction.intent.attempt_id,
        nowMs: transaction.committedAtMs + 1,
      })).toThrow(/reviewed branch/i);
    } finally {
      store.close();
    }
  });

  it("keeps newer source work on reopen and materializes an exact reviewed target", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const sourceSessionId = "reviewed-source-reopen";
    const targetSessionId = "reviewed-target-reopen";
    const source = openStore(sourceSessionId, {}, cwd);
    let attemptId = "";
    try {
      const transaction = commitSmallCompaction(source, "reviewed-reopen-attempt");
      attemptId = transaction.intent.attempt_id;
      source.markProjectionComplete(attemptId);
      source.appendRollout(
        { type: "response_item", payload: { role: "user", content: "newer work" } },
        { durable: true },
      );
      source.rollbackCompaction({
        attemptId,
        nowMs: transaction.committedAtMs + 1,
        reviewedBranchTargetSessionId: targetSessionId,
      });
    } finally {
      source.close();
    }

    const reopened = openStore(sourceSessionId, { resume: true }, cwd);
    try {
      const reconstruction = reconstructFromRollout(reopened.readAll());
      expect(reconstruction.history.map((message) => message.content)).toEqual([
        "authenticated compaction boundary",
        "source summary",
        "newer work",
      ]);
      expect(reconstruction.activeCompactionAttemptIds).toEqual([attemptId]);
    } finally {
      reopened.close();
    }

    const target = new SessionStore({
      cwd,
      sessionId: targetSessionId,
      agencVersion: "0.13.0",
      resume: true,
    });
    const targetReconstruction = reconstructFromRollout(target.readAll());
    expect(targetReconstruction.history.map((message) => message.content)).toEqual([
      "source one",
      "source two",
    ]);
    expect(targetReconstruction.activeCompactionAttemptIds).toEqual([]);
  });

  for (const target of ["../escape", "/tmp/escape", "nested/escape", "nested\\escape"]) {
    it(`rejects unsafe reviewed target ${JSON.stringify(target)} before source fsync`, () => {
      const source = openStore(`unsafe-${Buffer.from(target).toString("hex")}`);
      try {
        const transaction = commitSmallCompaction(source, `unsafe-target-attempt-${target.length}`);
        source.markProjectionComplete(transaction.intent.attempt_id);
        source.appendRollout(
          { type: "response_item", payload: { role: "user", content: "newer work" } },
          { durable: true },
        );
        expect(() =>
          source.rollbackCompaction({
            attemptId: transaction.intent.attempt_id,
            nowMs: transaction.committedAtMs + 1,
            reviewedBranchTargetSessionId: target,
          }),
        ).toThrow(/path-safe/i);
        expect(
          source.readAll().some((item) => item.type === "compaction_rollback_committed"),
        ).toBe(false);
      } finally {
        source.close();
      }
    });
  }

  it("repairs a reserved reviewed target after a crash following source rollback fsync", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const sourceSessionId = "reviewed-crash-source";
    const targetSessionId = "reviewed-crash-target";
    const source = openStore(sourceSessionId, {
      afterCompactionRollbackAppendForTestingOnly: () => {
        throw new Error("crash after rollback fsync");
      },
    }, cwd);
    try {
      const transaction = commitSmallCompaction(source, "reviewed-crash-attempt");
      source.markProjectionComplete(transaction.intent.attempt_id);
      source.appendRollout(
        { type: "response_item", payload: { role: "user", content: "newer work" } },
        { durable: true },
      );
      expect(() =>
        source.rollbackCompaction({
          attemptId: transaction.intent.attempt_id,
          nowMs: transaction.committedAtMs + 1,
          reviewedBranchTargetSessionId: targetSessionId,
        }),
      ).toThrow(/reconstruction is required/i);
    } finally {
      source.close();
    }
    const reopened = openStore(sourceSessionId, { resume: true }, cwd);
    try {
      const reconstruction = reconstructFromRollout(reopened.readAll());
      expect(reconstruction.history.map((message) => message.content)).toEqual([
        "authenticated compaction boundary",
        "source summary",
        "newer work",
      ]);
      expect(
        reopened.readAll().filter((item) => item.type === "compaction_rollback_committed"),
      ).toHaveLength(1);
    } finally {
      reopened.close();
    }
    const targetStore = new SessionStore({
      cwd,
      sessionId: targetSessionId,
      agencVersion: "0.13.0",
      resume: true,
    });
    expect(
      reconstructFromRollout(targetStore.readAll()).history.map((message) => message.content),
    ).toEqual(["source one", "source two"]);
  });

  it("does not create a reviewed target before source rollback fsync succeeds", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const sourceSessionId = "reviewed-fsync-source";
    const targetSessionId = "reviewed-fsync-target";
    const source = openStore(sourceSessionId, {}, cwd);
    const targetProbe = new SessionStore({
      cwd,
      sessionId: targetSessionId,
      agencVersion: "0.13.0",
      resume: true,
    });
    try {
      const transaction = commitSmallCompaction(source, "reviewed-fsync-attempt");
      source.markProjectionComplete(transaction.intent.attempt_id);
      source.appendRollout(
        { type: "response_item", payload: { role: "user", content: "newer work" } },
        { durable: true },
      );
      source.setFsyncImplForTest((fd) => {
        fsyncSync(fd);
        throw new Error("injected source rollback fsync uncertainty");
      });
      expect(() => source.rollbackCompaction({
        attemptId: transaction.intent.attempt_id,
        nowMs: transaction.committedAtMs + 1,
        reviewedBranchTargetSessionId: targetSessionId,
      })).toThrow(/source rollback fsync uncertainty/i);
      expect(existsSync(targetProbe.rolloutPath)).toBe(false);
    } finally {
      source.close();
    }

    const reopened = openStore(sourceSessionId, { resume: true }, cwd);
    try {
      expect(existsSync(targetProbe.rolloutPath)).toBe(false);
      expect(reopened.readAll().some(
        (item) => item.type === "compaction_rollback_committed",
      )).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("rejects a conflicting reviewed target before appending source rollback", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const targetSessionId = "reviewed-conflict-target";
    const target = new SessionStore({
      cwd,
      sessionId: targetSessionId,
      agencVersion: "0.13.0",
    });
    target.open({
      sessionId: targetSessionId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "conflict-test",
      agencVersion: "0.13.0",
    });
    target.appendRollout(
      { type: "response_item", payload: { role: "user", content: "source one" } },
      { durable: true },
    );
    target.close();

    const source = openStore("reviewed-conflict-source", {}, cwd);
    try {
      const transaction = commitSmallCompaction(source, "reviewed-conflict-attempt");
      source.markProjectionComplete(transaction.intent.attempt_id);
      source.appendRollout(
        { type: "response_item", payload: { role: "user", content: "newer work" } },
        { durable: true },
      );
      expect(() =>
        source.rollbackCompaction({
          attemptId: transaction.intent.attempt_id,
          nowMs: transaction.committedAtMs + 1,
          reviewedBranchTargetSessionId: targetSessionId,
        }),
      ).toThrow(/authenticated durable lineage binding/i);
      expect(
        source.readAll().some((item) => item.type === "compaction_rollback_committed"),
      ).toBe(false);
    } finally {
      source.close();
    }
  });

  it("never appends a failed terminal after the commit fsync point", () => {
    const store = openStore("commit-failpoint", {
      afterCompactionCommitAppendForTestingOnly: () => {
        throw new Error("crash after fsync");
      },
    });
    try {
      expect(() => commitSmallCompaction(store, "fsync-attempt")).toThrow(
        /reconstruction is required/i,
      );
      const terminals = store.readAll().filter(
        (item) =>
          (item.type === "compaction_committed" || item.type === "compaction_failed") &&
          item.payload.attempt_id === "fsync-attempt",
      );
      expect(terminals.map((item) => item.type)).toEqual(["compaction_committed"]);
      expect(() => store.assertCompactionProjectionReady()).toThrow(
        /reconstruction is required/i,
      );
    } finally {
      store.close();
    }
  });

  it("resolves write-success/fsync-failure as one committed terminal", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const store = openStore("ambiguous-fsync", {}, cwd);
    try {
      let fsyncCalls = 0;
      expect(() =>
        commitSmallCompaction(store, "ambiguous-fsync-attempt", () => {
          store.setFsyncImplForTest((fd) => {
            fsyncCalls += 1;
            // commit() first fsyncs the source-freshness proof. Fail the
            // following fsync, after the commit line itself was written.
            if (fsyncCalls === 2) {
              const error = new Error("injected fsync failure") as Error & {
                code: string;
              };
              error.code = "EIO";
              throw error;
            }
            fsyncSync(fd);
          });
        }),
      ).toThrow(/reconstruction is required/i);
      expect(
        store.readAll().filter(
          (item) =>
            (item.type === "compaction_committed" ||
              item.type === "compaction_failed") &&
            item.payload.attempt_id === "ambiguous-fsync-attempt",
        ).map((item) => item.type),
      ).toEqual(["compaction_committed"]);
      expect(() => store.assertCompactionProjectionReady()).toThrow(
        /reconstruction is required/i,
      );
    } finally {
      store.close();
    }

    const reopened = openStore(
      "ambiguous-fsync",
      { resume: true },
      cwd,
    );
    try {
      expect(
        reopened.readAll().filter(
          (item) =>
            (item.type === "compaction_committed" ||
              item.type === "compaction_failed") &&
            item.payload.attempt_id === "ambiguous-fsync-attempt",
        ).map((item) => item.type),
      ).toEqual(["compaction_committed"]);
      expect(() => reopened.assertCompactionProjectionReady()).toThrow(
        /reconstruction is required/i,
      );
      reopened.acknowledgeCompactionReconstruction([
        "ambiguous-fsync-attempt",
      ]);
      expect(() => reopened.assertCompactionProjectionReady()).not.toThrow();
    } finally {
      reopened.close();
    }
  });

  it("blocks the same live store while committed cleanup remains pending", () => {
    const store = openStore("cleanup-pending-live");
    try {
      const transaction = commitSmallCompaction(store, "cleanup-pending-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);
      store.markCleanupPending(
        transaction.intent.attempt_id,
        new Error("injected cleanup failure"),
      );
      expect(() => store.assertCompactionProjectionReady()).toThrow(
        /reconstruction is required/i,
      );
      store.markCleanupComplete(transaction.intent.attempt_id);
      expect(() => store.assertCompactionProjectionReady()).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("rejects a valid-JSON mutation of committed replacement history on restart", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const store = openStore("commit-tamper", {}, cwd);
    const rolloutPath = store.rolloutPath;
    try {
      const transaction = commitSmallCompaction(store, "commit-tamper-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);
      store.markCleanupComplete(transaction.intent.attempt_id);
    } finally {
      store.close();
    }
    mutatePayloadChunk(
      rolloutPath,
      "replacement_history",
      (fragment) => fragment.replace("source summary", "source tampery"),
    );
    expect(() => openStore("commit-tamper", { resume: true }, cwd)).toThrow(
      /payload chunk|digest|manifest/i,
    );
  });

  it("rejects valid-JSON rollback source-history tampering on restart", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const store = openStore("rollback-tamper", {}, cwd);
    const rolloutPath = store.rolloutPath;
    try {
      const transaction = commitSmallCompaction(store, "rollback-tamper-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);
      store.markCleanupComplete(transaction.intent.attempt_id);
      store.rollbackCompaction({
        attemptId: transaction.intent.attempt_id,
        nowMs: transaction.committedAtMs + 1,
      });
    } finally {
      store.close();
    }
    mutatePayloadChunk(
      rolloutPath,
      "source_history",
      (fragment) => fragment.replace("source one", "source uno"),
    );
    expect(() => openStore("rollback-tamper", { resume: true }, cwd)).toThrow(
      /payload chunk|digest|manifest/i,
    );
  });

  it("binds a persisted rollback to the hydrated canonical commit digest", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const sessionId = "rollback-commit-binding";
    const store = openStore(sessionId, {}, cwd);
    const rolloutPath = store.rolloutPath;
    try {
      const transaction = commitSmallCompaction(store, "rollback-binding-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);
      store.markCleanupComplete(transaction.intent.attempt_id);
      store.rollbackCompaction({
        attemptId: transaction.intent.attempt_id,
        nowMs: transaction.committedAtMs + 1,
      });
    } finally {
      store.close();
    }
    const rows = readTestRolloutRows(rolloutPath);
    const rollbackIndex = rows.findIndex(
      (row) => row.type === "compaction_rollback_committed",
    );
    if (rollbackIndex < 0) throw new Error("test rollback row is missing");
    const rollback = rows[rollbackIndex]!.payload as { readonly commit_sha256: string };
    rows[rollbackIndex] = {
      ...rows[rollbackIndex]!,
      payload: { ...rollback, commit_sha256: "f".repeat(64) },
    };
    writeTestRolloutRows(rolloutPath, rows);
    expect(() => openStore(sessionId, { resume: true }, cwd)).toThrow(
      /not bound to its hydrated commit/i,
    );
  });

  it("treats minimum_reader_runtime as a capability floor", () => {
    const store = openStore("reader-capability");
    try {
      const transaction = commitSmallCompaction(store, "reader-capability-attempt");
      expect(
        readCompactionRolloutPayload("compaction_intent", {
          ...transaction.intent,
          minimum_reader_runtime: "0.13.0",
        }).minimum_reader_runtime,
      ).toBe("0.13.0");
      expect(
        readCompactionRolloutPayload("compaction_intent", {
          ...transaction.intent,
          minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
        }).minimum_reader_runtime,
      ).toBe(COMPACTION_MINIMUM_READER_RUNTIME);
      expect(() =>
        readCompactionRolloutPayload("compaction_intent", {
          ...transaction.intent,
          minimum_reader_runtime: "0.15.0",
        }),
      ).toThrow(/reader floor/i);
      expect(() =>
        readCompactionRolloutPayload("compaction_intent", {
          ...transaction.intent,
          format_version: COMPACTION_EVENT_FORMAT_VERSION + 1,
        }),
      ).toThrow(/event version/i);
    } finally {
      store.close();
    }
  });

  for (const corruption of ["foreign", "out-of-range", "gap", "overlap"] as const) {
    it(`rejects a valid-rehashed ${corruption} summary leaf on restart`, () => {
      const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
      temporaryWorkspaces.push(cwd);
      const sessionId = `leaf-${corruption}`;
      const store = openStore(sessionId, {}, cwd);
      const rolloutPath = store.rolloutPath;
      try {
        const transaction = commitSmallCompaction(
          store,
          `${corruption}-leaf-attempt`,
        );
        store.markProjectionComplete(transaction.intent.attempt_id);
        store.markCleanupComplete(transaction.intent.attempt_id);
      } finally {
        store.close();
      }
      rewriteCommittedLeaves(rolloutPath, corruption);
      expect(() => openStore(sessionId, { resume: true }, cwd)).toThrow(
        /malformed compaction rollout event|runtime schema/i,
      );
    });
  }

  it("rejects a valid-rehashed summary DAG deeper than four levels on restart", () => {
    const fixture = committedStructuredFixture("dag-deep", 8, 2);
    rewriteCommittedDag(fixture.rolloutPath, (commit) =>
      chainedDag(commit, commit.summary_dag.leaf_plan.map((leaf) => leaf.source_ref))
    );
    expect(() => openStore(fixture.sessionId, { resume: true }, fixture.cwd)).toThrow(
      /malformed compaction rollout event|runtime schema/i,
    );
  });

  it("rejects a valid-rehashed summary DAG above its effective fan-in on restart", () => {
    const fixture = committedStructuredFixture("dag-overfan", 9, 8);
    rewriteCommittedDag(fixture.rolloutPath, (commit) =>
      overfanDag(commit, commit.summary_dag.leaf_plan.map((leaf) => leaf.source_ref))
    );
    expect(() => openStore(fixture.sessionId, { resume: true }, fixture.cwd)).toThrow(
      /malformed compaction rollout event|runtime schema/i,
    );
  });

  it("rejects a valid-rehashed DAG whose node count differs from planned calls", () => {
    const fixture = committedStructuredFixture("dag-call-count", 1, 8);
    rewriteCommittedDag(fixture.rolloutPath, (commit) => {
      const { dag_sha256: _digest, ...dag } = commit.summary_dag;
      return { dag: { ...dag, planned_provider_calls: 2 } };
    });
    expect(() => openStore(fixture.sessionId, { resume: true }, fixture.cwd)).toThrow(
      /malformed compaction rollout event|runtime schema/i,
    );
  });

  it("rejects a canonical intent/commit provider-call mismatch without SQLite", () => {
    const fixture = committedStructuredFixture("dag-lifecycle-count", 1, 8);
    const journal = readFileSync(fixture.rolloutPath, "utf8");
    const mismatched = journal.replace(
      '"planned_provider_calls":1',
      '"planned_provider_calls":2',
    );
    expect(mismatched).not.toBe(journal);
    writeFileSync(fixture.rolloutPath, mismatched, "utf8");
    removeStateDatabase(fixture.cwd);
    expect(() =>
      openStore(fixture.sessionId, { resume: true }, fixture.cwd)
    ).toThrow(/provider-call plan conflicts with its intent/i);
  });

  it("stamps only C2 rows at event version two and fails closed on a v1 C2 row", () => {
    const fixture = committedStructuredFixture("c2-event-version", 1, 8);
    const rows = readFileSync(fixture.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        readonly type: string;
        readonly eventVersion?: number;
      });
    expect(rows.find((row) => row.type === "response_item")?.eventVersion).toBe(1);
    expect(
      rows.filter((row) => row.type.startsWith("compaction_"))
        .every((row) => row.eventVersion === 2),
    ).toBe(true);
    const downgraded = rows.map((row) =>
      row.type === "compaction_intent" ? { ...row, eventVersion: 1 } : row
    );
    expect(() =>
      validateCanonicalJournalBytes(
        Buffer.from(`${downgraded.map((row) => JSON.stringify(row)).join("\n")}\n`),
        { expectedRunId: fixture.sessionId, expectedEpoch: 1 },
      )
    ).toThrow(/record version is not supported/i);
  });

  it("downshifts 100 logical messages from one prior commit record and reopens", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const sessionId = "logical-submessage-downshift";
    const store = openStore(sessionId, {}, cwd);
    try {
      const tail = Array.from({ length: 100 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `logical-${index}-${"x".repeat(2_048)}`,
      }));
      const first = commitSmallCompaction(
        store,
        "logical-source-attempt",
        undefined,
        tail,
      );
      store.markProjectionComplete(first.intent.attempt_id);
      store.markCleanupComplete(first.intent.attempt_id);
      const prepared = store.prepareSource("logical-downshift-probe", []);
      expect(prepared.source.active_history_refs).toHaveLength(102);
      expect(new Set(
        prepared.source.active_history_refs.map((ref) => ref.first_sequence),
      ).size).toBe(1);

      const harness = bindCompactionTransactionHarness(store, {
        contextWindowTokens: 32_000,
        maxOutputTokens: 512,
      });
      try {
        const result = await compactConversationTransactionally(
          harness.context,
          {
            customInstructions: "retain the durable logical sequence",
            automatic: false,
            messagesToKeep: [],
            completeSourceMessages: prepared.messages,
            messagesToSummarize: prepared.messages,
            summaryPlacement: "before_keep",
            createBoundaryMarker: () => ({
              role: "user",
              originalRole: "developer",
              content: "authenticated compaction boundary",
            }),
            createSummaryMessage: (content) => ({ role: "user", content }),
          },
        );
        expect(result.transaction).toBeDefined();
        store.markProjectionComplete(result.transaction!.attempt_id);
        store.markCleanupComplete(result.transaction!.attempt_id);
        expect(result.transaction!.committed.summary_dag.leaf_plan.length).toBeGreaterThan(1);
        const leaves = result.transaction!.committed.summary_dag.leaf_plan.map(
          (leaf) => leaf.source_ref,
        );
        expect(new Set(leaves.map((leaf) => leaf.first_sequence)).size).toBe(1);
        expect(leaves.every((leaf) =>
          leaf.contributing_ref_ids !== undefined &&
          leaf.contributing_ref_ids.length > 0
        )).toBe(true);
      } finally {
        harness.close();
      }
    } finally {
      store.close();
    }
    const reopened = openStore(sessionId, { resume: true }, cwd);
    try {
      expect(() => reopened.assertCompactionProjectionReady()).not.toThrow();
      const commits = reopened.readAll().filter(
        (item) => item.type === "compaction_committed",
      );
      expect(commits).toHaveLength(2);
      expect(reconstructFromRollout(reopened.readAll()).history).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });

  it("retains an ancestor source until its descendant compaction releases", () => {
    let nowMs = Date.now();
    const store = openStore("provenance-generations", {
      nowMilliseconds: () => nowMs,
    });
    try {
      const first = commitSmallCompaction(store, "generation-a");
      store.markProjectionComplete(first.intent.attempt_id);
      const second = commitSmallCompaction(store, "generation-b");
      store.markProjectionComplete(second.intent.attempt_id);

      expect(() =>
        store.beginCompactionSourceRelease({
          attemptId: first.intent.attempt_id,
          nowMs: first.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS,
        }),
      ).toThrow(/descendant_compaction reference generation-b/i);

      nowMs = second.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      store.beginCompactionSourceRelease({
        attemptId: second.intent.attempt_id,
        nowMs: second.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS,
      });
      expect(() =>
        store.beginCompactionSourceRelease({
          attemptId: first.intent.attempt_id,
          nowMs: Math.max(first.committedAtMs, second.committedAtMs) +
            COMPACTION_ROLLBACK_RETENTION_MS,
        }),
      ).not.toThrow();
      expect(physicalResponseContents(store.rolloutPath)).not.toContain("source one");
    } finally {
      store.close();
    }
  });

  it("uses the store clock instead of a caller-supplied future release time", () => {
    let nowMs = Date.now();
    const store = openStore("retention-clock", { nowMilliseconds: () => nowMs });
    try {
      const transaction = commitSmallCompaction(store, "retention-clock-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);
      expect(() => store.beginCompactionSourceRelease({
        attemptId: transaction.intent.attempt_id,
        nowMs: Number.MAX_SAFE_INTEGER,
      })).toThrow(/rollback window/i);
      nowMs = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      expect(() => store.beginCompactionSourceRelease({
        attemptId: transaction.intent.attempt_id,
        nowMs: 0,
      })).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("persists an operator rollback extension across restart before release", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    let nowMs = Date.now();
    const sessionId = "retention-extension-restart";
    const store = openStore(sessionId, { nowMilliseconds: () => nowMs }, cwd);
    let attemptId = "";
    let originalDeadline = 0;
    let extendedDeadline = 0;
    try {
      const transaction = commitSmallCompaction(store, "retention-extension-attempt");
      attemptId = transaction.intent.attempt_id;
      store.markProjectionComplete(attemptId);
      store.markCleanupComplete(attemptId);
      originalDeadline = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      extendedDeadline = originalDeadline + 60_000;
      store.extendCompactionRollbackRetention(attemptId, extendedDeadline);
      expect(store.readAll().at(-1)).toMatchObject({
        type: "compaction_retention_extended",
        payload: {
          previous_retention_deadline_ms: originalDeadline,
          effective_retention_deadline_ms: extendedDeadline,
        },
      });
    } finally {
      store.close();
    }

    nowMs = originalDeadline;
    const reopened = openStore(sessionId, {
      resume: true,
      nowMilliseconds: () => nowMs,
    }, cwd);
    try {
      expect(() => reopened.beginCompactionSourceRelease({
        attemptId,
        nowMs: Number.MAX_SAFE_INTEGER,
      })).toThrow(/rollback window/i);
      nowMs = extendedDeadline;
      expect(() => reopened.beginCompactionSourceRelease({
        attemptId,
        nowMs: 0,
      })).not.toThrow();
    } finally {
      reopened.close();
    }
  });

  it("rebuilds a rollback extension from canonical after SQLite loss", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    let nowMs = Date.now();
    const sessionId = "retention-extension-db-loss";
    const store = openStore(sessionId, { nowMilliseconds: () => nowMs }, cwd);
    let attemptId = "";
    let originalDeadline = 0;
    let extendedDeadline = 0;
    try {
      const transaction = commitSmallCompaction(store, "extension-db-loss-attempt");
      attemptId = transaction.intent.attempt_id;
      store.markProjectionComplete(attemptId);
      store.markCleanupComplete(attemptId);
      originalDeadline = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      extendedDeadline = originalDeadline + 120_000;
      store.extendCompactionRollbackRetention(attemptId, extendedDeadline);
    } finally {
      store.close();
    }
    removeStateDatabase(cwd);
    nowMs = originalDeadline;
    const reopened = openStore(sessionId, {
      resume: true,
      nowMilliseconds: () => nowMs,
    }, cwd);
    try {
      expect(() => reopened.beginCompactionSourceRelease({
        attemptId,
        nowMs: Number.MAX_SAFE_INTEGER,
      })).toThrow(/rollback window/i);
      nowMs = extendedDeadline;
      expect(() => reopened.beginCompactionSourceRelease({
        attemptId,
        nowMs: 0,
      })).not.toThrow();
    } finally {
      reopened.close();
    }
  });

  it("blocks the exact first ordinal after a physically deleted source row", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    let nowMs = Date.now();
    const store = openStore("deleted-plus-one", { nowMilliseconds: () => nowMs }, cwd);
    try {
      const transaction = commitSmallCompaction(store, "deleted-plus-one-source");
      store.markProjectionComplete(transaction.intent.attempt_id);
      const deletedLine = Math.min(...transaction.prepared.source.active_history_refs
        .map((ref) => ref.first_sequence));
      seedOrdinalGuardPin(
        cwd,
        transaction.intent,
        "deleted-plus-one-guard",
        deletedLine + 1,
      );
      nowMs = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      expect(() => store.beginCompactionSourceRelease({
        attemptId: transaction.intent.attempt_id,
        nowMs: 0,
      })).toThrow(/deleted-plus-one-guard.*live ordinal/i);
    } finally {
      store.close();
    }
  });

  it("does not overblock an active ordinal strictly before deleted rows", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    let nowMs = Date.now();
    const store = openStore("before-deleted-row", { nowMilliseconds: () => nowMs }, cwd);
    try {
      const transaction = commitSmallCompaction(store, "before-deleted-source");
      store.markProjectionComplete(transaction.intent.attempt_id);
      const deletedLine = Math.min(...transaction.prepared.source.active_history_refs
        .map((ref) => ref.first_sequence));
      seedOrdinalGuardPin(
        cwd,
        transaction.intent,
        "before-deleted-guard",
        deletedLine - 1,
      );
      nowMs = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      expect(() => store.beginCompactionSourceRelease({
        attemptId: transaction.intent.attempt_id,
        nowMs: 0,
      })).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("blocks A pruning when C retains a post-A ordinal after B was released", () => {
    let nowMs = Date.now();
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const store = openStore("transitive-ordinal-prune", {
      nowMilliseconds: () => nowMs,
    }, cwd);
    try {
      const generationA = commitSmallCompaction(store, "ordinal-a");
      store.markProjectionComplete(generationA.intent.attempt_id);
      const generationB = commitSmallCompaction(store, "ordinal-b");
      store.markProjectionComplete(generationB.intent.attempt_id);

      nowMs = generationB.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      store.beginCompactionSourceRelease({
        attemptId: generationB.intent.attempt_id,
        nowMs: Number.MAX_SAFE_INTEGER,
      });

      const generationC = commitSmallCompaction(store, "ordinal-c");
      store.markProjectionComplete(generationC.intent.attempt_id);
      const expected = store.prepareSource("ordinal-reopen-proof", []);
      expect(() =>
        store.beginCompactionSourceRelease({
          attemptId: generationA.intent.attempt_id,
          nowMs: Number.MAX_SAFE_INTEGER,
        }),
      ).toThrow(/descendant_compaction reference ordinal-c|ordinal-c.*live ordinal/i);
      expect(readFileSync(store.rolloutPath, "utf8")).toContain("source one");
      store.close();
      const reopened = openStore("transitive-ordinal-prune", {
        resume: true,
        nowMilliseconds: () => nowMs,
      }, cwd);
      try {
        const actual = reopened.prepareSource("ordinal-reopen-proof", []);
        expect(actual.source.source_sha256).toBe(expected.source.source_sha256);
        expect(actual.source.active_history_refs).toEqual(
          expected.source.active_history_refs,
        );
        expect(actual.messages).toEqual(expected.messages);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
    }
  });

  it("resumes finalization after a crash following physical source pruning", () => {
    let nowMs = Date.now();
    const store = openStore("prune-crash", {
      nowMilliseconds: () => nowMs,
      afterCompactionSourcePruneRewriteForTestingOnly: () => {
        throw new Error("crash after physical prune");
      },
    });
    try {
      const transaction = commitSmallCompaction(store, "prune-crash-attempt");
      store.markProjectionComplete(transaction.intent.attempt_id);
      const releaseAt = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      nowMs = releaseAt;
      expect(() =>
        store.beginCompactionSourceRelease({
          attemptId: transaction.intent.attempt_id,
          nowMs: releaseAt,
        }),
      ).toThrow(/crash after physical prune/i);
      expect(physicalResponseContents(store.rolloutPath)).not.toContain("source one");
      expect(sourceHistoryPayloadStats(store.rolloutPath)).toEqual({
        records: 0,
        encodedBytes: 0,
      });
      expect(
        store.resumeCompactionSourceRelease({
          attemptId: transaction.intent.attempt_id,
          nowMs: releaseAt + 1,
        }),
      ).toBe(true);
      expect(sourceHistoryPayloadStats(store.rolloutPath)).toEqual({
        records: 0,
        encodedBytes: 0,
      });
    } finally {
      store.close();
    }
  });

  it("rebuilds canonical compaction authority after complete SQLite loss", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    let nowMs = Date.now();
    const sessionId = "canonical-db-rebuild";
    const store = openStore(sessionId, { nowMilliseconds: () => nowMs }, cwd);
    let attemptId = "";
    let releaseAt = 0;
    try {
      const transaction = commitSmallCompaction(store, "canonical-db-attempt");
      attemptId = transaction.intent.attempt_id;
      store.markProjectionComplete(attemptId);
      store.markCleanupComplete(attemptId);
      releaseAt = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
    } finally {
      store.close();
    }

    removeStateDatabase(cwd);

    const reopened = openStore(sessionId, {
      resume: true,
      nowMilliseconds: () => nowMs,
    }, cwd);
    try {
      expect(() => reopened.assertCompactionProjectionReady()).not.toThrow();
      nowMs = releaseAt;
      expect(() => reopened.beginCompactionSourceRelease({
        attemptId,
        nowMs: Number.MAX_SAFE_INTEGER,
      })).not.toThrow();
      expect(sourceHistoryPayloadStats(reopened.rolloutPath)).toEqual({
        records: 0,
        encodedBytes: 0,
      });
    } finally {
      reopened.close();
    }

    removeStateDatabase(cwd);
    const rebuiltAfterRelease = openStore(sessionId, {
      resume: true,
      nowMilliseconds: () => nowMs,
    }, cwd);
    try {
      expect(() => rebuiltAfterRelease.assertCompactionProjectionReady()).not.toThrow();
      expect(sourceHistoryPayloadStats(rebuiltAfterRelease.rolloutPath)).toEqual({
        records: 0,
        encodedBytes: 0,
      });
      expect(rebuiltAfterRelease.readAll().some((item) =>
        item.type === "compaction_source_release" &&
        item.payload.attempt_id === attemptId
      )).toBe(true);
    } finally {
      rebuiltAfterRelease.close();
    }
  });

  it("does not accumulate released source-history payloads", () => {
    let nowMs = Date.now();
    const store = openStore("repeated-source-payload-gc", {
      nowMilliseconds: () => nowMs,
    });
    try {
      for (let generation = 0; generation < 4; generation += 1) {
        const transaction = commitSmallCompaction(
          store,
          `released-payload-${generation}`,
        );
        store.markProjectionComplete(transaction.intent.attempt_id);
        const beforeRelease = sourceHistoryPayloadStats(
          store.rolloutPath,
          transaction.intent.attempt_id,
        );
        expect(beforeRelease.records).toBeGreaterThan(0);
        expect(beforeRelease.encodedBytes).toBeGreaterThan(0);
        nowMs = Math.max(
          nowMs,
          transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS,
        );
        store.beginCompactionSourceRelease({
          attemptId: transaction.intent.attempt_id,
          nowMs,
        });
        expect(sourceHistoryPayloadStats(store.rolloutPath)).toEqual({
          records: 0,
          encodedBytes: 0,
        });
      }
    } finally {
      store.close();
    }
  });

  it("garbage-collects source history after a reviewed rollback owner is released", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
    temporaryWorkspaces.push(cwd);
    const sessionId = "released-reviewed-rollback-source";
    const targetSessionId = "released-reviewed-rollback-target";
    let nowMs = Date.now();
    const source = openStore(sessionId, {
      nowMilliseconds: () => nowMs,
    }, cwd);
    let attemptId = "";
    try {
      const transaction = commitSmallCompaction(
        source,
        "released-reviewed-rollback-attempt",
      );
      attemptId = transaction.intent.attempt_id;
      source.markProjectionComplete(attemptId);
      source.markCleanupComplete(attemptId);
      source.appendRollout(
        { type: "response_item", payload: { role: "user", content: "newer work" } },
        { durable: true },
      );
      nowMs = transaction.committedAtMs + 1;
      source.rollbackCompaction({
        attemptId,
        nowMs,
        reviewedBranchTargetSessionId: targetSessionId,
      });
      source.releaseCompactionSourceReference({
        attemptId,
        kind: "branch",
        referenceId: targetSessionId,
        recordedAtMs: nowMs + 1,
      });
      nowMs = transaction.committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS;
      source.beginCompactionSourceRelease({ attemptId, nowMs });

      expect(sourceHistoryPayloadStats(source.rolloutPath, attemptId)).toEqual({
        records: 0,
        encodedBytes: 0,
      });
      const releasedRows = source.readAll();
      expect(releasedRows.some((item) =>
        item.type === "compaction_rollback_committed" &&
        item.payload.attempt_id === attemptId
      )).toBe(true);
      expect(reconstructFromRollout(releasedRows).history.map(
        (message) => message.content,
      )).toEqual([
        "authenticated compaction boundary",
        "source summary",
        "newer work",
      ]);
    } finally {
      source.close();
    }

    removeStateDatabase(cwd);
    const rebuilt = openStore(sessionId, {
      resume: true,
      nowMilliseconds: () => nowMs,
    }, cwd);
    try {
      expect(() => rebuilt.assertCompactionProjectionReady()).not.toThrow();
      expect(sourceHistoryPayloadStats(rebuilt.rolloutPath, attemptId)).toEqual({
        records: 0,
        encodedBytes: 0,
      });
      expect(rebuilt.readAll().some((item) =>
        item.type === "compaction_source_release" &&
        item.payload.attempt_id === attemptId
      )).toBe(true);
    } finally {
      rebuilt.close();
    }
  });
});

function openStore(
  sessionId: string,
  options: {
    readonly afterCompactionCommitAppendForTestingOnly?: () => void;
    readonly afterCompactionSourcePruneRewriteForTestingOnly?: () => void;
    readonly afterCompactionRollbackAppendForTestingOnly?: () => void;
    readonly nowMilliseconds?: () => number;
    readonly resume?: boolean;
  } = {},
  existingCwd?: string,
): RolloutStore {
  const cwd = existingCwd ?? mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
  if (existingCwd === undefined) temporaryWorkspaces.push(cwd);
  const store = new RolloutStore({
    cwd,
    sessionId,
    agencVersion: "0.13.0",
    autoStartScheduler: false,
    ...options,
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "c2-test",
    agencVersion: "0.13.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function committedStructuredFixture(
  sessionId: string,
  leafCount: number,
  fanIn: number,
): { readonly cwd: string; readonly rolloutPath: string; readonly sessionId: string } {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-c2-workspace-"));
  temporaryWorkspaces.push(cwd);
  const store = openStore(sessionId, {}, cwd);
  const rolloutPath = store.rolloutPath;
  try {
    const transaction = commitStructuredCompaction(
      store,
      `${sessionId}-attempt`,
      leafCount,
      fanIn,
    );
    store.markProjectionComplete(transaction.intent.attempt_id);
    store.markCleanupComplete(transaction.intent.attempt_id);
  } finally {
    store.close();
  }
  return { cwd, rolloutPath, sessionId };
}

function commitStructuredCompaction(
  store: RolloutStore,
  attemptId: string,
  leafCount: number,
  fanIn: number,
): { readonly intent: CompactionIntentV1 } {
  for (let index = 0; index < leafCount; index += 1) {
    store.appendRollout(
      {
        type: "response_item",
        payload: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `structured-source-${index}`,
        },
      },
      { durable: true },
    );
  }
  const prepared = store.prepareSource(attemptId, []);
  const topology = fixtureTopology(leafCount, fanIn);
  const intent: CompactionIntentV1 = {
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
    attempt_id: attemptId,
    recorded_at_ms: Date.now(),
    source: prepared.source,
    policy_digest: "4".repeat(64),
    configuration_digest: "5".repeat(64),
    accounting_ref: "6".repeat(64),
    automatic: false,
    selected_history_indexes: prepared.source.active_history_refs.map(
      (ref) => ref.history_index,
    ),
    admission_required: true,
    planned_provider_calls: topology.calls,
  };
  store.pinAndRecordIntent(intent, sourcePayloadBundles(prepared, intent));
  appendCompactionAdmissionLifecycle(store, intent);
  const leaves = prepared.source.active_history_refs.map((_ref, index) =>
    leafForActiveRange(
      {
        source: prepared.source,
        attempt_id: attemptId,
      } as CompactionCommittedV1,
      index,
      index + 1,
    )
  );
  const tree = balancedDagSummaries(intent, leaves, fanIn);
  const dagWithoutDigest = {
    reduction_fan_in: fanIn,
    maximum_levels: topology.levels,
    planned_provider_calls: topology.calls,
    leaf_plan: leaves.map((sourceRef) => ({ source_ref: sourceRef, tool_pairs: [] })),
    intermediate_summaries: tree.intermediates,
  } as const;
  const summaryDag = {
      ...dagWithoutDigest,
      dag_sha256: digestWithDomain(
        COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
        dagWithoutDigest,
      ),
    };
  const replacementHistory = replacementForSummary(attemptId, tree.final);
  const committedAtMs = Date.now();
  store.commit({
    intent,
    summary: tree.final,
    summary_dag: summaryDag,
    accounting: {
      accounting_ref: intent.accounting_ref,
      source_tokens: 8_000,
      candidate_tokens: 500,
      context_window_tokens: 16_000,
      reserved_output_tokens: 1_000,
      source: "provider_exact",
      confidence: "exact",
    },
    replacement_history: replacementHistory,
    committed_at_ms: committedAtMs,
    payload_bundles: commitPayloadBundles({
      attemptId,
      recordedAtMs: committedAtMs,
      summary: tree.final,
      summaryDag,
      replacementHistory,
    }),
  });
  return { intent };
}

function fixtureTopology(
  leaves: number,
  fanIn: number,
): { readonly levels: number; readonly calls: number } {
  let levelWidth = leaves;
  let levels = 1;
  let calls = leaves;
  while (levelWidth > 1) {
    const fullGroups = Math.floor(levelWidth / fanIn);
    const remainder = levelWidth % fanIn;
    const reductionCalls = levelWidth <= fanIn
      ? 1
      : fullGroups + (remainder > 1 ? 1 : 0);
    levelWidth = reductionCalls + (remainder === 1 ? 1 : 0);
    calls += reductionCalls;
    levels += 1;
  }
  return { levels, calls };
}

function balancedDagSummaries(
  intent: CompactionIntentV1,
  leaves: readonly RolloutSpanRefV1[],
  fanIn: number,
): {
  readonly final: CompactionSummaryV1;
  readonly intermediates: CompactionSummaryDagV1["intermediate_summaries"];
} {
  const intermediates: Array<{
    readonly ref: CompactionSummaryRefV1;
    readonly summary: CompactionSummaryV1;
  }> = [];
  let serial = 0;
  const make = (
    stage: "map" | "reduce" | "final",
    refs: readonly (RolloutSpanRefV1 | CompactionSummaryRefV1)[],
  ): { readonly ref: CompactionSummaryRefV1; readonly summary: CompactionSummaryV1 } => {
    serial += 1;
    const summary = createCompactionSummaryV1({
      stage,
      attemptId: intent.attempt_id,
      policyDigest: intent.policy_digest,
      accountingRef: intent.accounting_ref,
      sourceRefs: refs,
      body: { narrative: `${stage}-${serial}`, facts: [], open_actions: [], tool_pairs: [] },
    });
    return {
      ref: {
        kind: "compaction_summary",
        ref_id: `${intent.attempt_id}:summary:${serial}`,
        sha256: summary.summary_sha256,
      },
      summary,
    };
  };
  if (leaves.length === 1) {
    return { final: make("final", leaves).summary, intermediates };
  }
  let level = leaves.map((leaf) => {
    const node = make("map", [leaf]);
    intermediates.push(node);
    return node.ref;
  });
  while (level.length > fanIn) {
    const next: CompactionSummaryRefV1[] = [];
    for (let index = 0; index < level.length; index += fanIn) {
      const group = level.slice(index, index + fanIn);
      if (group.length === 1) {
        next.push(group[0]!);
      } else {
        const node = make("reduce", group);
        intermediates.push(node);
        next.push(node.ref);
      }
    }
    level = next;
  }
  return { final: make("final", level).summary, intermediates };
}

function replacementForSummary(
  attemptId: string,
  summary: CompactionSummaryV1,
): CompactionCommittedV1["replacement_history"] {
  return [
    {
      role: "developer",
      content: "authenticated compaction boundary",
      compactionHistory: {
        version: 1,
        kind: "boundary",
        attempt_id: attemptId,
        summary_sha256: summary.summary_sha256,
      },
    },
    {
      role: "user",
      content: summary.body.narrative,
      compactionHistory: {
        version: 1,
        kind: "summary",
        attempt_id: attemptId,
        summary_sha256: summary.summary_sha256,
      },
    },
  ];
}

function rewriteCommittedDag(
  rolloutPath: string,
  rewrite: (commit: CompactionCommittedV1) => {
    readonly dag: Omit<CompactionSummaryDagV1, "dag_sha256">;
    readonly summary?: CompactionSummaryV1;
  },
): void {
  rewriteManifestCommit(rolloutPath, (commit) => {
    const rewritten = rewrite(commit);
    const withoutDigest = rewritten.dag;
    const summary = rewritten.summary ?? commit.summary;
    return {
      summary,
      summaryDag: {
        ...withoutDigest,
        dag_sha256: digestWithDomain(
          COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
          withoutDigest,
        ),
      },
      replacementHistory: replacementForSummary(commit.attempt_id, summary),
    };
  });
}

function chainedDag(
  commit: CompactionCommittedV1,
  leaves: readonly RolloutSpanRefV1[],
): {
  readonly dag: Omit<CompactionSummaryDagV1, "dag_sha256">;
  readonly summary: CompactionSummaryV1;
} {
  const nodes = balancedDagSummaries(
    {
      attempt_id: commit.attempt_id,
      policy_digest: commit.policy_digest,
      accounting_ref: commit.accounting.accounting_ref,
    } as CompactionIntentV1,
    leaves.slice(0, 2),
    2,
  );
  const intermediates = [...nodes.intermediates];
  let previous = summaryRefFor(nodes.final, `${commit.attempt_id}:chain:2`);
  intermediates.push({ ref: previous, summary: nodes.final });
  let final = nodes.final;
  for (let index = 2; index < leaves.length; index += 1) {
    const map = createSummaryNode(commit, "map", [leaves[index]!], `map:${index}`);
    intermediates.push(map);
    const stage = index === leaves.length - 1 ? "final" : "reduce";
    const parent = createSummaryNode(commit, stage, [previous, map.ref], `chain:${index + 1}`);
    final = parent.summary;
    if (stage !== "final") intermediates.push(parent);
    previous = parent.ref;
  }
  return {
    dag: {
      reduction_fan_in: 2,
      maximum_levels: 4,
      planned_provider_calls: intermediates.length + 1,
      leaf_plan: commit.summary_dag.leaf_plan,
      intermediate_summaries: intermediates,
    },
    summary: final,
  };
}

function overfanDag(
  commit: CompactionCommittedV1,
  leaves: readonly RolloutSpanRefV1[],
): {
  readonly dag: Omit<CompactionSummaryDagV1, "dag_sha256">;
  readonly summary: CompactionSummaryV1;
} {
  const maps = leaves.map((leaf, index) =>
    createSummaryNode(commit, "map", [leaf], `overfan-map:${index}`)
  );
  const finalNode = createSummaryNode(
    commit,
    "final",
    maps.map((node) => node.ref),
    "overfan-final",
  );
  return {
    dag: {
      reduction_fan_in: 8,
      maximum_levels: 2,
      planned_provider_calls: maps.length + 1,
      leaf_plan: commit.summary_dag.leaf_plan,
      intermediate_summaries: maps,
    },
    summary: finalNode.summary,
  };
}

function createSummaryNode(
  commit: CompactionCommittedV1,
  stage: "map" | "reduce" | "final",
  refs: readonly (RolloutSpanRefV1 | CompactionSummaryRefV1)[],
  id: string,
): { readonly ref: CompactionSummaryRefV1; readonly summary: CompactionSummaryV1 } {
  const summary = createCompactionSummaryV1({
    stage,
    attemptId: commit.attempt_id,
    policyDigest: commit.policy_digest,
    accountingRef: commit.accounting.accounting_ref,
    sourceRefs: refs,
    body: { narrative: id, facts: [], open_actions: [], tool_pairs: [] },
  });
  return { ref: summaryRefFor(summary, `${commit.attempt_id}:${id}`), summary };
}

function summaryRefFor(
  summary: CompactionSummaryV1,
  refId: string,
): CompactionSummaryRefV1 {
  return {
    kind: "compaction_summary",
    ref_id: refId,
    sha256: summary.summary_sha256,
  };
}

function rewriteCommittedLeaves(
  rolloutPath: string,
  corruption: "foreign" | "out-of-range" | "gap" | "overlap",
): void {
  rewriteManifestCommit(rolloutPath, (commit) => {
    const all = leafForActiveRange(
      commit,
      0,
      commit.source.active_history_refs.length,
    );
    const first = leafForActiveRange(commit, 0, 1);
    const second = leafForActiveRange(
      commit,
      1,
      commit.source.active_history_refs.length,
    );
    const leaves: readonly RolloutSpanRefV1[] = corruption === "foreign"
      ? [{ ...all, source_binding: `${all.source_binding}:foreign` }]
      : corruption === "out-of-range"
        ? [{ ...all, first_sequence: commit.source.first_sequence - 1 }]
        : corruption === "gap"
          ? [first]
          : [all, { ...second, ref_id: `${second.ref_id}:overlap` }];
    const summary = createCompactionSummaryV1({
      stage: "final",
      attemptId: commit.attempt_id,
      policyDigest: commit.policy_digest,
      accountingRef: commit.accounting.accounting_ref,
      sourceRefs: leaves,
      body: commit.summary.body,
    });
    const dagWithoutDigest = {
      reduction_fan_in: commit.summary_dag.reduction_fan_in,
      maximum_levels: 1,
      planned_provider_calls: 1,
      leaf_plan: leaves.map((sourceRef) => ({
        source_ref: sourceRef,
        tool_pairs: [],
      })),
      intermediate_summaries: [],
    } as const;
    const replacementHistory = commit.replacement_history.map((message) => ({
      ...message,
      ...(message.compactionHistory === undefined
        ? {}
        : {
            compactionHistory: {
              ...message.compactionHistory,
              summary_sha256: summary.summary_sha256,
            },
          }),
    }));
    return {
      summary,
      summaryDag: {
        ...dagWithoutDigest,
        dag_sha256: digestWithDomain(
          COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
          dagWithoutDigest,
        ),
      },
      replacementHistory,
    };
  });
}

interface TestRolloutRow {
  readonly type: string;
  readonly payload: unknown;
  readonly eventVersion?: number;
}

function mutatePayloadChunk(
  rolloutPath: string,
  payloadKind: CompactionPayloadKind,
  mutate: (fragment: string) => string,
): void {
  const rows = readTestRolloutRows(rolloutPath);
  const chunkIndex = rows.findIndex((row) =>
    row.type === "compaction_payload_chunk" &&
    (row.payload as CompactionPayloadChunkV1).payload_kind === payloadKind
  );
  if (chunkIndex < 0) {
    throw new Error(`test rollout has no ${payloadKind} payload chunk`);
  }
  const row = rows[chunkIndex]!;
  const chunk = row.payload as CompactionPayloadChunkV1;
  const changed = mutate(chunk.canonical_json_fragment);
  if (changed === chunk.canonical_json_fragment) {
    throw new Error(`test mutation did not change ${payloadKind}`);
  }
  rows[chunkIndex] = {
    ...row,
    payload: { ...chunk, canonical_json_fragment: changed },
  };
  writeTestRolloutRows(rolloutPath, rows);
}

function rewriteManifestCommit(
  rolloutPath: string,
  rewrite: (commit: CompactionCommittedV1) => {
    readonly summary: CompactionSummaryV1;
    readonly summaryDag: CompactionSummaryDagV1;
    readonly replacementHistory: CompactionCommittedV1["replacement_history"];
  },
): void {
  let rows = readTestRolloutRows(rolloutPath);
  const persistedCommit = rows.find((row) => row.type === "compaction_committed")
    ?.payload as CompactionPersistedCommittedV1 | undefined;
  if (persistedCommit === undefined) {
    throw new Error("test rollout has no persisted compaction commit");
  }
  const commit = hydrateTestCommit(rows, persistedCommit);
  const rewritten = rewrite(commit);
  const bundles = commitPayloadBundles({
    attemptId: commit.attempt_id,
    recordedAtMs: commit.recorded_at_ms,
    summary: rewritten.summary,
    summaryDag: rewritten.summaryDag,
    replacementHistory: rewritten.replacementHistory,
  });
  rows = replaceTestPayloadBundle(rows, bundles.final_summary);
  rows = replaceTestPayloadBundle(rows, bundles.summary_dag);
  rows = replaceTestPayloadBundle(rows, bundles.replacement_history);
  const commitIndex = rows.findIndex((row) => row.type === "compaction_committed");
  if (commitIndex < 0) throw new Error("test rollout lost its compaction commit");
  const commitRow = rows[commitIndex]!;
  rows[commitIndex] = {
    ...commitRow,
    payload: {
      ...persistedCommit,
      final_summary_manifest: bundles.final_summary.manifest,
      summary_dag_manifest: bundles.summary_dag.manifest,
      replacement_history_manifest: bundles.replacement_history.manifest,
    },
  };
  writeTestRolloutRows(rolloutPath, rows);
}

function hydrateTestCommit(
  rows: readonly TestRolloutRow[],
  persisted: CompactionPersistedCommittedV1,
): CompactionCommittedV1 {
  const {
    active_history_refs_manifest: activeHistoryManifest,
    ...sourceWithoutRefs
  } = persisted.source;
  const activeHistoryEntries = reconstructTestPayload(
    rows,
    activeHistoryManifest,
  ) as readonly CompactionActiveHistoryEntryV1[];
  const {
    final_summary_manifest: finalSummaryManifest,
    summary_dag_manifest: summaryDagManifest,
    replacement_history_manifest: replacementHistoryManifest,
    source: _persistedSource,
    ...commitWithoutPayloads
  } = persisted;
  return {
    ...commitWithoutPayloads,
    source: {
      ...sourceWithoutRefs,
      active_history_refs: hydrateActiveHistoryRefs(
        sourceWithoutRefs,
        activeHistoryEntries,
      ),
    },
    summary: reconstructTestPayload(
      rows,
      finalSummaryManifest,
    ) as CompactionSummaryV1,
    summary_dag: reconstructTestPayload(
      rows,
      summaryDagManifest,
    ) as CompactionSummaryDagV1,
    replacement_history: reconstructTestPayload(
      rows,
      replacementHistoryManifest,
    ) as CompactionCommittedV1["replacement_history"],
  };
}

function reconstructTestPayload(
  rows: readonly TestRolloutRow[],
  manifest: CompactionPayloadBundleV1["manifest"],
): unknown {
  const chunks = rows
    .filter((row) =>
      row.type === "compaction_payload_chunk" &&
      (row.payload as CompactionPayloadChunkV1).attempt_id === manifest.attempt_id &&
      (row.payload as CompactionPayloadChunkV1).payload_kind === manifest.payload_kind
    )
    .map((row) => row.payload as CompactionPayloadChunkV1);
  return reconstructCompactionPayloadV1(manifest, chunks);
}

function replaceTestPayloadBundle(
  rows: readonly TestRolloutRow[],
  bundle: CompactionPayloadBundleV1,
): TestRolloutRow[] {
  const firstChunkIndex = rows.findIndex((row) =>
    row.type === "compaction_payload_chunk" &&
    (row.payload as CompactionPayloadChunkV1).attempt_id ===
      bundle.manifest.attempt_id &&
    (row.payload as CompactionPayloadChunkV1).payload_kind ===
      bundle.manifest.payload_kind
  );
  if (firstChunkIndex < 0) {
    throw new Error(`test rollout has no ${bundle.manifest.payload_kind} bundle`);
  }
  const retained = rows.filter((row) =>
    row.type !== "compaction_payload_chunk" ||
    (row.payload as CompactionPayloadChunkV1).attempt_id !==
      bundle.manifest.attempt_id ||
    (row.payload as CompactionPayloadChunkV1).payload_kind !==
      bundle.manifest.payload_kind
  );
  const inserted = bundle.chunks.map((chunk) => ({
    type: "compaction_payload_chunk",
    payload: chunk,
    eventVersion: 2,
  }));
  retained.splice(firstChunkIndex, 0, ...inserted);
  return retained;
}

function readTestRolloutRows(rolloutPath: string): TestRolloutRow[] {
  return readFileSync(rolloutPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as TestRolloutRow);
}

function writeTestRolloutRows(
  rolloutPath: string,
  rows: readonly TestRolloutRow[],
): void {
  writeFileSync(
    rolloutPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

function physicalResponseContents(rolloutPath: string): readonly unknown[] {
  return readTestRolloutRows(rolloutPath)
    .filter((row) => row.type === "response_item")
    .map((row) => (row.payload as { readonly content?: unknown }).content);
}

function sourceHistoryPayloadStats(
  rolloutPath: string,
  attemptId?: string,
): { readonly records: number; readonly encodedBytes: number } {
  const rows = readTestRolloutRows(rolloutPath).filter((row) =>
    row.type === "compaction_payload_chunk" &&
    (row.payload as CompactionPayloadChunkV1).payload_kind === "source_history" &&
    (attemptId === undefined ||
      (row.payload as CompactionPayloadChunkV1).attempt_id === attemptId)
  );
  return {
    records: rows.length,
    encodedBytes: rows.reduce(
      (total, row) => total + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
      0,
    ),
  };
}

function leafForActiveRange(
  commit: CompactionCommittedV1,
  start: number,
  end: number,
): RolloutSpanRefV1 {
  const active = commit.source.active_history_refs.slice(start, end);
  const first = active[0];
  const last = active.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("test leaf range is empty");
  }
  const messageSources = active.map((ref) => ({
    kind: ref.kind,
    ref_id: ref.ref_id,
    source_binding: ref.source_binding,
    first_sequence: ref.first_sequence,
    last_sequence: ref.last_sequence,
    sha256: ref.sha256,
    first_history_index: ref.history_index,
    last_history_index: ref.history_index,
    contributing_ref_ids: [ref.ref_id],
  }));
  return {
    kind: "rollout_span",
    ref_id: `${commit.attempt_id}:test-span:${start}-${end}`,
    source_binding: commit.source.source_binding,
    first_sequence: first.first_sequence,
    last_sequence: last.last_sequence,
    first_history_index: first.history_index,
    last_history_index: last.history_index,
    contributing_ref_ids: active.map((ref) => ref.ref_id),
    sha256: digestWithDomain(COMPACTION_SOURCE_DIGEST_DOMAIN, {
      source_sha256: commit.source.source_sha256,
      message_sources: messageSources,
    }),
  };
}

function commitSmallCompaction(
  store: RolloutStore,
  attemptId: string,
  beforeCommit?: () => void,
  replacementTail: readonly CompactionCommittedV1["replacement_history"][number][] = [],
  automatic = false,
): {
  readonly prepared: CompactionPreparedSourceV1;
  readonly intent: CompactionIntentV1;
  readonly committedAtMs: number;
} {
  store.appendRollout(
    { type: "response_item", payload: { role: "user", content: "source one" } },
    { durable: true },
  );
  store.appendRollout(
    { type: "response_item", payload: { role: "assistant", content: "source two" } },
    { durable: true },
  );
  const prepared = store.prepareSource(attemptId, []);
  const intent: CompactionIntentV1 = {
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
    attempt_id: attemptId,
    recorded_at_ms: Date.now(),
    source: prepared.source,
    policy_digest: "1".repeat(64),
    configuration_digest: "2".repeat(64),
    accounting_ref: "3".repeat(64),
    automatic,
    selected_history_indexes: prepared.source.active_history_refs.map(
      (ref) => ref.history_index,
    ),
    admission_required: true,
    planned_provider_calls: 1,
  };
  store.pinAndRecordIntent(intent, sourcePayloadBundles(prepared, intent));
  appendCompactionAdmissionLifecycle(store, intent);
  const firstMessageRef = prepared.message_source_refs[0]!;
  const lastMessageRef = prepared.message_source_refs.at(-1)!;
  const sourceRef = {
    kind: "rollout_span" as const,
    ref_id: `${attemptId}:span:001`,
    source_binding: prepared.source.source_binding,
    first_sequence: firstMessageRef.first_sequence,
    last_sequence: lastMessageRef.last_sequence,
    first_history_index: firstMessageRef.first_history_index!,
    last_history_index: lastMessageRef.last_history_index!,
    contributing_ref_ids: prepared.message_source_refs.flatMap((ref) =>
      ref.contributing_ref_ids ?? [ref.ref_id]
    ),
    sha256: digestWithDomain(COMPACTION_SOURCE_DIGEST_DOMAIN, {
      source_sha256: prepared.source.source_sha256,
      message_sources: prepared.message_source_refs,
    }),
  };
  const summary = createCompactionSummaryV1({
    stage: "final",
    attemptId,
    policyDigest: intent.policy_digest,
    accountingRef: intent.accounting_ref,
    sourceRefs: [sourceRef],
    body: {
      narrative: "source summary",
      facts: [],
      open_actions: [],
      tool_pairs: [],
    },
  });
  const dagWithoutDigest = {
    reduction_fan_in: 8,
    maximum_levels: 1,
    planned_provider_calls: 1,
    leaf_plan: [{ source_ref: sourceRef, tool_pairs: [] }],
    intermediate_summaries: [],
  } as const;
  const committedAtMs = Date.now();
  const summaryDag = {
    ...dagWithoutDigest,
    dag_sha256: digestWithDomain(
      COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
      dagWithoutDigest,
    ),
  };
  const replacementHistory = [
    {
      role: "developer" as const,
      content: "authenticated compaction boundary",
      compactionHistory: {
        version: 1 as const,
        kind: "boundary" as const,
        attempt_id: attemptId,
        summary_sha256: summary.summary_sha256,
      },
    },
    {
      role: "user" as const,
      content: "source summary",
      compactionHistory: {
        version: 1 as const,
        kind: "summary" as const,
        attempt_id: attemptId,
        summary_sha256: summary.summary_sha256,
      },
    },
    ...replacementTail,
  ];
  beforeCommit?.();
  store.commit({
    intent,
    summary,
    summary_dag: summaryDag,
    accounting: {
      accounting_ref: intent.accounting_ref,
      source_tokens: 4_000,
      candidate_tokens: 500,
      context_window_tokens: 8_000,
      reserved_output_tokens: 1_000,
      source: "provider_exact",
      confidence: "exact",
    },
    replacement_history: replacementHistory,
    committed_at_ms: committedAtMs,
    payload_bundles: commitPayloadBundles({
      attemptId,
      recordedAtMs: committedAtMs,
      summary,
      summaryDag,
      replacementHistory,
    }),
  });
  return { prepared, intent, committedAtMs };
}

function sourcePayloadBundles(
  prepared: CompactionPreparedSourceV1,
  intent: CompactionIntentV1,
): CompactionSourcePayloadBundlesV1 {
  const activeHistoryEntries = compactActiveHistoryEntries(
    prepared.source.active_history_refs,
  );
  const sourceHistory = prepared.messages.map(projectionMessage);
  return {
    active_history_refs: createCompactionPayloadBundleV1({
      attemptId: intent.attempt_id,
      recordedAtMs: intent.recorded_at_ms,
      payloadKind: "active_history_refs",
      value: activeHistoryEntries,
      itemCount: activeHistoryEntries.length,
    }),
    source_history: createCompactionPayloadBundleV1({
      attemptId: intent.attempt_id,
      recordedAtMs: intent.recorded_at_ms,
      payloadKind: "source_history",
      value: sourceHistory,
      itemCount: sourceHistory.length,
    }),
  };
}

function commitPayloadBundles(params: {
  readonly attemptId: string;
  readonly recordedAtMs: number;
  readonly summary: CompactionCommittedV1["summary"];
  readonly summaryDag: CompactionCommittedV1["summary_dag"];
  readonly replacementHistory: CompactionCommittedV1["replacement_history"];
}): CompactionCommitPayloadBundlesV1 {
  return {
    final_summary: createCompactionPayloadBundleV1({
      attemptId: params.attemptId,
      recordedAtMs: params.recordedAtMs,
      payloadKind: "final_summary",
      value: params.summary,
      itemCount: 1,
    }),
    summary_dag: createCompactionPayloadBundleV1({
      attemptId: params.attemptId,
      recordedAtMs: params.recordedAtMs,
      payloadKind: "summary_dag",
      value: params.summaryDag,
      itemCount: 1,
    }),
    replacement_history: createCompactionPayloadBundleV1({
      attemptId: params.attemptId,
      recordedAtMs: params.recordedAtMs,
      payloadKind: "replacement_history",
      value: params.replacementHistory,
      itemCount: params.replacementHistory.length,
    }),
  };
}

function projectionMessage(message: RuntimeMessage): CompactionProjectionMessageV1 {
  const role = message.originalRole ?? message.role ?? message.message?.role ?? "user";
  if (!["system", "developer", "user", "assistant", "tool"].includes(role)) {
    throw new Error(`unsupported test projection role ${role}`);
  }
  const content = message.content ?? message.message?.content ?? "";
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new Error("test projection content is not persistable");
  }
  return {
    role: role as CompactionProjectionMessageV1["role"],
    content: content as CompactionProjectionMessageV1["content"],
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.uuid !== undefined ? { id: message.uuid } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    ...(message.runtimeOnly?.toolResultIntegrity !== undefined
      ? { toolResultIntegrity: { ...message.runtimeOnly.toolResultIntegrity } }
      : {}),
    ...(message.runtimeOnly?.agentInvocation !== undefined
      ? { agentInvocation: { ...message.runtimeOnly.agentInvocation } }
      : {}),
    ...(message.runtimeOnly?.compactionHistory !== undefined
      ? { compactionHistory: { ...message.runtimeOnly.compactionHistory } }
      : {}),
  };
}

function appendCompactionAdmissionLifecycle(
  store: RolloutStore,
  intent: CompactionIntentV1,
): void {
  const timestamp = new Date(intent.recorded_at_ms).toISOString();
  const firstSequence = store.readAll().reduce(
    (maximum, item) =>
      item.type === "event_msg"
        ? Math.max(maximum, item.payload.seq ?? 0)
        : maximum,
    0,
  ) + 1;
  let offset = 0;
  for (
    let callNumber = 1;
    callNumber <= intent.planned_provider_calls;
    callNumber += 1
  ) {
    const stepId = `compact:${intent.attempt_id}:${callNumber}`;
    const reservationId = `reservation:${intent.attempt_id}:${callNumber}`;
    for (const event of ["queued", "allowed", "dispatched", "reconciled"] as const) {
      const eventId = `admission:${intent.attempt_id}:${callNumber}:${event}`;
      const sequence = firstSequence + offset;
      offset += 1;
      store.append(
        {
          id: eventId,
          eventId,
          seq: sequence,
          msg: {
            type: "execution_admission",
            payload: {
              sequence,
              eventId,
              timestamp,
              runId: intent.attempt_id,
              stepId,
              kind: "model_turn",
              event,
              reservationId,
            },
          },
        },
        { durable: true },
      );
    }
  }
}

function appendAutomaticCompactionBoundary(
  store: RolloutStore,
  turnId: string,
): void {
  const sequence = store.readAll().reduce(
    (maximum, item) =>
      item.type === "event_msg"
        ? Math.max(maximum, item.payload.seq ?? 0)
        : maximum,
    0,
  ) + 1;
  const eventId = `context-compacted:${turnId}`;
  store.append(
    {
      id: eventId,
      eventId,
      seq: sequence,
      msg: {
        type: "context_compacted",
        payload: { summary: `auto-compact boundary (turnId=${turnId})` },
      },
    },
    { durable: true },
  );
}

function seedOrdinalGuardPin(
  cwd: string,
  sourceIntent: CompactionIntentV1,
  attemptId: string,
  sequence: number,
): void {
  const digest = "a".repeat(64);
  const driver = openStateDatabases({ cwd });
  try {
    new CompactionRetentionRepository(driver).createPreparingPin({
      ...sourceIntent,
      attempt_id: attemptId,
      recorded_at_ms: sourceIntent.recorded_at_ms + 1,
      source: {
        ...sourceIntent.source,
        attempt_id: attemptId,
        first_sequence: sequence,
        last_sequence: sequence,
        source_sha256: digest,
        source_bytes: 1,
        history_digest: digest,
        active_history_refs: [{
          kind: "rollout_span",
          ref_id: `${attemptId}:guard`,
          source_binding: sourceIntent.source.source_binding,
          first_sequence: sequence,
          last_sequence: sequence,
          sha256: digest,
          history_index: 0,
          record_message_index: 0,
          encoded_bytes: 1,
        }],
      },
      selected_history_indexes: [0],
    });
  } finally {
    driver.close();
  }
}

function removeStateDatabase(cwd: string): void {
  const { stateDbPath } = resolveStateDatabasePaths({ cwd });
  unlinkSync(stateDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${stateDbPath}${suffix}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
}
