import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";

import { Box } from "../../../../src/tui/ink.js";
import { stringWidth } from "../../../../src/tui/ink/stringWidth.js";
import { ContentWidthProvider } from "../../../../src/tui/context/contentWidthContext.js";
import {
  DiffInline,
  Tool,
  diffInlineCodeCellWidth,
} from "../../../../src/tui/components/v2/primitives.js";
import { renderToString } from "../../../../src/utils/staticRender.js";

/**
 * Render a `DiffInline` through the SAME tree the live transcript uses: a
 * message-level `ContentWidthProvider` (carrying `messageContentWidth`) wrapping
 * a `Tool` whose `detail` is the diff and which is `expanded`. The Tool detail
 * box indents the diff by 4 columns and re-provides that exact width to
 * `DiffInline`, which is what enables the deterministic code-cell sizing under
 * test. Returns the plain (ANSI-stripped) frame.
 */
function renderTranscriptDiff(
  messageContentWidth: number,
  lines: React.ComponentProps<typeof DiffInline>["lines"],
): Promise<string> {
  return renderToString(
    <ContentWidthProvider width={messageContentWidth}>
      <Box flexDirection="column" width={messageContentWidth}>
        <Tool
          kind="write"
          label="Write"
          state="done"
          args="x.ts"
          expanded
          detail={<DiffInline file="x.ts" stats="+1 -0" lines={lines} />}
        />
      </Box>
    </ContentWidthProvider>,
    messageContentWidth,
  );
}

describe("diffInlineCodeCellWidth (pure width contract)", () => {
  // The cell width is the box outer width minus a CONSTANT chrome of 15 columns:
  // border (2) + row paddingX (2) + the fixed line-number gutter (4 + 4 + 3).
  // This is the single source of truth the deterministic render relies on, so it
  // is asserted directly, independent of Yoga.
  it("is exactly boxOuterWidth − 15 across a range of widths", () => {
    for (const boxOuterWidth of [20, 30, 40, 56, 60, 76, 80, 96, 120, 200]) {
      expect(diffInlineCodeCellWidth(boxOuterWidth)).toBe(boxOuterWidth - 15);
    }
  });

  it("clamps to a minimum of 1 when the box is narrower than its chrome", () => {
    expect(diffInlineCodeCellWidth(15)).toBe(1);
    expect(diffInlineCodeCellWidth(10)).toBe(1);
    expect(diffInlineCodeCellWidth(0)).toBe(1);
  });

  it("floors fractional widths before subtracting chrome", () => {
    expect(diffInlineCodeCellWidth(60.9)).toBe(45);
  });
});

