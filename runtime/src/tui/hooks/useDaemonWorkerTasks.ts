import { useEffect } from "react";
import type { AgenCBridgeSession } from "../session-types.js";
import type { AppState } from "../state/AppStateStore.js";
import { startDaemonWorkerTaskPolling, type DaemonSessionSnapshot } from "../state/daemonWorkerTasks.js";

export function useDaemonWorkerTasks(
  session: AgenCBridgeSession,
  setAppState: (update: (state: AppState) => AppState) => void,
  onError: (message: string) => void,
  onSnapshot?: (snapshot: DaemonSessionSnapshot) => void,
): void {
  useEffect(() => startDaemonWorkerTaskPolling(session, setAppState, onError, onSnapshot), [session, setAppState, onError, onSnapshot]);
}
