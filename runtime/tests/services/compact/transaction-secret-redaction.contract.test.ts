import { describe, expect, it, vi } from "vitest";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { finalizeCompactionTransaction } from "../../../src/services/compact/finalize-transaction.js";
import {
  canonicalizeJson,
  createCompactionSummaryV1,
  verifyCompactionSummaryDigest,
} from "../../../src/services/compact/summary-v1.js";
import type { CompactionSourceRefV1 } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import type { LLMMessage, LLMResponse } from "../../../src/llm/types.js";
import { REDACTED_SECRET } from "../../../src/secrets/sanitizer.js";
import { redactDurableSecrets } from "../../../src/session/provider-replay-redaction.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

const TOKEN = "xai-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7R8";

/**
 * The soak session died when its history held an npm auth token: the rollout
 * line encoder redacted the compaction payload chunk after its digest was
 * taken, the commit failed on re-validation, and every later strict read of
 * the session rejected the chunk. The payload is redacted before it is hashed
 * now; this drives a real automatic compaction through the durable commit and
 * reads the rollout back strictly.
 */
describe("automatic compaction with a secret in the source history", () => {
  it("commits, keeps the secret out of the rollout, and the rollout reads back strictly", async () => {
    const source: readonly RuntimeMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === 3
          ? `npmrc:\n//npm.pkg.github.com/:_authToken = ${TOKEN}\n${"x".repeat(4_000)}`
          : `source-${index}:${"x".repeat(4_000)}`,
    }));
    const harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: "automatic-secret-redaction",
    });
    try {
      const result = await compactConversation(source, harness.context);
      const transaction = result.transaction;
      expect(transaction).toBeDefined();
      const cleanup = vi.fn();
      await finalizeCompactionTransaction({
        store: harness.store,
        attemptId: transaction!.attempt_id,
        applyProjection: () => {},
        cleanup,
      });
      expect(cleanup).toHaveBeenCalledOnce();

      // Strict re-read from disk: this is the read that used to throw
      // "payload chunk count does not match its manifest".
      const items = harness.store.readAll();
      const types = items.map((item) => item.type);
      expect(types).toContain("compaction_committed");
      expect(types).not.toContain("compaction_failed");
      const chunks = items.filter((item) => item.type === "compaction_payload_chunk");
      expect(chunks.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).toContain(REDACTED_SECRET);
      const history = reconstructFromRollout(items).history;
      expect(JSON.stringify(history)).not.toContain(TOKEN);
    } finally {
      harness.close();
    }
  });
});

// w20-polish (2026-11-19): after Compact, every prompt and transcript read of a
// Desktop chat failed with "compaction summary digest does not match its RFC
// 8785 preimage". The summarizer had written "continue at the next token:
// suspension bridge load path" and the rollout's secret redaction stored
// "token: [REDACTED_SECRET]" under a digest of the words it replaced.
const NEXT_TOKEN = "Each answer came over turns where the user said to continue at the next token: suspension bridge load path, jet engine thrust, camera lens focusing.";
// A run of twelve or more wordlist words is redacted as a seed phrase. The
// source keeps the words apart ("number one is volcano, ..."); a summary that
// lists them does not (live run r2, w21-coredigest).
const QUIZ_LIST = "Recall fact: quiz answers in order: 1 volcano, 2 tornado, 3 island, 4 desert, 5 canyon, 6 ocean, 7 river, 8 forest, 9 planet, 10 galaxy, 11 rocket, 12 robot, 13 dragon, 14 dinosaur.";

function summarizerWriting(
  body: (sourceRefId: string) => Record<string, unknown>,
): (messages: readonly LLMMessage[]) => Promise<LLMResponse> {
  return async (messages) => {
    // Cite the first label this call allows, as a summarizer is told to.
    let sourceRefId = "s1";
    for (const message of messages) {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      const allowed = /"allowed_source_ref_ids":\["([^"]+)"/u.exec(text);
      if (allowed !== null) sourceRefId = allowed[1]!;
    }
    return {
      content: JSON.stringify(body(sourceRefId)),
      toolCalls: [],
      usage: {
        promptTokens: 128,
        completionTokens: 128,
        totalTokens: 256,
        availability: "reported",
        provenance: "provider",
      },
      model: "grok-4.5",
      finishReason: "stop",
    } as LLMResponse;
  };
}

