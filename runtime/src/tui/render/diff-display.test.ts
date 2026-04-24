import { describe, expect, it } from "vitest";

import {
  looksLikeDiffText,
  renderDiffDisplayLines,
  renderSourceMutationDisplayLines,
} from "./diff-display.js";

describe("diff-display", () => {
  it("renders apply_patch payloads as semantic diff lines", () => {
    const lines = renderDiffDisplayLines(
      [
        "*** Begin Patch",
        "*** Add File: CMakeLists.txt",
        "+cmake_minimum_required(VERSION 3.16)",
        "+project(example)",
        "*** End Patch",
      ].join("\n"),
    );

    expect(lines.map((line) => [line.mode, line.text])).toEqual([
      ["diff-header", "create · CMakeLists.txt"],
      ["diff-add", "+cmake_minimum_required(VERSION 3.16)"],
      ["diff-add", "+project(example)"],
    ]);
  });

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

  it("renders source mutation previews for write/edit tools", () => {
    const lines = renderSourceMutationDisplayLines({
      filePath: "src/app.ts",
      mutationKind: "replace",
      beforeText: "export const oldValue = 1;",
      afterText: "export const newValue = 2;",
    });

    expect(lines.map((line) => [line.mode, line.text])).toEqual([
      ["diff-header", "replace · src/app.ts"],
      ["diff-hunk", "@@ replace @@"],
      ["diff-section-remove", "--- before"],
      ["diff-remove", "- export const oldValue = 1;"],
      ["diff-section-add", "+++ after"],
      ["diff-add", "+ export const newValue = 2;"],
    ]);
  });
});
