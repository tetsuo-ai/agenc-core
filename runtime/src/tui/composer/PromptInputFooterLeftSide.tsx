import * as React from "react";

import { Box, Text } from "../ink-public.js";
import { Byline } from "../design-system/Byline.js";
import { KeyboardShortcutHint } from "../design-system/KeyboardShortcutHint.js";
import {
  getDisplayForCommand,
} from "../keybindings/shortcutFormat.js";
import type { PromptInputMode } from "./inputModes.js";
import { isVimModeEnabled } from "./promptInput-utils.js";
import type { PermissionMode } from "../../permissions/types.js";
import {
  isDefaultMode,
  permissionModeDisplayColor,
  permissionModeSymbol,
  permissionModeTitle,
} from "../../permissions/mode-display.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";

export type VimMode = "INSERT" | "NORMAL";

type Props = {
  readonly exitMessage: { readonly show: boolean; readonly key?: string };
  readonly vimMode?: VimMode;
  readonly mode: PromptInputMode;
  readonly permissionMode: PermissionMode;
  readonly suppressHint: boolean;
  readonly isLoading: boolean;
  readonly isPasting?: boolean;
  readonly isSearching?: boolean;
  readonly status?: { readonly color: Color; readonly text: string } | null;
  readonly pendingRequestCount?: number;
};

export function PromptInputFooterLeftSide({
  exitMessage,
  vimMode,
  mode,
  permissionMode,
  suppressHint,
  isLoading,
  isPasting,
  isSearching,
  status,
  pendingRequestCount = 0,
}: Props): React.ReactNode {
  if (exitMessage.show) {
    return (
      <Text dimColor>Press {exitMessage.key} again to exit</Text>
    );
  }

  if (isPasting === true) {
    return <Text dimColor>Pasting text…</Text>;
  }

  const showVim =
    isVimModeEnabled() && vimMode === "INSERT" && isSearching !== true;
  const vimNode = showVim ? (
    <Text dimColor>-- INSERT --</Text>
  ) : null;

  const showHint = !suppressHint && !showVim;
  const statusNode =
    status !== null && status !== undefined ? (
      <Text color={status.color} wrap="truncate">
        {status.text}
      </Text>
    ) : null;

  const modeIndicator = (
    <ModeIndicator
      mode={mode}
      permissionMode={permissionMode}
      showHint={showHint}
      isLoading={isLoading}
      pendingRequestCount={pendingRequestCount}
    />
  );

  if (statusNode !== null) {
    return (
      <Box flexDirection="column">
        {statusNode}
        <Box justifyContent="flex-start" gap={1}>
          {vimNode}
          {modeIndicator}
        </Box>
      </Box>
    );
  }

  return (
    <Box justifyContent="flex-start" gap={1}>
      {vimNode}
      {modeIndicator}
    </Box>
  );
}

type ModeIndicatorProps = {
  readonly mode: PromptInputMode;
  readonly permissionMode: PermissionMode;
  readonly showHint: boolean;
  readonly isLoading: boolean;
  readonly pendingRequestCount: number;
};

function ModeIndicator({
  mode,
  permissionMode,
  showHint,
  isLoading,
  pendingRequestCount,
}: ModeIndicatorProps): React.ReactNode {
  if (mode === "bash") {
    return <Text color="accent">! for bash mode</Text>;
  }
  if (mode === "memory") {
    return <Text color="warning"># appends to AGENC.md</Text>;
  }

  const modeCycleShortcut =
    getDisplayForCommand("chat:cycleMode", "chat") ?? "Shift+Tab";
  const escShortcut = (
    getDisplayForCommand("chat:cancel", "chat") ?? "Esc"
  ).toLowerCase();

  const modePart =
    !isDefaultMode(permissionMode) ? (
      <Box flexShrink={0}>
        <Text
          key="permission-mode"
          color={footerModeColor(permissionMode, pendingRequestCount) as Color}
        >
          {permissionModeSymbol(permissionMode)}{" "}
          {permissionModeTitle(permissionMode).toLowerCase()} on
          {showHint && !isLoading ? (
            <Text dimColor>
              {" "}
              <KeyboardShortcutHint
                shortcut={modeCycleShortcut}
                action="cycle"
                parens
              />
            </Text>
          ) : null}
        </Text>
      </Box>
    ) : null;

  const parts: React.ReactElement[] = [];
  if (isLoading) {
    parts.push(
      <Text dimColor key="esc">
        <KeyboardShortcutHint shortcut={escShortcut} action="interrupt" />
      </Text>,
    );
  }
  if (showHint && !isLoading && isDefaultMode(permissionMode)) {
    parts.push(
      <Text dimColor>? for shortcuts</Text>
    );
  }

  if (parts.length === 0 && modePart === null) {
    return <Text> </Text>;
  }

  return (
    <Box height={1} overflow="hidden">
      {modePart}
      {modePart !== null && parts.length > 0 ? <Text dimColor>{" · "}</Text> : null}
      {parts.length > 0 ? (
        <Text wrap="truncate">
          <Byline>{parts}</Byline>
        </Text>
      ) : null}
    </Box>
  );
}

function footerModeColor(
  mode: PermissionMode,
  pendingRequestCount: number,
): Color {
  if (pendingRequestCount > 0) return theme.colors.warning as Color;
  switch (permissionModeDisplayColor(mode)) {
    case "planMode":
      return theme.colors.modePlan as Color;
    case "autoAccept":
      return theme.colors.modeAcceptEdits as Color;
    case "error":
      return theme.colors.modeBypass as Color;
    case "warning":
      return theme.colors.warning as Color;
    case "permission":
      return theme.colors.accent as Color;
    case "text":
    default:
      return theme.colors.ink as Color;
  }
}
