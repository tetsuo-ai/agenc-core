import React from "react";
import { describe, expect, it } from "vitest";

import { createDiffMenuSnapshot } from "../../../src/commands/diff-menu.js";
import { DiffSurfaceView } from "../../../src/tui/workbench/surfaces/DiffSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("DiffSurfaceView", () => {
  it.each([
    [89, 28],
    [60, 20],
  ])("renders changed files within %ix%i", async (columns, rows) => {
    const snapshot = createDiffMenuSnapshot({
      rawDiff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      nameStatus: "M\tsrc/app.ts\nA\tsrc/new.ts\nUU\tsrc/conflict.ts",
      numstat: "1\t1\tsrc/app.ts\n2\t0\tsrc/new.ts\n1\t1\tsrc/conflict.ts",
      untrackedFiles: ["src/untracked.ts"],
    });

    const output = await renderToString(
      <DiffSurfaceView
        snapshot={snapshot}
        selected={0}
        decisions={{ "src/app.ts": "accept" }}
        focused={true}
        pendingApprovalRisk="medium"
      />,
      { columns, rows },
    );

    expect(output).toContain("DIFF");
    expect(output).toContain("git diff HEAD");
    expect(output).toContain("pending medium approval");
    expect(output).toContain("@ attach hunk");
    for (const line of output.split(/\r?\n/u)) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });
});
