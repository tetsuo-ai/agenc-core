/**
 * Simulation detail view — one bridge-backed simulation record.
 */

import { useMemo, useState } from 'react';
import { useSimulation, type SimulationRecord, type SimulationStatus } from './useSimulation';
import { SimulationControls } from './SimulationControls';
import { AgentCard } from './AgentCard';
import { EventTimeline } from './EventTimeline';
import { WorldStatePanel } from './WorldStatePanel';
import { AgentInspector } from './AgentInspector';
import { TownView } from './town/TownView';

type ViewMode = 'timeline' | 'town';

interface SimulationViewerProps {
  bridgeUrl?: string;
  simulation: SimulationRecord;
  active?: boolean;
  onBackToDashboard?: () => void;
}

const TERMINAL_STATUSES = new Set(['stopped', 'finished', 'failed', 'archived', 'deleted']);

export function SimulationViewer({
  bridgeUrl = 'http://localhost:3200',
  simulation,
  active = true,
  onBackToDashboard,
}: SimulationViewerProps) {
  const [inspectedAgent, setInspectedAgent] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('town');
  const initialStatus = useMemo(() => buildSimulationStatus(simulation), [simulation]);
  const { state, play, pause, step, stop } = useSimulation({
    simulationId: simulation.simulation_id,
    bridgeUrl,
    agentIds: simulation.agent_ids,
    pollIntervalMs: active ? 750 : 3000,
    active,
    initialStatus,
  });

  const displayStatus = useMemo(
    () => buildDisplayStatus(simulation, state.status),
    [simulation, state.status],
  );
  const historicalMode = TERMINAL_STATUSES.has(displayStatus.status);
  const inspected = inspectedAgent && state.agentStates[inspectedAgent]
    ? state.agentStates[inspectedAgent]
    : null;
  const identityLabel = simulation.lineage_id
    ? 'Lineage ' + simulation.lineage_id.slice(0, 8)
    : 'Standalone run';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-black text-green-400 font-mono">
      <SimulationControls
        status={displayStatus}
        onPlay={play}
        onPause={pause}
        onStep={step}
        onStop={stop}
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-green-900 px-3 py-1 text-xs text-green-600">
        <span className="text-green-300">{simulation.world_id}</span>
        <span className="text-green-800">|</span>
        <span>{simulation.agents.length} agents</span>
        <span className="text-green-800">|</span>
        <span>{identityLabel}</span>
        {simulation.gm_model && (
          <>
            <span className="text-green-800">|</span>
            <span>GM {simulation.gm_model}</span>
          </>
        )}
        {simulation.gm_provider && (
          <>
            <span className="text-green-800">|</span>
            <span>{simulation.gm_provider}</span>
          </>
        )}
        {simulation.max_steps !== null && (
          <>
            <span className="text-green-800">|</span>
            <span>Max {simulation.max_steps}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setViewMode(viewMode === 'timeline' ? 'town' : 'timeline')}
            className="border border-green-700 px-2 py-0.5 text-green-300 hover:bg-green-950"
            type="button"
          >
            {viewMode === 'timeline' ? 'Town View' : 'Timeline'}
          </button>
          {onBackToDashboard && (
            <button
              onClick={onBackToDashboard}
              className="border border-green-800 px-2 py-0.5 text-green-300 hover:bg-green-950"
              type="button"
            >
              Back to Dashboard
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-green-950 px-3 py-1 text-xs">
        <StatePill label={displayStatus.status.toUpperCase()} tone={historicalMode ? 'muted' : 'live'} />
        {displayStatus.status === 'launching' && <StatePill label="launching" tone="warn" />}
        {displayStatus.execution_phase && displayStatus.execution_phase !== 'idle' && (
          <StatePill
            label={displayStatus.execution_phase.replace(/_/g, ' ')}
            tone={
              displayStatus.execution_phase === 'stopped'
                ? 'muted'
                : displayStatus.execution_phase === 'step_complete'
                  ? 'live'
                  : 'warn'
            }
          />
        )}
        {state.transportState === 'replay-hydrating' && <StatePill label="replay-hydrating" tone="warn" />}
        {state.transportState === 'reconnecting' && <StatePill label="reconnecting" tone="warn" />}
        {state.transportState === 'disconnected' && !historicalMode && <StatePill label="disconnected" tone="error" />}
        {state.notFound && <StatePill label="sim not found" tone="error" />}
        {displayStatus.status === 'failed' && <StatePill label="failed sim" tone="error" />}
        {historicalMode && <StatePill label="historical detail" tone="muted" />}
        {displayStatus.checkpoint && (
          <StatePill
            label={'checkpoint ' + String(displayStatus.checkpoint.runtime_cursor.current_step)}
            tone="muted"
          />
        )}
        {state.error && (
          <span className="text-red-400">control failure: {state.error}</span>
        )}
      </div>

      {viewMode === 'town' ? (
        <TownView
          worldId={simulation.world_id}
          agentStates={state.agentStates}
          events={state.events}
          onInspectAgent={setInspectedAgent}
        />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 w-64 shrink-0 overflow-y-auto border-r border-green-800 p-2 xl:w-72">
            <div className="mb-2 text-xs font-bold tracking-wider text-green-600">
              AGENTS ({Object.keys(state.agentStates).length || simulation.agent_ids.length})
            </div>
            {Object.entries(state.agentStates).map(([id, agentState]) => (
              <div
                key={id}
                onClick={() => setInspectedAgent(id)}
                className="cursor-pointer"
              >
                <AgentCard agentId={id} agent={agentState} />
              </div>
            ))}
            {Object.keys(state.agentStates).length === 0 && simulation.agent_ids.length > 0 && (
              <div className="p-2 text-xs text-green-800">
                {state.transportState === 'replay-hydrating' ? 'Hydrating agent state...' : 'Waiting for agent data...'}
                <div className="mt-1 text-green-900">
                  Agents: {simulation.agent_ids.join(', ')}
                </div>
              </div>
            )}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <EventTimeline events={state.events} />
          </div>
        </div>
      )}

      <WorldStatePanel
        agentStates={state.agentStates}
        worldId={displayStatus.world_id || simulation.world_id}
      />

      {inspected && inspectedAgent && (
        <AgentInspector
          agentId={inspectedAgent}
          agent={inspected}
          onClose={() => setInspectedAgent(null)}
        />
      )}
    </div>
  );
}

function buildDisplayStatus(
  simulation: SimulationRecord,
  liveStatus: SimulationStatus,
): SimulationStatus {
  if (liveStatus.simulation_id === simulation.simulation_id) {
    return liveStatus;
  }
  return buildSimulationStatus(simulation);
}

function buildSimulationStatus(simulation: SimulationRecord): SimulationStatus {
  return {
    simulation_id: simulation.simulation_id,
    world_id: simulation.world_id,
    workspace_id: simulation.workspace_id,
    status: simulation.status,
    execution_phase: simulation.execution_phase ?? null,
    reason: simulation.reason,
    error: simulation.error,
    step: simulation.last_completed_step,
    max_steps: simulation.max_steps,
    running: simulation.status === 'running',
    paused: simulation.status === 'paused',
    agent_count: simulation.agent_ids.length,
    started_at: simulation.started_at,
    ended_at: simulation.ended_at,
    updated_at: simulation.updated_at,
    last_step_outcome: simulation.last_step_outcome,
    terminal_reason: simulation.reason,
    checkpoint: simulation.checkpoint,
  };
}

function StatePill({
  label,
  tone,
}: {
  label: string;
  tone: 'live' | 'warn' | 'error' | 'muted';
}) {
  const className = {
    live: 'border-green-700 text-green-300',
    warn: 'border-yellow-700 text-yellow-300',
    error: 'border-red-700 text-red-300',
    muted: 'border-green-900 text-green-600',
  }[tone];

  return <span className={'border px-2 py-0.5 uppercase ' + className}>{label}</span>;
}
