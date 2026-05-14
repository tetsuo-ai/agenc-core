import { describe, expect, it } from 'vitest';

import { getPermissionPromptFooterText } from './permissionPromptFooter.js';

describe('getPermissionPromptFooterText', () => {
  it('renders the base cancel hint without optional actions', () => {
    expect(getPermissionPromptFooterText(false)).toBe('Esc to cancel');
  });

  it('uses the unicode separator by default', () => {
    expect(getPermissionPromptFooterText(true)).toBe(
      'Esc to cancel · Tab to amend',
    );
  });

  it('uses the ascii separator when requested', () => {
    expect(
      getPermissionPromptFooterText(true, { AGENC_TUI_GLYPHS: 'ascii' }),
    ).toBe('Esc to cancel - Tab to amend');
  });
});
