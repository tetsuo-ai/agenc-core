const SHELL_OUTPUT_HORIZONTAL_PADDING = 6

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0
}

export function getShellOutputMaxWidth(columns: number): number {
  return Math.max(1, normalizeColumns(columns) - SHELL_OUTPUT_HORIZONTAL_PADDING)
}
