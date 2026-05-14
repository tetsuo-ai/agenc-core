import { resolveAgenCTuiGlyphMode, selectAgenCTuiGlyphs } from '../../glyphs.js';

export function getSettingsConfigGlyphLabels(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): {
  searchPlaceholder: string;
  scrollUpPrefix: string;
  scrollDownPrefix: string;
  pointer: string;
  switchTabsShortcut: string;
  returnShortcut: string;
  selectShortcut: string;
  tabsShortcut: string;
} {
  const glyphs = selectAgenCTuiGlyphs(env);
  const useAsciiLabels = resolveAgenCTuiGlyphMode(env) === 'ascii';
  return {
    searchPlaceholder: `Search settings${glyphs.ellipsis}`,
    scrollUpPrefix: glyphs.arrowUp,
    scrollDownPrefix: glyphs.arrowDown,
    pointer: glyphs.pointer,
    switchTabsShortcut: useAsciiLabels ? 'left/right tab' : `${glyphs.arrowLeft}/${glyphs.arrowRight} tab`,
    returnShortcut: useAsciiLabels ? 'down' : glyphs.arrowDown,
    selectShortcut: useAsciiLabels ? 'Enter/down' : `Enter/${glyphs.arrowDown}`,
    tabsShortcut: useAsciiLabels ? 'up' : glyphs.arrowUp,
  };
}
