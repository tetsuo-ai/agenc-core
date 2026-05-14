import { describe, expect, it } from 'vitest';

import { AGENT_MESSAGE_THEME_COLOR } from './agentMessageTheme.js';

describe('agent message theme token', () => {
  it('uses a current AgenC theme token for agent message rows', () => {
    expect(AGENT_MESSAGE_THEME_COLOR).toBe('suggestion');
  });
});
