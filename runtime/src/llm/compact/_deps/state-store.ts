/**
 * Minimal state-store factory matching the AgenC
 * `state/store.ts::createStore` API surface compact-warning-state
 * uses: `getState()`, `setState(updater)`, `subscribe(listener)`.
 */

export interface SimpleStore<T> {
  getState(): T;
  setState(updater: (current: T) => T): void;
  subscribe(listener: (state: T) => void): () => void;
}

export function createStore<T>(initial: T): SimpleStore<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    getState(): T {
      return state;
    },
    setState(updater: (current: T) => T): void {
      const next = updater(state);
      if (next === state) return;
      state = next;
      for (const fn of listeners) fn(state);
    },
    subscribe(listener: (state: T) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
