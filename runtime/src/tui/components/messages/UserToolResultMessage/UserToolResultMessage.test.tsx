import { describe, expect, test } from "vitest";

import { formatOrphanToolResultContent } from "./UserToolResultMessage.js";

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
