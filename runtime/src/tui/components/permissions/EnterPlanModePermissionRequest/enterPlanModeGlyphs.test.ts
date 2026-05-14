import { describe, expect, it } from 'vitest';

import { getEnterPlanModeBulletPrefix } from './enterPlanModeGlyphs.js';

describe('getEnterPlanModeBulletPrefix', () => {
  it('uses the unicode separator by default', () => {
    expect(getEnterPlanModeBulletPrefix()).toBe(' · ');
  });

  it('uses the ascii separator when requested', () => {
    expect(getEnterPlanModeBulletPrefix({ AGENC_TUI_GLYPHS: 'ascii' })).toBe(
      ' - ',
    );
  });
});
