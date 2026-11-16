import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSubagentRollout, readFirstUserPreview, userFacingPreviewText } from "./resume.js";

const userMessage = (message: string) =>
  JSON.stringify({ type: "event_msg", payload: { msg: { type: "user_message", payload: { message } } } });

describe("/resume picker shows what the user typed", () => {
  it("unwraps a shell line, a slash command and drops model-only blocks", () => {
    expect(userFacingPreviewText("<bash-input>ls -la</bash-input>")).toBe("!ls -la");
    expect(userFacingPreviewText(
      "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>",
    )).toBe("/review src");
    expect(userFacingPreviewText(
      "<system-reminder>\nThe user sent a new message while you were working:\nfix the parser\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>",
    )).toBe("fix the parser");
    // A prompt the user typed with a literal tag is previewed as typed.
    expect(userFacingPreviewText("<system-reminder>Explain this tag</system-reminder>"))
      .toBe("<system-reminder>Explain this tag</system-reminder>");
  });

  it("previews the first input of a session that started with a shell line", () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-preview-"));
    const file = join(dir, "rollout.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { sessionId: "s", originator: "agenc-tui" } }),
      userMessage("<bash-input>ls</bash-input>"),
    ].join("\n"));
    expect(readFirstUserPreview(file)).toBe("!ls");
    expect(isSubagentRollout(file)).toBe(false);
  });

  it("recognizes a sub-agent rollout, whose first message is a runtime-written prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-subagent-"));
    const file = join(dir, "rollout.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { sessionId: "child", originator: "agenc-subagent", admissionOwner: { parentRunId: "conv-1" } } }),
      userMessage("You are a subagent spawned to complete a specific task.\nTask: You are now acting as the memory extraction subagent."),
    ].join("\n"));
    expect(isSubagentRollout(file)).toBe(true);
  });
});
