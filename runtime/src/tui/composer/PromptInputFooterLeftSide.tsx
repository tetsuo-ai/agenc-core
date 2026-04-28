/**
 * Left-hand status row rendered beneath the composer input.
 *
 * AgenC's surface is significantly slimmer than upstream's — there's
 * no swarm, no remote-session pill, no voice indicator, no PR badge,
 * no fast-mode picker, no proactive countdown. What ports cleanly:
 *
 *   - Exit warning ("Press Ctrl+D again to exit") when the keybinding
 *     provider has surfaced a double-press warning.
 *   - "Pasting text…" hint while a bracketed paste is mid-stream.
 *   - History-search input — placeholder until tranche 5B ports
 *     `HistorySearchInput`. Until then the composer's own
 *     `status-line.ts` already covers the active history-search row,
 *     so this widget just no-ops when `isSearching` is true.
 *   - Mode hint ("? for shortcuts" / shift+tab cycles modes / esc to
 *     interrupt).
 *
 * Bash mode replaces the mode hint with a static "! for bash mode"
 * pill, mirroring upstream.
 */

import * as React from "react";

import { Box, Text } from "../ink-public.js";
import { Byline } from "../design-system/Byline.js";
import { KeyboardShortcutHint } from "../design-system/KeyboardShortcutHint.js";
import {
  getDisplayForCommand,
} from "../keybindings/shortcutFormat.js";
import type { PromptInputMode } from "./inputModes.js";
import { isVimModeEnabled } from "./promptInput-utils.js";

export type VimMode = "INSERT" | "NORMAL";

type Props = {
  readonly exitMessage: { readonly show: boolean; readonly key?: string };
  readonly vimMode?: VimMode;
  readonly mode: PromptInputMode;
  readonly suppressHint: boolean;
  readonly isLoading: boolean;
  readonly isPasting?: boolean;
  readonly isSearching?: boolean;
};

export function PromptInputFooterLeftSide({
  exitMessage,
  vimMode,
  mode,
  suppressHint,
  isLoading,
  isPasting,
  isSearching,
}: Props): React.ReactNode {
  if (exitMessage.show) {
    return (
      <Text dimColor>Press {exitMessage.key} again to exit</Text>
    );
  }

  if (isPasting === true) {
    return <Text dimColor>Pasting text…</Text>;
  }

  if (isSearching === true) {
    // History search rendering is owned by `status-line.ts` for now;
    // tranche 5B will introduce a dedicated `HistorySearchInput` here.
    return null;
  }

  const showVim =
    isVimModeEnabled() && vimMode === "INSERT";
  const vimNode = showVim ? (
    <Text dimColor>-- INSERT --</Text>
  ) : null;

  const showHint = !suppressHint && !showVim;

  return (
    <Box justifyContent="flex-start" gap={1}>
      {vimNode}
      <ModeIndicator mode={mode} showHint={showHint} isLoading={isLoading} />
    </Box>
  );
}

type ModeIndicatorProps = {
  readonly mode: PromptInputMode;
  readonly showHint: boolean;
  readonly isLoading: boolean;
};

function ModeIndicator({
  mode,
  showHint,
  isLoading,
}: ModeIndicatorProps): React.ReactNode {
  if (mode === "bash") {
    return <Text color="accent">! for bash mode</Text>;
  }
  if (mode === "memory") {
    return <Text color="warning"># appends to AGENC.md</Text>;
  }

  if (!showHint) return null;

  const modeCycleShortcut =
    getDisplayForCommand("chat:cycleMode", "chat") ?? "Shift+Tab";
  const escShortcut = (
    getDisplayForCommand("chat:cancel", "chat") ?? "Esc"
  ).toLowerCase();

  const parts: React.ReactElement[] = [];
  if (isLoading) {
    parts.push(
      <React.Fragment key="esc">
        <Text dimColor>
          <KeyboardShortcutHint shortcut={escShortcut} action="interrupt" />
        </Text>
      </React.Fragment>,
    );
  }
  parts.push(
    <React.Fragment key="mode-cycle">
      <Text dimColor>
        <KeyboardShortcutHint
          shortcut={modeCycleShortcut}
          action="cycle mode"
          parens
        />
      </Text>
    </React.Fragment>,
  );
  parts.push(
    <React.Fragment key="shortcuts-hint">
      <Text dimColor>? for shortcuts</Text>
    </React.Fragment>,
  );

  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate">
        <Byline>{parts}</Byline>
      </Text>
    </Box>
  );
}
