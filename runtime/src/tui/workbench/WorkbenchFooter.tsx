import React from "react";

import { Box, Text } from "../ink.js";
import { stringWidth } from "../ink/stringWidth.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useShortcutDisplay } from "../keybindings/useShortcutDisplay.js";
import { useAppState } from "../state/AppState.js";
import { useWorkbenchState } from "./state.js";
import { useBufferStore } from "./buffer/useBufferStore.js";

// Hints are `<label>: <segment>  <segment>  …` with double-space separators.
// On narrow terminals whole trailing segments are dropped instead of
// ellipsizing the last one mid-word ("ctrl+w k focu…" taught nothing). The
// label plus first segment always render (truncated as a last resort).
export function fitFooterHints(hints: string, available: number): string {
  if (stringWidth(hints) <= available) return hints;
  const segments = hints.split(/ {2,}/);
  let line = "";
  for (const segment of segments) {
    const candidate = line === "" ? segment : `${line}  ${segment}`;
    if (stringWidth(candidate) > available) break;
    line = candidate;
  }
  return line === "" ? (segments[0] ?? hints) : line;
}

export function WorkbenchFooter(): React.ReactElement {
  const { columns } = useTerminalSize();
  const workbench = useWorkbenchState();
  const buffer = useBufferStore();
  const bufferKeybindingContext = buffer.provider.capabilities.terminalUi
    ? "BufferHost"
    : "Buffer";
  const composerShortcut = useShortcutDisplay(
    "workbench:focusComposer",
    bufferKeybindingContext,
    "shift+tab",
  );
  const panelShortcut = useShortcutDisplay(
    "workbench:focusRail",
    bufferKeybindingContext,
    buffer.provider.capabilities.terminalUi ? "alt+l" : "ctrl+x l",
  );
  const maximizeShortcut = useShortcutDisplay(
    "workbench:toggleSurfaceMaximized",
    bufferKeybindingContext,
    buffer.provider.capabilities.terminalUi ? "alt+z" : "ctrl+x z",
  );
  const saveShortcut = useShortcutDisplay(
    "buffer:save",
    bufferKeybindingContext,
    "ctrl+s",
  );
  const configuredRedoShortcut = useShortcutDisplay(
    "buffer:redo",
    "Buffer",
    "ctrl+x y",
  );
  const redoShortcut = buffer.provider.capabilities.terminalUi
    ? "ctrl+r"
    : configuredRedoShortcut;
  const closeShortcut = useShortcutDisplay(
    "buffer:close",
    bufferKeybindingContext,
    buffer.provider.capabilities.terminalUi ? "alt+q" : "ctrl+x q",
  );
  const modeShortcut = useShortcutDisplay(
    "chat:cycleMode",
    "Chat",
    "shift+tab",
  );
  const transcriptShortcut = useShortcutDisplay(
    "app:toggleTranscript",
    "Global",
    "ctrl+o",
  );
  // The workbench frame clips the classic footer notification lane (its
  // bottom-anchored layout drops rows from the top), which made failed
  // submits look silently swallowed. Surface the current notification in
  // the always-visible hint row instead.
  const currentNotification = useAppState((s) => s.notifications.current);
  const footerNotification =
    currentNotification !== null && "text" in currentNotification
      ? currentNotification
      : null;
  const bufferOwnsKeys =
    workbench.activeSurfaceMode === "buffer" &&
    workbench.focusedPane === "surface";
  const hints = bufferOwnsKeys
    ? [
        `BUFFER: ${saveShortcut} save`,
        `${redoShortcut} redo`,
        ...(workbench.rail !== null ? [`${panelShortcut} AI panel`] : []),
        `${composerShortcut} composer`,
        `${maximizeShortcut} ${workbench.surfaceMaximized ? "restore" : "maximize"}`,
        `${closeShortcut} hide`,
      ].join("  ")
    : [
        "/ commands",
        "@ attach",
        `${modeShortcut} mode`,
        `${transcriptShortcut} transcript`,
        "? shortcuts",
      ].join("  ");
  return (
    <Box
      height={3}
      width="100%"
      flexShrink={0}
      paddingX={2}
      paddingTop={1}
      alignItems="center"
      backgroundColor="#000000"
      borderTop
      borderTopColor="lineSoft"
    >
      {footerNotification !== null ? (
        <Text color={footerNotification.color ?? "text"} wrap="truncate-end">
          {footerNotification.text}
        </Text>
      ) : (
        <Text color="inactive" wrap="truncate-end">
          {fitFooterHints(hints, Math.max(1, columns - 6))}
        </Text>
      )}
    </Box>
  );
}
