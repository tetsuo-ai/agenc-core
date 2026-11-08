import { fsyncSync, writeSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";

import type { LLMResponse } from "../../src/llm/types.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import { CompactionReconstructionRequiredError } from "../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../src/services/compact/types.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

// A compaction commit record can reach the rollout without being confirmed:
// its fsync fails, or the state database does not mark it committed. The
// attempt is then committed and the session is rebuilt from it. It must keep
// that one terminal record: a failure record after it makes the rollout
// impossible to open again ("compaction attempt has conflicting terminals").

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

let harness: CompactionTransactionHarness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

const terminals = (items: readonly RolloutItem[]): string[] =>
  items.flatMap((item) => item.type === "compaction_committed" || item.type === "compaction_failed"
    ? [item.type] : []);

/** Close the store and open the rollout again, as a restarted daemon does; returns its items. */
function reopen(store: RolloutStore): RolloutItem[] {
  const cwd = store.store.cwd;
  const sessionId = store.sessionId;
  store.close();
  const reopened = new RolloutStore({ cwd, sessionId, agencVersion: "0.13.0", sessionTempRoot: cwd,
    autoStartScheduler: false, resume: true });
  try {
    reopened.open({ sessionId, timestamp: new Date().toISOString(), cwd, originator: "unconfirmed-commit-test",
      agencVersion: "0.13.0", model: "grok-4.5", modelProvider: "grok" });
    return reopened.readAll();
  } finally {
    reopened.close();
  }
}

async function expectOneCommittedTerminal(): Promise<void> {
  const error = await compactConversation(SOURCE, harness!.context).then(() => undefined, (thrown: unknown) => thrown);
  await harness!.store.store.awaitPendingFsyncRetries();
  expect(terminals(harness!.store.readAll())).toEqual(["compaction_committed"]);
  expect(terminals(reopen(harness!.store))).toEqual(["compaction_committed"]);
  // The caller learns that the session must be rebuilt from the commit.
  expect(error).toBeInstanceOf(CompactionReconstructionRequiredError);
}

test("a commit whose fsync fails keeps its one terminal record, and the rollout opens again", async () => {
  harness = createCompactionTransactionHarness(SOURCE, { chat: async () => SUMMARY });
  const store = harness.store.store;
  // The commit record is written and the fsync after it fails once.
  let failNextFsync = false;
  store.setWriteImplForTest((fd, buffer, offset, length) => {
    const written = writeSync(fd, buffer, offset, length);
    if (Buffer.from(buffer.subarray(offset, offset + length)).toString("utf8").includes('"compaction_committed"')) {
      failNextFsync = true;
    }
    return written;
  });
  store.setFsyncImplForTest((fd) => {
    if (failNextFsync) {
      failNextFsync = false;
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    }
    fsyncSync(fd);
  });
  await expectOneCommittedTerminal();
});

test("a commit the state database cannot mark committed keeps its one terminal record, and the rollout opens again", async () => {
  harness = createCompactionTransactionHarness(SOURCE, { chat: async () => SUMMARY });
  const repo = (harness.store as unknown as { compactionRetentionRepo: { markCommitted(...args: unknown[]): unknown } })
    .compactionRetentionRepo;
  vi.spyOn(repo, "markCommitted").mockImplementationOnce(() => {
    throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
  });
  await expectOneCommittedTerminal();
});
