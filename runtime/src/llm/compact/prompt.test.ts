import { describe, expect, it } from "vitest";

import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
} from "./prompt.js";

describe("getCompactPrompt", () => {
  it("includes all 9 summary sections", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("1. Primary Request and Intent");
    expect(prompt).toContain("2. Key Technical Concepts");
    expect(prompt).toContain("3. Files and Code Sections");
    expect(prompt).toContain("4. Errors and fixes");
    expect(prompt).toContain("5. Problem Solving");
    expect(prompt).toContain("6. All user messages");
    expect(prompt).toContain("7. Pending Tasks");
    expect(prompt).toContain("8. Current Work");
    expect(prompt).toContain("9. Optional Next Step");
  });

  it("includes the no-tools preamble and trailer", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(prompt).toContain("REMINDER: Respond with TEXT ONLY");
  });

  it("appends custom instructions when provided", () => {
    const prompt = getCompactPrompt("Focus on test output.");
    expect(prompt).toContain("Additional Instructions:");
    expect(prompt).toContain("Focus on test output.");
  });
});

describe("formatCompactSummary", () => {
  it("strips analysis blocks", () => {
    const raw =
      "<analysis>\nthinking here\n</analysis>\n<summary>\nactual content\n</summary>";
    const formatted = formatCompactSummary(raw);
    expect(formatted).not.toContain("<analysis>");
    expect(formatted).not.toContain("thinking here");
    expect(formatted).toContain("actual content");
  });

  it("formats summary tags into readable headers", () => {
    const raw = "<summary>\n1. Primary Request\n</summary>";
    const formatted = formatCompactSummary(raw);
    expect(formatted).toContain("Summary:");
    expect(formatted).toContain("1. Primary Request");
    expect(formatted).not.toContain("<summary>");
    expect(formatted).not.toContain("</summary>");
  });

  it("handles plain text without XML tags", () => {
    const raw = "Just a plain summary without tags.";
    expect(formatCompactSummary(raw)).toBe("Just a plain summary without tags.");
  });
});

describe("getCompactUserSummaryMessage", () => {
  it("wraps summary with continuation preamble", () => {
    const msg = getCompactUserSummaryMessage("test summary");
    expect(msg).toContain("continued from a previous conversation");
    expect(msg).toContain("test summary");
  });

  it("appends continuation instruction when suppressFollowUpQuestions is set", () => {
    const msg = getCompactUserSummaryMessage("test", {
      suppressFollowUpQuestions: true,
    });
    expect(msg).toContain("Continue the conversation from where it left off");
  });
});
