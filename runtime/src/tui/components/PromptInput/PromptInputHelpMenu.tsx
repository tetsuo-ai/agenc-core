import React from 'react';
import { Box, Text } from '../../ink.js';
import { getPlatform } from '../../../utils/platform.js';
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { getNewlineInstructions } from './utils.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { GlobalRuntimeState } from '../../../config/runtime-state-repository.js';

/** Below this width the two groups stack into one column. */
const NARROW_LAYOUT_BREAKPOINT = 100;

/**
 * Show a binding the way this keyboard labels it: "ctrl+o", "option+p" on
 * macOS (alt elsewhere), "ctrl+shift+-" for ctrl+_ .
 */
export function formatHelpKey(binding: string, platform: string = getPlatform()): string {
  if (binding === 'ctrl+_') return 'ctrl+shift+-';
  const optionName = platform === 'macos' ? 'option' : 'alt';
  return binding
    .split('+')
    .map(part => (part === 'meta' || part === 'alt' ? optionName : part))
    .join('+');
}

/** "shift + ⏎ for newline" style text from the newline helper, as key + action. */
function newlineKey(text: string): string {
  if (text.startsWith('shift')) return 'shift+enter';
  if (text.startsWith('\\')) return '\\ then enter';
  return '\\ then enter';
}

type Props = {
  dimColor?: boolean;
  fixedWidth?: boolean;
  gap?: number;
  paddingX?: number;
  runtimeState: Pick<
    GlobalRuntimeState,
    'shiftEnterKeyBindingInstalled' | 'hasUsedBackslashReturn'
  >;
};

type Row = { readonly key: string; readonly action: string };

function KeyRows({
  rows,
  dimColor,
  keyWidth,
}: {
  readonly rows: readonly Row[];
  readonly dimColor?: boolean;
  readonly keyWidth: number;
}): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map(row => (
        // Rows never shrink: when the pane is short the transcript gives way,
        // instead of two shortcut rows collapsing onto one line.
        <Box key={`${row.key}:${row.action}`} flexDirection="row" flexShrink={0}>
          <Box width={keyWidth} flexShrink={0}>
            <Text dimColor={dimColor}>{row.key}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{row.action}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function PromptInputHelpMenu(props: Props): React.ReactNode {
  const { dimColor, gap, paddingX, runtimeState } = props;
  const { columns: terminalColumns } = useTerminalSize();
  const isNarrowLayout = terminalColumns < NARROW_LAYOUT_BREAKPOINT;
  const platform = getPlatform();
  const optionName = platform === 'macos' ? 'option' : 'alt';

  const transcript = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
  const todos = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t');
  const undo = useShortcutDisplay('chat:undo', 'Chat', 'ctrl+_');
  const stash = useShortcutDisplay('chat:stash', 'Chat', 'ctrl+s');
  const cycleMode = useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');
  const modelPicker = useShortcutDisplay('chat:modelPicker', 'Chat', 'alt+p');
  const externalEditor = useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+g');
  const imagePaste = useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v');

  // Both mode keys work; show both so a keyboard that eats one still has a way.
  const cycleModeKey = cycleMode === 'meta+m' || cycleMode === 'alt+m' || cycleMode === 'shift+tab'
    ? `shift+tab or ${optionName}+m`
    : formatHelpKey(cycleMode, platform);

  // Only "!" changes how a message is read; "/" and "@" open pickers.
  const prefixRows: Row[] = [
    { key: '/', action: 'commands' },
    { key: '!', action: 'run a shell command' },
    { key: '@', action: 'attach a file' },
  ];
  const editingRows: Row[] = [
    { key: cycleModeKey, action: 'change mode' },
    { key: newlineKey(getNewlineInstructions(runtimeState)), action: 'new line' },
    { key: 'esc esc', action: 'clear the prompt' },
    { key: formatHelpKey(stash, platform), action: 'set the prompt aside' },
    { key: formatHelpKey(externalEditor, platform), action: 'edit in your editor' },
    { key: formatHelpKey(undo, platform), action: 'undo' },
  ];
  const viewRows: Row[] = [
    { key: formatHelpKey(modelPicker, platform), action: 'switch model' },
    { key: formatHelpKey(imagePaste, platform), action: 'paste an image' },
    { key: formatHelpKey(transcript, platform), action: 'show details' },
    { key: formatHelpKey(todos, platform), action: 'show the to-do list' },
    ...(platform !== 'windows' ? [{ key: 'ctrl+z', action: 'suspend' }] : []),
  ];

  const footer = isKeybindingCustomizationEnabled() ? (
    <Text dimColor>/keybindings to change these keys</Text>
  ) : null;

  const editingKeyWidth = Math.max(...editingRows.map(row => row.key.length)) + 2;
  const viewKeyWidth = Math.max(...viewRows.map(row => row.key.length)) + 2;

  if (isNarrowLayout) {
    // Two short columns and a one-line prefix row keep the whole panel about
    // ten lines tall, so it fits under the prompt on an 80x24 terminal.
    return (
      <Box paddingX={paddingX} flexDirection="column" flexShrink={0}>
        <Text dimColor={dimColor}>/ commands   ! shell command   @ attach a file</Text>
        <Box flexDirection="row" gap={2} flexShrink={0}>
          <KeyRows rows={editingRows} dimColor={dimColor} keyWidth={editingKeyWidth} />
          <KeyRows rows={viewRows} dimColor={dimColor} keyWidth={viewKeyWidth} />
        </Box>
        {footer}
      </Box>
    );
  }
  return (
    <Box paddingX={paddingX} flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" gap={gap ?? 4} flexShrink={0}>
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>start with</Text>
          <KeyRows rows={prefixRows} dimColor={dimColor} keyWidth={3} />
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>keys</Text>
          <KeyRows rows={editingRows} dimColor={dimColor} keyWidth={editingKeyWidth} />
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor> </Text>
          <KeyRows rows={viewRows} dimColor={dimColor} keyWidth={viewKeyWidth} />
        </Box>
      </Box>
      {footer}
    </Box>
  );
}
