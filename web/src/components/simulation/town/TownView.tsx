/**
 * Root layout for the town visualization.
 * Phase 4: replay scrubber, multiple maps.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentState, SimulationEvent } from '../useSimulation';
import { TownCanvas } from './TownCanvas';
import { useTownState } from './hooks/useTownState';
import { useViewport } from './hooks/useViewport';
import { loadTiledMap } from './maps/TiledMapLoader';
import { parseTiledMap } from './maps/TiledMapLoader';
import { createLocationRegistry, type LocationRegistryInstance } from './systems/LocationRegistry';
import { getMapConfig, hasCustomMap } from './config/ScenarioMapRegistry';
import { generateDefaultMap, extractDiscoveredLocations } from './config/DefaultMapConfig';
import { interpretEvents } from './systems/EventInterpreter';
import type { ParsedMap } from './maps/types';
import { EventTimeline } from '../EventTimeline';

interface TownViewProps {
  worldId: string;
  agentStates: Record<string, AgentState>;
  events: SimulationEvent[];
  onInspectAgent?: (agentId: string) => void;
}

export function TownView({ worldId, agentStates, events, onInspectAgent }: TownViewProps) {
  const [parsedMap, setParsedMap] = useState<ParsedMap | null>(null);
  const [registry, setRegistry] = useState<LocationRegistryInstance | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [replayStep, setReplayStep] = useState<number | null>(null);

  const { viewport, handlers, resetView } = useViewport(1);

  // Load map — use custom map if available, otherwise try default, and generate if default fails
  useEffect(() => {
    let cancelled = false;
    const config = getMapConfig(worldId);

    loadTiledMap(config.mapJson)
      .then((parsed) => {
        if (cancelled) return;

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
        if (cancelled) return;

        // If no custom map, generate one from discovered locations
        if (!hasCustomMap(worldId)) {
          const discoveredLocations = extractDiscoveredLocations(agentStates);
          if (discoveredLocations.length > 0) {
            const generatedJson = generateDefaultMap(discoveredLocations);
            const parsed = parseTiledMap(generatedJson);
            setParsedMap(parsed);
            const reg = createLocationRegistry(
              parsed.locationObjects,
              parsed.pixelWidth,
              parsed.pixelHeight,
            );
            setRegistry(reg);
            setMapError(null);
            return;
          }
        }

        setMapError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [worldId, agentStates]);

  const { agents, updatePositions } = useTownState(agentStates, registry);

  // Replay: filter events up to the replay step
  const displayEvents = useMemo(() => {
    if (replayStep === null) return events;
    return events.filter((e) => e.step <= replayStep);
  }, [events, replayStep]);

  const commands = useMemo(() => {
    const recent = displayEvents.slice(-10);
    return interpretEvents(recent);
  }, [displayEvents]);

  const timeOfDay = useMemo(() => {
    for (const state of Object.values(agentStates)) {
      const tod = state.worldProjection?.clock?.time_of_day;
      if (tod) return tod;
    }
    return null;
  }, [agentStates]);

  // Compute max step for replay scrubber
  const maxStep = useMemo(() => {
    let max = 0;
    for (const e of events) {
      if (e.step > max) max = e.step;
    }
    return max;
  }, [events]);

  const handlePositionsUpdate = useCallback(
    (positions: Map<string, { x: number; y: number; locationId: string | null }>) => {
      updatePositions(positions);
    },
    [updatePositions],
  );

  const handleAgentClick = useCallback(
    (agentId: string) => {
      onInspectAgent?.(agentId);
    },
    [onInspectAgent],
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Replay scrubber */}
      {maxStep > 0 && (
        <div className="flex items-center gap-2 border-b border-green-900 px-3 py-1">
          <span className="text-xs text-green-600 shrink-0">Replay</span>
          <input
            type="range"
            min={0}
            max={maxStep}
            value={replayStep ?? maxStep}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              setReplayStep(val === maxStep ? null : val);
            }}
            className="flex-1 accent-green-500"
          />
          <span className="text-xs text-green-400 tabular-nums w-16 text-right shrink-0">
            {replayStep !== null ? `${replayStep}/${maxStep}` : 'Live'}
          </span>
          {replayStep !== null && (
            <button
              onClick={() => setReplayStep(null)}
              className="text-xs text-green-500 border border-green-800 px-1.5 py-0.5 hover:bg-green-950"
              type="button"
            >
              Live
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex-1 min-h-0 min-w-0 bg-gray-950">
          {parsedMap ? (
            <TownCanvas
              parsedMap={parsedMap}
              agents={agents}
              agentStates={agentStates}
              commands={commands}
              viewport={viewport}
              timeOfDay={timeOfDay}
              onAgentPositionsUpdate={handlePositionsUpdate}
              onAgentClick={handleAgentClick}
              onWheel={handlers.onWheel}
              onPointerDown={handlers.onPointerDown}
              onPointerMove={handlers.onPointerMove}
              onPointerUp={handlers.onPointerUp}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-green-700 font-mono text-sm">
              Loading map...
            </div>
          )}
          <div className="absolute bottom-2 right-2 flex gap-1">
            <button
              onClick={resetView}
              className="border border-green-800 bg-black/70 px-2 py-0.5 text-xs text-green-400 hover:bg-green-950"
              type="button"
            >
              Reset
            </button>
            {timeOfDay && (
              <span className="border border-green-900 bg-black/70 px-2 py-0.5 text-xs text-green-600">
                {timeOfDay}
              </span>
            )}
          </div>
        </div>
        <div className="w-64 min-h-0 shrink-0 overflow-y-auto border-l border-green-800">
          <EventTimeline events={displayEvents} />
        </div>
      </div>
    </div>
  );
}
