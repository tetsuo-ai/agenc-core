import { describe, expect, it } from 'vitest';

import { getBashPermissionFooterText } from './bashPermissionFooter.js';

describe('getBashPermissionFooterText', () => {
  it('uses the shared unicode separator by default', () => {
    expect(getBashPermissionFooterText({
      focusedOption: 'yes',
      yesInputMode: false,
      noInputMode: false,
      explainerEnabled: true,
      explainerVisible: false,
    })).toBe('Esc to cancel · Tab to amend · ctrl+e to explain');
  });

  it('uses the ascii separator when requested', () => {
    expect(getBashPermissionFooterText({
      focusedOption: 'no',
      yesInputMode: false,
      noInputMode: false,
      explainerEnabled: true,
      explainerVisible: true,
    }, { AGENC_TUI_GLYPHS: 'ascii' })).toBe('Esc to cancel - Tab to amend - ctrl+e to hide');
  });

  it('omits optional actions when unavailable', () => {
    expect(getBashPermissionFooterText({
      focusedOption: 'yes',
      yesInputMode: true,
      noInputMode: false,
      explainerEnabled: false,
      explainerVisible: false,
    })).toBe('Esc to cancel');
  });
});
