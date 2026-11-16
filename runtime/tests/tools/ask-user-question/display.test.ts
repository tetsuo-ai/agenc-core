import { describe, expect, test } from "vitest";
import {
  askUserQuestionDisplayFromModelText,
  askUserQuestionErrorDisplay,
  buildAskUserQuestionDisplay,
  formatAskUserQuestionDisplay,
  resolveAskUserQuestionDisplay,
} from "./display.js";

const SUFFIX = ". You can now continue with the user's answers in mind.";

describe("AskUserQuestion user-facing display", () => {
  test("builds entries in question order with typed notes", () => {
    const display = buildAskUserQuestionDisplay({
      outcome: "answered",
      questions: [{ question: "Second?" }, { question: "First?" }],
      answers: { "First?": "A", "Second?": "B" },
      annotations: { "First?": { notes: " check disk " }, "Second?": { preview: "p" } },
    });
    expect(display.entries).toEqual([
      { question: "Second?", answer: "B" },
      { question: "First?", answer: "A", note: "check disk" },
    ]);
    expect(formatAskUserQuestionDisplay(display)).toBe(
      "Second?  B\nFirst?  A\n  Note: check disk",
    );
  });

  test("names the non-answer outcomes plainly", () => {
    expect(formatAskUserQuestionDisplay({ outcome: "skipped", entries: [] })).toBe("Questions skipped");
    expect(formatAskUserQuestionDisplay({ outcome: "skip_plan_interview", entries: [] })).toBe("Planning interview skipped");
    expect(formatAskUserQuestionDisplay({ outcome: "chat_about_this", entries: [] })).toBe("Chose to discuss the questions first");
  });

  test("recovers an old session's answers from the model-facing text", () => {
    const text = `User has answered your questions: "What should I focus on?"="General health check (Recommended)"${SUFFIX}`;
    expect(askUserQuestionDisplayFromModelText(text)).toEqual({
      outcome: "answered",
      entries: [{ question: "What should I focus on?", answer: "General health check (Recommended)" }],
    });
  });

  test("recovers several answers, a note and a preview, with or without the call input", () => {
    const text = `User has answered your questions: "Which, of \\"a\\", b?"="One, two" user notes: keep it, short, "Layout?"="Wide" selected preview:\n+---+\n| x |${SUFFIX}`;
    const expected = {
      outcome: "answered",
      entries: [
        { question: 'Which, of \\"a\\", b?', answer: "One, two", note: "keep it, short" },
        { question: "Layout?", answer: "Wide" },
      ],
    };
    expect(askUserQuestionDisplayFromModelText(text, [
      { question: 'Which, of \\"a\\", b?' },
      { question: "Layout?" },
    ])).toEqual(expected);
    const simple = `User has answered your questions: "A?"="One" user notes: n1, "B?"="Two"${SUFFIX}`;
    expect(askUserQuestionDisplayFromModelText(simple)?.entries).toEqual([
      { question: "A?", answer: "One", note: "n1" },
      { question: "B?", answer: "Two" },
    ]);
  });

  test("recovers skip texts and prefers metadata over text", () => {
    expect(askUserQuestionDisplayFromModelText(
      "User skipped these questions. Proceed with your best judgment",
    )).toEqual({ outcome: "skipped", entries: [] });
    expect(resolveAskUserQuestionDisplay({
      result: "anything",
      metadata: { askUserQuestion: { outcome: "answered", entries: [{ question: "Q?", answer: "A" }] } },
    })).toEqual({ outcome: "answered", entries: [{ question: "Q?", answer: "A" }] });
    expect(resolveAskUserQuestionDisplay({ result: "Permission denied" })).toBeNull();
  });

  test("replaces the third-person missing-answer error", () => {
    expect(askUserQuestionErrorDisplay('{"error":"User did not provide answers."}')).toBe("No answer given");
    expect(askUserQuestionErrorDisplay("other")).toBeNull();
  });
});
