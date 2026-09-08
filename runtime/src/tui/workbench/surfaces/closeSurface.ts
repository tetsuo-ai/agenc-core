import type { AppState } from "../../state/AppStateStore.js";
import { applyWorkbenchCommand } from "../state.js";

export type SurfaceCloseResult = {
  readonly status: "closed" | "needs_confirmation" | "blocked";
  readonly state: AppState;
};

export function requestWorkbenchSurfaceClose(appState: AppState): SurfaceCloseResult {
  const state = applyWorkbenchCommand(appState, { type: "closeSurface" });
  if (state === appState) return { status: "blocked", state };
  return {
    status: state.workbench.pendingBlockedOverlay === null ? "closed" : "needs_confirmation",
    state,
  };
}
