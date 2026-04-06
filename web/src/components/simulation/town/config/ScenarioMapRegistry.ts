/**
 * Maps world_id to map asset paths.
 */

interface MapConfig {
  mapJson: string;
  tilesetBase: string;
}

const SCENARIO_MAPS: Record<string, MapConfig> = {
  'medieval-town': {
    mapJson: '/assets/maps/medieval-town/medieval-town.json',
    tilesetBase: '/assets/maps/medieval-town/',
  },
};

const DEFAULT_MAP: MapConfig = {
  mapJson: '/assets/maps/default/default-town.json',
  tilesetBase: '/assets/maps/default/',
};

export function getMapConfig(worldId: string): MapConfig {
  return SCENARIO_MAPS[worldId] ?? DEFAULT_MAP;
}

export function hasCustomMap(worldId: string): boolean {
  return worldId in SCENARIO_MAPS;
}
