import { useCallback } from "react";

import type { AppState } from "../state/AppStateStore.js";
import { useAppState, useSetAppState } from "../state/AppState.js";
import { ensureWorkbenchState, getDefaultWorkbenchState, workbenchReducer } from "./reducer.js";
import type { WorkbenchCommand, WorkbenchState } from "./types.js";
import { WORKBENCH_ENV_VAR } from "./types.js";

export function isWorkbenchEnabled(
  env: Partial<Record<typeof WORKBENCH_ENV_VAR, string | undefined>> = process.env,
): boolean {
  const value = env[WORKBENCH_ENV_VAR];
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

export function getWorkbenchStateFromAppState(state: AppState): WorkbenchState {
  return ensureWorkbenchState(state.workbench);
}

export function applyWorkbenchCommand(
  appState: AppState,
  command: WorkbenchCommand,
): AppState {
  return {
    ...appState,
    workbench: workbenchReducer(appState.workbench, command),
  };
}

export function useWorkbenchState(): WorkbenchState {
  return useAppState((state: AppState) => state.workbench ?? getDefaultWorkbenchState());
}

export function useWorkbenchDispatch(): (command: WorkbenchCommand) => void {
  const setAppState = useSetAppState();
  return useCallback(
    (command: WorkbenchCommand) => {
      setAppState((prev: AppState) => applyWorkbenchCommand(prev, command));
    },
    [setAppState],
  );
}
