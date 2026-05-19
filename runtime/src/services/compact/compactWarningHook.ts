/**
 * React hook for compact warning suppression state.
 *
 * Source snapshot: `src/services/compact/compactWarningHook.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import { useSyncExternalStore } from "react";
import { compactWarningStore } from "./compactWarningState.js";

export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getState,
  );
}
