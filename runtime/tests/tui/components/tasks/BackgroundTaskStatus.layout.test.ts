import { describe, expect, test } from "vitest";

import {
  getTeammateFooterLayout,
  TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS,
  TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS,
} from "./BackgroundTaskStatus.layout.js";

function renderedColumns(layout: ReturnType<typeof getTeammateFooterLayout>): number {
  const pillColumns = layout.visiblePillWidths.reduce(
    (sum, width) => sum + width,
    0,
  );
  const separatorColumns = Math.max(0, layout.visiblePillWidths.length - 1);
  const arrowColumns =
    (layout.showLeftArrow ? TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS : 0) +
    (layout.showRightArrow ? TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS : 0);
  const hintColumns = layout.showExpandHint
    ? TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS
    : 0;
  return pillColumns + separatorColumns + arrowColumns + hintColumns;
}

describe("BackgroundTaskStatus teammate footer layout", () => {
  test.each([1, 3, 8, 24])(
    "keeps pill rows inside tiny terminal width %i",
    columns => {
      const layout = getTeammateFooterLayout([5, 14, 9], columns, 1);

      expect(renderedColumns(layout)).toBeLessThanOrEqual(columns);
      expect(layout.visiblePillWidths.every(width => width >= 1)).toBe(true);
      expect(layout.showExpandHint).toBe(false);
    },
  );

  test("preserves full pill widths and hint when the row fits", () => {
    const layout = getTeammateFooterLayout([5, 8, 7], 80, 0);

    expect(layout.visiblePillWidths).toEqual([5, 7, 6]);
    expect(layout.showExpandHint).toBe(true);
    expect(renderedColumns(layout)).toBeLessThanOrEqual(80);
  });
});
