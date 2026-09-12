import type { AgenCBridgeSession } from "../session-types.js";
import type { AppState } from "./AppStateStore.js";
import { isRecord } from "../../utils/record.js";
import { projectDaemonWorkerTask } from "./collabAgentTaskSync.js";

export type DaemonSessionSnapshot = Awaited<ReturnType<NonNullable<AgenCBridgeSession["getDaemonSessionSnapshot"]>>>;

type SetAppState = (update: (state: AppState) => AppState) => void;

/** Hydrate current native workers without replaying historical tool events. */
export function startDaemonWorkerTaskPolling(
  session: Pick<AgenCBridgeSession, "conversationId" | "getDaemonSessionSnapshot" | "subscribeToEvents">,
  setAppState: SetAppState,
  onError: (message: string) => void,
  onSnapshot?: (snapshot: DaemonSessionSnapshot) => void,
): () => void {
  if (session.getDaemonSessionSnapshot === undefined) return () => {};
  const projection = {};
  let active = true;
  let reading = false;
  let eventRevision = 0;
  let lastProjection: string | undefined;
  let lastError: string | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const requestRefresh = (): void => {
    if (!active || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void poll();
    }, 250);
    refreshTimer.unref?.();
  };
  const poll = async (): Promise<void> => {
    if (!active || reading) return;
    reading = true;
    const sessionId = session.conversationId;
    const revision = eventRevision;
    try {
      const snapshot = await session.getDaemonSessionSnapshot?.();
      if (!active || session.conversationId !== sessionId || snapshot === undefined) return;
      // A live transition may have overtaken this RPC's inventory snapshot.
      if (eventRevision !== revision) return;
      lastError = undefined;
      // Share this read with context chrome, including older daemons that
      // expose resident context but do not yet report native workers.
      onSnapshot?.(snapshot);
      if (snapshot.nativeWorkers === undefined) return;
      const signature = JSON.stringify([sessionId, snapshot.sessionId, revision, snapshot.nativeWorkers]);
      if (signature === lastProjection) return;
      setAppState(state => {
        if (!active || session.conversationId !== sessionId || eventRevision !== revision) return state;
        const tasks = Object.fromEntries(Object.entries(state.tasks).filter(([, task]) =>
          task.type !== "local_agent" || task.daemonWorker?.projection !== projection));
        for (const worker of snapshot.nativeWorkers!) {
          const previous = state.tasks[worker.agentId];
          // Only native collaboration rows from this session can be adopted.
          if (previous !== undefined && (previous.type !== "local_agent" || previous.nativeWorker !== true ||
              (previous.daemonWorker !== undefined && previous.daemonWorker.projection !== projection))) continue;
          tasks[worker.agentId] = projectDaemonWorkerTask(worker, previous, { projection, sessionId: snapshot.sessionId });
        }
        return { ...state, tasks };
      });
      lastProjection = signature;
    } catch (error) {
      if (active && session.conversationId === sessionId) {
        const message = `Unable to refresh native workers: ${error instanceof Error ? error.message : String(error)}`;
        if (message !== lastError) onError(message);
        lastError = message;
      }
    } finally {
      reading = false;
      if (eventRevision !== revision) requestRefresh();
    }
  };
  const unsubscribe = session.subscribeToEvents?.((event) => {
    if (!isRecord(event)) return;
    if ((typeof event.type === "string" && event.type.startsWith("collab_")) ||
        event.type === "background_agent_status" ||
        ["token_count", "history_replaced", "history_cleared", "context_compacted", "turn_complete", "turn_aborted", "turn_started", "user_message", "session_configured"].includes(String(event.type)) ||
        (isRecord(event.payload) && event.payload.cause === "daemon_connection_state")) {
      eventRevision++;
      requestRefresh();
    }
  });
  void poll();
  const timer = setInterval(() => { void poll(); }, 5_000);
  timer.unref?.();
  return () => {
    active = false;
    clearInterval(timer);
    clearTimeout(refreshTimer);
    unsubscribe?.();
    setAppState(state => ({
      ...state,
      tasks: Object.fromEntries(Object.entries(state.tasks).filter(([, task]) =>
        task.type !== "local_agent" || task.daemonWorker?.projection !== projection)),
    }));
  };
}
