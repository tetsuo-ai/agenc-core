import type { Session } from "../session/session.js";

type ChildApprovalObserver = (child: Session) => () => void;

interface ChildApprovalOwnership {
  readonly parent: Session;
  readonly cancellation: AbortController;
}

const approvalParents = new WeakMap<Session, ChildApprovalOwnership>();
const approvalObservers = new WeakMap<Session, Set<ChildApprovalObserver>>();

export function isApprovalSessionOwnedBy(session: Session, owner: Session): boolean {
  let current: Session | undefined = session;
  while (current !== undefined) {
    if (current === owner) return true;
    const ownership = approvalParents.get(current);
    if (ownership?.cancellation.signal.aborted) return false;
    current = ownership?.parent;
  }
  return false;
}

export function observeChildApprovalSessions(
  parent: Session,
  observer: ChildApprovalObserver,
): () => void {
  let observers = approvalObservers.get(parent);
  if (observers === undefined) {
    observers = new Set();
    approvalObservers.set(parent, observers);
  }
  observers.add(observer);
  return () => {
    observers.delete(observer);
    if (observers.size === 0) approvalObservers.delete(parent);
  };
}

export function registerChildApprovalSession(child: Session, parent: Session): void {
  if (approvalParents.has(child) || isApprovalSessionOwnedBy(parent, child)) {
    throw new Error("Child approval ownership is already assigned or cyclic");
  }
  const cancellation = new AbortController();
  const revoke = () => cancellation.abort("child approval ownership revoked");
  const parentSignal = approvalParents.get(parent)?.cancellation.signal ?? parent.abortController.signal;
  const childSignal = child.abortController.signal;
  parentSignal.addEventListener("abort", revoke, { once: true });
  childSignal.addEventListener("abort", revoke, { once: true });
  const cleanups: Array<() => void> = [];
  const unregisterClose = child.onBeforeDurableClose(() => {
    revoke();
    approvalParents.delete(child);
    parentSignal.removeEventListener("abort", revoke);
    childSignal.removeEventListener("abort", revoke);
    for (const cleanup of cleanups) cleanup();
    unregisterClose();
  });
  approvalParents.set(child, { parent, cancellation });
  if (parentSignal.aborted || childSignal.aborted) revoke();
  let ancestor: Session | undefined = parent;
  while (ancestor !== undefined) {
    for (const observer of approvalObservers.get(ancestor) ?? []) {
      cleanups.push(observer(child));
    }
    ancestor = approvalParents.get(ancestor)?.parent;
  }
}

export function childApprovalRevocationSignal(child: Session): AbortSignal | undefined {
  return approvalParents.get(child)?.cancellation.signal;
}

export function revokeChildApprovalSession(child: Session): void {
  approvalParents.get(child)?.cancellation.abort("child approval session is shutting down");
}
