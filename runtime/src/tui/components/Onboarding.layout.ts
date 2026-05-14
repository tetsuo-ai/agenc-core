const MAX_ONBOARDING_BODY_WIDTH = 70;
const HORIZONTAL_CHROME_COLUMNS = 4;
const MIN_ONBOARDING_BODY_WIDTH = 1;
const MIN_ROWS_FOR_WELCOME_BANNER = 14;

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function calculateOnboardingBodyWidth(columns: number): number {
  const contentColumns = normalizeDimension(columns) - HORIZONTAL_CHROME_COLUMNS;
  return Math.max(
    MIN_ONBOARDING_BODY_WIDTH,
    Math.min(MAX_ONBOARDING_BODY_WIDTH, contentColumns),
  );
}

export function shouldShowOnboardingWelcomeBanner(rows: number): boolean {
  return normalizeDimension(rows) >= MIN_ROWS_FOR_WELCOME_BANNER;
}
