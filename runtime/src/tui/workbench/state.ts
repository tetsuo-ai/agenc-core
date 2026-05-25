import { useCallback } from "react";

import type { AppState } from "../state/AppStateStore.js";
import { useAppState, useSetAppState } from "../state/AppState.js";
import { getWorkbenchBufferProviderController } from "./buffer/providers/BufferProviderController.js";
import { ensureWorkbenchState, getDefaultWorkbenchState, workbenchReducer } from "./reducer.js";
import type { WorkbenchCommand, WorkbenchState } from "./types.js";
import { WORKBENCH_ENV_VAR } from "./types.js";

type WorkbenchEnv = {
  readonly AGENC_TUI_WORKBENCH?: string;
};

export function isWorkbenchEnabled(
  env: WorkbenchEnv = process.env,
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
  const workbench = ensureWorkbenchState(appState.workbench);
  if (dirtyBufferWouldBeAbandoned(workbench, command)) {
    return {
      ...appState,
      workbench: workbenchReducer(workbench, {
        type: "blockForApproval",
        requestId: "buffer-dirty-surface-switch",
        attemptedAction: "leaving dirty BUFFER",
      }),
    };
  }
  return {
    ...appState,
    workbench: workbenchReducer(workbench, command),
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

function dirtyBufferWouldBeAbandoned(
  state: WorkbenchState,
  command: WorkbenchCommand,
): boolean {
  if (state.activeSurfaceMode !== "buffer") return false;
  if (!commandLeavesBufferSurface(command)) return false;
  return getWorkbenchBufferProviderController().getSnapshot().dirty;
}

function commandLeavesBufferSurface(command: WorkbenchCommand): boolean {
  switch (command.type) {
    case "openSurface":
      return command.mode !== "buffer";
    case "openPreview":
    case "openSearch":
    case "openDiff":
    case "openShell":
    case "openAgent":
    case "closeSurface":
      return true;
    case "deletePathReferences":
      return command.closeAffectedSurface === true;
    default:
      return false;
  }
}
