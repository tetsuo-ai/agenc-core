import type { LiveAgent } from "./control.js";

/**
 * Process-local record of the routing supervisors that watch a child's first
 * task. A supervisor lives only in the process and turn that spawned the
 * child, so a child restored after a restart has none and keeps its ordinary
 * provider retries.
 */
const supervisors = new WeakMap<LiveAgent, () => boolean>();

/**
 * Register while a supervisor observes the child. `canFallback` reports
 * whether it could still start a retry on another provider right now.
 * Returns the release for when the observation settles.
 */
export function superviseChildRoutingRetries(live: LiveAgent, canFallback: () => boolean): () => void {
  supervisors.set(live, canFallback);
  return () => {
    if (supervisors.get(live) === canFallback) supervisors.delete(live);
  };
}

/**
 * Whether a live supervisor could still restart this child's task on another
 * provider. While it holds, a provider failure ends the child's task instead
 * of retrying the same provider.
 */
export function childRoutingSupervisorCanFallback(live: LiveAgent): boolean {
  const canFallback = supervisors.get(live);
  if (canFallback === undefined) return false;
  try {
    return canFallback();
  } catch {
    return false;
  }
}
