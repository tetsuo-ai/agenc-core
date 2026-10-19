import type { Session } from "./session.js";

// Display invalidation follows actual Session construction. Review authority
// still comes from the durable spawn edges, never from these notifications.
const parents = new WeakMap<Session, Session>();
const listeners = new WeakMap<Session, Set<() => void>>();

export function subscribeChildEffectReviews(session: Session, listener: () => void): () => void {
  let subscriptions = listeners.get(session);
  if (subscriptions === undefined) listeners.set(session, subscriptions = new Set());
  subscriptions.add(listener);
  return () => { subscriptions.delete(listener); };
}

export function watchChildEffectReviews(parent: Session, child: Session): () => void {
  parents.set(child, parent);
  const unsubscribe = child.eventLog.subscribe((event) => {
    if (event.msg.type !== "effect_unknown_outcome" && event.msg.type !== "effect_review_resolved") return;
    // Session.emit publishes before the durable projection has been applied.
    queueMicrotask(() => {
      const seen = new Set<Session>();
      for (let owner: Session | undefined = parent; owner !== undefined && !seen.has(owner); owner = parents.get(owner)) {
        seen.add(owner);
        for (const listener of listeners.get(owner) ?? []) listener();
      }
    });
  });
  return () => { unsubscribe(); parents.delete(child); };
}
