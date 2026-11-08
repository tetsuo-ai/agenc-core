import { fsyncSync, readFileSync, writeSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";

import type { LLMMessage, LLMProvider, LLMResponse } from "../../src/llm/types.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { parseRolloutLine } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { FileThreadStore } from "../../src/thread-store/store.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

// While a compaction attempt is open the rollout store holds session state and
// metadata lines and writes them after the attempt (rollout-store.ts). These
// cover how and when the held lines leave the store.

const SOURCE: RuntimeMessage[] = Array.from({ length: 12 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `source-${index}:${"x".repeat(2_000)}`,
}));

const SUMMARY: LLMResponse = {
  content: JSON.stringify({ narrative: "Bounded summary.", facts: [], open_actions: [] }),
  toolCalls: [],
  usage: { promptTokens: 128, completionTokens: 128, totalTokens: 256, availability: "reported",
    provenance: "provider" },
  model: "grok-4.5",
  finishReason: "stop",
};

/** A user stop, as a client Stop writes it; the generation marks the line written in each test. */
function heldLine(generation: number): RolloutItem {
  return { type: "session_state", payload: { userStop: { stopped: true, generation } } } as RolloutItem;
}

const isHeldLine = (generation: number) => (item: RolloutItem | undefined): boolean =>
  item?.type === "session_state" && item.payload.userStop?.generation === generation;

interface Repo {
  bindIntent(...args: unknown[]): void;
  markCommitted(...args: unknown[]): void;
  recordFailure(...args: unknown[]): void;
}
const retentionRepo = (harness: CompactionTransactionHarness): Repo =>
  (harness.store as unknown as { compactionRetentionRepo: Repo }).compactionRetentionRepo;

