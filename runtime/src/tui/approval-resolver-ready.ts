import type { ApprovalResolver } from "../tools/orchestrator.js";

type ApprovalServices = { approvalResolver?: ApprovalResolver };
const waiting = new WeakMap<ApprovalServices, Set<() => void>>();

/** Daemon replay can arrive before React mounts the approval UI. */
export function waitForApprovalResolver(
  services: ApprovalServices,
  signal: AbortSignal,
): Promise<ApprovalResolver | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  if (services.approvalResolver !== undefined) return Promise.resolve(services.approvalResolver);
  return new Promise(resolve => {
    const listeners = waiting.get(services) ?? new Set<() => void>();
    waiting.set(services, listeners);
    const finish = () => {
      if (!signal.aborted && services.approvalResolver === undefined) return;
      listeners.delete(finish);
      if (listeners.size === 0) waiting.delete(services);
      signal.removeEventListener("abort", finish);
      resolve(signal.aborted ? undefined : services.approvalResolver);
    };
    listeners.add(finish);
    signal.addEventListener("abort", finish, { once: true });
    finish();
  });
}

export function notifyApprovalResolverReady(services: ApprovalServices): void {
  for (const ready of [...(waiting.get(services) ?? [])]) ready();
}
