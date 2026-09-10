import type { ActiveSurfaceMode } from "./types.js";

export function workbenchSurfacePadding(mode: ActiveSurfaceMode): number {
  return mode === "transcript" ? 3 : 1;
}