describe("compaction whose summary the rollout's secret redaction rewrites", () => {
  it("digests the summary as stored, commits, and the session reads back strictly", async () => {
    const source: readonly RuntimeMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `source-${index}:${"x".repeat(4_000)}`,
    }));
    const harness = createCompactionTransactionHarness(source, {
      compactionMode: "manual",
      sessionId: "summary-secret-redaction",
      chat: summarizerWriting((sourceRefId) => ({
        narrative: NEXT_TOKEN,
        facts: [{ id: "f1", text: QUIZ_LIST, source_ref_ids: [sourceRefId] }],
        open_actions: [],
      })),
    });
    try {
      const result = await compactConversation(source, harness.context);
      const transaction = result.transaction;
      expect(transaction).toBeDefined();
      await finalizeCompactionTransaction({
        store: harness.store,
        attemptId: transaction!.attempt_id,
        applyProjection: () => {},
        cleanup: () => {},
      });

      // The strict read every later prompt, transcript and reopen makes. It
      // threw "compaction summary digest does not match its RFC 8785
      // preimage" before.
      const items = harness.store.readAll();
      expect(items.map((item) => item.type)).not.toContain("compaction_failed");
      const commit = items.find((item) => item.type === "compaction_committed");
      if (commit?.type !== "compaction_committed") throw new Error("no hydrated commit");
      const stored = commit.payload.summary;
      expect(() => verifyCompactionSummaryDigest(stored)).not.toThrow();
      expect(stored.summary_sha256).toBe(transaction!.committed.summary.summary_sha256);
      expect(stored.body.narrative).toContain(`token: ${REDACTED_SECRET}`);
      expect(stored.body.facts[0]!.text).toContain(REDACTED_SECRET);

      // What the session continues with in memory is what a reopen reads.
      expect(canonicalizeJson(commit.payload.replacement_history))
        .toBe(canonicalizeJson(transaction!.committed.replacement_history));
      const onDisk = JSON.stringify(items);
      expect(onDisk).not.toContain("suspension");
      expect(onDisk).not.toContain("volcano");
      const history = JSON.stringify(reconstructFromRollout(items).history);
      expect(history).toContain(REDACTED_SECRET);
      expect(history).not.toContain("suspension");
    } finally {
      harness.close();
    }
  });
});

describe("compaction whose model-visible summary message the rollout's redaction rewrites", () => {
  it("commits, and the session continues with the replacement history a reopen reads", async () => {
    // Review finding: the body passes redaction unchanged (the word after the
    // blank line has 7 characters), but the message the model reads renders
    // the body as JSON, where the newlines become two characters each and the
    // value rule matches. Stored history and session history must still agree.
    const narrative = "The deploy password:\n\nunknown until the user says it.";
    const source: readonly RuntimeMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `source-${index}:${"x".repeat(4_000)}`,
    }));
    const harness = createCompactionTransactionHarness(source, {
      compactionMode: "manual",
      sessionId: "summary-message-redaction",
      chat: summarizerWriting(() => ({ narrative, facts: [], open_actions: [] })),
    });
    try {
      const result = await compactConversation(source, harness.context);
      const transaction = result.transaction;
      expect(transaction).toBeDefined();
      expect(transaction!.committed.summary.body.narrative).toBe(narrative);
      await finalizeCompactionTransaction({
        store: harness.store,
        attemptId: transaction!.attempt_id,
        applyProjection: () => {},
        cleanup: () => {},
      });
      const items = harness.store.readAll();
      const commit = items.find((item) => item.type === "compaction_committed");
      if (commit?.type !== "compaction_committed") throw new Error("no hydrated commit");
      expect(canonicalizeJson(commit.payload.replacement_history))
        .toBe(canonicalizeJson(transaction!.committed.replacement_history));
      const summaryMessage = transaction!.committed.replacement_history.find(
        (message) => message.compactionHistory?.kind === "summary",
      );
      expect(JSON.stringify(summaryMessage?.content)).toContain(REDACTED_SECRET);
      expect(JSON.stringify(summaryMessage?.content)).not.toContain("unknown until");
    } finally {
      harness.close();
    }
  });
});

describe("createCompactionSummaryV1 and the rollout's secret redaction", () => {
  const sourceRef: CompactionSourceRefV1 = {
    kind: "compaction_summary",
    ref_id: "child-1",
    sha256: "a".repeat(64),
  };
  const create = (body: Parameters<typeof createCompactionSummaryV1>[0]["body"]) =>
    createCompactionSummaryV1({
      stage: "final",
      attemptId: "attempt-1",
      policyDigest: "b".repeat(64),
      accountingRef: "c".repeat(64),
      sourceRefs: [sourceRef],
      body,
    });

  it("digests the body the rollout will hold", () => {
    const summary = create({
      narrative: NEXT_TOKEN,
      facts: [{ id: "f1", text: QUIZ_LIST, source_ref_ids: ["child-1"] }],
      open_actions: [],
      tool_pairs: [],
    });
    expect(summary.body.narrative).toContain(`token: ${REDACTED_SECRET}`);
    expect(summary.body.facts[0]!.text).not.toContain("volcano");
    expect(() => verifyCompactionSummaryDigest(summary)).not.toThrow();
    // The payload writer's redaction leaves it as it is, digest included.
    expect(canonicalizeJson(redactDurableSecrets(summary, "ordinary")))
      .toBe(canonicalizeJson(summary));
  });

  it("refuses a body the redaction would leave invalid", () => {
    // Two records whose ids differ only in what the redactor removes.
    expect(() =>
      create({
        narrative: "two passwords were set",
        facts: [
          { id: "password: alpha-centauri", text: "first", source_ref_ids: ["child-1"] },
          { id: "password: beta-centauri", text: "second", source_ref_ids: ["child-1"] },
        ],
        open_actions: [],
        tool_pairs: [],
      })
    ).toThrow(/duplicate id/u);
  });
});
