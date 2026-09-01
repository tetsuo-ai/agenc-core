import { afterEach, describe, expect, it } from "vitest";

import { compactConversation } from "../../../src/services/compact/compact.js";
import { CompactionTransactionError } from "../../../src/services/compact/transaction-types.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

const SESSION_ID = "bounded-tool-result-contract";
const CLEARED_MARKER = "[Old tool result content cleared]";
const FULL_TOOL_RESULT = `file body:${"y".repeat(7_000)}`;

/**
 * Once a tool result is persisted, the runtime keeps only the most recent
 * few full in memory and replaces older ones with a marker. The canonical
 * rollout keeps the full body. A caller that compacts from its in-memory
 * history therefore offers a tool result whose text no longer matches the
 * record, and the transaction used to refuse the whole compaction with
 * "caller history is not an ordered projection of canonical active
 * history". Every mid-turn compaction of a long session died there.
 *
 * The sealed integrity record is the authenticated identity of the body on
 * both sides, so it is the identity the transaction maps by.
 */
describe("compaction transaction with an in-memory bounded tool result", () => {
  let harness: CompactionTransactionHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it("maps a cleared tool result onto its canonical record through its sealed integrity", async () => {
    const source = createSource();
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
    });

    const bounded = source.map((message) =>
      message.toolCallId === "call-1"
        ? { ...message, content: CLEARED_MARKER, message: { role: "tool", content: CLEARED_MARKER } }
        : message,
    );

    const result = await compactConversation(bounded, harness.context);
    expect(result.transaction?.committed.replacement_history.length).toBeGreaterThan(0);
    // The canonical body was summarized, not the marker the caller held.
    expect(JSON.stringify(result.transaction?.committed)).not.toContain(CLEARED_MARKER);
  });

  it("still refuses a tool result whose sealed identity is not canonical", async () => {
    const source = createSource();
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
    });

    const forged = source.map((message) =>
      message.toolCallId === "call-1"
        ? {
            ...message,
            content: CLEARED_MARKER,
            message: { role: "tool", content: CLEARED_MARKER },
            runtimeOnly: {
              // Same run and call id, but sealed over a body the rollout
              // never held: identity, not just text, has to match.
              toolResultIntegrity: createToolResultIntegrity({
                runId: SESSION_ID,
                toolCallId: "call-1",
                content: "a body the rollout never held",
              }),
            },
          }
        : message,
    );

    await expect(compactConversation(forged, harness.context)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CompactionTransactionError &&
        error.reason === "pin_failed" &&
        /not an ordered projection of canonical active history/.test(error.message),
    );
  });
});

function createSource(): RuntimeMessage[] {
  const toolResult: RuntimeMessage = {
    role: "tool",
    originalRole: "tool",
    toolCallId: "call-1",
    toolName: "FileRead",
    content: FULL_TOOL_RESULT,
    message: { role: "tool", content: FULL_TOOL_RESULT },
    runtimeOnly: {
      toolResultIntegrity: createToolResultIntegrity({
        runId: SESSION_ID,
        toolCallId: "call-1",
        content: FULL_TOOL_RESULT,
      }),
    },
  };
  const filler = (index: number): RuntimeMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `source-${index}:${"x".repeat(3_000)}`,
  });
  return [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "FileRead", arguments: "{}" }],
    },
    toolResult,
    ...Array.from({ length: 8 }, (_, index) => filler(index)),
  ];
}
