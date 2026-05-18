import { describe, expect, it } from 'vitest';

import {
  formatReviewStageCounts,
  getRemoteProgressGlyphText,
} from './RemoteSessionProgress.js';

describe('remote session progress glyph text', () => {
  it('uses unicode glyphs by default', () => {
    expect(getRemoteProgressGlyphText({})).toEqual({
      runningMarker: '◇',
      completeMarker: '◆',
      separator: '·',
      stageSeparator: ' · ',
      ellipsis: '…',
      viewShortcut: 'shift+↓',
    });
  });

  it('uses readable ascii glyphs when requested', () => {
    const glyphs = getRemoteProgressGlyphText({ AGENC_TUI_GLYPHS: 'ascii' });
    expect(glyphs).toEqual({
      runningMarker: '<>',
      completeMarker: '*',
      separator: '-',
      stageSeparator: ' - ',
      ellipsis: '...',
      viewShortcut: 'shift + down',
    });
    expect(formatReviewStageCounts('verifying', 3, 2, 1, glyphs.stageSeparator))
      .toBe('3 found - 2 verified - 1 refuted');
  });
});
