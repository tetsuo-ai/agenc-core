import { describe, expect, it } from "vitest";

import { clampSurfaceSelection } from "../../../src/tui/workbench/surfaces/selection.js";

describe("workbench surface selection helpers", () => {
  it("clamps stale or malformed selected indexes to live rows", () => {
    expect(clampSurfaceSelection(0, 3)).toBe(0);
    expect(clampSurfaceSelection(2, 3)).toBe(2);
    expect(clampSurfaceSelection(99, 3)).toBe(2);
    expect(clampSurfaceSelection(-4, 3)).toBe(0);
    expect(clampSurfaceSelection(Number.NaN, 3)).toBe(0);
    expect(clampSurfaceSelection(1, 0)).toBe(0);
    expect(clampSurfaceSelection(1.8, 3)).toBe(1);
  });
});
