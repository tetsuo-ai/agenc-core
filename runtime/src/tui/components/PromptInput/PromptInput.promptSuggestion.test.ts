import { describe, expect, it } from "vitest";
import {
  computePromptSuggestionOutcome,
  getVisiblePromptSuggestion,
  shouldShowPromptSuggestionPlaceholder,
} from "./promptSuggestionControl.js";

describe("PromptInput prompt suggestion helpers", () => {
  it("shows generated suggestions only for idle empty prompt input", () => {
    expect(
      getVisiblePromptSuggestion({
        inputValue: "",
        isAssistantResponding: false,
        suggestionText: "run tests",
      }),
    ).toBe("run tests");
    expect(
      getVisiblePromptSuggestion({
        inputValue: "r",
        isAssistantResponding: false,
        suggestionText: "run tests",
      }),
    ).toBeNull();
    expect(
      getVisiblePromptSuggestion({
        inputValue: "",
        isAssistantResponding: true,
        suggestionText: "run tests",
      }),
    ).toBeNull();
  });

  it("classifies enter, tab, and ignored suggestion outcomes", () => {
    expect(
      computePromptSuggestionOutcome({
        acceptedAt: 0,
        finalInput: "run tests",
        now: 150,
        shownAt: 100,
        suggestionText: "run tests",
      }),
    ).toMatchObject({
      wasAccepted: true,
      tabWasPressed: false,
      timeMs: 150,
      similarity: 1,
    });
    expect(
      computePromptSuggestionOutcome({
        acceptedAt: 125,
        finalInput: "",
        now: 150,
        shownAt: 100,
        suggestionText: "run tests",
      }),
    ).toMatchObject({
      wasAccepted: true,
      tabWasPressed: true,
      timeMs: 125,
      similarity: 0,
    });
    expect(
      computePromptSuggestionOutcome({
        acceptedAt: 0,
        finalInput: "ship it",
        now: 150,
        shownAt: 100,
        suggestionText: "run tests",
      }),
    ).toMatchObject({
      wasAccepted: false,
      tabWasPressed: false,
      timeMs: 150,
    });
    expect(
      computePromptSuggestionOutcome({
        acceptedAt: 0,
        finalInput: "run tests",
        now: 150,
        shownAt: 0,
        suggestionText: "run tests",
      }),
    ).toBeNull();
  });

  it("suppresses suggestion placeholders outside prompt mode and teammate task views", () => {
    expect(
      shouldShowPromptSuggestionPlaceholder({
        mode: "prompt",
        promptSuggestion: "run tests",
        suggestionCount: 0,
        viewingAgentTaskId: null,
      }),
    ).toBe(true);
    expect(
      shouldShowPromptSuggestionPlaceholder({
        mode: "prompt",
        promptSuggestion: "run tests",
        suggestionCount: 1,
        viewingAgentTaskId: null,
      }),
    ).toBe(false);
    expect(
      shouldShowPromptSuggestionPlaceholder({
        mode: "prompt",
        promptSuggestion: "run tests",
        suggestionCount: 0,
        viewingAgentTaskId: "agent-task",
      }),
    ).toBe(false);
    expect(
      shouldShowPromptSuggestionPlaceholder({
        mode: "bash",
        promptSuggestion: "run tests",
        suggestionCount: 0,
        viewingAgentTaskId: null,
      }),
    ).toBe(false);
  });
});
