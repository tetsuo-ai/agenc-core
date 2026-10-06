/**
 * Response-detail fallback copy and late insertion. Assembly already places
 * the section beside Output Style; Grok, AgenC, Anthropic, Chat Completions,
 * and OpenAI Responses call `withResponseDetailSystemPrompt` after that for
 * routes chosen after the prompt is built. Wrong placement breaks the
 * cached prefix or double-injects the instruction.
 */
import { describe, expect, test } from "vitest";

import {
  getResponseDetailSection,
  withResponseDetailSystemPrompt,
} from "./response-detail.js";
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SYSTEM_PROMPT_VOLATILE_BOUNDARY,
} from "./system-prompt-boundary.js";

const REPORTING_CONTRACT =
  "If you ran checks or tests, still report their results. Always report errors, blockers, and approval requests.";

function sectionFor(level: "low" | "medium" | "high"): string {
  const section = getResponseDetailSection(level);
  if (section === null) {
    throw new Error(`expected a Response Detail section for ${level}`);
  }
  return section;
}

describe("getResponseDetailSection", () => {
  test("returns null when the session inherits the route default", () => {
    expect(getResponseDetailSection(null)).toBeNull();
  });

  test.each([
    [
      "low",
      "Concise: keep every user-facing message short. Answer in 1 to 3 sentences, or at most 3 short bullets, with no preamble, recap or offer to continue. Write more only when the user asks for it.",
    ],
    ["medium", "Balanced: explain as much as the question needs, without padding."],
    [
      "high",
      "Detailed: give thorough user-facing answers. Explain the reasoning, context and trade-offs, and include a concrete example when it helps.",
    ],
  ] as const)("locks %s fallback wording and the reporting contract", (level, amount) => {
    const section = sectionFor(level);
    expect(section).toBe(
      `# Response Detail\n${amount} This sets only how much you write: do the same work and checks. ${REPORTING_CONTRACT}`,
    );
  });
});

describe("withResponseDetailSystemPrompt", () => {
  test("leaves the prompt unchanged when no override is set", () => {
    expect(withResponseDetailSystemPrompt(undefined, null)).toBeUndefined();
    expect(withResponseDetailSystemPrompt("STATIC_HEAD", null)).toBe("STATIC_HEAD");
  });

  test("does not insert a second section when assembly already wrote one", () => {
    const existing = `STATIC\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n# Response Detail\nConcise: keep it short.`;
    expect(withResponseDetailSystemPrompt(existing, "high")).toBe(existing);
  });

  test("a heading without the trailing newline is not treated as already present", () => {
    const prompt = `# Response Detail is mentioned in passing\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`;
    const result = withResponseDetailSystemPrompt(prompt, "medium");
    expect(result).toContain(sectionFor("medium"));
    expect(result?.match(/# Response Detail/gu)).toHaveLength(2);
  });

  test("inserts after Output Style and before the next heading when the dynamic boundary is present", () => {
    const prompt = [
      "STATIC_HEAD",
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "# Output Style: custom",
      "STYLE_SENTINEL",
      "",
      "# Permissions",
      "ask first",
    ].join("\n");
    const result = withResponseDetailSystemPrompt(prompt, "low");
    expect(result).toContain(`STYLE_SENTINEL\n\n${sectionFor("low")}\n\n# Permissions`);
    expect(result?.indexOf("# Response Detail")).toBeGreaterThan(
      result?.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) ?? -1,
    );
    expect(result?.startsWith("STATIC_HEAD")).toBe(true);
  });

  test("inserts after Output Style and before the volatile tail", () => {
    const prompt = [
      "STATIC_HEAD",
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "# Output Style: custom",
      "STYLE_SENTINEL",
      "",
      SYSTEM_PROMPT_VOLATILE_BOUNDARY,
      "permission snapshot",
    ].join("\n");
    const result = withResponseDetailSystemPrompt(prompt, "high");
    expect(result).toContain(
      `STYLE_SENTINEL\n\n${sectionFor("high")}\n\n${SYSTEM_PROMPT_VOLATILE_BOUNDARY}`,
    );
    expect(result?.endsWith("permission snapshot")).toBe(true);
  });

  test("appends after Output Style when it is the last section", () => {
    const prompt = [
      "STATIC_HEAD",
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "# Output Style: custom",
      "STYLE_SENTINEL",
    ].join("\n");
    expect(withResponseDetailSystemPrompt(prompt, "medium")).toBe(
      `${prompt}\n\n${sectionFor("medium")}`,
    );
  });

  test("appends to the volatile tail when Output Style is absent", () => {
    const prompt = `STATIC_HEAD\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\nstable\n\n${SYSTEM_PROMPT_VOLATILE_BOUNDARY}\n\nvolatile`;
    expect(withResponseDetailSystemPrompt(prompt, "low")).toBe(
      `${prompt}\n\n${sectionFor("low")}`,
    );
  });

  test("appends after the dynamic boundary when there is no Output Style or volatile tail", () => {
    const prompt = `STATIC_HEAD\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\nDYNAMIC_TAIL`;
    expect(withResponseDetailSystemPrompt(prompt, "medium")).toBe(
      `${prompt}\n\n${sectionFor("medium")}`,
    );
  });

  test("adds a dynamic boundary when the prompt has no cache markers", () => {
    expect(withResponseDetailSystemPrompt("STATIC_HEAD", "high")).toBe(
      `STATIC_HEAD\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${sectionFor("high")}`,
    );
  });

  test("builds a boundary-only prompt when the source is empty", () => {
    const expected = `${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${sectionFor("low")}`;
    expect(withResponseDetailSystemPrompt(undefined, "low")).toBe(expected);
    expect(withResponseDetailSystemPrompt("   \n", "low")).toBe(expected);
  });
});