describe("DiffInline deterministic code-cell width (revert-sensitive)", () => {
  // messageContentWidth 80 → DiffInline box 76 → codeCellWidth 76 − 15 = 61.
  const MCW = 80;
  const BOX_WIDTH = MCW - 4; // Tool detail box inset (marginLeft 2 + border 1 + paddingLeft 1)
  const CODE_CELL_WIDTH = diffInlineCodeCellWidth(BOX_WIDTH); // 61

  /**
   * Pull the visible code text out of a rendered diff body row, given the
   * one-char marker the row carries (+ / - / space). The gutter (line numbers +
   * ` {sigil} `) precedes the code; everything after the ` {sigil} ` marker and
   * before the trailing padding + right border is the code cell content.
   */
  function extractCode(frame: string, sigil: "+" | "-" | " ", needle: string): string {
    const bodyRow = frame
      .split("\n")
      .find((l) => l.includes(` ${sigil} `) && l.includes(needle));
    expect(bodyRow, `expected a body row containing ${JSON.stringify(needle)}`).toBeDefined();
    // After the marker ` {sigil} `, before the trailing ` │` (paddingX + border).
    const afterMarker = bodyRow!.slice(bodyRow!.indexOf(` ${sigil} `) + 3);
    return afterMarker.replace(/\s*│\s*$/, "");
  }

  // THE crux assertion. A code line whose visible width EXCEEDS the code-cell
  // width must reach the render PRE-TRUNCATED to EXACTLY codeCellWidth visible
  // columns, with the ellipsis INSIDE that width.
  //
  // Revert-sensitivity: against the pre-fix code the cell flexed and the FULL,
  // un-pre-truncated `line.code` was handed to the text node, leaving Yoga +
  // the text node to truncate to whatever the flex-rounded cell happened to be
  // (±1). With the fix, the string is truncated deterministically to exactly
  // codeCellWidth. Reverting either the `width={codeCellWidth}` pin or the
  // `wrapText(..., codeCellWidth, ...)` pre-truncation makes the visible width
  // drift off `CODE_CELL_WIDTH`, failing this exact-equality assertion.
  it("pre-truncates an over-width line to EXACTLY codeCellWidth visible columns", async () => {
    const over = "g".repeat(MCW + 40); // far wider than the cell
    const frame = await renderTranscriptDiff(MCW, [
      { kind: "add", newLine: "2", code: over },
    ]);
    const code = extractCode(frame, "+", "g");
    expect(stringWidth(code)).toBe(CODE_CELL_WIDTH);
    expect(code.endsWith("…")).toBe(true);
    // The ellipsis is the LAST column — the content before it is codeCellWidth-1.
    expect(stringWidth(code.replace(/…$/, ""))).toBe(CODE_CELL_WIDTH - 1);
  });

  // A line EXACTLY at the code-cell width must render in FULL — no early
  // ellipsis (Symptom A) — and must not spill past the border (Symptom B).
  it("renders an at-width line in full with no ellipsis", async () => {
    const exact = "f".repeat(CODE_CELL_WIDTH);
    const frame = await renderTranscriptDiff(MCW, [
      { kind: "add", newLine: "2", code: exact },
    ]);
    const code = extractCode(frame, "+", "f");
    expect(code).toBe(exact); // unchanged, all CODE_CELL_WIDTH chars
    expect(code).not.toContain("…");
    expect(stringWidth(code)).toBe(CODE_CELL_WIDTH);
  });

  // A SHORT line (≤ codeCellWidth) must pass through UNCHANGED (no
  // over-truncation regression).
  it("passes a short line through unchanged", async () => {
    const short = "const x = 1;";
    const frame = await renderTranscriptDiff(MCW, [
      { kind: "add", newLine: "2", code: short },
    ]);
    const code = extractCode(frame, "+", "const x");
    expect(code).toBe(short);
    expect(code).not.toContain("…");
  });

  // REVERT-SENSITIVE in the headless harness. A single-line diff in a tightly
  // fitted parent lets Yoga's flex round to exactly codeCellWidth, so a render
  // assertion alone cannot tell the two layouts apart there. We force a
  // divergence by rendering at a PHYSICAL viewport much wider than the content
  // width the context reports: the deterministic box is PINNED to its inset
  // content width (and the cell to codeCellWidth) regardless of the viewport,
  // while the reverted flex box would grow to fill the wider viewport and
  // truncate the over-width line to a much larger column count.
  it("pins the box + cell width even when the physical viewport is far wider (revert proof)", async () => {
    const PHYSICAL = 130; // much wider than MCW (80)
    const over = "g".repeat(220);
    const frame = await renderToString(
      <ContentWidthProvider width={MCW}>
        <Box flexDirection="column">
          <Tool
            kind="write"
            label="Write"
            state="done"
            args="x.ts"
            expanded
            detail={
              <DiffInline
                file="x.ts"
                stats="+1 -0"
                lines={[{ kind: "add", newLine: "2", code: over }]}
              />
            }
          />
        </Box>
      </ContentWidthProvider>,
      PHYSICAL,
    );
    // Deterministic: the over-width code is truncated to EXACTLY codeCellWidth
    // (61), NOT to the ~111 cols the flex box would allow at a 130-col viewport.
    const code = extractCode(frame, "+", "g");
    expect(stringWidth(code)).toBe(CODE_CELL_WIDTH);
    // The diff card rows stay at the inset box width (BOX_WIDTH=76) + the 4-col
    // Tool detail indent = 80, never widening toward the 130-col viewport.
    const cardRows = stripAnsi(frame)
      .split("\n")
      .filter((l) => l.includes("│"));
    expect(cardRows.length).toBeGreaterThan(0);
    for (const row of cardRows) {
      expect(stringWidth(row)).toBe(BOX_WIDTH + 4);
    }
  });

  // Belt-and-suspenders: no rendered diff row exceeds the diff box width at a
  // range of widths (the last code char can never sit past the right border).
  it("never renders a diff row wider than the box across several widths", async () => {
    for (const mcw of [40, 60, 80, 120]) {
      const boxWidth = mcw - 4;
      const cellWidth = diffInlineCodeCellWidth(boxWidth);
      const frame = await renderTranscriptDiff(mcw, [
        { kind: "ctx", oldLine: "1", newLine: "1", code: "ok();" },
        { kind: "add", newLine: "2", code: "x".repeat(cellWidth) }, // exactly at width
        { kind: "add", newLine: "3", code: "y".repeat(mcw + 50) }, // far over
      ]);
      const diffRows = stripAnsi(frame)
        .split("\n")
        .filter((l) => l.includes("│"));
      for (const row of diffRows) {
        // Every diff card row is the box width plus the 4-col Tool detail inset.
        expect(stringWidth(row)).toBeLessThanOrEqual(boxWidth + 4);
      }
    }
  });
});
