/**
 * Maps world_id to map asset paths.
 */

const BASE = import.meta.env.BASE_URL ?? '/';

interface MapConfig {
  mapJson: string;
  tilesetBase: string;
}

const SCENARIO_MAPS: Record<string, MapConfig> = {
  'medieval-town': {
    mapJson: `${BASE}assets/maps/medieval-town/medieval-town.json`,
    tilesetBase: `${BASE}assets/maps/medieval-town/`,
  },
  'trading-floor': {
    mapJson: `${BASE}assets/maps/trading-floor/trading-floor.json`,
    tilesetBase: `${BASE}assets/maps/trading-floor/`,
  },
  'research-lab': {
    mapJson: `${BASE}assets/maps/research-lab/research-lab.json`,
    tilesetBase: `${BASE}assets/maps/research-lab/`,
  },
};

const DEFAULT_MAP: MapConfig = {
  mapJson: `${BASE}assets/maps/default/default-town.json`,
  tilesetBase: `${BASE}assets/maps/default/`,
};

export function getMapConfig(worldId: string): MapConfig {
  if (SCENARIO_MAPS[worldId]) return SCENARIO_MAPS[worldId];
  const prefix = Object.keys(SCENARIO_MAPS).find((key) => worldId.startsWith(key));
  if (prefix) return SCENARIO_MAPS[prefix];
  return DEFAULT_MAP;
}

export function hasCustomMap(worldId: string): boolean {
  return worldId in SCENARIO_MAPS ||
    Object.keys(SCENARIO_MAPS).some((key) => worldId.startsWith(key));
}

export function getAvailableMapIds(): string[] {
  return Object.keys(SCENARIO_MAPS);
}
