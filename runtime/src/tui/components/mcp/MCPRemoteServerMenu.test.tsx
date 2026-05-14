import { describe, expect, test } from "vitest";

import { clampMcpCallbackInputColumns } from "./MCPRemoteServerMenu.js";

describe("MCPRemoteServerMenu callback input sizing", () => {
  test("clamps callback input columns on narrow terminals", () => {
    expect(clampMcpCallbackInputColumns(Number.NaN)).toBe(1);
    expect(clampMcpCallbackInputColumns(0)).toBe(1);
    expect(clampMcpCallbackInputColumns(7)).toBe(1);
    expect(clampMcpCallbackInputColumns(8)).toBe(1);
    expect(clampMcpCallbackInputColumns(9.9)).toBe(1);
    expect(clampMcpCallbackInputColumns(80)).toBe(72);
  });
});
