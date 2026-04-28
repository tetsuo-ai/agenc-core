/**
 * Three-column help menu shown below the composer when the input is
 * empty. Reminds the user of the input mode triggers (`!`, `/`, `@`,
 * `&`, `/btw`) and the most common chat / app shortcuts.
 *
 * Ported from upstream. Shortcut text uses static defaults; AgenC does
 * not yet have a `useShortcutDisplay` hook tied to live keybindings,
 * so the menu always displays the canonical shortcut for each action.
 * When AgenC ships per-action shortcut lookup, this widget can pick up
 * the live binding without changing its layout.
 */
import * as React from "react";

import { Box, Text } from "../ink-public.js";

interface Props {
  readonly dimColor?: boolean;
  readonly fixedWidth?: boolean;
  readonly gap?: number;
  readonly paddingX?: number;
}

const isWindows =
  typeof process !== "undefined" && process.platform === "win32";

const newlineInstructions = "\\ followed by enter for newline";

const transcriptShortcut = "ctrl + o";
const todosShortcut = "ctrl + t";
const undoShortcut = "ctrl + _";
const stashShortcut = "ctrl + s";
const cycleModeShortcut = "shift + tab";
const modelPickerShortcut = "alt + p";
const externalEditorShortcut = "ctrl + g";
const imagePasteShortcut = "ctrl + v";

export function PromptInputHelpMenu({
  dimColor,
  fixedWidth,
  gap,
  paddingX,
}: Props): React.ReactElement {
  const triggersWidth = fixedWidth ? 24 : undefined;
  const modesWidth = fixedWidth ? 35 : undefined;

  return (
    <Box paddingX={paddingX} flexDirection="row" gap={gap}>
      <Box flexDirection="column" width={triggersWidth}>
        <Box>
          <Text dimColor={dimColor}>! for bash mode</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>/ for commands</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>@ for file paths</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{"& for background"}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>/btw for side question</Text>
        </Box>
      </Box>
      <Box flexDirection="column" width={modesWidth}>
        <Box>
          <Text dimColor={dimColor}>double tap esc to clear input</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {cycleModeShortcut} to auto-accept edits
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {transcriptShortcut} for verbose output
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{todosShortcut} to toggle tasks</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{newlineInstructions}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text dimColor={dimColor}>{undoShortcut} to undo</Text>
        </Box>
        {!isWindows && (
          <Box>
            <Text dimColor={dimColor}>ctrl + z to suspend</Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>{imagePasteShortcut} to paste images</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {modelPickerShortcut} to switch model
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{stashShortcut} to stash prompt</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {externalEditorShortcut} to edit in $EDITOR
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export default PromptInputHelpMenu;
