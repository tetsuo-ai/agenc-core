import { isRecord } from "../../utils/record.js";

export type TrustRecord = Record<string, unknown>;

export function isTrustRecord(value: unknown): value is TrustRecord {
  return isRecord(value);
}
