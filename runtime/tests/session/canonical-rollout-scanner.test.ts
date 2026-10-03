import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { COMPACTION_SOURCE_DIGEST_DOMAIN } from "../../src/services/compact/transaction-types.js";
import { compactConversationTransactionally } from "../../src/services/compact/transaction.js";
import {
  CanonicalRolloutScanner,
  scanCanonicalRollout,
  type CanonicalRolloutScan,
} from "../../src/session/canonical-rollout-scanner.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { commitWholeHistoryCompaction } from "../helpers/canonical-rollout-scan.js";
import { bindCompactionTransactionHarness } from "../helpers/compaction-transaction-harness.js";

let temporaryHome = "";
let previousHome: string | undefined;
let temporaryWorkspace = "";

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "agenc-c2-scan-home-"));
  temporaryWorkspace = mkdtempSync(join(tmpdir(), "agenc-c2-scan-workspace-"));
  previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = temporaryHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  rmSync(temporaryHome, { recursive: true, force: true });
  rmSync(temporaryWorkspace, { recursive: true, force: true });
});

describe("canonical rollout compaction scanner", () => {
  it("validates a fresh journal without opening a payload spool, including close", () => {
    const store = createStore("plain-prefix");
    const scanner = new CanonicalRolloutScanner();
    const sessionTempRoot = join(temporaryHome, "plain-prefix-temp");
    const observed: string[] = [];
    try {
      const scan = scanner.scan(store.rolloutPath, {
        ...bookkeepingOptions(sessionTempRoot, "plain-prefix"),
        nowMilliseconds: () => {
          try { observed.push(...readdirSync(sessionTempRoot)); } catch { /* root not created yet */ }
          return Date.now();
        },
      });
      expect(scan.proof.recordCount).toBe(1);
      expect(scan.attempts.size).toBe(0);
      expect(observed.some((name) => name.startsWith("agenc-recovery-identities-"))).toBe(true);
      expect(observed.some((name) => name.startsWith("agenc-c2-payloads-"))).toBe(false);
    } finally {
      scanner.close();
      scanner.close();
      store.close();
    }
    expect(readdirSync(sessionTempRoot)).toEqual([]);
  });

  it("retains no ordinary rows from a large zero-compaction journal", () => {
    const store = createStore("zero-c2-large");
    const rolloutPath = store.rolloutPath;
    try {
      for (let index = 0; index < 2_500; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "user", content: `ordinary-${index}-${"x".repeat(256)}` },
        });
      }
      store.flushDurable();
    } finally {
      store.close();
    }

    const scan = scanCanonicalRollout(rolloutPath, {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "zero-c2-large",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    });
    expect(scan.proof.recordCount).toBe(2_501);
    expect(scan.attempts.size).toBe(0);
    expect(scan.sourceRecords.size).toBe(0);
  });

  it("checks the operational deadline while streaming", () => {
    const store = createStore("scan-deadline");
    const rolloutPath = store.rolloutPath;
    try {
      for (let index = 0; index < 50; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "user", content: `deadline-${index}` },
        });
      }
      store.flushDurable();
    } finally {
      store.close();
    }
    let tick = 0;
    expect(() => scanCanonicalRollout(rolloutPath, {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "scan-deadline",
      expectedEpoch: 1,
      maximumScanMilliseconds: 5,
      nowMilliseconds: () => tick++,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    })).toThrow(/scan deadline/i);
  });

  it("reconstructs and physically maps a large active history", () => {
    const store = createStore("large-active-history");
    const rolloutPath = store.rolloutPath;
    try {
      for (let index = 0; index < 5_000; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `active-${index}-${"x".repeat(256)}`,
          },
        });
      }
      store.flushDurable();
    } finally {
      store.close();
    }

    const scan = scanCanonicalRollout(rolloutPath, {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "large-active-history",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      captureActiveHistory: true,
    });
    expect(scan.activeHistory?.messages).toHaveLength(5_000);
    expect(scan.activeHistory?.positions).toHaveLength(5_000);
    expect(scan.sourceRecords.size).toBe(5_000);
    expect(scan.activeHistory?.messages.at(-1)?.content).toContain("active-4999");
  });

  it("isolates scan registries under each captured session temp root", async () => {
    const store = createStore("session-temp-authority");
    const rolloutPath = store.rolloutPath;
    try {
      store.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "temp authority" },
      });
      store.flushDurable();
      appendLargeHistory(store, 4);
      await commitWholeHistoryCompaction(store, {
        attemptId: "temp-authority-attempt",
        customInstructions: "payload registry temp authority",
      });
    } finally {
      store.close();
    }

    const rootA = join(temporaryHome, "scan-temp-a");
    const rootB = join(temporaryHome, "scan-temp-b");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });

    const scanAt = async (sessionTempRoot: string): Promise<Set<string>> => {
      const observedEntries = new Set<string>();
      await Promise.resolve();
      scanCanonicalRollout(rolloutPath, {
        sessionTempRoot,
        expectedRunId: "session-temp-authority",
        expectedEpoch: 1,
        maximumScanMilliseconds: 30_000,
        nowMilliseconds: () => {
          for (const entry of readdirSync(sessionTempRoot)) {
            observedEntries.add(entry);
          }
          return Date.now();
        },
        compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      });
      return observedEntries;
    };

    const [entriesA, entriesB] = await Promise.all([
      scanAt(rootA),
      scanAt(rootB),
    ]);

    for (const entries of [entriesA, entriesB]) {
      expect([...entries]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^agenc-recovery-identities-/u),
          expect.stringMatching(/^agenc-c2-payloads-/u),
        ]),
      );
    }
    expect(readdirSync(rootA)).toEqual([]);
    expect(readdirSync(rootB)).toEqual([]);
  });

  it("removes a partial payload registry when SQLite initialization fails and retries", async () => {
    const store = createStore("payload-init-failure");
    const rolloutPath = store.rolloutPath;
    try {
      store.appendRollout({ type: "response_item", payload: { role: "user", content: "payload retry" } });
      appendLargeHistory(store, 4);
      await commitWholeHistoryCompaction(store, {
        attemptId: "payload-retry-attempt",
        customInstructions: "payload initialization retry",
      });
    } finally {
      store.close();
    }
    const sessionTempRoot = join(temporaryHome, "payload-init-temp");
    mkdirSync(sessionTempRoot, { recursive: true });
    const originalPragma = Database.prototype.pragma;
    const pragmaSpy = vi
      .spyOn(Database.prototype, "pragma")
      .mockImplementation(function (
        this: Database.Database,
        source: string,
        options?: Database.PragmaOptions,
      ) {
        if (this.name.endsWith("payloads.sqlite")) {
          throw new Error("injected payload registry initialization failure");
        }
        return originalPragma.call(this, source, options);
      });
    try {
      expect(() =>
        scanCanonicalRollout(rolloutPath, {
          sessionTempRoot,
          expectedRunId: "payload-init-failure",
          expectedEpoch: 1,
          maximumScanMilliseconds: 30_000,
          compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
        }),
      ).toThrow("injected payload registry initialization failure");
    } finally {
      pragmaSpy.mockRestore();
    }
    expect(readdirSync(sessionTempRoot)).toEqual([]);
    const recovered = scanCanonicalRollout(rolloutPath, {
      sessionTempRoot,
      expectedRunId: "payload-init-failure",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    });
    expect(recovered.attempts.size).toBe(1);
    expect(readdirSync(sessionTempRoot)).toEqual([]);
  });

  it("agrees with a full replay after a compaction landed on the tail", async () => {
    const store = createStore("prefix-reuse-agrees");
    const rolloutPath = store.rolloutPath;
    const scanner = new CanonicalRolloutScanner();
    const options = {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "prefix-reuse-agrees",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      captureActiveHistory: true,
    } as const;
    try {
      for (let index = 0; index < 200; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `before-compaction-${index}-${"detail ".repeat(64)}`,
          },
        });
      }
      store.flushDurable();
      // Warm the scanner on the pre-compaction prefix, so the whole compaction
      // lifecycle below reaches it as an appended tail.
      scanner.scan(rolloutPath, options);
      expect(readdirSync(options.sessionTempRoot).some((name) => name.startsWith("agenc-c2-payloads-"))).toBe(false);

      const committed = await commitWholeHistoryCompaction(store, {
        attemptId: "agreement-attempt",
        customInstructions: "prefix reuse agreement",
      });
      expect(committed).toBeDefined();

      const warm = scanner.scan(rolloutPath, options);
      const cold = scanCanonicalRollout(rolloutPath, options);
      expect(comparable(warm)).toEqual(comparable(cold));
      expect(warm.attempts.size).toBe(1);
      expect(readdirSync(options.sessionTempRoot).filter((name) => name.startsWith("agenc-c2-payloads-"))).toHaveLength(1);
    } finally {
      scanner.close();
      store.close();
    }
    expect(readdirSync(options.sessionTempRoot)).toEqual([]);
  }, 120_000);

  it("does not carry an end-of-file bookkeeping conclusion into a later scan", async () => {
    const store = createStore("post-commit-window");
    const rolloutPath = store.rolloutPath;
    const scanner = new CanonicalRolloutScanner();
    const options = {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: "post-commit-window",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    } as const;
    try {
      for (let index = 0; index < 200; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `post-commit-${index}-${"detail ".repeat(64)}`,
          },
        });
      }
      store.flushDurable();
      const prepared = store.prepareSource("window-source", []);
      const harness = bindCompactionTransactionHarness(store, {
        contextWindowTokens: 64_000,
        maxOutputTokens: 512,
      });
      try {
        const result = await compactConversationTransactionally(
          harness.context,
          {
            customInstructions: "post-commit window",
            automatic: true,
            messagesToKeep: [],
            completeSourceMessages: prepared.messages,
            messagesToSummarize: prepared.messages,
            summaryPlacement: "before_keep",
            createBoundaryMarker: () => ({
              role: "user",
              originalRole: "developer",
              content: "compaction boundary",
            }),
            createSummaryMessage: (content) => ({ role: "user", content }),
          },
        );
        expect(result.transaction).toBeDefined();
        // commit.ts stamps the causal boundary straight after an automatic
        // commit and only then re-appends the session header, so a scan that
        // lands in between sees a file ending mid-bookkeeping.
        harness.session.emit({
          eventId: "post-commit-boundary",
          id: "post-commit-boundary",
          msg: {
            type: "context_compacted",
            payload: { summary: "auto-compact boundary (turnId=window-turn)" },
          },
        });
      } finally {
        harness.close();
      }
      store.flushDurable();

      const atBoundary = scanner.scan(rolloutPath, options);
      const attemptId = [...atBoundary.attempts.keys()].at(-1)!;
      expect(atBoundary.attempts.get(attemptId)?.hasLaterCanonicalWork).toBe(
        true,
      );

      store.store.reAppendSessionMetadata();
      store.flushDurable();

      // The conclusion belonged to where the earlier scan stopped reading, so
      // the scan that reads past it must answer as a full replay does.
      const warm = scanner.scan(rolloutPath, options);
      const cold = scanCanonicalRollout(rolloutPath, options);
      expect(warm.attempts.get(attemptId)?.hasLaterCanonicalWork).toBe(false);
      expect(comparable(warm)).toEqual(comparable(cold));
    } finally {
      scanner.close();
      store.close();
    }
  }, 120_000);

  it("keeps no prefix once its active history outgrows the retention ceiling", () => {
    const store = createStore("prefix-history-ceiling");
    const rolloutPath = store.rolloutPath;
    const sessionTempRoot = join(temporaryHome, "ceiling-temp");
    mkdirSync(sessionTempRoot, { recursive: true });
    const scanner = new CanonicalRolloutScanner();
    const options = {
      sessionTempRoot,
      expectedRunId: "prefix-history-ceiling",
      expectedEpoch: 1,
      maximumScanMilliseconds: 60_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      captureActiveHistory: true,
    } as const;
    try {
      // Under the ceiling the prefix is worth its memory, and its identity
      // registry is the visible sign that a scanner is holding one.
      for (let index = 0; index < 64; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "user", content: `small-${"x".repeat(4_096)}` },
        });
      }
      store.flushDurable();
      const small = scanner.scan(rolloutPath, options);
      expect(small.activeHistory?.messages).toHaveLength(64);
      expect(readdirSync(sessionTempRoot)).toHaveLength(1);

      // Past it the prefix would hold a second copy of the whole session, so
      // it answers this scan and is released rather than kept.
      for (let index = 0; index < 1_100; index += 1) {
        store.appendRollout({
          type: "response_item",
          payload: { role: "assistant", content: `large-${"y".repeat(4_096)}` },
        });
      }
      store.flushDurable();
      const large = scanner.scan(rolloutPath, options);
      expect(large.activeHistory?.messages).toHaveLength(1_164);
      expect(statSync(rolloutPath).size).toBeGreaterThan(4 * 1_024 * 1_024);
      expect(readdirSync(sessionTempRoot)).toEqual([]);

      // The bookkeeping that reduces no history is the repeat-heavy part of a
      // compaction step, so an active history this size is not what costs it
      // its prefix. It is charged for hydrated lifecycle payload instead,
      // which this rollout has none of; the two tests below charge it.
      const bookkeeping = { ...options, captureActiveHistory: false } as const;
      scanner.scan(rolloutPath, bookkeeping);
      expect(readdirSync(sessionTempRoot)).toHaveLength(1);
      scanner.scan(rolloutPath, bookkeeping);
      expect(readdirSync(sessionTempRoot)).toHaveLength(1);
    } finally {
      scanner.close();
      store.close();
    }
  }, 120_000);

  it("keeps no prefix once the payload its lifecycle holds passes the ceiling", async () => {
    const store = createStore("prefix-lifecycle-ceiling");
    const rolloutPath = store.rolloutPath;
    const sessionTempRoot = join(temporaryHome, "lifecycle-ceiling-temp");
    mkdirSync(sessionTempRoot, { recursive: true });
    const scanner = new CanonicalRolloutScanner();
    // The bookkeeping shape: it reduces no active history, so the active
    // history ceiling can never be what releases this prefix.
    const options = bookkeepingOptions(
      sessionTempRoot,
      "prefix-lifecycle-ceiling",
    );
    try {
      appendLargeHistory(store, 1_000);

      // Nothing hydrated yet, so this prefix is small and worth keeping: its
      // identity registry is the visible sign that the scanner holds one.
      scanner.scan(rolloutPath, options);
      expect(readdirSync(sessionTempRoot)).toHaveLength(1);

      const transaction = await commitWholeHistory(store, "ceiling-source");
      // A rollback reconstructs the whole pre-compaction conversation back
      // into the row the scan retains, which is how a bounded number of
      // lifecycle rows becomes a session-sized thing to hold.
      store.markProjectionComplete(transaction.attempt_id);
      store.rollbackCompaction({
        attemptId: transaction.attempt_id,
        nowMs: transaction.committed.committed_at_ms + 2,
      });
      store.flushDurable();

      const scan = scanner.scan(rolloutPath, options);
      expect(retainedPayloadBytes(scan)).toBeGreaterThan(4 * 1_024 * 1_024);
      expect(readdirSync(sessionTempRoot)).toEqual([]);
    } finally {
      scanner.close();
      store.close();
    }
  }, 180_000);

  it("keeps the prefix of a scan that only proved a large payload", async () => {
    const store = createStore("prefix-proved-payload");
    const rolloutPath = store.rolloutPath;
    const sessionTempRoot = join(temporaryHome, "proved-payload-temp");
    mkdirSync(sessionTempRoot, { recursive: true });
    const scanner = new CanonicalRolloutScanner();
    const options = bookkeepingOptions(
      sessionTempRoot,
      "prefix-proved-payload",
    );
    try {
      appendLargeHistory(store, 1_000);
      await commitWholeHistory(store, "proved-source");

      // Proving the committed attempt's source history reconstructs it and
      // then drops every byte: counting that would put this prefix over the
      // ceiling, while what it actually still holds is far under it.
      const scan = scanner.scan(rolloutPath, options);
      expect(scan.attempts.size).toBe(1);
      const proved =
        [...scan.attempts.values()][0]!.sourceHistoryManifest
          ?.canonical_utf8_bytes ?? 0;
      const held = retainedPayloadBytes(scan);
      expect(held).toBeLessThan(4 * 1_024 * 1_024);
      expect(proved + held).toBeGreaterThan(4 * 1_024 * 1_024);
      expect(readdirSync(sessionTempRoot)).toHaveLength(2);
    } finally {
      scanner.close();
      store.close();
    }
  }, 180_000);

  it("keeps no prefix that is keyed to one attempt's history", () => {
    const store = createStore("prefix-per-attempt");
    const rolloutPath = store.rolloutPath;
    const sessionTempRoot = join(temporaryHome, "per-attempt-temp");
    mkdirSync(sessionTempRoot, { recursive: true });
    const scanner = new CanonicalRolloutScanner();
    const options = {
      sessionTempRoot,
      expectedRunId: "prefix-per-attempt",
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    } as const;
    try {
      appendMarkedRows(store, 40);
      scanner.scan(rolloutPath, options);
      expect(readdirSync(sessionTempRoot)).toHaveLength(1);

      // Rollback bookkeeping names the attempt it is reconstructing, so no
      // later scan can ask this prefix its question: holding it would only
      // evict one that a later scan can still use.
      scanner.scan(rolloutPath, {
        ...options,
        captureHistoryAtAttemptIds: ["rollback-attempt"],
      });
      expect(readdirSync(sessionTempRoot)).toHaveLength(1);
    } finally {
      scanner.close();
      store.close();
    }
  });

  it("re-validates a rollout replaced at the same path", () => {
    const { store, scanner, options, rolloutPath } =
      bindPrefixScanner("prefix-inode-replaced");
    try {
      appendMarkedRows(store, 40);
      const before = scanner.scan(rolloutPath, options);

      // What an atomic rewrite leaves behind: the same path, the same length,
      // other bytes, another inode. The prefix names an inode that no longer
      // holds them, so it cannot stand in for the file.
      replaceAtNewInode(rolloutPath, "row-0007-", "row-9999-");
      const after = scanner.scan(rolloutPath, options);

      expect(after.proof.sourceSha256).not.toBe(before.proof.sourceSha256);
      expect(after.proof.recordCount).toBe(before.proof.recordCount);
    } finally {
      scanner.close();
      store.close();
    }
  });

  it("re-validates a rollout truncated under it", () => {
    const { store, scanner, options, rolloutPath } =
      bindPrefixScanner("prefix-truncated");
    try {
      appendMarkedRows(store, 40);
      const before = scanner.scan(rolloutPath, options);

      // Same inode, fewer bytes: the prefix reaches past the end of the file
      // it was built from, so there is nothing left for it to stand in for.
      truncateAtRecordBoundary(rolloutPath, 20);
      const after = scanner.scan(rolloutPath, options);

      expect(after.proof.recordCount).toBe(20);
      expect(before.proof.recordCount).toBe(41);
    } finally {
      scanner.close();
      store.close();
    }
  });
});


