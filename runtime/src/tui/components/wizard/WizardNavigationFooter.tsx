import React, { type ReactNode } from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/tui/hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { resolveAgenCTuiGlyphMode, selectAgenCTuiGlyphs } from '../../glyphs.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint';
import { Byline } from '../design-system/Byline';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint';
type Props = {
  instructions?: ReactNode;
};

export function getWizardNavigationShortcut(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  if (resolveAgenCTuiGlyphMode(env) === 'ascii') {
    return 'up/down';
  }
  const glyphs = selectAgenCTuiGlyphs(env);
  return `${glyphs.arrowUp}${glyphs.arrowDown}`;
}

export function getDefaultWizardNavigationInstructions(): ReactNode {
  return <Byline>
      <KeyboardShortcutHint shortcut={getWizardNavigationShortcut()} action="navigate" />
      <KeyboardShortcutHint shortcut="Enter" action="select" />
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
    </Byline>;
}

export function WizardNavigationFooter({
  instructions = getDefaultWizardNavigationInstructions()
}: Props): ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();
  return <Box marginLeft={3} marginTop={1}>
      <Text dimColor>
        {exitState.pending ? `Press ${exitState.keyName} again to exit` : instructions}
      </Text>
    </Box>;
}
