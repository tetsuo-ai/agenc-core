import React from "react";
import { afterEach, describe, expect, test } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { FallbackToolUseRejectedMessage } from "./FallbackToolUseRejectedMessage.js";

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS;

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS;
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode;
  }
});

describe("FallbackToolUseRejectedMessage", () => {
  test("renders the interrupted fallback inside a response gutter", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderToString(<FallbackToolUseRejectedMessage />, 80);

    expect(output).toContain("|_ Interrupted");
    expect(output).toContain("What should AgenC do instead?");
  });
});
