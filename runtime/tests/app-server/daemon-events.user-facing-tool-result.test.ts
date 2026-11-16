import { describe, expect, test } from "vitest";
import {
  clientFacingSessionEvent,
  notificationFromDaemonEvent,
} from "../../src/app-server/background-agent-runner/daemon-events.js";

const SUFFIX = ". You can now continue with the user's answers in mind.";

type Sent = { params: { event: { payload: { result: unknown; metadata?: unknown } } } };

function recorded(payload: Record<string, unknown>): Sent {
  return notificationFromDaemonEvent("session-1", "agent-1", {
    id: "event-1",
    type: "tool_call_completed",
    payload: { callId: "call-1", isError: false, ...payload },
  } as never) as never;
}

/** What an attached client receives. */
function resultOf(payload: Record<string, unknown>): { result: unknown; metadata?: unknown } {
  return (clientFacingSessionEvent(recorded(payload) as never) as unknown as Sent).params.event.payload;
}

// Clients such as the desktop app print the live event's `result` as the
// tool output. Text written for the model must not be that output.
describe("live tool results sent to clients", () => {
  test("AskUserQuestion carries the question and answer, never the model sentence", () => {
    const metadata = {
      askUserQuestion: {
        outcome: "answered",
        entries: [{ question: "What should I focus on?", answer: "General health check (Recommended)", note: "be quick" }],
      },
    };
    const sent = resultOf({
      toolName: "AskUserQuestion",
      result: `User has answered your questions: "What should I focus on?"="General health check (Recommended)" user notes: be quick${SUFFIX}`,
      metadata,
    });
    expect(sent.result).toBe("What should I focus on?  General health check (Recommended)\n  Note: be quick");
    expect(sent.metadata).toEqual(metadata);
  });

  test("AskUserQuestion without metadata is recovered from the text", () => {
    expect(resultOf({
      toolName: "AskUserQuestion",
      result: `User has answered your questions: "A?"="One", "B?"="Two"${SUFFIX}`,
    }).result).toBe("A?  One\nB?  Two");
    expect(resultOf({
      toolName: "AskUserQuestion",
      result: "User skipped these questions. Proceed with your best judgment.",
    }).result).toBe("Questions skipped");
    expect(resultOf({
      toolName: "AskUserQuestion",
      isError: true,
      result: "User did not provide answers.",
    }).result).toBe("No answer given");
  });

  test("EnterPlanMode and Skill carry a one-line receipt", () => {
    expect(resultOf({
      toolName: "EnterPlanMode",
      result: "Entered plan mode. In plan mode, you should: 1. Explore. DO NOT write or edit any files except the plan file.",
    }).result).toBe("Entered plan mode");
    const prompt = `<command-name>iot-builder</command-name>\n${"Follow these instructions. ".repeat(40)}`;
    expect(resultOf({ toolName: "Skill", result: prompt }).result).toBe(
      `Loaded skill iot-builder (${prompt.length} chars of instructions, hidden from chat)`,
    );
  });

  test("other tools and errors pass through unchanged", () => {
    expect(resultOf({ toolName: "FileRead", result: "1→hello" }).result).toBe("1→hello");
    expect(resultOf({ toolName: "EnterPlanMode", isError: true, result: "Permission denied" }).result).toBe("Permission denied");
    expect(resultOf({ toolName: "AskUserQuestion", isError: true, result: "Permission denied" }).result).toBe("Permission denied");
  });
});

describe("live ExitPlanMode results sent to clients", () => {
  test.each([
    ["User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /p.md\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n# Plan", "Plan approved"],
    ["User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan (edited by user):\n# Plan", "Plan approved with your edits"],
    ["User has approved exiting plan mode. You can now proceed.", "Left plan mode"],
    ["User wants you to keep planning. Remain in plan mode, revise the plan file, then call ExitPlanMode again.", "Keep planning"],
    ["User wants changes before approving the plan:\n\nadd tests first\n\nRemain in plan mode, revise the plan file, then call ExitPlanMode again.", "Changes requested: add tests first"],
  ])("%s", (result, shown) => {
    expect(resultOf({ toolName: "ExitPlanMode", result }).result).toBe(shown);
  });
});

describe("live request_user_input results sent to clients", () => {
  test("answers read as text, not as the JSON written for the model", () => {
    expect(resultOf({
      toolName: "request_user_input",
      result: JSON.stringify({ answers: { q1: { answers: ["yes"] }, q2: { answers: ["blue", "green"] } } }),
    }).result).toBe("Answered: yes; blue; green");
  });
});

// The daemon's own observers (snapshot policy, routines, recovery) receive
// the notification before the client fan-out. A snapshot's tool result can
// be replayed to the model after a restart, so that copy must stay the text
// the model was given.
describe("the recorded notification keeps the model-facing result", () => {
  test.each([
    ["AskUserQuestion", `User has answered your questions: "A?"="One"${SUFFIX}`],
    ["EnterPlanMode", "Entered plan mode.\n\nIn plan mode, you should:\n1. Thoroughly explore"],
    ["ExitPlanMode", "User has approved exiting plan mode. You can now proceed."],
    ["Skill", "<command-name>x</command-name>\nbody"],
    ["request_user_input", JSON.stringify({ answers: { q1: { answers: ["yes"] } } })],
  ])("%s", (toolName, result) => {
    const notification = recorded({ toolName, result });
    expect(notification.params.event.payload.result).toBe(result);
    // The client copy is a new object; the recorded one is not mutated.
    const client = clientFacingSessionEvent(notification as never) as unknown as Sent;
    expect(client.params.event.payload.result).not.toBe(result);
    expect(notification.params.event.payload.result).toBe(result);
  });

  test("other notifications pass through as the same object", () => {
    const other = { jsonrpc: "2.0", method: "event.message_chunk", params: { delta: "x" } };
    expect(clientFacingSessionEvent(other as never)).toBe(other);
  });
});
