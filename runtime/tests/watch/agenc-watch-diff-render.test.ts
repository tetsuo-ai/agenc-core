import { describe, expect, it } from "vitest";

import { buildDiffDisplayLines } from "./agenc-watch-diff-render.mjs";

describe("agenc-watch-diff-render", () => {
  it("renders metadata-backed file headers through the file-link helper", () => {
    const lines = buildDiffDisplayLines(
      {
        previewMode: "source-write",
        mutationKind: "replace",
        filePath: "/tmp/AgenC Demo/notes/My File.ts",
        fileRange: { startLine: 18 },
        mutationBeforeText: "before",
        mutationAfterText: "after",
      },
      {
        cwd: "/tmp/AgenC Demo",
        maxPathChars: 48,
      },
    );

    expect(lines[0]).toMatchObject({
      text: "replace · notes/My File.ts",
      filePath: "/tmp/AgenC Demo/notes/My File.ts",
      fileLinkText: "notes/My File.ts",
    });
  });
});
