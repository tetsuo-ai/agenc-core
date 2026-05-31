import type { AgenCBridgeSession } from "./session-types.js";
import type { AppState } from "./state/AppState.js";

export function createSessionAppStateBridge(
  setModel: (next: string) => void,
  setExpandedView: (next: "none" | "tasks") => void,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  getAppState: () => AppState,
): NonNullable<AgenCBridgeSession["appStateBridge"]> {
  return {
    getAppState: getAppState as () => unknown,
    setModel,
    setExpandedView,
    setAppState: setAppState as (updater: (prev: unknown) => unknown) => void,
  };
}