/** Every part of a scan, in a shape deep equality can compare. */
function comparable(scan: CanonicalRolloutScan): unknown {
  return {
    proof: scan.proof,
    attempts: [...scan.attempts].map(([attemptId, attempt]) => [
      attemptId,
      {
        intent: attempt.intent,
        records: attempt.records,
        admissionValid: attempt.admissionValid,
        hasLaterCanonicalWork: attempt.hasLaterCanonicalWork,
        sourceHistoryRetained: attempt.sourceHistoryRetained,
        sourceHistoryManifest: attempt.sourceHistoryManifest,
      },
    ]),
    sourceRecords: [...scan.sourceRecords].sort(
      ([left], [right]) => left - right,
    ),
    payloadRecordsAtAttempts: [...scan.payloadRecordsAtAttempts],
    activeHistory: scan.activeHistory,
    historyAtAttempts: [...scan.historyAtAttempts],
  };
}

/** The bookkeeping shape of scan: it reduces no active history. */
function bookkeepingOptions(sessionTempRoot: string, sessionId: string) {
  return {
    sessionTempRoot,
    expectedRunId: sessionId,
    expectedEpoch: 1,
    maximumScanMilliseconds: 120_000,
    compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    captureActiveHistory: false,
  } as const;
}

/** Enough conversation that one compaction of it passes the ceiling. */
function appendLargeHistory(store: RolloutStore, rows: number): void {
  for (let index = 0; index < rows; index += 1) {
    store.appendRollout({
      type: "response_item",
      payload: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `lifecycle-${index}-${"x".repeat(4_096)}`,
      },
    });
  }
  store.flushDurable();
}

