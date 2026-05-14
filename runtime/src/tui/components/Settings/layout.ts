const SETTINGS_MAX_CONTENT_HEIGHT = 30;
const SETTINGS_MIN_NORMAL_CONTENT_HEIGHT = 15;
const SETTINGS_CONFIG_CHROME_LINES = 10;
const MIN_VISIBLE_LINE_COUNT = 1;

function normalizeRows(rows: number): number {
  return Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
}

export function calculateSettingsContentHeight(rows: number, insideModal: boolean): number {
  const safeRows = normalizeRows(rows);
  if (insideModal) {
    return Math.max(MIN_VISIBLE_LINE_COUNT, safeRows);
  }

  const preferred = Math.max(
    SETTINGS_MIN_NORMAL_CONTENT_HEIGHT,
    Math.min(Math.floor(safeRows * 0.8), SETTINGS_MAX_CONTENT_HEIGHT),
  );
  return Math.max(MIN_VISIBLE_LINE_COUNT, Math.min(preferred, safeRows));
}

export function calculateSettingsConfigMaxVisible(paneCap: number): number {
  const safePaneCap = normalizeRows(paneCap);
  const preferred = Math.max(MIN_VISIBLE_LINE_COUNT, safePaneCap - SETTINGS_CONFIG_CHROME_LINES);
  return Math.max(MIN_VISIBLE_LINE_COUNT, Math.min(preferred, safePaneCap));
}
