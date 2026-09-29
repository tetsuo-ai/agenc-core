import { describe, expect, test } from "vitest";
import { getLightSystemPrompt } from "../../src/prompts/light-system-prompt.js";
import { UNTRUSTED_TOOL_RESULT_BOUNDARY } from "../../src/tools/untrusted-tool-result-framing.js";

describe("Light system head", () => {
  test("bounds the fixed head without dropping authority and verification guidance", () => {
    const text = getLightSystemPrompt({ headless: true, deadline: true });
    expect(text.split(/\s+/u).length).toBeLessThanOrEqual(600);
    expect(text).toContain(UNTRUSTED_TOOL_RESULT_BOUNDARY);
    expect(text).toContain("Never bypass a denial");
    expect(text).toContain("sandbox, network or budget policy");
    expect(text).toContain("explicit authorization");
    expect(text).toContain("Keep secrets out of output");
    expect(text).toContain("Never weaken checks");
    expect(text).toContain("actual output");
    expect(text).toContain("Do not claim actions or results without evidence");
    expect(text).toContain("fixed time budget");
    expect(text).toContain("time_remaining_sec");
    expect(text).toContain("exact paths, formats and boundaries");
  });

  test("interactive sessions do not receive the no-human contract", () => {
    const text = getLightSystemPrompt({ headless: false, deadline: false });
    expect(text).not.toContain("Nobody can answer");
    expect(text).not.toContain("time_remaining_sec");
    expect(text).toContain("concrete blocker requires the user");
  });
});