async function commitWholeHistory(store: RolloutStore, attemptId: string) {
  return commitWholeHistoryCompaction(store, {
    attemptId,
    customInstructions: "retention ceiling",
    contextWindowTokens: 2_000_000,
  });
}

/** What the scan's lifecycle rows reconstructed and are still holding. */
function retainedPayloadBytes(scan: CanonicalRolloutScan): number {
  return [...scan.attempts.values()]
    .flatMap((attempt) => attempt.records)
    .reduce(
      (total, record) => total + JSON.stringify(record.item.payload).length,
      0,
    );
}

/**
 * A store, a scanner, and the scan options that name that store's rollout.
 *
 * Each caller still opens its own `try`/`finally` around what it does with
 * them, so what is shared here is only how the three come to exist.
 */
function bindPrefixScanner(sessionId: string) {
  const store = createStore(sessionId);
  return {
    store,
    rolloutPath: store.rolloutPath,
    scanner: new CanonicalRolloutScanner(),
    options: {
      sessionTempRoot: join(temporaryHome, "scan-temp"),
      expectedRunId: sessionId,
      expectedEpoch: 1,
      maximumScanMilliseconds: 30_000,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
    } as const,
  };
}

/** Fixed-width markers so a record can be rewritten without resizing it. */
function appendMarkedRows(store: RolloutStore, rows: number): void {
  for (let index = 0; index < rows; index += 1) {
    store.appendRollout({
      type: "response_item",
      payload: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `row-${String(index).padStart(4, "0")}-${"x".repeat(256)}`,
      },
    });
  }
  store.flushDurable();
}

