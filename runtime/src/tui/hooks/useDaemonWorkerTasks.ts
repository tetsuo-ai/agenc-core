import { useEffect } from "react";
import type { AgenCBridgeSession } from "../session-types.js";
import type { AppState } from "../state/AppStateStore.js";
import { startDaemonWorkerTaskPolling } from "../state/daemonWorkerTasks.js";

export function useDaemonWorkerTasks(
  session: AgenCBridgeSession,
  setAppState: (update: (state: AppState) => AppState) => void,
  onError: (message: string) => void,
): void {
  useEffect(() => startDaemonWorkerTaskPolling(session, setAppState, onError), [session, setAppState, onError]);
}
