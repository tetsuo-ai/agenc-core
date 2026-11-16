import { describe, expect, it } from "vitest";
import { createHistoryReplacedEvent } from "../../src/session/transcript-replacement.js";
import { userFacingHistoryText } from "../../src/session/user-facing-history-text.js";

const QUEUED = "<system-reminder>\nThe user sent a new message while you were working:\nalso add a test\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>";
const GATE = "<completion_gate round=\"1\" of=\"2\">\nBefore finishing, verify each requirement.\n</completion_gate>";

describe("user-role history shown to the user", () => {
  it("unwraps a prompt queued mid-turn and drops runtime-only text", () => {
    expect(userFacingHistoryText(QUEUED)).toBe("also add a test");
    expect(userFacingHistoryText(GATE)).toBe("");
    expect(userFacingHistoryText(
      "Continue generating directly from where you left off. Do not apologize, do not restart, do not add preamble. Pick up at the next token.",
    )).toBe("");
    // Not an AgenC envelope: the user's own text, shown as written (UPDATE-4 U2).
    const own = "fix the parser\n<system-reminder>\nhook context\n</system-reminder>";
    expect(userFacingHistoryText(own)).toBe(own);
    expect(userFacingHistoryText("plain prompt")).toBe("plain prompt");
    // A tag typed inside a prompt is the user's text.
    const typed = "why does my log show <system-reminder>x</system-reminder> here?";
    expect(userFacingHistoryText(typed)).toBe(typed);
  });

  // A rewind, partial compact or compaction rollback rebuilds the TUI rows
  // from the model history (history_replaced).
  it("rebuilt rows show the user's words, never the wrapper written for the model", () => {
    const event = createHistoryReplacedEvent({
      replacementHistory: [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "working" },
        { role: "user", content: QUEUED },
        { role: "user", content: GATE },
        { role: "user", content: [{ type: "text", text: QUEUED }] },
      ],
      reason: "compaction_rollback",
    });
    const rows = event.payload.messages.filter((row) => row.type === "user");
    // One row per history item (rewind ordinals count them); an item with
    // runtime text only shows a short placeholder.
    expect(rows.map((row) => row.message.content)).toEqual([
      "first prompt",
      "also add a test",
      "Runtime note for the model (hidden)",
      [{ type: "text", text: "also add a test" }],
    ]);
    expect(rows.map((row) => row.isMeta === true)).toEqual([false, false, false, false]);
    expect(JSON.stringify(event.payload.messages)).not.toContain("system-reminder");
    expect(JSON.stringify(event.payload.messages)).not.toContain("completion_gate");
  });
});