/** Rewrite one record and publish the result as a new file at the same path. */
function replaceAtNewInode(path: string, find: string, replace: string): void {
  if (find.length !== replace.length) {
    throw new Error("replacement must preserve the rollout length");
  }
  const bytes = readFileSync(path);
  const offset = bytes.indexOf(find);
  if (offset === -1) throw new Error(`rollout has no ${find} record`);
  bytes.write(replace, offset, "utf8");
  const staged = `${path}.staged`;
  writeFileSync(staged, bytes);
  const before = statSync(path);
  renameSync(staged, path);
  const after = statSync(path);
  if (before.ino === after.ino) throw new Error("rollout kept its inode");
  if (before.size !== after.size) throw new Error("rollout changed size");
}

/** Drop every record after the first `keepRecords` lines, in place. */
function truncateAtRecordBoundary(path: string, keepRecords: number): void {
  const bytes = readFileSync(path);
  let offset = 0;
  for (let record = 0; record < keepRecords; record += 1) {
    const next = bytes.indexOf(0x0a, offset);
    if (next === -1) throw new Error("rollout has fewer records than that");
    offset = next + 1;
  }
  const before = statSync(path);
  truncateSync(path, offset);
  const after = statSync(path);
  if (before.ino !== after.ino) throw new Error("truncation replaced the file");
}

function createStore(sessionId: string): RolloutStore {
  const store = new RolloutStore({
    cwd: temporaryWorkspace,
    sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: join(temporaryHome, "rollout-temp"),
    autoStartScheduler: false,
  });
  store.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: temporaryWorkspace,
    originator: "canonical-scanner-test",
    agencVersion: "0.13.0",
  });
  return store;
}
