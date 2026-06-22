export type TrustRecord = Record<string, unknown>;

export function isTrustRecord(value: unknown): value is TrustRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
