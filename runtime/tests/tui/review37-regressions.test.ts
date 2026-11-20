import { describe, expect, test } from "vitest";
import { userFacingResultText } from "../../src/tui/user-facing-tool-text.js";
import { summarizeToolError } from "../../src/tui/tool-error-text.js";
import { userFacingHistoryText } from "../../src/session/user-facing-history-text.js";
import { promptSubmissionErrorText } from "../../src/tui/prompt-submission-error-text.js";

describe("review37 literal data and actionable feedback", () => {
  test("keeps actionable history-blocked remediation", () => {
    const error = new Error("session 12345678-1234-1234-1234-123456789abc cannot start a turn: invalid tool pairing. Its history no longer accepts new entries; continue in a new session.");
    expect(promptSubmissionErrorText(error)).toContain("new session");
  });
  test("preserves a literal leading tag in shell fallback output", () => {
    const output = "<system-reminder>literal fixture</system-reminder>\nactual stdout";
    expect(userFacingResultText(output, "exec_command")).toBe(output);
  });
  test("preserves a literal trailing tag in file fallback output", () => {
    const output = "fixture text\n<system-reminder>literal fixture</system-reminder>";
    expect(userFacingResultText(output, "FileRead")).toBe(output);
  });
  test("keeps the user's feedback when summarizing a declined call", () => {
    const error = "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nUse staging instead";
    expect(summarizeToolError(error)).toContain("Use staging instead");
  });
  test("preserves a user's literal XML prompt", () => {
    const prompt = "<system-reminder>Explain this tag</system-reminder>";
    expect(userFacingHistoryText(prompt)).toBe(prompt);
  });
});

import { wrapCommandText } from "../../src/utils/messages.js";
import {
  RESUME_META_CONTENT,
  RETRY_REASONING_ONLY_CONTENT,
  RETRY_REFERENCED_HANDOFF_CONTENT,
  RETRY_TRUNCATED_TOOL_CONTENT,
} from "../../src/recovery/max-output-tokens.js";
import { buildCompletionGateFinalAnswerMessage } from "../../src/phases/completion-gate.js";
import { RUNTIME_RECOVERY_MESSAGES } from "../../src/session/user-facing-history-text.js";

// Round 2 (UPDATE-4): history items are AgenC's only when they are exactly
// what AgenC's producers write. These pin the recognized envelopes to the
// producers, so a wording change there cannot silently re-expose them.
describe("runtime history envelopes are pinned to their producers", () => {
  test("queued prompts from the user, the coordinator and a channel", () => {
    const human = `<system-reminder>\n${wrapCommandText("also add a test", undefined)}\n</system-reminder>`;
    expect(userFacingHistoryText(human)).toBe("also add a test");
    const coordinator = `<system-reminder>\n${wrapCommandText("ship it", { kind: "coordinator" } as never)}\n</system-reminder>`;
    expect(userFacingHistoryText(coordinator)).toBe("From the coordinator: ship it");
    const channel = `<system-reminder>\n${wrapCommandText("hi there", { kind: "channel", server: "slack" } as never)}\n</system-reminder>`;
    expect(userFacingHistoryText(channel)).toBe("From slack: hi there");
    const task = `<system-reminder>\n${wrapCommandText("<task-notification>x</task-notification>", { kind: "task-notification" } as never)}\n</system-reminder>`;
    expect(userFacingHistoryText(task)).toBe("");
  });
  test("recovery and completion-gate messages", () => {
    expect(RUNTIME_RECOVERY_MESSAGES).toEqual([
      RESUME_META_CONTENT,
      // Core's continuation note before it asked for the repeat, still in
      // sessions recorded with it.
      "Continue generating directly from where you left off. Do not apologize, do not restart, do not add preamble. Pick up at the next token.",
      RETRY_REASONING_ONLY_CONTENT,
      RETRY_TRUNCATED_TOOL_CONTENT,
      RETRY_TRUNCATED_TOOL_CONTENT + RETRY_REFERENCED_HANDOFF_CONTENT,
    ]);
    for (const text of RUNTIME_RECOVERY_MESSAGES) expect(userFacingHistoryText(text)).toBe("");
    expect(userFacingHistoryText(buildCompletionGateFinalAnswerMessage())).toBe("");
  });
  test("a user's own text that resembles them stays", () => {
    for (const prompt of [
      "<completion_gate>\ncheck this\n</completion_gate>",
      `${RESUME_META_CONTENT} Also fix the parser.`,
      "Continue generating directly from where you left off.",
      "<system-reminder>\nThe user sent a new message while you were working:\nx\n</system-reminder>",
    ]) expect(userFacingHistoryText(prompt)).toBe(prompt);
  });
  test("the recovery action stays, the session id goes", () => {
    const text = promptSubmissionErrorText(new Error("session 12345678-1234-1234-1234-123456789abc cannot start a turn: invalid tool pairing. Its history no longer accepts new entries; continue in a new session."));
    expect(text).toBe("Could not send your message: this session cannot start a turn: invalid tool pairing. Its history no longer accepts new entries; continue in a new session.");
  });
  test("a declined call shows the person's reason", () => {
    expect(summarizeToolError("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse staging instead\nand keep prod untouched"))
      .toBe("Declined: Use staging instead and keep prod untouched");
  });
});