let harness: CompactionTransactionHarness | undefined;
let threadStore: FileThreadStore | undefined;
afterEach(() => {
  threadStore?.close();
  threadStore = undefined;
  harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

/** A harness whose summarizer first runs `inside` while the attempt is open. */
function harnessWriting(inside: () => void, reply: () => LLMResponse = () => SUMMARY): CompactionTransactionHarness {
  let written = false;
  const chat: LLMProvider["chat"] = async (_messages: readonly LLMMessage[]) => {
    if (!written) {
      written = true;
      inside();
    }
    return reply();
  };
  harness = createCompactionTransactionHarness(SOURCE, { chat });
  return harness;
}

const ioError = () => Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
const failureReasons = (items: readonly RolloutItem[]) =>
  items.flatMap((item) => item.type === "compaction_failed" ? [item.payload.reason] : []);

test("an attempt whose intent could not be bound is closed when its lease is released, and the next compaction commits", async () => {
  harness = createCompactionTransactionHarness(SOURCE);
  // The intent and its payload are in the rollout, then binding the intent in
  // the retention database fails: the transaction writes no committed or
  // failed record and its pin stays preparing.
  vi.spyOn(retentionRepo(harness), "bindIntent").mockImplementationOnce(() => { throw ioError(); });
  await expect(compactConversation(SOURCE, harness.context)).rejects.toThrow();
  // Closed as reconciliation on open closes it: bound, then a failure record.
  const ended = harness.store.readAll();
  expect(ended.filter((item) => item.type === "compaction_intent")).toHaveLength(1);
  expect(failureReasons(ended)).toEqual(["recovery_interrupted"]);
  expect(ended.some((item) => item.type === "compaction_committed")).toBe(false);

  // A user stop after the attempt ended reaches the rollout at once.
  harness.store.appendRollout(heldLine(1), { durable: true });
  expect(harness.store.readAll().filter(isHeldLine(1))).toHaveLength(1);

  // A later compaction does not take the unfinished attempt as its source
  // provenance ("is no longer referenceable"): it commits without a restart.
  const result = await compactConversation(SOURCE, harness.context);
  expect(result.transaction?.committed).toBeDefined();
  expect(harness.store.readAll().filter((item) => item.type === "compaction_committed")).toHaveLength(1);
});

test("an attempt that cannot be closed when it ends keeps no window open and is closed before the next compaction", async () => {
  harness = createCompactionTransactionHarness(SOURCE);
  // The bind fails in the transaction and again when its lease is released.
  vi.spyOn(retentionRepo(harness), "bindIntent")
    .mockImplementationOnce(() => { throw ioError(); })
    .mockImplementationOnce(() => { throw ioError(); });
  await expect(compactConversation(SOURCE, harness.context)).rejects.toThrow();
  const ended = harness.store.readAll();
  expect(ended.filter((item) => item.type === "compaction_intent")).toHaveLength(1);
  expect(ended.some((item) => item.type === "compaction_committed" || item.type === "compaction_failed"))
    .toBe(false);
  // Its window is closed anyway: a user stop after it reaches the rollout at
  // once instead of waiting in memory until the store closes.
  harness.store.appendRollout(heldLine(5), { durable: true });
  expect(harness.store.readAll().filter(isHeldLine(5))).toHaveLength(1);
  // The next compaction closes it first, then commits.
  const result = await compactConversation(SOURCE, harness.context);
  expect(result.transaction?.committed).toBeDefined();
  const items = harness.store.readAll();
  expect(failureReasons(items)).toEqual(["recovery_interrupted"]);
  const closed = items.findIndex((item) => item.type === "compaction_failed");
  const nextIntent = items.findIndex((item, index) => index > 0 && item.type === "compaction_intent" &&
    item.payload.attempt_id !== (ended.find((e) => e.type === "compaction_intent") as { payload: { attempt_id: string } }).payload.attempt_id);
  expect(closed).toBeLessThan(nextIntent);
});

/** Fail every write that carries a compaction_failed record, as a full disk would. */
function failWritesOfFailureRecords(store: RolloutStore): void {
  store.store.setWriteImplForTest((fd, buffer, offset, length) => {
    if (Buffer.from(buffer.subarray(offset, offset + length)).toString("utf8").includes('"compaction_failed"')) {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return writeSync(fd, buffer, offset, length);
  });
}

/** Close the store and open the rollout again, as a restarted daemon does; returns its items. */
function reopen(store: RolloutStore): RolloutItem[] {
  const cwd = store.store.cwd;
  const sessionId = store.sessionId;
  store.close();
  const reopened = new RolloutStore({ cwd, sessionId, agencVersion: "0.13.0", sessionTempRoot: cwd,
    autoStartScheduler: false, resume: true });
  try {
    reopened.open({ sessionId, timestamp: new Date().toISOString(), cwd, originator: "held-line-test",
      agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
    return reopened.readAll();
  } finally {
    reopened.close();
  }
}

test("an attempt whose failure record waits in the degraded buffer is not closed a second time", async () => {
  const store = () => harness!.store;
  // The summary is invalid, so the attempt records its failure; the disk is
  // full for that write, which waits in the session store's degraded buffer.
  harnessWriting(() => failWritesOfFailureRecords(store()), () => ({ ...SUMMARY, content: "not the summary JSON" }));
  await expect(compactConversation(SOURCE, harness!.context)).rejects.toThrow();
  expect(store().store.isDegraded).toBe(true);
  // The disk recovers and the store closes: what waited is written. One
  // terminal record for the attempt, and the rollout opens again.
  store().store.setWriteImplForTest(writeSync);
  const items = reopen(store());
  expect(failureReasons(items)).toHaveLength(1);
});

test("a failure record the close cannot write leaves the attempt unfinished, and the next compaction closes it", async () => {
  harness = createCompactionTransactionHarness(SOURCE);
  // The intent bind fails in the transaction; closing the attempt when its
  // lease is released binds it, and then its failure record meets a full disk.
  vi.spyOn(retentionRepo(harness), "bindIntent").mockImplementationOnce(() => { throw ioError(); });
  failWritesOfFailureRecords(harness.store);
  await expect(compactConversation(SOURCE, harness.context)).rejects.toThrow();
  expect(harness.store.store.isDegraded).toBe(true);
  // The disk recovers and the waiting rows drain.
  harness.store.store.setWriteImplForTest(writeSync);
  await (harness.store.store as unknown as { degraded: { tryFlush(): Promise<boolean> } }).degraded.tryFlush();
  expect(harness.store.store.isDegraded).toBe(false);
  // The next compaction closes the attempt first and commits, without a restart.
  const result = await compactConversation(SOURCE, harness.context);
  expect(result.transaction?.committed).toBeDefined();
  expect(failureReasons(harness.store.readAll())).toEqual(["recovery_interrupted"]);
});

test("a held line is written right after the committed record, before the commit's projection", async () => {
  const store = () => harness!.store;
  harnessWriting(() => store().appendRollout(heldLine(2), { durable: true }));
  const repo = retentionRepo(harness!);
  const markCommitted = repo.markCommitted.bind(repo);
  let onDiskAtProjection: boolean | undefined;
  vi.spyOn(repo, "markCommitted").mockImplementation((...args: unknown[]) => {
    onDiskAtProjection = store().readAll().some(isHeldLine(2));
    return markCommitted(...args);
  });
  await compactConversation(SOURCE, harness!.context);
  expect(onDiskAtProjection).toBe(true);
  const items = store().readAll();
  const commit = items.findIndex((item) => item.type === "compaction_committed");
  expect(commit).toBeGreaterThan(0);
  expect(isHeldLine(2)(items[commit + 1])).toBe(true);
});

test("a held line is written right after the failed record, before the failure guard advances", async () => {
  const store = () => harness!.store;
  harnessWriting(() => store().appendRollout(heldLine(3), { durable: true }),
    () => ({ ...SUMMARY, content: "not the summary JSON" }));
  const repo = retentionRepo(harness!);
  const recordFailure = repo.recordFailure.bind(repo);
  let onDiskAtFailureGuard: boolean | undefined;
  vi.spyOn(repo, "recordFailure").mockImplementation((...args: unknown[]) => {
    onDiskAtFailureGuard = store().readAll().some(isHeldLine(3));
    return recordFailure(...args);
  });
  await expect(compactConversation(SOURCE, harness!.context)).rejects.toThrow();
  expect(onDiskAtFailureGuard).toBe(true);
  const items = store().readAll();
  const failed = items.findIndex((item) => item.type === "compaction_failed");
  expect(failed).toBeGreaterThan(0);
  expect(isHeldLine(3)(items[failed + 1])).toBe(true);
});

test("a held line whose fsync fails is written once, and the compaction still commits", async () => {
  const store = () => harness!.store;
  harnessWriting(() => store().appendRollout(heldLine(4), { durable: true }));
  // The write of the held line reaches the file and its fsync fails once.
  let failed = false;
  store().setFsyncImplForTest((fd) => {
    if (!failed && readFileSync(store().rolloutPath, "utf8").split("\n")
      .some((line) => line.trim().length > 0 && isHeldLine(4)(parseRolloutLine(line) ?? undefined))) {
      failed = true;
      throw new Error("injected fsync failure");
    }
    fsyncSync(fd);
  });
  const result = await compactConversation(SOURCE, harness!.context);
  expect(result.transaction?.committed).toBeDefined();
  // Later writes do not write the held line again.
  for (let index = 0; index < 3; index += 1) {
    try {
      store().appendRollout({ type: "response_item", payload: { role: "user", content: `after ${index}` } },
        { durable: true });
    } catch {
      // An append that flushes the held line reports its failed fsync.
    }
  }
  store().flushDurable();
  expect(failed).toBe(true);
  expect(store().readAll().filter(isHeldLine(4))).toHaveLength(1);
});

test("a memory mode change inside a window keeps the metadata line the window holds before it", async () => {
  const threadId = () => harness!.store.sessionId;
  harnessWriting(() => {
    // Archiving the live thread writes a metadata line; the memory mode
    // change after it derives its line from the latest metadata.
    threadStore!.archiveThread({ threadId: threadId() });
    threadStore!.updateThreadMetadata({ threadId: threadId(), patch: { memoryMode: "disabled" },
      includeArchived: true });
  });
  threadStore = new FileThreadStore({ agencHome: harness!.store.store.agencHome, cwd: harness!.store.store.cwd });
  threadStore.createThread({ threadId: threadId(), rolloutStore: harness!.store });
  await compactConversation(SOURCE, harness!.context);
  harness!.store.flushDurable();
  const items = harness!.store.readAll();
  const commit = items.findIndex((item) => item.type === "compaction_committed");
  const metadata = items.flatMap((item, index) => item.type === "session_meta" && index > commit ? [item.payload] : []);
  expect(metadata).toHaveLength(2);
  const latest = metadata.at(-1) as { memoryMode?: string; threadMetadata?: { archivedAt?: string } };
  expect(latest.memoryMode).toBe("disabled");
  expect(typeof latest.threadMetadata?.archivedAt).toBe("string");
});
