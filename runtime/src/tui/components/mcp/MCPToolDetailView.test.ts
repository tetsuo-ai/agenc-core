import { describe, expect, it } from 'vitest';

import {
  getMCPToolDetailDescriptionText,
  getMCPToolDetailParameterPrefix,
} from './MCPToolDetailView.js';

describe('MCPToolDetailView helpers', () => {
  it('shows a loading row while the async tool description is unresolved', () => {
    expect(getMCPToolDetailDescriptionText('loading', '', { AGENC_TUI_GLYPHS: 'ascii' })).toBe('Loading description...');
  });

  it('falls back when the async tool description is empty or failed', () => {
    expect(getMCPToolDetailDescriptionText('loaded', '')).toBe('No description available');
    expect(getMCPToolDetailDescriptionText('failed', 'Failed to load description')).toBe('Failed to load description');
  });

  it('uses ascii-safe parameter prefixes when requested', () => {
    expect(getMCPToolDetailParameterPrefix({ AGENC_TUI_GLYPHS: 'ascii' })).toBe('*');
    expect(getMCPToolDetailParameterPrefix({})).not.toBe('*');
  });
});
