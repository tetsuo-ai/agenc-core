import { describe, expect, it } from "vitest";

import { buildDiffLines, extractDiffFileSummaries } from "./model.js";

describe("tui/components/Diff/model", () => {
  it("builds display lines from source-write metadata previews", () => {
    const lines = buildDiffLines({
      previewMode: "source-write",
      mutationKind: "replace",
      filePath: "/tmp/demo/src/app.ts",
      fileRange: { startLine: 4 },
      mutationBeforeText: "before",
      mutationAfterText: "after",
    });

    expect(lines[0]).toMatchObject({
      mode: "diff-header",
      filePath: "/tmp/demo/src/app.ts",
    });
    expect(lines.some((line) => line.mode === "diff-add")).toBe(true);
    expect(lines.some((line) => line.mode === "diff-remove")).toBe(true);
  });

  it("extracts one file summary per diff header", () => {
    const summaries = extractDiffFileSummaries(
      buildDiffLines({
        previewMode: "source-write",
        mutationKind: "append",
        filePath: "/tmp/demo/src/app.ts",
        mutationAfterText: "console.log('hi')",
      }),
    );

    expect(summaries).toEqual([
      {
        path: "/tmp/demo/src/app.ts",
        label: "/tmp/demo/src/app.ts",
        status: "append",
      },
    ]);
  });
});
