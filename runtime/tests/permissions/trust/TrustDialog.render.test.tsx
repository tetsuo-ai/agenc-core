import React from "react";
import { describe, expect, it, vi } from "vitest";

// The dialog calls useInput, which (in the real hook) flips the terminal into
// raw mode — unsupported on the non-TTY test stream. Stub it so the render is
// pure; we exercise the path LAYOUT here, not the keyboard logic (covered by
// the trustDialogOptionLabel unit test).
vi.mock("../../../src/tui/ink/hooks/use-input.js", () => ({
  default: () => {},
}));

import { TerminalSizeContext } from "../../../src/tui/ink/components/TerminalSizeContext.js";
import { TrustDialog, formatTrustPath } from "./TrustDialog.js";
import { renderToString } from "../../../src/utils/staticRender.js";

// A realistic deep project path — the exact shape that hard-wrapped mid-segment
// in the first-run "Trust this project?" dialog (a long scratchpad path).
const LONG_PATH =
  "/tmp/user/1000/claude-1000/-home-tetsuo-git-AgenC-agenc-core/5ea051e8-c097-408c-8fcc-841eb4b0e57a/scratchpad/visualqa/frames-build/sandbox";

function renderTrust(path: string, columns: number): Promise<string> {
  return renderToString(
    <TerminalSizeContext.Provider value={{ columns, rows: 24 }}>
      <TrustDialog workspaceRoot={path} onAccept={() => {}} onReject={() => {}} />
    </TerminalSizeContext.Provider>,
    { columns, rows: 24 },
  );
}

describe("formatTrustPath", () => {
  it("returns a short path verbatim", () => {
    expect(formatTrustPath("/home/me/project", 80)).toBe("/home/me/project");
  });

  it("elides the MIDDLE and keeps the meaningful tail at a segment boundary", () => {
    const out = formatTrustPath(LONG_PATH, 60);
    // Fits the budget…
    expect(out.length).toBeLessThanOrEqual(60);
    // …leads with an ellipsis (middle elided)…
    expect(out.startsWith("…/")).toBe(true);
    // …and preserves the deepest, most meaningful tail intact.
    expect(out.endsWith("/frames-build/sandbox")).toBe(true);
    // The break happened at a "/" boundary — the segment right after the
    // ellipsis is a WHOLE path component, never a sliced fragment.
    const firstTailSegment = out.slice("…/".length).split("/")[0];
    expect(LONG_PATH.split("/")).toContain(firstTailSegment);
  });

  it("never splits a path segment across the elision boundary", () => {
    for (const width of [24, 30, 40, 50, 60, 70]) {
      const out = formatTrustPath(LONG_PATH, width);
      expect(out.length).toBeLessThanOrEqual(width);
      if (out.startsWith("…/")) {
        // Every kept tail segment is a genuine component of the source path.
        const tailSegments = out.slice("…/".length).split("/");
        for (const seg of tailSegments) {
          expect(LONG_PATH.split("/")).toContain(seg);
        }
      }
    }
  });

  it("degrades a single over-long segment to a middle truncation (no hard cut)", () => {
    const giant = "/" + "x".repeat(200);
    const out = formatTrustPath(giant, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toContain("…");
  });
});

describe("TrustDialog path presentation", () => {
  it("frames the path and elides it instead of hard-wrapping mid-segment", async () => {
    const out = await renderTrust(LONG_PATH, 80);
    // The dialog still shows its core copy + choices (logic unchanged).
    expect(out).toContain("Trust this project?");
    expect(out).toContain("Yes, I trust this project");
    expect(out).toContain("No, exit");

    // The path is framed: a bordered box surrounds it.
    expect(out).toMatch(/[╭┌]/);

    // It is elided (middle removed) — the meaningful tail survives on ONE line.
    const tailLine = out
      .split("\n")
      .find((line) => line.includes("frames-build/sandbox"));
    expect(tailLine).toBeDefined();
    expect(tailLine).toContain("…");

    // REGRESSION GUARD vs the hard mid-segment wrap: the prior bug split the
    // raw path so that a line ENDED in `.../visualqa/` and the next line BEGAN
    // with a bare `frames-build/sandbox` fragment (no leading slash, no
    // indentation). With the fix the path is a single elided line, so no line
    // begins with that orphaned fragment.
    const lines = out.split("\n").map((line) => line.trimStart());
    expect(lines.some((line) => line.startsWith("frames-build/sandbox"))).toBe(
      false,
    );
    // And the full raw path is no longer printed verbatim across the dialog
    // (it has been elided), so no single line carries the whole thing.
    expect(out.split("\n").some((line) => line.includes(LONG_PATH))).toBe(false);
  });

  it("REVERT-SENSITIVITY: a short path is shown in full, a long path is elided", async () => {
    const shortPath = "/home/me/workdir";
    const shortOut = await renderTrust(shortPath, 80);
    const longOut = await renderTrust(LONG_PATH, 80);
    // The short path is shown in full with no ellipsis on its line.
    const shortLine = shortOut
      .split("\n")
      .find((line) => line.includes("/home/me/workdir"));
    expect(shortLine).toBeDefined();
    expect(shortLine).not.toContain("…");
    expect(shortLine).toContain(shortPath);
    // The long path's line is elided — proving the truncation path is exercised
    // (a revert to the raw `props.workspaceRoot` text would carry no ellipsis
    // and would hard-wrap the segment instead).
    const longLine = longOut
      .split("\n")
      .find((line) => line.includes("sandbox"));
    expect(longLine).toBeDefined();
    expect(longLine).toContain("…");
  });
});
