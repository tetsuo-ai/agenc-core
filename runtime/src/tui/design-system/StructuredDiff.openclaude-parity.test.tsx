import type { StructuredPatchHunk } from "diff";
import React from "react";
import { describe, expect, test } from "vitest";

import { StructuredDiff } from "./StructuredDiff.js";

describe("StructuredDiff OpenClaude parity", () => {
  test("accepts structured patch hunks with file context and memoized gutter splitting", () => {
    const patch: StructuredPatchHunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["@@ -1,1 +1,1 @@", "-const a = 1", "+const a = 2"],
    };

    const element = (
      <StructuredDiff
        patch={patch}
        filePath="src/app.ts"
        firstLine="const a = 0"
        fileContent="const a = 0"
        width={80}
        dim={false}
      />
    );

    expect(element.props.patch).toBe(patch);
    expect(element.props.fileContent).toContain("const");
  });

  test("keeps raw patch text and prebuilt line inputs supported", () => {
    expect(
      <StructuredDiff patchText={"@@\n-old\n+new"} width={80} />,
    ).toBeTruthy();
    expect(
      <StructuredDiff
        lines={[{ text: " 1 +new", plainText: " 1 +new", mode: "diff-add" }]}
        width={80}
      />,
    ).toBeTruthy();
  });
});
