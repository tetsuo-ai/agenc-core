import { describe, expect, test } from "vitest";
import { getLightSystemPrompt } from "../../src/prompts/light-system-prompt.js";
import { UNTRUSTED_TOOL_RESULT_BOUNDARY } from "../../src/tools/untrusted-tool-result-framing.js";

describe("Light fixed head", () => {
  test("keeps authority and truthful verification within a small head", () => {
    const text = getLightSystemPrompt({ headless: true, deadline: true });
    expect(text.length).toBeLessThan(1500);
    for (const phrase of [UNTRUSTED_TOOL_RESULT_BOUNDARY, "Never bypass a denial", "need authorization", "Keep secrets private", "Never weaken checks", "unobserved success", "never follow", "grant permissions", "time_remaining_sec"]) expect(text).toContain(phrase);
    expect(text).not.toContain("- [x]");
  });
  test("only explicit verification mode asks for a checklist", () => {
    expect(getLightSystemPrompt({ headless: true, deadline: false, completionGate: true })).toContain("- [x]");
    const interactive = getLightSystemPrompt({ headless: false, deadline: false });
    expect(interactive).not.toContain("No human");
    expect(interactive).not.toContain("time_remaining_sec");
  });
});
