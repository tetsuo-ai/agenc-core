export function clampSurfaceSelection(selected: number, itemCount: number): number {
  if (!Number.isFinite(selected) || selected <= 0 || itemCount <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(selected), itemCount - 1);
}
