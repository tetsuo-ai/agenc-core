import { useEffect } from "react";

import { useNotifications } from "../../context/notifications.js";
import { takeTuiStartupNotices } from "../../startup-notices.js";

const STARTUP_NOTICE_TIMEOUT_MS = 15_000;

/** Show the notices the CLI entry queued before the TUI mounted. */
export function useStartupNotices(): void {
  const { addNotification } = useNotifications();
  useEffect(() => {
    for (const notice of takeTuiStartupNotices()) {
      addNotification({
        key: notice.key,
        text: notice.text,
        color: "warning",
        priority: "high",
        wrap: true,
        timeoutMs: STARTUP_NOTICE_TIMEOUT_MS,
      });
    }
  }, [addNotification]);
}
