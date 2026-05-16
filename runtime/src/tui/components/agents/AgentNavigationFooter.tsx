import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/tui/hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { resolveAgenCTuiGlyphMode, selectAgenCTuiGlyphs } from '../../glyphs.js';
type Props = {
  instructions?: string;
};
export function getAgentNavigationFooterInstructions(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAgenCTuiGlyphs(env);
  if (resolveAgenCTuiGlyphMode(env) === 'ascii') {
    return 'Press up/down to navigate - Enter to select - Esc to go back';
  }
  return `Press ${glyphs.arrowUp}${glyphs.arrowDown} to navigate ${glyphs.separator} Enter to select ${glyphs.separator} Esc to go back`;
}
export function getAgentCloseFooterInstructions(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAgenCTuiGlyphs(env);
  if (resolveAgenCTuiGlyphMode(env) === 'ascii') {
    return 'Press up/down to navigate - Enter to select - Esc to close';
  }
  return `Press ${glyphs.arrowUp}${glyphs.arrowDown} to navigate ${glyphs.separator} Enter to select ${glyphs.separator} Esc to close`;
}
export function getAgentDeleteFooterInstructions(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAgenCTuiGlyphs(env);
  if (resolveAgenCTuiGlyphMode(env) === 'ascii') {
    return 'Press up/down to navigate, Enter to select, Esc to cancel';
  }
  return `Press ${glyphs.arrowUp}${glyphs.arrowDown} to navigate, Enter to select, Esc to cancel`;
}
export function AgentNavigationFooter(t0: Props): React.ReactNode {
  const $ = _c(2);
  const {
    instructions: t1
  } = t0;
  const instructions = t1 === undefined ? getAgentNavigationFooterInstructions() : t1;
  const exitState = useExitOnCtrlCDWithKeybindings();
  const t2 = exitState.pending ? `Press ${exitState.keyName} again to exit` : instructions;
  let t3;
  if ($[0] !== t2) {
    t3 = <Box marginLeft={2}><Text dimColor={true}>{t2}</Text></Box>;
    $[0] = t2;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  return t3;
}
