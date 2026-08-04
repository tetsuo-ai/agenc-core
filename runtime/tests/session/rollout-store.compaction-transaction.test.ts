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
  COMPACTION_READER_RUNTIME_CAPABILITY,
  COMPACTION_ROLLBACK_RETENTION_MS,
  COMPACTION_SOURCE_DIGEST_DOMAIN,
  COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
  type CompactionIntentV1,
  type CompactionCommittedV1,
  type CompactionPreparedSourceV1,
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
import { compactionMapReduceTopology } from "../../src/services/compact/plan.js";
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
    const journal = readFileSync(rolloutPath, "utf8");
    expect(journal).toContain('"content":"source summary"');
    writeFileSync(
      rolloutPath,
      journal.replace(
        '"content":"source summary"',
        '"content":"source tampery"',
      ),
      "utf8",
    );
    expect(() => openStore("commit-tamper", { resume: true }, cwd)).toThrow(
      /commit digest does not match/i,
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
    const journal = readFileSync(rolloutPath, "utf8");
    const rollbackCopy = journal.lastIndexOf('"content":"source one"');
    expect(rollbackCopy).toBeGreaterThan(0);
    const tampered =
      journal.slice(0, rollbackCopy) +
      journal.slice(rollbackCopy).replace(
        '"content":"source one"',
        '"content":"source uno"',
      );
    writeFileSync(rolloutPath, tampered, "utf8");
    expect(() => openStore("rollback-tamper", { resume: true }, cwd)).toThrow(
      /compaction_rollback_committed payload does not match the runtime schema/i,
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
          minimum_reader_runtime: COMPACTION_READER_RUNTIME_CAPABILITY,
        }).minimum_reader_runtime,
      ).toBe(COMPACTION_READER_RUNTIME_CAPABILITY);
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
        /compaction_committed payload does not match the runtime schema/i,
      );
    });
  }

  it("rejects a valid-rehashed summary DAG deeper than four levels on restart", () => {
    const fixture = committedStructuredFixture("dag-deep", 8, 2);
    rewriteCommittedDag(fixture.rolloutPath, (commit) =>
      chainedDag(commit, commit.summary_dag.leaf_plan.map((leaf) => leaf.source_ref))
    );
    expect(() => openStore(fixture.sessionId, { resume: true }, fixture.cwd)).toThrow(
      /compaction_committed payload does not match the runtime schema/i,
    );
  });

  it("rejects a valid-rehashed summary DAG above its effective fan-in on restart", () => {
    const fixture = committedStructuredFixture("dag-overfan", 9, 8);
    rewriteCommittedDag(fixture.rolloutPath, (commit) =>
      overfanDag(commit, commit.summary_dag.leaf_plan.map((leaf) => leaf.source_ref))
    );
    expect(() => openStore(fixture.sessionId, { resume: true }, fixture.cwd)).toThrow(
      /compaction_committed payload does not match the runtime schema/i,
    );
  });

  it("rejects a valid-rehashed DAG whose node count differs from planned calls", () => {
    const fixture = committedStructuredFixture("dag-call-count", 1, 8);
    rewriteCommittedDag(fixture.rolloutPath, (commit) => {
      const { dag_sha256: _digest, ...dag } = commit.summary_dag;
      return { dag: { ...dag, planned_provider_calls: 2 } };
    });
    expect(() => openStore(fixture.sessionId, { resume: true }, fixture.cwd)).toThrow(
      /compaction_committed payload does not match the runtime schema/i,
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
    expect(() =>
      validateCanonicalJournalBytes(Buffer.from(mismatched, "utf8"), {
        expectedRunId: fixture.sessionId,
        expectedEpoch: 1,
      })
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
      expect(readFileSync(store.rolloutPath, "utf8")).not.toContain("source one");
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
      expect(readFileSync(store.rolloutPath, "utf8")).not.toContain("source one");
      expect(
        store.resumeCompactionSourceRelease({
          attemptId: transaction.intent.attempt_id,
          nowMs: releaseAt + 1,
        }),
      ).toBe(true);
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
    } finally {
      reopened.close();
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
  const topology = compactionMapReduceTopology(leafCount, fanIn);
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
  store.pinAndRecordIntent(intent);
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
  store.commit({
    intent,
    summary: tree.final,
    summary_dag: {
      ...dagWithoutDigest,
      dag_sha256: digestWithDomain(
        COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
        dagWithoutDigest,
      ),
    },
    accounting: {
      accounting_ref: intent.accounting_ref,
      source_tokens: 8_000,
      candidate_tokens: 500,
      context_window_tokens: 16_000,
      reserved_output_tokens: 1_000,
      source: "provider_exact",
      confidence: "exact",
    },
    replacement_history: replacementForSummary(attemptId, tree.final),
    committed_at_ms: Date.now(),
  });
  return { intent };
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
  const lines = readFileSync(rolloutPath, "utf8").trimEnd().split("\n");
  const commitIndex = lines.findIndex((line) =>
    (JSON.parse(line) as { readonly type?: string }).type === "compaction_committed"
  );
  if (commitIndex < 0) throw new Error("test rollout has no compaction commit");
  const item = JSON.parse(lines[commitIndex]!) as {
    readonly type: "compaction_committed";
    readonly payload: CompactionCommittedV1;
    readonly eventVersion?: number;
  };
  const rewritten = rewrite(item.payload);
  const withoutDigest = rewritten.dag;
  const summary = rewritten.summary ?? item.payload.summary;
  lines[commitIndex] = JSON.stringify({
    ...item,
    payload: {
      ...item.payload,
      summary,
      summary_dag: {
        ...withoutDigest,
        dag_sha256: digestWithDomain(
          COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
          withoutDigest,
        ),
      },
      replacement_history: replacementForSummary(item.payload.attempt_id, summary),
    },
  });
  writeFileSync(rolloutPath, `${lines.join("\n")}\n`, "utf8");
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
  const lines = readFileSync(rolloutPath, "utf8").trimEnd().split("\n");
  const commitIndex = lines.findIndex((line) =>
    (JSON.parse(line) as { readonly type?: string }).type ===
      "compaction_committed"
  );
  if (commitIndex < 0) throw new Error("test rollout has no compaction commit");
  const item = JSON.parse(lines[commitIndex]!) as {
    readonly type: "compaction_committed";
    readonly payload: CompactionCommittedV1;
    readonly eventVersion?: number;
  };
  const commit = item.payload;
  const all = leafForActiveRange(commit, 0, commit.source.active_history_refs.length);
  const first = leafForActiveRange(commit, 0, 1);
  const second = leafForActiveRange(commit, 1, commit.source.active_history_refs.length);
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
  lines[commitIndex] = JSON.stringify({
    ...item,
    payload: {
      ...commit,
      summary,
      summary_dag: {
        ...dagWithoutDigest,
        dag_sha256: digestWithDomain(
          COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
          dagWithoutDigest,
        ),
      },
      replacement_history: replacementHistory,
    },
  });
  writeFileSync(rolloutPath, `${lines.join("\n")}\n`, "utf8");
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
    automatic: false,
    selected_history_indexes: prepared.source.active_history_refs.map(
      (ref) => ref.history_index,
    ),
    admission_required: true,
    planned_provider_calls: 1,
  };
  store.pinAndRecordIntent(intent);
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
  beforeCommit?.();
  store.commit({
    intent,
    summary,
    summary_dag: {
      ...dagWithoutDigest,
      dag_sha256: digestWithDomain(
        COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
        dagWithoutDigest,
      ),
    },
    accounting: {
      accounting_ref: intent.accounting_ref,
      source_tokens: 4_000,
      candidate_tokens: 500,
      context_window_tokens: 8_000,
      reserved_output_tokens: 1_000,
      source: "provider_exact",
      confidence: "exact",
    },
    replacement_history: [
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
        content: "source summary",
        compactionHistory: {
          version: 1,
          kind: "summary",
          attempt_id: attemptId,
          summary_sha256: summary.summary_sha256,
        },
      },
      ...replacementTail,
    ],
    committed_at_ms: committedAtMs,
  });
  return { prepared, intent, committedAtMs };
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
