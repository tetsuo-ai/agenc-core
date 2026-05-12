import { describe, expect, test } from "vitest";

import { clampMcpCallbackInputColumns } from "./MCPRemoteServerMenu.js";

describe("MCPRemoteServerMenu callback input sizing", () => {
  test("clamps callback input columns on narrow terminals", () => {
    expect(clampMcpCallbackInputColumns(0)).toBe(0);
    expect(clampMcpCallbackInputColumns(7)).toBe(0);
    expect(clampMcpCallbackInputColumns(8)).toBe(0);
    expect(clampMcpCallbackInputColumns(80)).toBe(72);
  });
});
