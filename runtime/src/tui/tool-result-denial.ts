import { isRecord } from "../utils/record.js";

/**
 * Marker text stored in histories by earlier builds; trajectory curation
 * matches it. It is data, not wording for the screen.
 */
export const PERMISSION_DENIED_TOOL_RESULT_MESSAGE =
  "Permission request denied by user.";

/** What a denied permission request reads as on screen. */
export const PERMISSION_DENIED_DISPLAY_TEXT = "Permission denied.";

const USER_REJECTION_TEXT = "rejected by user";
// Prefix of the orchestrator's resolver-denial message.
const PERMISSION_DENIED_PREFIX = "permission denied:";

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * True for the approval flow's own denial of a call ("Permission denied:
 * exec_command. denied", "... was denied by this session's approval
 * resolver", "rejected by user"). A tool's own error that happens to start
 * with "Permission denied: /path" (EACCES, a remote refusal) is not one and
 * keeps its detail.
 */
export function isApprovalDenialToolResult(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === USER_REJECTION_TEXT) return true;
    if (/^Permission denied: [A-Za-z_][\w.-]*(?:\. \S| was denied by this session's approval resolver)/u.test(trimmed)) {
      return true;
    }
    const parsed = trimmed.startsWith("{") || trimmed.startsWith("[") ? parseJsonText(trimmed) : undefined;
    return parsed !== undefined && isApprovalDenialToolResult(parsed);
  }
  if (Array.isArray(value)) return value.some((item) => isApprovalDenialToolResult(item));
  if (!isRecord(value)) return false;
  for (const key of ["error", "text", "content", "message", "reason"]) {
    if (isApprovalDenialToolResult(value[key])) return true;
  }
  return false;
}

export function isPermissionDeniedToolResult(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === USER_REJECTION_TEXT) return true;
    if (lowered.startsWith(PERMISSION_DENIED_PREFIX)) return true;
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
