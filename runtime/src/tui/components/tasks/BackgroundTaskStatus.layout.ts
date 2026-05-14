import { calculateHorizontalScrollWindow } from "../../../utils/horizontalScroll.js";

export const TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS = 22;
export const TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS = 2;
const MIN_HINT_PILL_COLUMNS = 4;

export type TeammateFooterLayout = {
  startIndex: number;
  endIndex: number;
  showLeftArrow: boolean;
  showRightArrow: boolean;
  showExpandHint: boolean;
  visiblePillWidths: number[];
};

export function getTeammateFooterLayout(
  pillWidths: readonly number[],
  columns: number,
  selectedIndex: number,
): TeammateFooterLayout {
  const safeColumns = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  const showExpandHint =
    safeColumns >= TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS + MIN_HINT_PILL_COLUMNS;
  const pillColumns = Math.max(
    1,
    safeColumns - (showExpandHint ? TEAMMATE_FOOTER_EXPAND_HINT_COLUMNS : 0),
  );
  const totalItems = pillWidths.length;

  if (totalItems === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      showLeftArrow: false,
      showRightArrow: false,
      showExpandHint,
      visiblePillWidths: [],
    };
  }

  const clampedSelected = Math.max(0, Math.min(selectedIndex, totalItems - 1));
  const window = calculateHorizontalScrollWindow(
    pillWidths.map(width => Math.max(1, width)),
    pillColumns,
    TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS,
    clampedSelected,
  );
  const visibleRawWidths = pillWidths
    .slice(window.startIndex, window.endIndex)
    .map((width, offset) =>
      Math.max(1, width - (window.startIndex + offset > 0 ? 1 : 0)),
    );
  let showLeftArrow = window.showLeftArrow;
  let showRightArrow = window.showRightArrow;
  while (
    (showLeftArrow ? TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS : 0) +
      (showRightArrow ? TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS : 0) +
      1 >
    pillColumns
  ) {
    if (showRightArrow) {
      showRightArrow = false;
    } else {
      showLeftArrow = false;
    }
  }
  const arrowColumns =
    (showLeftArrow ? TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS : 0) +
    (showRightArrow ? TEAMMATE_FOOTER_SCROLL_ARROW_COLUMNS : 0);
  const separatorColumns = Math.max(0, visibleRawWidths.length - 1);
  const availablePillColumns = Math.max(
    1,
    pillColumns - arrowColumns - separatorColumns,
  );

  return {
    startIndex: window.startIndex,
    endIndex: window.endIndex,
    showLeftArrow,
    showRightArrow,
    showExpandHint,
    visiblePillWidths: fitPillWidths(visibleRawWidths, availablePillColumns),
  };
}

function fitPillWidths(widths: readonly number[], availableColumns: number): number[] {
  const fitted = widths.map(width => Math.max(1, width));
  let total = fitted.reduce((sum, width) => sum + width, 0);

  while (total > availableColumns) {
    let widestIndex = -1;
    let widest = 1;
    for (let index = 0; index < fitted.length; index += 1) {
      const width = fitted[index]!;
      if (width > widest) {
        widest = width;
        widestIndex = index;
      }
    }
    if (widestIndex === -1) break;
    fitted[widestIndex] = fitted[widestIndex]! - 1;
    total -= 1;
  }

  return fitted;
}
