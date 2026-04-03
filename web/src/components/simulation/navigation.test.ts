import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMULATION_ROUTE,
  normalizeSimulationRoute,
  readSimulationRouteFromUrl,
  readViewFromUrl,
  writeAppNavigationToUrl,
} from './navigation';

describe('simulation navigation helpers', () => {
  it('defaults to chat/dashboard when no query parameters are present', () => {
    expect(readViewFromUrl({ search: '' })).toBe('chat');
    expect(readSimulationRouteFromUrl({ search: '' })).toEqual(DEFAULT_SIMULATION_ROUTE);
  });

  it('parses deep-linked simulation detail state from the URL', () => {
    expect(
      readSimulationRouteFromUrl({
        search: '?view=simulation&simMode=detail&simulationId=sim-42',
      }),
    ).toEqual({ mode: 'detail', simulationId: 'sim-42' });
    expect(readViewFromUrl({ search: '?view=simulation' })).toBe('simulation');
  });

  it('normalizes invalid detail routes back to the dashboard', () => {
    expect(normalizeSimulationRoute({ mode: 'detail', simulationId: null })).toEqual(
      DEFAULT_SIMULATION_ROUTE,
    );
  });

  it('writes view and simulation route state back into the URL', () => {
    const url = new URL('http://localhost:3100/?view=chat');
    writeAppNavigationToUrl(url, 'simulation', { mode: 'detail', simulationId: 'sim-99' });

    expect(url.searchParams.get('view')).toBe('simulation');
    expect(url.searchParams.get('simMode')).toBe('detail');
    expect(url.searchParams.get('simulationId')).toBe('sim-99');
  });
});
