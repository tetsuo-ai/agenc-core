export type TaskPayloadRecord = Record<string, unknown>;

export function isTaskRecord(value: unknown): value is TaskPayloadRecord {
  return typeof value === "object" && value !== null;
}

export function taskStringField(
  record: TaskPayloadRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function taskNumberField(
  record: TaskPayloadRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
