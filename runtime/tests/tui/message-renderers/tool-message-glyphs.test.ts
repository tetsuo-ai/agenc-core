import { describe, expect, it } from 'vitest';

import { getCollapseReadSearchEllipsis, getSearchReadSummaryText } from '../../utils/collapseReadSearch.js';
import { getAssistantToolUsePendingText } from './AssistantToolUseMessage.js';
import {
  getHookProgressRunningLabel,
  getHookProgressTranscriptRunningLabel,
} from './HookProgressMessage.js';

describe('tool message glyph fallbacks', () => {
  it('uses ascii ellipses for assistant tool pending labels when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' };

    expect(getAssistantToolUsePendingText('permission', env)).toBe('Waiting for permission...');
    expect(getAssistantToolUsePendingText('auto-classifier', env)).toBe('Auto classifier checking...');
    expect(getAssistantToolUsePendingText('bash-classifier', env)).toBe('Bash classifier checking...');
  });

  it('uses ascii ellipses for hook progress labels when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' };

    expect(getHookProgressRunningLabel(1, env)).toBe(' hook...');
    expect(getHookProgressRunningLabel(2, env)).toBe(' hooks...');
  });

  it('uses running wording for transcript hook progress labels', () => {
    expect(getHookProgressTranscriptRunningLabel(1)).toBe(' hook running');
    expect(getHookProgressTranscriptRunningLabel(2)).toBe(' hooks running');
  });

  it('uses ascii ellipses for collapsed active summaries when requested', () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS;
    process.env.AGENC_TUI_GLYPHS = 'ascii';

    try {
      expect(getCollapseReadSearchEllipsis({ AGENC_TUI_GLYPHS: 'ascii' })).toBe('...');
      expect(getSearchReadSummaryText(2, 1, true)).toBe('Searching for 2 patterns, reading 1 file...');
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS;
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode;
      }
    }
  });
});
