import { describe, expect, test } from 'vitest';

import {
  getAgentCloseFooterInstructions,
  getAgentDeleteFooterInstructions,
  getAgentNavigationFooterInstructions,
} from './AgentNavigationFooter.js';

describe('AgentNavigationFooter instructions', () => {
  test('uses ASCII-safe navigation instructions in ASCII glyph mode', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' };

    expect(getAgentNavigationFooterInstructions(env)).toBe(
      'Press up/down to navigate - Enter to select - Esc to go back',
    );
    expect(getAgentCloseFooterInstructions(env)).toBe(
      'Press up/down to navigate - Enter to select - Esc to close',
    );
    expect(getAgentDeleteFooterInstructions(env)).toBe(
      'Press up/down to navigate, Enter to select, Esc to cancel',
    );
  });

  test('preserves Unicode navigation instructions by default', () => {
    expect(getAgentNavigationFooterInstructions({})).toContain('↑↓');
    expect(getAgentNavigationFooterInstructions({})).toContain('·');
    expect(getAgentCloseFooterInstructions({})).toContain('Esc to close');
    expect(getAgentDeleteFooterInstructions({})).toContain('↑↓');
  });
});
