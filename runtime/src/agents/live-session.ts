import type { Session } from "../session/session.js";
import type { LiveAgent } from "./control.js";

// Session authority belongs to the exact live handle, never a model-supplied
// thread id or a process-wide lookup by string. Only runAgent installs it.
const sessions = new WeakMap<LiveAgent, {
  readonly session: Session;
  readonly agentId: string;
  readonly agentPath: string;
}>();

export function bindLiveAgentSession(live: LiveAgent, session: Session): () => void {
  if (sessions.has(live) || live.agentId !== session.conversationId ||
    live.abortController.signal.aborted || session.abortController.signal.aborted || session.isShuttingDown) {
    throw new Error("Live agent session identity is already bound, does not match, or is shutting down");
  }
  const binding = { session, agentId: live.agentId, agentPath: live.agentPath };
  const revoke = (): void => {
    if (sessions.get(live) === binding) sessions.delete(live);
    unregisterClose();
  };
  const unregisterClose = session.onBeforeDurableClose(revoke);
  sessions.set(live, binding);
  return revoke;
}

/** The caller must first authenticate the identity and obtain this exact
 * handle from its owning AgentControl. A stopped/replaced session is refused. */
export function liveAgentSession(live: LiveAgent): Session | undefined {
  const binding = sessions.get(live);
  if (binding === undefined ||
    binding.agentId !== live.agentId || binding.agentPath !== live.agentPath ||
    binding.session.conversationId !== live.agentId ||
    live.abortController.signal.aborted ||
    binding.session.abortController.signal.aborted || binding.session.isShuttingDown) {
    return undefined;
  }
  return binding.session;
}
