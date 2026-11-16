import { describe, expect, it } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const event = (id: string, type: string, payload: Record<string, unknown>) => ({ id, type, payload });

function rowText(events: any[]): string {
  const transcript = adaptTranscriptEvents(events as never);
  return JSON.stringify(transcript.messages.map((message: any) => message.content ?? message.message?.content));
}

describe("daemon transcript rows never show text written for the model", () => {
  it.each([
    ["User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /p.md\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n# Plan\n1. Do it", "Plan approved", "You can now start coding"],
    ["User wants you to keep planning. Remain in plan mode, revise the plan file, then call ExitPlanMode again.", "Keep planning", "Remain in plan mode"],
    ["User wants changes before approving the plan:\n\nadd tests first\n\nRemain in plan mode, revise the plan file, then call ExitPlanMode again.", "Changes requested: add tests first", "Remain in plan mode"],
    ["User has approved exiting plan mode. You can now proceed.", "Left plan mode", "You can now proceed"],
  ])("ExitPlanMode: %s", (result, shown, hidden) => {
    const text = rowText([
      event("s", "tool_call_started", { callId: "plan", toolName: "ExitPlanMode", args: "{}" }),
      event("c", "tool_call_completed", { callId: "plan", toolName: "ExitPlanMode", result, isError: false }),
    ]);
    expect(text).toContain(shown);
    expect(text).not.toContain(hidden);
    expect(text).not.toContain("User has approved");
    expect(text).not.toContain("User wants");
  });

  it("request_user_input answers are not raw JSON", () => {
    const text = rowText([
      event("s", "tool_call_started", { callId: "ask", toolName: "request_user_input", args: "{}" }),
      event("c", "tool_call_completed", { callId: "ask", toolName: "request_user_input", isError: false,
        result: JSON.stringify({ answers: { q1: { answers: ["yes"] } } }) }),
    ]);
    expect(text).toContain("Answered: yes");
    expect(text).not.toContain('{\\"answers\\"');
  });

  it("a turn stopped by a denied permission request is named in words", () => {
    const text = rowText([
      event("t", "turn_started", { turnId: "turn-1" }),
      event("a", "turn_aborted", { turnId: "turn-1", reason: "approval_denied" }),
    ]);
    expect(text).toContain("Turn aborted: permission request denied");
    expect(text).not.toContain("approval_denied");
  });
});
