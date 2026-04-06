/**
 * Root layout for the town visualization.
 * Renders TownCanvas with agent overlay + event sidebar.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AgentState, SimulationEvent } from '../useSimulation';
import { TownCanvas } from './TownCanvas';
import { useTownState } from './hooks/useTownState';
import { loadTiledMap } from './maps/TiledMapLoader';
import { createLocationRegistry, type LocationRegistryInstance } from './systems/LocationRegistry';
import { getMapConfig } from './config/ScenarioMapRegistry';
import type { ParsedMap } from './maps/types';
import { EventTimeline } from '../EventTimeline';

interface TownViewProps {
  worldId: string;
  agentStates: Record<string, AgentState>;
  events: SimulationEvent[];
}

export function TownView({ worldId, agentStates, events }: TownViewProps) {
  const [parsedMap, setParsedMap] = useState<ParsedMap | null>(null);
  const [registry, setRegistry] = useState<LocationRegistryInstance | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const config = getMapConfig(worldId);

    loadTiledMap(config.mapJson)
      .then((parsed) => {
        if (cancelled) return;

        // Resolve tileset image paths relative to map base
        for (const ts of parsed.tilesets) {
          if (!ts.image.startsWith('/') && !ts.image.startsWith('http')) {
            ts.image = config.tilesetBase + ts.image;
          }
        }

        setParsedMap(parsed);
        const reg = createLocationRegistry(
          parsed.locationObjects,
          parsed.pixelWidth,
          parsed.pixelHeight,
        );
        setRegistry(reg);
        setMapError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setMapError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [worldId]);

  const { agents, updatePositions } = useTownState(agentStates, registry);

  const handlePositionsUpdate = useCallback(
    (positions: Map<string, { x: number; y: number; locationId: string | null }>) => {
      updatePositions(positions);
    },
    [updatePositions],
  );

  if (mapError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-yellow-400 font-mono text-sm">
        <div className="text-center">
          <div>Map loading failed</div>
          <div className="mt-1 text-xs text-yellow-600">{mapError}</div>
          <div className="mt-2 text-xs text-green-700">
            Ensure map assets exist at public/assets/maps/
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex-1 min-h-0 min-w-0 bg-gray-950">
        {parsedMap ? (
          <TownCanvas
            parsedMap={parsedMap}
            agents={agents}
            onAgentPositionsUpdate={handlePositionsUpdate}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-green-700 font-mono text-sm">
            Loading map...
          </div>
        )}
      </div>
      <div className="w-64 min-h-0 shrink-0 overflow-y-auto border-l border-green-800">
        <EventTimeline events={events} />
      </div>
    </div>
  );
}
