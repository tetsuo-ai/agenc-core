import React from 'react';
import { describe, expect, test } from 'vitest';

import { renderToString } from '../../../utils/staticRender.js';
import { SettingsConfigLoadingState } from './LoadingState.js';

describe('Settings loading states', () => {
  test('renders visible config loading text while Config is suspended', async () => {
    const output = await renderToString(<SettingsConfigLoadingState />, 80);

    expect(output).toContain('Loading settings...');
  });
});
