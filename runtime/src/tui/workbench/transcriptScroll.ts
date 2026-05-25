import type { ActiveSurfaceMode } from "./types.js";

export type TranscriptScrollKeybindingOptions = {
  readonly fullscreen: boolean;
  readonly workbenchEnabled: boolean;
  readonly permissionRequestCount: number;
  readonly modalVisible: boolean;
  readonly activeSurfaceMode: ActiveSurfaceMode;
};

export function shouldEnableTranscriptScrollKeybindings(
  options: TranscriptScrollKeybindingOptions,
): boolean {
  if (!options.fullscreen) return false;
  if (options.permissionRequestCount > 0) return false;
  if (!options.workbenchEnabled) return true;
  if (options.modalVisible) return true;
  return options.activeSurfaceMode === "transcript";
}
