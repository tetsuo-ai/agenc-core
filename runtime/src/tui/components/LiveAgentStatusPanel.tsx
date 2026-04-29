import React from "react";

import { useLiveAgentStatuses } from "../hooks/useLiveAgentStatuses.js";
import { CoordinatorAgentStatus } from "../transcript/messages/CoordinatorAgentStatus.js";

export interface LiveAgentStatusPanelProps {
  readonly session: Parameters<typeof useLiveAgentStatuses>[0];
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function LiveAgentStatusPanel({
  session,
}: LiveAgentStatusPanelProps): React.ReactElement | null {
  const agents = useLiveAgentStatuses(session);
  return <CoordinatorAgentStatus agents={agents} now={nowMs()} />;
}
