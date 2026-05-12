import { describe, expect, test } from "vitest";

import { formatRenderHealthWarning } from "./App.js";

describe("TUI render health warning", () => {
  test("renders nothing when metrics are absent or healthy", () => {
    expect(formatRenderHealthWarning(undefined)).toBeNull();
    expect(formatRenderHealthWarning({ averageFps: 30, low1PctFps: 20 })).toBeNull();
  });

  test("warns when average FPS or one-percent-low FPS crosses the threshold", () => {
    expect(formatRenderHealthWarning({ averageFps: 19.8, low1PctFps: 20 })).toContain(
      "average 19.8 FPS",
    );
    expect(formatRenderHealthWarning({ averageFps: 30, low1PctFps: 11.5 })).toContain(
      "1% low 11.5 FPS",
    );
  });
});
