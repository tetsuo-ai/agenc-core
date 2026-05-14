import { describe, expect, test } from 'vitest';

import { getWizardNavigationShortcut } from './WizardNavigationFooter.js';

describe('WizardNavigationFooter glyphs', () => {
  test('uses ASCII-safe navigation text in ASCII glyph mode', () => {
    expect(getWizardNavigationShortcut({ AGENC_TUI_GLYPHS: 'ascii' })).toBe(
      'up/down',
    );
  });

  test('preserves Unicode navigation arrows by default', () => {
    expect(getWizardNavigationShortcut({})).toBe('↑↓');
  });
});
