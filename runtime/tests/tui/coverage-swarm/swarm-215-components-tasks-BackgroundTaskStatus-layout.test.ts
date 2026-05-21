import { describe, expect, test } from "vitest";

import {
  getTeammateFooterLayout,
  TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS,
  TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS,
} from "../../../src/tui/components/tasks/BackgroundTaskStatus.layout.js";

function renderedColumns(
  layout: ReturnType<typeof getTeammateFooterLayout>,
): number {
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

describe("BackgroundTaskStatus layout coverage swarm row 215", () => {
  test("normalizes empty footer widths before deciding whether to reserve the expand hint", () => {
    expect(
      getTeammateFooterLayout([], Number.POSITIVE_INFINITY, 99),
    ).toEqual({
      startIndex: 0,
      endIndex: 0,
      showLeftArrow: false,
      showRightArrow: false,
      showExpandHint: false,
      visiblePillWidths: [],
    });

    expect(
      getTeammateFooterLayout([], TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS + 4.9, -1),
    ).toEqual({
      startIndex: 0,
      endIndex: 0,
      showLeftArrow: false,
      showRightArrow: false,
      showExpandHint: true,
      visiblePillWidths: [],
    });
  });

  test("clamps selections to the visible edge and removes leading separators from scrolled pills", () => {
    const leftEdge = getTeammateFooterLayout([9, 9, 9], 10, -12);
    expect(leftEdge).toEqual({
      startIndex: 0,
      endIndex: 1,
      showLeftArrow: false,
      showRightArrow: true,
      showExpandHint: false,
      visiblePillWidths: [8],
    });
    expect(renderedColumns(leftEdge)).toBeLessThanOrEqual(10);

    const rightEdge = getTeammateFooterLayout([5, 6, 7, 8], 12, 99);
    expect(rightEdge).toEqual({
      startIndex: 3,
      endIndex: 4,
      showLeftArrow: true,
      showRightArrow: false,
      showExpandHint: false,
      visiblePillWidths: [7],
    });
    expect(renderedColumns(rightEdge)).toBeLessThanOrEqual(12);
  });

  test("suppresses both scroll arrows when a one-column row cannot fit them", () => {
    const layout = getTeammateFooterLayout([8, 8, 8], 1, 1);

    expect(layout).toEqual({
      startIndex: 1,
      endIndex: 2,
      showLeftArrow: false,
      showRightArrow: false,
      showExpandHint: false,
      visiblePillWidths: [1],
    });
    expect(renderedColumns(layout)).toBe(1);
  });

  test("coerces non-positive pill widths to one column without shrinking below one", () => {
    const layout = getTeammateFooterLayout([0, -2, 0], 3, 0);

    expect(layout).toEqual({
      startIndex: 0,
      endIndex: 1,
      showLeftArrow: false,
      showRightArrow: true,
      showExpandHint: false,
      visiblePillWidths: [1],
    });
    expect(renderedColumns(layout)).toBeLessThanOrEqual(3);
  });
});
