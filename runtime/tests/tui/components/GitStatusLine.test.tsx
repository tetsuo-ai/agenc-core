import React from 'react';
import { describe, expect, it } from 'vitest';
import { GitStatusLine, formatGitStatus } from '../../../src/tui/components/GitStatusLine.js';
import { renderToString } from '../../../src/utils/staticRender.js';
import { stringWidth } from '../../../src/tui/ink/stringWidth.js';

const clean = { branch: 'main', changed: 0, ahead: 0, behind: 0 };
const dirty = { ...clean, changed: 3, ahead: 1, behind: 2 };
describe('composer git status line', () => {
  it.each([
    [80, dirty, '⎇ main · 3 changed · ↑1 ↓2'],
    [24, dirty, '⎇ main · 3 changed'],
    [12, dirty, '⎇ main'],
    [80, clean, '⎇ main'],
    [80, { ...clean, ahead: 1 }, '⎇ main · ↑1'],
    [80, { ...clean, behind: 2 }, '⎇ main · ↓2'],
    [80, { ...clean, branch: 'abcdef1' }, '⎇ abcdef1'],
    [80, null, ''],
  ])('renders one right-aligned row at width %i', async (columns, status, expected) => {
    const output = await renderToString(<GitStatusLine status={status} columns={columns} />, columns);
    expect(output.trim()).toBe(expected);
    if (expected) {
      expect(output.split('\n')).toHaveLength(1);
      expect(output.trimEnd()).toBe(expected.padStart(columns - 2));
    }
  });
  it('drops facts before truncating the branch in the middle and respects tiny and Unicode widths', () => {
    expect(formatGitStatus({ ...dirty, branch: 'feature/long-name' }, 12, 'Y')).toBe('Y featu…name');
    for (const columns of [0, 1, 2, 3, 4, 8, 16, 24]) {
      expect(stringWidth(formatGitStatus({ ...dirty, branch: '分支/long/🦀/end' }, columns, '⎇'))).toBeLessThanOrEqual(columns);
    }
    expect(formatGitStatus(clean, 80, 'Y')).toBe('Y main');
  });
});
