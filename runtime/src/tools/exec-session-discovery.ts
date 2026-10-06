// Trusted execution-side discovery, scoped to the registry that made the call.
// Model arguments cannot forge this association. It grants no execution rights.
const observers = new WeakMap<object, () => void>();

export function bindExecSessionDiscovery(args: object, observer: () => void): void {
  observers.set(args, observer);
}

export function notifyExecSessionDiscovery(args: object, fallback?: () => void): void {
  (observers.get(args) ?? fallback)?.();
}
