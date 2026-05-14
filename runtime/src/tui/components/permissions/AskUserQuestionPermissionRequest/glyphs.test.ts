import { describe, expect, it } from 'vitest';

import { getPreviewBoxTruncationLabel, selectAskUserQuestionGlyphs } from './glyphs.js';

describe('AskUserQuestion glyph fallbacks', () => {
  it('uses unicode glyphs by default', () => {
    const glyphs = selectAskUserQuestionGlyphs();

    expect(glyphs.previewBox.topLeft).toBe('┌');
    expect(glyphs.previewBox.horizontal).toBe('─');
    expect(glyphs.truncationMarker).toBe('✂');
    expect(glyphs.statusSuccess).toBe('✓');
  });

  it('uses ascii glyphs when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' };
    const glyphs = selectAskUserQuestionGlyphs(env);

    expect(glyphs.previewBox.topLeft).toBe('+');
    expect(glyphs.previewBox.horizontal).toBe('-');
    expect(glyphs.checkboxOn).toBe('[x]');
    expect(glyphs.checkboxOff).toBe('[ ]');
    expect(glyphs.truncationMarker).toBe('cut');
    expect(getPreviewBoxTruncationLabel(4, env)).toBe('--- cut --- 4 lines hidden ');
  });
});
