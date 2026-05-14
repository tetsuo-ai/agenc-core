import { describe, expect, test } from 'vitest';

import {
  getAgentDetailIndentedValueColumns,
  getAgentDetailValueColumns,
} from './AgentDetail.layout.js';

describe('AgentDetail layout sizing', () => {
  test('keeps detail values inside terminal width', () => {
    expect(getAgentDetailValueColumns(120)).toBe(116);
    expect(getAgentDetailValueColumns(40)).toBe(36);
    expect(getAgentDetailValueColumns(4)).toBe(1);
    expect(getAgentDetailValueColumns(0)).toBe(1);
  });

  test('subtracts indentation without underflowing on tiny terminals', () => {
    expect(getAgentDetailIndentedValueColumns(40, 2)).toBe(34);
    expect(getAgentDetailIndentedValueColumns(40, 4)).toBe(32);
    expect(getAgentDetailIndentedValueColumns(4, 4)).toBe(1);
    expect(getAgentDetailIndentedValueColumns(0, 2)).toBe(1);
  });
});
