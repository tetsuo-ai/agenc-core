import type { ViewId } from '../../types';

export type SimulationWorkspaceMode = 'dashboard' | 'detail' | 'setup';

export interface SimulationWorkspaceRoute {
  mode: SimulationWorkspaceMode;
  simulationId: string | null;
}

export const DEFAULT_SIMULATION_ROUTE: SimulationWorkspaceRoute = {
  mode: 'dashboard',
  simulationId: null,
};

const VALID_VIEWS = new Set<ViewId>([
  'chat',
  'status',
  'marketplace',
  'tools',
  'runs',
  'observability',
  'skills',
  'tasks',
  'memory',
  'activity',
  'desktop',
  'settings',
  'payment',
  'simulation',
]);

const VALID_SIMULATION_MODES = new Set<SimulationWorkspaceMode>([
  'dashboard',
  'detail',
  'setup',
]);

export function normalizeSimulationRoute(
  route: Partial<SimulationWorkspaceRoute> | null | undefined,
): SimulationWorkspaceRoute {
  const simulationId = typeof route?.simulationId === 'string' && route.simulationId.length > 0
    ? route.simulationId
    : null;
  const mode = VALID_SIMULATION_MODES.has(route?.mode as SimulationWorkspaceMode)
    ? (route?.mode as SimulationWorkspaceMode)
    : simulationId
      ? 'detail'
      : 'dashboard';

  if (mode === 'detail' && simulationId === null) {
    return DEFAULT_SIMULATION_ROUTE;
  }

  return { mode, simulationId };
}

export function readViewFromUrl(locationLike: Pick<Location, 'search'>): ViewId {
  const params = new URLSearchParams(locationLike.search);
  const view = params.get('view');
  return VALID_VIEWS.has(view as ViewId) ? (view as ViewId) : 'chat';
}

export function readSimulationRouteFromUrl(
  locationLike: Pick<Location, 'search'>,
): SimulationWorkspaceRoute {
  const params = new URLSearchParams(locationLike.search);
  return normalizeSimulationRoute({
    mode: (params.get('simMode') ?? undefined) as SimulationWorkspaceMode | undefined,
    simulationId: params.get('simulationId'),
  });
}

export function writeAppNavigationToUrl(
  url: URL,
  view: ViewId,
  route: SimulationWorkspaceRoute,
): void {
  const normalizedRoute = normalizeSimulationRoute(route);
  url.searchParams.set('view', view);

  if (normalizedRoute.simulationId) {
    url.searchParams.set('simulationId', normalizedRoute.simulationId);
  } else {
    url.searchParams.delete('simulationId');
  }

  if (normalizedRoute.mode !== 'dashboard' || normalizedRoute.simulationId) {
    url.searchParams.set('simMode', normalizedRoute.mode);
  } else {
    url.searchParams.delete('simMode');
  }
}
