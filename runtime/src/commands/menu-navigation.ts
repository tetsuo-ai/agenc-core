export function previousMenuIndex(current: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  const last = itemCount - 1;
  const clamped = Math.max(0, Math.min(current, last));
  return clamped === 0 ? last : clamped - 1;
}

export function nextMenuIndex(current: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  const last = itemCount - 1;
  const clamped = Math.max(0, Math.min(current, last));
  return clamped === last ? 0 : clamped + 1;
}
