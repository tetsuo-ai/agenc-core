import { describe, expect, test } from "vitest";

import { formatOrphanToolResultContent } from "./UserToolResultMessage.js";
import { getToolResultFallbackContent, isToolUseResultMissing } from "./UserToolSuccessMessage.js";

describe("UserToolResultMessage orphan fallback", () => {
  test("formats string orphan results for visible recovery output", () => {
    expect(formatOrphanToolResultContent("done")).toBe("done");
  });

  test("formats text-block orphan results for visible recovery output", () => {
    expect(
      formatOrphanToolResultContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  test("formats denied orphan results as a user-facing denial", () => {
    expect(
      formatOrphanToolResultContent([
        { type: "text", text: "{\"error\":\"rejected by user\"}" },
      ]),
    ).toBe("Permission request denied by user.");
  });
});

describe("UserToolSuccessMessage fallback recovery", () => {
  test("recovers persisted string output from tool result content", () => {
    expect(
      getToolResultFallbackContent([
        {
          type: "tool_result",
          content: "<persisted-output>saved text</persisted-output>",
        },
      ]),
    ).toBe("saved text");
  });

  test("recovers non-string tool result content blocks", () => {
    expect(
      getToolResultFallbackContent([
        {
          type: "tool_result",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
  });

  test("only treats nullish toolUseResult values as missing", () => {
    expect(isToolUseResultMissing(undefined)).toBe(true);
    expect(isToolUseResultMissing(null)).toBe(true);
    expect(isToolUseResultMissing(false)).toBe(false);
    expect(isToolUseResultMissing(0)).toBe(false);
    expect(isToolUseResultMissing("")).toBe(false);
  });
});
