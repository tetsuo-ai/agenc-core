import { describe, expect, test } from 'vitest';

import {
  calculateSettingsConfigMaxVisible,
  calculateSettingsContentHeight,
} from './layout.js';

describe('Settings layout sizing', () => {
  test('clamps settings content height to modal rows', () => {
    expect(calculateSettingsContentHeight(30, true)).toBe(30);
    expect(calculateSettingsContentHeight(3, true)).toBe(3);
    expect(calculateSettingsContentHeight(0, true)).toBe(1);
  });

  test('keeps normal settings content inside tiny and large terminals', () => {
    expect(calculateSettingsContentHeight(100, false)).toBe(30);
    expect(calculateSettingsContentHeight(24, false)).toBe(19);
    expect(calculateSettingsContentHeight(8, false)).toBe(8);
    expect(calculateSettingsContentHeight(0, false)).toBe(1);
  });

  test('clamps config visible rows to the available pane', () => {
    expect(calculateSettingsConfigMaxVisible(30)).toBe(20);
    expect(calculateSettingsConfigMaxVisible(15)).toBe(5);
    expect(calculateSettingsConfigMaxVisible(12)).toBe(2);
    expect(calculateSettingsConfigMaxVisible(8)).toBe(1);
    expect(calculateSettingsConfigMaxVisible(0)).toBe(1);
  });
});
