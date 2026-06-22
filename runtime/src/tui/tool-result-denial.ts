import { isRecord } from "../utils/record.js";

export const PERMISSION_DENIED_TOOL_RESULT_MESSAGE =
  "Permission request denied by user.";

const USER_REJECTION_TEXT = "rejected by user";

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function isPermissionDeniedToolResult(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === USER_REJECTION_TEXT) return true;
    const parsed = parseJsonText(trimmed);
    return parsed !== undefined && isPermissionDeniedToolResult(parsed);
  }

  if (Array.isArray(value)) {
    return value.some((item) => isPermissionDeniedToolResult(item));
  }

  if (!isRecord(value)) return false;

  for (const key of ["error", "text", "content", "message", "reason"]) {
    if (isPermissionDeniedToolResult(value[key])) return true;
  }

  return false;
}
