/**
 * Bridge useSimulation state → town visual agent positions.
 * Computes pixel positions from agentStates via LocationRegistry.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentState } from '../../useSimulation';
import type { LocationRegistryInstance } from '../systems/LocationRegistry';

export interface AgentVisualState {
  agentId: string;
  name: string;
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  locationId: string | null;
  color: number;
  moving: boolean;
  speedMultiplier: number;
}

/** Simple string hash for deterministic per-agent speed variation. */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const AGENT_COLORS = [
  0xe74c3c, // red
  0x3498db, // blue
  0x2ecc71, // green
  0xf39c12, // orange
  0x9b59b6, // purple
  0x1abc9c, // teal
  0xe67e22, // dark orange
  0x2980b9, // dark blue
  0x27ae60, // dark green
  0xc0392b, // dark red
];

function getAgentColor(index: number): number {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

export function computeAgentPositions(
  agentStates: Record<string, AgentState>,
  registry: LocationRegistryInstance | null,
  previousPositions: Map<string, { x: number; y: number; locationId: string | null }>,
): AgentVisualState[] {
  if (!registry) return [];

  const agents: AgentVisualState[] = [];
  let colorIndex = 0;

  for (const [agentId, state] of Object.entries(agentStates)) {
    const locationId = state.worldProjection?.active_location_id ?? null;
    const name = state.identity?.name ?? agentId;
    const prev = previousPositions.get(agentId);
    const target = registry.randomPointInRegion(
      locationId ?? '__fallback__',
    );

    const locationChanged = prev?.locationId !== locationId;

    agents.push({
      agentId,
      name,
      currentX: prev ? prev.x : target.x,
      currentY: prev ? prev.y : target.y,
      targetX: locationChanged ? target.x : (prev?.x ?? target.x),
      targetY: locationChanged ? target.y : (prev?.y ?? target.y),
      locationId,
      color: getAgentColor(colorIndex),
      moving: locationChanged && prev !== undefined,
      speedMultiplier: 0.85 + (hashCode(agentId) % 30) / 100,
    });

    colorIndex++;
  }

  return agents;
}

export function useTownState(
  agentStates: Record<string, AgentState>,
  registry: LocationRegistryInstance | null,
) {
  const [agents, setAgents] = useState<AgentVisualState[]>([]);
  const previousPositions = useRef(
    new Map<string, { x: number; y: number; locationId: string | null }>(),
  );

  // Stable target positions per location — only recompute random target on location change
  const stableTargets = useRef(new Map<string, { x: number; y: number }>());

  const agentCount = Object.keys(agentStates).length;
  const registryReady = registry !== null;

  useEffect(() => {
    if (!registry || agentCount === 0) {
      setAgents([]);
      return;
    }

    const result: AgentVisualState[] = [];
    let colorIndex = 0;

    for (const [agentId, state] of Object.entries(agentStates)) {
      const locationId = state.worldProjection?.active_location_id ?? null;
      const name = state.identity?.name ?? agentId;
      const prev = previousPositions.current.get(agentId);
      const locationChanged = prev?.locationId !== locationId;

      let targetX: number;
      let targetY: number;

      if (locationChanged || !stableTargets.current.has(agentId)) {
        const target = registry.randomPointInRegion(locationId ?? '__fallback__');
        targetX = target.x;
        targetY = target.y;
        stableTargets.current.set(agentId, { x: targetX, y: targetY });
      } else {
        const stable = stableTargets.current.get(agentId)!;
        targetX = stable.x;
        targetY = stable.y;
      }

      result.push({
        agentId,
        name,
        currentX: prev?.x ?? targetX,
        currentY: prev?.y ?? targetY,
        targetX,
        targetY,
        locationId,
        color: getAgentColor(colorIndex),
        moving: locationChanged && prev !== undefined,
        speedMultiplier: 0.85 + (hashCode(agentId) % 30) / 100,
      });

      colorIndex++;
    }

    setAgents(result);
  }, [agentStates, registry, agentCount, registryReady]);

  const updatePositions = useMemo(
    () => (positions: Map<string, { x: number; y: number; locationId: string | null }>) => {
      previousPositions.current = positions;
    },
    [],
  );

  return { agents, updatePositions };
}
