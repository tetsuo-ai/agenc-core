import React from "react";
import { describe, expect, it } from "vitest";

import {
  AgentActivityTrack,
  buildAgentActivityTrackFrame,
} from "../../../src/tui/workbench/agents/AgentActivityTrack.js";
import { stringWidth } from "../../../src/tui/ink/stringWidth.js";
import { renderToString } from "../../../src/utils/staticRender.js";

function frameText(width: number, step: number): string {
  const frame = buildAgentActivityTrackFrame(width, step);
  return frame.before + frame.tail + frame.head + frame.after;
}

describe("AgentActivityTrack", () => {
  it("keeps every scan frame exactly as wide as its track", () => {
    for (let step = 0; step < 40; step += 1) {
      expect(stringWidth(frameText(24, step))).toBe(24);
    }
  });

  it("moves a two-cell comet across the track and wraps cleanly", () => {
    expect(frameText(8, 0)).toBe("◆·······");
    expect(frameText(8, 1)).toBe("╺◆······");
    expect(frameText(8, 2)).toBe("╺━◇·····");
    expect(frameText(8, 7)).toBe("·····╺━◇");
    expect(frameText(8, 8)).toBe("◆·······");
  });

  it("renders a stable centered scanline when reduced motion is enabled", async () => {
    const output = await renderToString(
      <AgentActivityTrack reducedMotion seed="agent-a" width={12} />,
      20,
    );

    expect(output).toContain("╺━◇");
    expect(stringWidth(output.trim())).toBe(12);
  });
});
