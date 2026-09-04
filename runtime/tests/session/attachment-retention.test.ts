import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  attachmentAnchorKey,
  createAttachmentRetentionLedger,
  currentUserMessageIndex,
  lastHistoryMessageIndex,
  projectRetainedAttachments,
  recordRetainedAttachments,
} from "../../src/session/attachment-retention.js";

const reminder = (text: string): LLMMessage => ({
  role: "user",
  content: `<system-reminder>\n${text}\n</system-reminder>`,
  runtimeOnly: { mergeBoundary: "user_context" },
});
const user = (text: string): LLMMessage => ({ role: "user", content: text });
const assistantCall = (id: string): LLMMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "FileRead", arguments: "{}" }],
});
const toolResult = (id: string, body: string): LLMMessage => ({
  role: "tool",
  toolCallId: id,
  toolName: "FileRead",
  content: body,
});

describe("attachment retention", () => {
  it("keeps the first request's block before the prompt on later projections", () => {
    const ledger = createAttachmentRetentionLedger();
    const first = [{ role: "system", content: "sys" } as LLMMessage, user("build it")];
    recordRetainedAttachments(ledger, first, 1, "before", [reminder("skills")]);

    const second = [...first, assistantCall("c1"), toolResult("c1", "ok")];
    const projected = projectRetainedAttachments(second, ledger);
    expect(projected.dropped).toBe(0);
    expect(projected.messages.map((m) => m.content)).toEqual([
      "sys",
      "<system-reminder>\nskills\n</system-reminder>",
      "build it",
      "",
      "ok",
    ]);
  });

  it("appends later blocks after the history item they followed and keeps the order across turns", () => {
    const ledger = createAttachmentRetentionLedger();
    const base1 = [user("turn one")];
    recordRetainedAttachments(ledger, base1, 0, "before", [reminder("A1")]);
    const base2 = [...base1, assistantCall("c1"), toolResult("c1", "r1")];
    recordRetainedAttachments(ledger, base2, 2, "after", [reminder("A2")]);
    const base3 = [...base2, { role: "assistant", content: "done" } as LLMMessage, user("turn two")];
    recordRetainedAttachments(ledger, base3, 4, "before", [reminder("A3")]);

    const projected = projectRetainedAttachments(base3, ledger).messages;
    expect(projected.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual([
      "<system-reminder>\nA1\n</system-reminder>",
      "turn one",
      "",
      "r1",
      "<system-reminder>\nA2\n</system-reminder>",
      "done",
      "<system-reminder>\nA3\n</system-reminder>",
      "turn two",
    ]);
    // The bytes of the earlier requests are a prefix of the later projection.
    const earlier = projectRetainedAttachments(base2, createLedgerWith(ledger, 2)).messages;
    expect(projected.slice(0, earlier.length)).toEqual(earlier);
  });

  it("survives a shortened tool result because tool anchors key on the call id", () => {
    const ledger = createAttachmentRetentionLedger();
    const base = [user("go"), assistantCall("c9"), toolResult("c9", "x".repeat(5000))];
    recordRetainedAttachments(ledger, base, 2, "after", [reminder("diag")]);
    const shortened = [user("go"), assistantCall("c9"), toolResult("c9", "[truncated]")];
    const projected = projectRetainedAttachments(shortened, ledger);
    expect(projected.dropped).toBe(0);
    expect(projected.messages[3]?.content).toContain("diag");
  });

  it("drops a block whose anchor left the history", () => {
    const ledger = createAttachmentRetentionLedger();
    recordRetainedAttachments(ledger, [user("old prompt")], 0, "before", [reminder("gone")]);
    const compacted = [{ role: "user", content: "summary of the past" } as LLMMessage, user("new prompt")];
    const projected = projectRetainedAttachments(compacted, ledger);
    expect(projected.dropped).toBe(1);
    expect(ledger.blocks).toHaveLength(0);
    expect(projected.messages).toHaveLength(2);
  });

  it("disambiguates identical prompts by the recorded position", () => {
    const ledger = createAttachmentRetentionLedger();
    const base = [user("again"), { role: "assistant", content: "ok" } as LLMMessage, user("again")];
    recordRetainedAttachments(ledger, base, 2, "before", [reminder("second")]);
    const projected = projectRetainedAttachments(base, ledger).messages;
    expect(projected.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual([
      "again",
      "ok",
      "<system-reminder>\nsecond\n</system-reminder>",
      "again",
    ]);
  });

  it("never records an attachment as an anchor and skips them when locating history", () => {
    const ledger = createAttachmentRetentionLedger();
    const messages = [user("p"), reminder("r")];
    recordRetainedAttachments(ledger, messages, 1, "after", [reminder("x")]);
    expect(ledger.blocks).toHaveLength(0);
    expect(lastHistoryMessageIndex(messages)).toBe(0);
    expect(currentUserMessageIndex([reminder("a"), user("p"), reminder("b")])).toBe(1);
    expect(attachmentAnchorKey(toolResult("c1", "a"))).toBe("tool:c1");
    expect(attachmentAnchorKey(user("a"))).not.toBe(attachmentAnchorKey(user("b")));
  });
});

function createLedgerWith(source: ReturnType<typeof createAttachmentRetentionLedger>, count: number) {
  const ledger = createAttachmentRetentionLedger();
  ledger.blocks = source.blocks.slice(0, count);
  return ledger;
}
