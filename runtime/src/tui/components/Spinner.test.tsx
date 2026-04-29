import { describe, expect, it } from "vitest";

import { SPINNER_FRAMES, getSpinnerFrame } from "./Spinner.js";

describe("tui/components/Spinner", () => {
  it("cycles through the shared spinner frame table", () => {
    expect(getSpinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(getSpinnerFrame(1)).toBe(SPINNER_FRAMES[1]);
    expect(getSpinnerFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });
});
