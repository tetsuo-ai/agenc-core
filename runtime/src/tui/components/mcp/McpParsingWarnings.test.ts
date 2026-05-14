import { describe, expect, it } from 'vitest';

import { getMcpParsingWarningTreePrefix } from './McpParsingWarnings.js';

describe('McpParsingWarnings helpers', () => {
  it('uses ascii tree prefixes when requested', () => {
    expect(getMcpParsingWarningTreePrefix({ AGENC_TUI_GLYPHS: 'ascii' })).toBe('`- ');
  });

  it('keeps the unicode tree prefix in the default glyph mode', () => {
    expect(getMcpParsingWarningTreePrefix({})).toBe('└─ ');
  });
});
