/**
 * Session memory-mode helpers.
 *
 * Modes mirror the AgenC runtime memory-mode semantics but are stored in AgenC's
 * per-session attachment state for now. A later persistence migration can
 * move this to the thread store without changing callers.
 *
 * @module
 */

import { getAttachmentTrackingState } from "../../session/attachment-state.js";

export type MemoryMode = "enabled" | "disabled" | "polluted";

export function parseMemoryMode(raw: string): MemoryMode | null {
  switch (raw.trim().toLowerCase()) {
    case "enabled":
    case "on":
      return "enabled";
    case "disabled":
    case "off":
      return "disabled";
    case "polluted":
      return "polluted";
    default:
      return null;
  }
}

export function getSessionMemoryMode(sessionKey: object): MemoryMode {
  return getAttachmentTrackingState(sessionKey).memoryMode;
}

export function setSessionMemoryMode(
  sessionKey: object,
  mode: MemoryMode,
): void {
  getAttachmentTrackingState(sessionKey).memoryMode = mode;
}

export function memoryModeAllowsRecall(mode: MemoryMode): boolean {
  return mode !== "disabled";
}

export function memoryModeAllowsWrites(mode: MemoryMode): boolean {
  return mode === "enabled";
}

