import { describe, expect, it } from "vitest";

import {
  looksLikeDiffText,
  renderDiffDisplayLines,
} from "./diff-display.js";

describe("diff-display", () => {
  it("detects unified diff text", () => {
    const diff = [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(looksLikeDiffText(diff)).toBe(true);
    expect(renderDiffDisplayLines(diff).some((line) => line.mode === "diff-add"))
      .toBe(true);
  });
});
