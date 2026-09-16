import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import type { CompactionCommittedV1 } from "../../../src/services/compact/transaction-types.js";

function assertColdReopen(
  harness: ReturnType<typeof createCompactionTransactionHarness>,
  committed: CompactionCommittedV1,
) {
  const meta = harness.store.readAll().find((record) => record.type === "session_meta");
  if (meta?.type !== "session_meta") throw new Error("fixture has no canonical metadata");
  harness.store.markProjectionComplete(committed.attempt_id);
  harness.store.markCleanupComplete(committed.attempt_id);
  harness.store.close();
  const reopened = new RolloutStore({
    cwd: meta.payload.cwd,
    sessionId: meta.payload.sessionId,
    agencVersion: "0.13.0",
    sessionTempRoot: tmpdir(),
    autoStartScheduler: false,
    resume: true,
  });
  try {
    reopened.open(meta.payload);
    const records = reopened.readAll();
    expect(records.filter((record) => record.type === "compaction_committed")).toHaveLength(1);
    expect(reconstructFromRollout(records).history).toEqual(committed.replacement_history);
    const restored = records.find((record) => record.type === "compaction_committed");
    expect(restored?.type === "compaction_committed" && restored.payload.source.source_sha256)
      .toBe(committed.source.source_sha256);
  } finally { reopened.close(); }
}

describe("independent long-source durable transaction", () => {
  it("commits a full compaction of many small messages, not just a standalone plan", async () => {
    const messages: RuntimeMessage[] = Array.from({ length: 2_000 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      originalRole: index % 2 ? "assistant" : "user",
      content: `synthetic item ${index}`,
    }));
    const harness = createCompactionTransactionHarness(messages, {
      contextWindowTokens: 950_000,
      maxOutputTokens: 4_000,
      compactionMode: "automatic",
    });
    try {
      const result = await compactConversation(messages, harness.context);
      expect(result.transaction).toBeDefined();
      expect(harness.store.readAll().filter((record) => record.type === "compaction_committed"))
        .toHaveLength(1);
      expect(harness.provider.chat).toHaveBeenCalled();
      assertColdReopen(harness, result.transaction!.committed);
    } catch (error) {
      console.log(JSON.stringify({ messages: messages.length,
        providerCalls: harness.provider.chat.mock.calls.length,
        stack: error instanceof Error ? error.stack : String(error) }));
      throw error;
    } finally { harness.close(); }
  }, 30_000);

  it("also compacts 1,657 messages with complete tool-call pairs", async () => {
    const sessionId = "source-tool-history-review";
    const messages: RuntimeMessage[] = [{ role: "user", originalRole: "user", content: "synthetic task" }];
    for (let index = 0; index < 828; index += 1) {
      const id = `synthetic-tool-${index}`;
      const content = `synthetic result ${index} ${"data ".repeat(40)}`;
      messages.push({ role: "assistant", originalRole: "assistant", content: "checking",
        toolCalls: [{ id, name: "Read", arguments: '{"path":"/app/synthetic"}' }] });
      messages.push({ role: "user", originalRole: "tool", content,
        toolCallId: id, toolName: "Read", runtimeOnly: {
          toolResultIntegrity: createToolResultIntegrity({ runId: sessionId, toolCallId: id, content }),
        } });
    }
    const harness = createCompactionTransactionHarness(messages, {
      sessionId, contextWindowTokens: 950_000, maxOutputTokens: 4_000, compactionMode: "automatic",
      // Runtime pins the known tool pairs itself. The generic harness echoes
      // every pair while reporting only 128 output tokens, which is invalid
      // for this large source. Model a valid small provider response instead.
      chat: async () => ({
        content: JSON.stringify({ narrative: "Bounded summary.", facts: [], open_actions: [], tool_pairs: [] }),
        toolCalls: [], model: "grok-4.5", finishReason: "stop",
        usage: { promptTokens: 128, completionTokens: 128, totalTokens: 256,
          availability: "reported", provenance: "provider" },
      }),
    });
    try {
      const result = await compactConversation(messages, harness.context);
      expect(result.transaction).toBeDefined();
      expect(harness.store.readAll().filter((record) => record.type === "compaction_committed"))
        .toHaveLength(1);
      const committed = result.transaction!.committed;
      const selected = new Set(committed.selected_history_indexes);
      const expectedPairIds = messages.flatMap((message, index) =>
        selected.has(index) && message.originalRole === "tool" ? [message.toolCallId!] : []);
      expect(committed.summary.body.tool_pairs.map((pair) => pair.tool_call_id).sort())
        .toEqual(expectedPairIds.sort());
      assertColdReopen(harness, result.transaction!.committed);
    } catch (error) {
      console.log(JSON.stringify({ messages: messages.length, shape: "paired-tools",
        providerCalls: harness.provider.chat.mock.calls.length,
        stack: error instanceof Error ? error.stack : String(error) }));
      throw error;
    } finally { harness.close(); }
  }, 30_000);

  it("validates the cold-reopen fixture on a small history", async () => {
    const messages: RuntimeMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: Array.from({ length: 300 }, (_, part) =>
        `small-control-${index}.${part}: result=${part};\n`).join(""),
    }));
    const harness = createCompactionTransactionHarness(messages);
    try {
      const result = await compactConversation(messages, harness.context);
      expect(result.transaction).toBeDefined();
      assertColdReopen(harness, result.transaction!.committed);
    } finally { harness.close(); }
  });
});
