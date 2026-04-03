import { useCallback, useEffect, useMemo, useState } from 'react';
import { SimulationSetup, type SimulationSetupConfig } from './SimulationSetup';
import { SimulationViewer } from './SimulationViewer';
import type { SimulationRecord, SimulationSummary } from './useSimulation';
import type { SimulationWorkspaceRoute } from './navigation';

interface SimulationWorkspaceProps {
  bridgeUrl?: string;
  active?: boolean;
  route: SimulationWorkspaceRoute;
  onRouteChange: (route: SimulationWorkspaceRoute, options?: { replace?: boolean }) => void;
}

const ACTIVE_STATUSES = new Set(['launching', 'running', 'paused', 'stopping']);
const TERMINAL_STATUSES = new Set(['stopped', 'finished', 'failed', 'archived', 'deleted']);

const STATUS_STYLES: Record<string, string> = {
  launching: 'text-yellow-400 border-yellow-700',
  running: 'text-green-400 border-green-700',
  paused: 'text-amber-300 border-amber-700',
  stopping: 'text-orange-400 border-orange-700',
  stopped: 'text-green-600 border-green-900',
  finished: 'text-cyan-400 border-cyan-800',
  failed: 'text-red-400 border-red-700',
  archived: 'text-blue-400 border-blue-800',
  deleted: 'text-zinc-500 border-zinc-800',
};

