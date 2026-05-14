import { describe, expect, test } from "vitest";

import {
  clampMcpCallbackInputColumns,
  getMCPRemoteServerGlyphs,
} from "./MCPRemoteServerMenu.js";

describe("MCPRemoteServerMenu callback input sizing", () => {
  test("clamps callback input columns on narrow terminals", () => {
    expect(clampMcpCallbackInputColumns(Number.NaN)).toBe(1);
    expect(clampMcpCallbackInputColumns(0)).toBe(1);
    expect(clampMcpCallbackInputColumns(7)).toBe(1);
    expect(clampMcpCallbackInputColumns(8)).toBe(1);
    expect(clampMcpCallbackInputColumns(9.9)).toBe(1);
    expect(clampMcpCallbackInputColumns(80)).toBe(72);
  });

  test("uses ascii-safe remote server glyphs when requested", () => {
    const glyphs = getMCPRemoteServerGlyphs({ AGENC_TUI_GLYPHS: "ascii" });

    expect(Object.values(glyphs).join("")).toMatch(/^[\x00-\x7F]*$/);
    expect(glyphs).toMatchObject({
      arrowDown: "v",
      arrowUp: "^",
      ellipsis: "...",
      pointer: ">",
      statusError: "ERR",
      statusInactive: "o",
      statusSuccess: "OK",
      statusWarning: "!",
    });
  });
});
