import { useCallback } from "react";

import type { AppState } from "../state/AppStateStore.js";
import { useAppState, useSetAppState } from "../state/AppState.js";
import { getWorkbenchBufferProviderController } from "./buffer/providers/BufferProviderController.js";
import type { BufferProviderSnapshot } from "./buffer/providers/types.js";
import { ensureWorkbenchState, workbenchReducer } from "./reducer.js";
import { containsWorkspacePathReference } from "./pathReferences.js";
import type {
  WorkbenchCommand,
  WorkbenchState,
  WorkbenchSurfaceLeaveCommand,
} from "./types.js";
import { WORKBENCH_ENV_VAR } from "./types.js";

type WorkbenchEnv = {
  readonly AGENC_TUI_WORKBENCH?: string;
};

export function isWorkbenchEnabled(env: WorkbenchEnv = process.env): boolean {
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
  if (
    workbench.pendingBlockedOverlay !== null &&
    command.type !== "resolveBlockedOverlay" &&
    command.type !== "clearBlockedOverlay"
  ) {
    return appState;
  }
  if (
    command.type === "resolveBlockedOverlay" &&
    workbench.pendingBlockedOverlay?.requestId === command.requestId &&
    blockedSurfaceLeaveCommand(
      workbench,
      workbench.pendingBlockedOverlay.deferredCommand,
    ) !== null
  ) {
    // Save/discard completion and deferred replay are separated by an async
    // boundary. Re-read the live provider here so an edit arriving in that
    // gap cannot make a previously approved filesystem or exit operation
    // bypass the dirty-buffer transaction. Keep the same overlay open; its
    // reactive buffer list will show the new blocker.
    return appState;
  }
  if (blocksPendingRecoveryNavigation(workbench, command)) return appState;
  const deferredCommand = blockedSurfaceLeaveCommand(workbench, command);
  if (deferredCommand !== null) {
    return {
      ...appState,
      workbench: workbenchReducer(workbench, {
        type: "blockForApproval",
        requestId: "buffer-dirty-surface-switch",
        attemptedAction: blockedActionLabel(deferredCommand),
        deferredCommand,
      }),
    };
  }
  return {
    ...appState,
    workbench: workbenchReducer(workbench, command),
  };
}

function blocksPendingRecoveryNavigation(
  state: WorkbenchState,
  command: WorkbenchCommand,
): boolean {
  if (state.activeSurfaceMode !== "buffer" || command.type !== "openBuffer") {
    return false;
  }
  const recovery =
    getWorkbenchBufferProviderController().getSnapshot().recovery;
  const recoveryPending =
    recovery?.status === "pending" || recovery?.status === "working";
  return recoveryPending && command.path !== state.activeFilePath;
}

export function useWorkbenchState(): WorkbenchState {
  return useAppState(getWorkbenchStateFromAppState);
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

function blockedSurfaceLeaveCommand(
  state: WorkbenchState,
  command: WorkbenchCommand,
): WorkbenchSurfaceLeaveCommand | null {
  const snapshot = getWorkbenchBufferProviderController().getSnapshot();
  if (command.type === "requestAppExit" && snapshot.dirty) {
    return command;
  }
  if (
    (command.type === "requestProjectPathRename" ||
      command.type === "requestProjectPathDelete") &&
    projectMutationTouchesDirtyBuffer(command, snapshot)
  ) {
    return command;
  }
  // In Editor, preview/open is ordinary file navigation inside the persistent
  // Neovim workspace. The reducer keeps BUFFER active and schedules a new
  // buffer open, so this is not a dirty-surface leave operation.
  if (
    state.activeWorkspaceView === "editor" &&
    command.type === "openPreview" &&
    snapshot.provider.capabilities.multiBuffer
  ) {
    return null;
  }
  if (state.activeSurfaceMode !== "buffer") return null;
  if (!isSurfaceLeaveCommand(command) || !commandLeavesBufferSurface(command))
    return null;
  return snapshot.dirty ? command : null;
}

export function projectMutationTouchesDirtyBuffer(
  command:
    | Extract<
        WorkbenchSurfaceLeaveCommand,
        { readonly type: "requestProjectPathRename" }
      >
    | Extract<
        WorkbenchSurfaceLeaveCommand,
        { readonly type: "requestProjectPathDelete" }
      >,
  snapshot: BufferProviderSnapshot,
): boolean {
  const target =
    command.type === "requestProjectPathRename"
      ? command.fromPath
      : command.path;
  const dirtyPaths = snapshot.buffers
    .filter((buffer) => buffer.modified)
    .flatMap((buffer) => buffer.filePath ?? buffer.absolutePath ?? []);
  if (dirtyPaths.length === 0 && snapshot.dirty && snapshot.filePath) {
    dirtyPaths.push(snapshot.filePath);
  }
  return dirtyPaths.some((path) =>
    containsWorkspacePathReference(path, target),
  );
}

function blockedActionLabel(command: WorkbenchSurfaceLeaveCommand): string {
  switch (command.type) {
    case "requestProjectPathRename":
      return `renaming ${command.fromPath}`;
    case "requestProjectPathDelete":
      return `deleting ${command.path}`;
    case "requestAppExit":
      return "exiting AgenC";
    default:
      return "leaving dirty BUFFER";
  }
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
    case "moveFileToRail":
    case "requestAppExit":
      return true;
    case "requestProjectPathRename":
    case "requestProjectPathDelete":
      return false;
    case "deletePathReferences":
      return command.closeAffectedSurface === true;
    default:
      return false;
  }
}

function isSurfaceLeaveCommand(
  command: WorkbenchCommand,
): command is WorkbenchSurfaceLeaveCommand {
  switch (command.type) {
    case "openSurface":
    case "openPreview":
    case "openSearch":
    case "openDiff":
    case "openShell":
    case "openAgent":
    case "closeSurface":
    case "moveFileToRail":
    case "requestAppExit":
    case "requestProjectPathRename":
    case "requestProjectPathDelete":
    case "deletePathReferences":
      return true;
    default:
      return false;
  }
}
