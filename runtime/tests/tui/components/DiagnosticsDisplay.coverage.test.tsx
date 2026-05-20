import React from "react";
import figures from "figures";
import { afterEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { DiagnosticsDisplay } from "./DiagnosticsDisplay.js";

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS;

vi.mock("../../utils/cwd.js", () => ({
  getCwd: () => "/repo",
}));

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS;
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode;
  }
});

describe("DiagnosticsDisplay coverage", () => {
  test("renders verbose AgenC right-file diagnostics with relative paths and metadata", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderToString(
      <DiagnosticsDisplay
        attachment={{
          type: "diagnostics",
          isNew: true,
          files: [
            {
              uri: "_agenc_fs_right:/repo/src/problem.ts",
              diagnostics: [
                {
                  severity: "Error",
                  range: {
                    start: { line: 3, character: 7 },
                    end: { line: 3, character: 19 },
                  },
                  message: "Type mismatch",
                  code: "TS2345",
                  source: "tsserver",
                },
              ],
            },
          ],
        }}
        verbose={true}
      />,
      100,
    );

    expect(output).toContain("|_ src/problem.ts (agenc_fs_right):");
    expect(output).toContain(
      `|_   ${figures.cross} [Line 4:8] Type mismatch [TS2345] (tsserver)`,
    );
    expect(output).not.toContain("_agenc_fs_right:");
  });
});
