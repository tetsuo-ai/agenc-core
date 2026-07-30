import type {
  ActiveSurfaceMode,
  WorkbenchPane,
  WorkbenchRail,
  WorkspaceView,
} from "./types.js";

export type TranscriptScrollKeybindingOptions = {
  readonly fullscreen: boolean;
  readonly workbenchEnabled: boolean;
  readonly permissionRequestCount: number;
  readonly modalVisible: boolean;
  readonly activeSurfaceMode: ActiveSurfaceMode;
  readonly activeWorkspaceView?: WorkspaceView;
  readonly focusedPane?: WorkbenchPane;
  readonly rail?: WorkbenchRail;
};

export function shouldEnableTranscriptScrollKeybindings(
  options: TranscriptScrollKeybindingOptions,
): boolean {
  if (!options.fullscreen) return false;
  if (options.permissionRequestCount > 0) return false;
  if (!options.workbenchEnabled) return true;
  if (options.modalVisible) return true;
  if (options.activeWorkspaceView === "editor") {
    return (
      options.focusedPane === "rail" &&
      (options.rail?.kind === "transcript" ||
        options.rail?.kind === "editor-proposal")
    );
  }
  return options.activeSurfaceMode === "transcript";
}
