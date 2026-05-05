/**
 * Compact warning suppression state.
 *
 * Source snapshot: `src/services/compact/compactWarningState.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

type Listener = () => void;

let suppressed = false;
const listeners = new Set<Listener>();

export const compactWarningStore = {
  getState(): boolean {
    return suppressed;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function suppressCompactWarning(): void {
  setSuppressed(true);
}

export function clearCompactWarningSuppression(): void {
  setSuppressed(false);
}

function setSuppressed(next: boolean): void {
  if (suppressed === next) return;
  suppressed = next;
  for (const listener of listeners) listener();
}
