import { describe, expect, test } from "vitest";

import { plainTextErrorToolResult } from "src/tools/results.js";

describe("tool result helpers", () => {
  test("creates the plain-text error envelope used by legacy tools", () => {
    expect(plainTextErrorToolResult("failed")).toEqual({
      content: "failed",
      isError: true,
    });
  });
});
