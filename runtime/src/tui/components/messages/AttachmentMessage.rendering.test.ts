import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getSelectedLinesAttachmentPrefix } from './AttachmentMessage.js';

describe('AttachmentMessage rendering helpers', () => {
  it('uses an ascii selected-lines prefix when requested', () => {
    expect(getSelectedLinesAttachmentPrefix({ AGENC_TUI_GLYPHS: 'ascii' })).toBe('[]');
    expect(getSelectedLinesAttachmentPrefix({})).toBe('⧉');
  });

  it('does not keep the dead killed task-status branch', () => {
    const source = readFileSync('src/tui/components/messages/AttachmentMessage.tsx', 'utf8');

    expect(source).not.toContain('false && attachment.status === "killed"');
  });
});
