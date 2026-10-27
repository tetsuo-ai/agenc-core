// Trusted execution-side discovery, scoped to the registry that made the call.
// Model arguments cannot forge this association. It grants no execution rights.
const observers = new WeakMap<object, () => void>();
const escalationObservers = new WeakMap<object, () => void>();

export function bindExecSessionDiscovery(args: object, observer: () => void): void {
  observers.set(args, observer);
}

export function notifyExecSessionDiscovery(args: object, fallback?: () => void): void {
  (observers.get(args) ?? fallback)?.();
}

/**
 * A sandbox notice on this call told the model to retry with
 * sandbox_permissions: the observer makes the next request present
 * exec_command's full schema, so the field it was told to use is there.
 * Presentation only; the retry still goes through approval and the sandbox.
 */
export function bindExecEscalationDiscovery(args: object, observer: () => void): void {
  escalationObservers.set(args, observer);
}

export function notifyExecEscalationDiscovery(args: object, fallback?: () => void): void {
  (escalationObservers.get(args) ?? fallback)?.();
}