export function SimulationWorkspace({
  bridgeUrl = 'http://localhost:3200',
  active = true,
  route,
  onRouteChange,
}: SimulationWorkspaceProps) {
  const [summaries, setSummaries] = useState<SimulationSummary[]>([]);
  const [summariesLoading, setSummariesLoading] = useState(false);
  const [summariesError, setSummariesError] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<SimulationRecord | null>(null);
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordMissing, setRecordMissing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const refreshSimulations = useCallback(async (signal?: AbortSignal) => {
    setSummariesLoading(true);
    try {
      const resp = await fetch(`${bridgeUrl}/simulations`, { signal });
      if (!resp.ok) {
        throw new Error(`Failed to load simulations: ${resp.status}`);
      }
      const payload = (await resp.json()) as { simulations?: SimulationSummary[] };
      setSummaries(payload.simulations ?? []);
      setSummariesError(null);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      setSummariesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) {
        setSummariesLoading(false);
      }
    }
  }, [bridgeUrl]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const controller = new AbortController();
    void refreshSimulations(controller.signal);
    const interval = setInterval(() => {
      void refreshSimulations(controller.signal);
    }, 5000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [active, refreshSimulations]);

  useEffect(() => {
    const simulationId = route.simulationId;
    if (!active || route.mode !== 'detail' || !simulationId) {
      setRecordLoading(false);
      setRecordError(null);
      setRecordMissing(false);
      return;
    }

    const controller = new AbortController();
    setRecordLoading(true);
    setRecordError(null);
    setRecordMissing(false);

    const loadRecord = async () => {
      try {
        const resp = await fetch(
          `${bridgeUrl}/simulations/${encodeURIComponent(simulationId)}`,
          { signal: controller.signal },
        );
        if (resp.status === 404) {
          setSelectedRecord(null);
          setRecordMissing(true);
          setRecordError(null);
          return;
        }
        if (!resp.ok) {
          throw new Error(`Failed to load simulation: ${resp.status}`);
        }
        const record = (await resp.json()) as SimulationRecord;
        setSelectedRecord(record);
        setRecordMissing(false);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setSelectedRecord(null);
        setRecordError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!controller.signal.aborted) {
          setRecordLoading(false);
        }
      }
    };

    void loadRecord();
    return () => controller.abort();
  }, [active, bridgeUrl, route.mode, route.simulationId]);

  const activeSimulations = useMemo(
    () => summaries.filter((simulation) => ACTIVE_STATUSES.has(simulation.status)),
    [summaries],
  );
  const recentSimulations = useMemo(
    () => summaries.filter((simulation) => TERMINAL_STATUSES.has(simulation.status)),
    [summaries],
  );
  const selectedSummary = useMemo(
    () => summaries.find((simulation) => simulation.simulation_id === route.simulationId) ?? null,
    [route.simulationId, summaries],
  );
  const detailRecord = selectedRecord && selectedRecord.simulation_id === route.simulationId
    ? selectedRecord
    : null;
  const noSimsYet = !summariesLoading && summaries.length === 0;

  const handleLaunch = useCallback(async (config: SimulationSetupConfig) => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const resp = await fetch(`${bridgeUrl}/simulations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          world_id: config.worldId,
          workspace_id: 'concordia-sim',
          agents: config.agents.map((agent) => ({
            agent_id: agent.id,
            agent_name: agent.name,
            personality: agent.personality,
            goal: agent.goal,
          })),
          premise: config.premise,
          max_steps: config.maxSteps,
          gm_model: config.gmModel,
          gm_provider: config.gmProvider,
          gm_instructions: config.gmInstructions,
          scenes: config.scenes.map((scene) => ({
            scene_id: scene.sceneId,
            name: scene.name,
            description: scene.description,
            num_rounds: scene.numRounds,
            zone_id: scene.zoneId || null,
            location_id: scene.locationId || null,
            time_of_day: scene.timeOfDay || null,
            day_index: scene.dayIndex,
            gm_instructions: scene.gmInstructions || null,
            world_events: scene.worldEvents.map((worldEvent) => ({
              event_id: worldEvent.eventId || undefined,
              summary: worldEvent.summary,
              observation: worldEvent.observation || null,
              trigger_round: worldEvent.triggerRound,
            })),
          })),
          engine_type: config.engineType,
        }),
      });

      if (!resp.ok) {
        throw new Error(`Setup failed: ${resp.status}`);
      }

      const payload = (await resp.json()) as { simulation_id: string };
      onRouteChange({ mode: 'detail', simulationId: payload.simulation_id });
      await refreshSimulations();
      await fetch(
        `${bridgeUrl}/simulations/${encodeURIComponent(payload.simulation_id)}/play`,
        { method: 'POST' },
      ).catch(() => {});
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setLaunching(false);
    }
  }, [bridgeUrl, onRouteChange, refreshSimulations]);

  const openDashboard = useCallback(() => {
    onRouteChange({ mode: 'dashboard', simulationId: route.simulationId });
  }, [onRouteChange, route.simulationId]);

  const openSetup = useCallback(() => {
    onRouteChange({ mode: 'setup', simulationId: route.simulationId });
  }, [onRouteChange, route.simulationId]);

  const openDetail = useCallback((simulationId: string) => {
    onRouteChange({ mode: 'detail', simulationId });
  }, [onRouteChange]);

  const clearMissingSelection = useCallback(() => {
    setSelectedRecord(null);
    setRecordMissing(false);
    onRouteChange({ mode: 'dashboard', simulationId: null });
  }, [onRouteChange]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-black text-green-400 font-mono">
      <div className="flex items-center gap-2 border-b border-green-800 px-3 py-2 text-sm">
        <span className="font-bold tracking-wider text-green-200">SIM WORKSPACE</span>
        <span className="text-green-800">|</span>
        <span className="text-green-600">{activeSimulations.length} active</span>
        <span className="text-green-800">|</span>
        <span className="text-green-600">{recentSimulations.length} recent</span>
        <button
          onClick={() => void refreshSimulations()}
          className="ml-auto border border-green-800 px-2 py-0.5 text-xs text-green-500 hover:bg-green-950"
          type="button"
        >
          Refresh Registry
        </button>
        <button
          onClick={openDashboard}
          className={`border px-2 py-0.5 text-xs ${route.mode === 'dashboard' ? 'border-green-400 text-green-200' : 'border-green-800 text-green-500 hover:bg-green-950'}`}
          type="button"
        >
          Dashboard
        </button>
        <button
          onClick={openSetup}
          className={`border px-2 py-0.5 text-xs ${route.mode === 'setup' ? 'border-green-400 text-green-200' : 'border-green-800 text-green-500 hover:bg-green-950'}`}
          type="button"
        >
          New Simulation
        </button>
      </div>

      <div className="min-h-8 border-b border-green-950 px-3 py-1 text-xs text-green-600">
        {launching && <span className="text-yellow-400">Launching simulation...</span>}
        {!launching && launchError && <span className="text-red-400">Launch failed: {launchError}</span>}
        {!launching && !launchError && summariesError && <span className="text-red-400">Registry refresh failed: {summariesError}</span>}
        {!launching && !launchError && !summariesError && route.mode === 'detail' && selectedSummary && (
          <span>
            Selected: {selectedSummary.world_id} ({selectedSummary.status})
          </span>
        )}
        {!launching && !launchError && !summariesError && route.mode !== 'detail' && (
          <span>
            Drafts persist across SIM tab switches and selection changes until this page reloads.
          </span>
        )}
      </div>

      <div className={route.mode === 'dashboard' ? 'flex-1 overflow-y-auto p-4' : 'hidden'}>
        <SimulationDashboardSection
          title="Active Sims"
          emptyLabel={noSimsYet ? 'No sims yet. Launch one to populate the dashboard.' : 'No active simulations.'}
          simulations={activeSimulations}
          loading={summariesLoading}
          onOpen={openDetail}
        />
        <SimulationDashboardSection
          title="Recent Sims"
          emptyLabel={noSimsYet ? 'Historical sims will appear here after the first run completes.' : 'No recent simulations yet.'}
          simulations={recentSimulations}
          loading={false}
          onOpen={openDetail}
        />
      </div>

      <div className={route.mode === 'setup' ? 'flex-1 overflow-hidden' : 'hidden'}>
        <SimulationSetup onLaunch={handleLaunch} loading={launching} bridgeUrl={bridgeUrl} />
      </div>

      <div className={route.mode === 'detail' ? 'flex min-h-0 flex-1 overflow-hidden' : 'hidden'}>
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-green-900 bg-black/80 p-3">
          <div className="mb-3 text-xs font-bold tracking-wider text-green-500">CURRENT SIMS</div>
          {summariesLoading && summaries.length === 0 && (
            <div className="text-xs text-green-700">Loading simulations...</div>
          )}
          {summaries.map((simulation) => (
            <SimulationSummaryCard
              key={simulation.simulation_id}
              simulation={simulation}
              compact
              selected={simulation.simulation_id === route.simulationId}
              onOpen={openDetail}
            />
          ))}
          {summaries.length === 0 && !summariesLoading && (
            <div className="text-xs text-green-700">No simulations available.</div>
          )}
        </aside>
        <div className="min-w-0 flex-1 overflow-hidden">
          {recordLoading && (
            <div className="flex h-full items-center justify-center text-sm text-yellow-400">
              Hydrating simulation detail...
            </div>
          )}
          {!recordLoading && recordMissing && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
              <div className="text-red-400">Simulation not found. It may have been deleted or the selected run no longer exists.</div>
              <button
                onClick={clearMissingSelection}
                className="border border-green-800 px-3 py-1 text-green-300 hover:bg-green-950"
                type="button"
              >
                Return to Dashboard
              </button>
            </div>
          )}
          {!recordLoading && !recordMissing && recordError && (
            <div className="flex h-full items-center justify-center text-sm text-red-400">
              Failed to load simulation detail: {recordError}
            </div>
          )}
          {!recordLoading && !recordMissing && !recordError && detailRecord && (
            <SimulationViewer
              active={active && route.mode === 'detail'}
              bridgeUrl={bridgeUrl}
              simulation={detailRecord}
              onBackToDashboard={openDashboard}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SimulationDashboardSection({
  title,
  emptyLabel,
  simulations,
  loading,
  onOpen,
}: {
  title: string;
  emptyLabel: string;
  simulations: SimulationSummary[];
  loading: boolean;
  onOpen: (simulationId: string) => void;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-green-500">
        <span>{title}</span>
        <span className="text-green-900">[{simulations.length}]</span>
      </div>
      {loading && simulations.length === 0 ? (
        <div className="border border-green-900 bg-black/70 p-4 text-sm text-green-700">
          Loading simulations...
        </div>
      ) : simulations.length === 0 ? (
        <div className="border border-green-900 bg-black/70 p-4 text-sm text-green-700">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {simulations.map((simulation) => (
            <SimulationSummaryCard
              key={simulation.simulation_id}
              simulation={simulation}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SimulationSummaryCard({
  simulation,
  onOpen,
  selected = false,
  compact = false,
}: {
  simulation: SimulationSummary;
  onOpen: (simulationId: string) => void;
  selected?: boolean;
  compact?: boolean;
}) {
  const statusStyle = STATUS_STYLES[simulation.status] ?? 'text-green-500 border-green-900';
  const timeLabel = new Date(simulation.updated_at).toLocaleTimeString();

  return (
    <button
      type="button"
      onClick={() => onOpen(simulation.simulation_id)}
      className={`w-full border p-3 text-left transition-colors hover:bg-green-950 ${selected ? 'border-green-400 bg-green-950/60' : 'border-green-900 bg-black/70'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-green-200">{simulation.world_id}</div>
          <div className="truncate text-[11px] text-green-700">{simulation.simulation_id}</div>
        </div>
        <span className={`shrink-0 border px-2 py-0.5 text-[10px] uppercase ${statusStyle}`}>
          {simulation.status}
        </span>
      </div>
      <div className={`mt-2 grid gap-1 ${compact ? 'text-[11px]' : 'text-xs'} text-green-500`}>
        <div>Agents: {simulation.agent_ids.length}</div>
        <div>Step: {simulation.last_completed_step}</div>
        <div>Updated: {timeLabel}</div>
        {simulation.error && (
          <div className="line-clamp-2 text-red-400">{simulation.error}</div>
        )}
        {!simulation.error && simulation.last_step_outcome && (
          <div className="line-clamp-2 text-green-700">Outcome: {simulation.last_step_outcome}</div>
        )}
      </div>
    </button>
  );
}
