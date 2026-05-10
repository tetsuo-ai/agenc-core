// MonitorMcpDetailDialog — placeholder detail view for monitor_mcp tasks.
//
// AgenC routes monitoring through LocalShellTask (kind: 'monitor'),
// not through an MCP backend, so the monitor_mcp task type has no
// detail UI of its own. This module exists to satisfy the optional
// require('./MonitorMcpDetailDialog') in BackgroundTasksDialog.tsx
// when the MONITOR_TOOL feature is on. It mirrors the upstream
// no-op placeholder exactly.

import React from "react";


// ---- donor-purge stubs ----
// These symbols used to come from modules deleted in the api.anthropic.com
// purge. They are stubbed here as no-ops so the surrounding moved-source
// code paths degrade silently. Real implementations land when AgenC ships
// the equivalent backend.
const BackgroundTasksDialog = (_props: unknown): null => null;
// ---- end donor-purge stubs ----
export function MonitorMcpDetailDialog(_props: {
  readonly task: unknown;
  readonly onKill?: () => void;
  readonly onBack: () => void;
}): React.ReactElement | null {
  return null;
}
