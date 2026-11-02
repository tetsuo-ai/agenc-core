import type { Notification } from "./context/notifications.js";
import type { UpdateNotice } from "./update-relaunch-state.js";

/** The terminal outcome of the update this window was following. */
export function updateFollowNotification(notice: UpdateNotice): Notification {
  return {
    key: "agenc-update",
    text: notice.text,
    ...(notice.kind === "error" ? { color: "error" as const } : {}),
    // A suspended client can still have the earlier waiting notice current.
    // Replace it instead of letting same-key deduplication discard the end.
    priority: "immediate",
    invalidates: ["agenc-update"],
    timeoutMs: 30_000,
  };
}
