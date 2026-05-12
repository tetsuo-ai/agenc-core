// MonitorMcpDetailDialog — placeholder detail view for monitor_mcp tasks.
//
// AgenC routes monitoring through LocalShellTask (kind: 'monitor'),
// not through an MCP backend, so the monitor_mcp task type has no
// detail UI of its own. This module exists to satisfy the optional
// require('./MonitorMcpDetailDialog') in BackgroundTasksDialog.tsx
// when the MONITOR_TOOL feature is on.

import React from "react";

export function MonitorMcpDetailDialog(_props: {
  readonly task: unknown;
  readonly onKill?: () => void;
  readonly onBack: () => void;
}): React.ReactElement | null {
  return null;
}
