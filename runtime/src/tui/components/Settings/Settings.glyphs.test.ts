import { describe, expect, test } from 'vitest';

import { getSettingsConfigGlyphLabels } from './glyphs.js';

describe('Settings config glyph labels', () => {
  test('uses ASCII-safe labels when ASCII glyph mode is requested', () => {
    expect(getSettingsConfigGlyphLabels({ AGENC_TUI_GLYPHS: 'ascii' })).toEqual({
      searchPlaceholder: 'Search settings...',
      scrollUpPrefix: '^',
      scrollDownPrefix: 'v',
      pointer: '>',
      switchTabsShortcut: 'left/right tab',
      returnShortcut: 'down',
      selectShortcut: 'Enter/down',
      tabsShortcut: 'up',
    });
  });

  test('preserves Unicode labels by default', () => {
    const labels = getSettingsConfigGlyphLabels({});

    expect(labels.searchPlaceholder).toBe('Search settings…');
    expect(labels.scrollUpPrefix).not.toBe('^');
    expect(labels.scrollDownPrefix).not.toBe('v');
    expect(labels.pointer).not.toBe('>');
    expect(labels.switchTabsShortcut).toContain('tab');
  });
});
