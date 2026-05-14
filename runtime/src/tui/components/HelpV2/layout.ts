const COMMAND_LIST_CHROME_ROWS = 4;
const COMMAND_OPTION_ROWS = 2;

function normalizeRows(rows: number): number {
  return Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
}

export function calculateHelpBodyHeight(rows: number): number {
  const normalizedRows = normalizeRows(rows);
  if (normalizedRows === 0) {
    return 1;
  }

  return Math.max(1, Math.floor(normalizedRows / 2));
}

export function calculateCommandVisibleOptionCount(maxHeight: number): number {
  const normalizedHeight = normalizeRows(maxHeight);
  const availableOptionRows = normalizedHeight - COMMAND_LIST_CHROME_ROWS;
  if (availableOptionRows < COMMAND_OPTION_ROWS) {
    return 0;
  }

  return Math.floor(availableOptionRows / COMMAND_OPTION_ROWS);
}
