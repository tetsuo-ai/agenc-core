import { describe, expect, it } from 'vitest';

import { getPlanApprovalResponseTitle } from './PlanApprovalMessage.js';

describe('PlanApprovalMessage glyph fallbacks', () => {
  it('uses shared status glyphs for approval response titles', () => {
    expect(getPlanApprovalResponseTitle(true, 'agent-a')).toBe('✓ Plan Approved by agent-a');
    expect(getPlanApprovalResponseTitle(false, 'agent-b')).toBe('✗ Plan Rejected by agent-b');
  });

  it('uses ascii status labels when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' };

    expect(getPlanApprovalResponseTitle(true, 'agent-a', env)).toBe('OK Plan Approved by agent-a');
    expect(getPlanApprovalResponseTitle(false, 'agent-b', env)).toBe('ERR Plan Rejected by agent-b');
  });
});
