import { afterEach, describe, expect, it } from "vitest";

import { compactConversation } from "../../../src/services/compact/compact.js";
import { CompactionTransactionError } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

const SESSION_ID = "transient-context-contract";
const SKILL_REMINDER =
  "<system-reminder>\nThe following skills are available for use with the Skill tool.\n</system-reminder>";

/**
 * A per-request context message (a skill listing, a permission reminder) is
 * rendered for the model on the user channel and never written to the
 * rollout. When one leaks into the history a caller offers for compaction,
 * the transaction used to refuse the whole compaction with "caller history is
 * not an ordered projection of canonical active history", which ended the
 * turn. Observed live after a max-output-tokens retry copied the query
 * projection into the durable history: a 1252-byte skill reminder sat inside
 * the durable prefix and the next mid-turn compaction died on it.
 *
 * Such a message carries nothing to summarize or keep, so the transaction
 * leaves it out. An ordinary message the rollout never saw is still refused.
 */
describe("compaction transaction with a per-request context message the rollout never stored", () => {
  let harness: CompactionTransactionHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it("leaves the context message out instead of refusing the compaction", async () => {
    const source = createSource();
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
    });
    const reminder: RuntimeMessage = {
      role: "user",
      content: SKILL_REMINDER,
      runtimeOnly: { mergeBoundary: "user_context" },
    };
    const offered = [source[0]!, reminder, ...source.slice(1)];

    const result = await compactConversation(offered, harness.context);
    expect(result.transaction?.committed.replacement_history.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.transaction?.committed)).not.toContain(
      "skills are available",
    );
  });

  it("still refuses an ordinary user message the rollout never stored", async () => {
    const source = createSource();
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
    });
    const stranger: RuntimeMessage = {
      role: "user",
      content: "a message the rollout never saw",
    };
    const offered = [source[0]!, stranger, ...source.slice(1)];

    await expect(compactConversation(offered, harness.context)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CompactionTransactionError &&
        error.reason === "pin_failed" &&
        /not an ordered projection of canonical active history/.test(error.message),
    );
  });
});

function createSource(): RuntimeMessage[] {
  const filler = (index: number): RuntimeMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `source-${index}:${"x".repeat(3_000)}`,
  });
  return [
    { role: "user", content: "build the chess game" },
    { role: "assistant", content: "I'll start by reading the scaffolds." },
    ...Array.from({ length: 10 }, (_, index) => filler(index)),
  ];
}
