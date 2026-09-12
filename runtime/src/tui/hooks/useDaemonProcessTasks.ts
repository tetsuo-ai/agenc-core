import { useEffect } from "react";
import type { AgenCBridgeSession } from "../session-types.js";
import type { AppState } from "../state/AppStateStore.js";
import { startDaemonProcessTaskPolling } from "../state/daemonProcessTasks.js";

export function useDaemonProcessTasks(
  session: AgenCBridgeSession,
  setAppState: (update: (state: AppState) => AppState) => void,
  onError: (message: string) => void,
): void {
  useEffect(() => startDaemonProcessTaskPolling(session, setAppState, onError), [session, setAppState, onError]);
}
