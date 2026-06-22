export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}
