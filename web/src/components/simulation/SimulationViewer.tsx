/**
 * Main simulation viewer — setup → running → inspect flow.
 *
 * States:
 * 1. SETUP: Configure world, agents, GM — pick preset or build custom
 * 2. RUNNING: Live event timeline, agent cards, controls, world state
 * 3. INSPECT: Click an agent card to deep-dive into memory/beliefs
 */

import { useState, useCallback, useEffect } from "react";
import { useSimulation } from "./useSimulation";
import { SimulationSetup, type SimulationSetupConfig } from "./SimulationSetup";
import { SimulationControls } from "./SimulationControls";
import { AgentCard } from "./AgentCard";
import { EventTimeline } from "./EventTimeline";
import { WorldStatePanel } from "./WorldStatePanel";
import { AgentInspector } from "./AgentInspector";

type SimPhase = "setup" | "running" | "finished";

interface SimulationViewerProps {
  eventWsUrl?: string;
  bridgeUrl?: string;
  controlUrl?: string;
  agentIds?: string[];
}

export function SimulationViewer({
  eventWsUrl = "ws://localhost:3201",
  bridgeUrl = "http://localhost:3200",
  controlUrl = "http://localhost:3202",
  agentIds: initialAgentIds = [],
}: SimulationViewerProps) {
  const [phase, setPhase] = useState<SimPhase>("setup");
  const [agentIds, setAgentIds] = useState<string[]>(initialAgentIds);
  const [launching, setLaunching] = useState(false);
  const [inspectedAgent, setInspectedAgent] = useState<string | null>(null);
  const [launchConfig, setLaunchConfig] = useState<SimulationSetupConfig | null>(null);

  const { state, play, pause, step, stop } = useSimulation({
    eventWsUrl,
    bridgeUrl,
    controlUrl,
    agentIds,
    pollIntervalMs: phase === "running" ? 2000 : 10000,
  });

  const handleLaunch = useCallback(
    async (config: SimulationSetupConfig) => {
      setLaunching(true);
      setLaunchConfig(config);
      try {
        // POST to bridge /setup
        const resp = await fetch(`${bridgeUrl}/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            world_id: config.worldId,
            workspace_id: "concordia-sim",
            agents: config.agents.map((a) => ({
              agent_id: a.id,
              agent_name: a.name,
              personality: a.personality,
              goal: a.goal,
            })),
            premise: config.premise,
            max_steps: config.maxSteps,
            gm_model: config.gmModel,
            gm_provider: config.gmProvider,
          }),
        });

        if (!resp.ok) {
          throw new Error(`Setup failed: ${resp.status}`);
        }

        setAgentIds(config.agents.map((a) => a.id));
        setPhase("running");

        // Auto-play
        await fetch(`${controlUrl}/simulation/play`, { method: "POST" }).catch(
          () => {},
        );
      } catch (err) {
        console.error("Launch failed:", err);
        alert(`Failed to launch simulation: ${err}`);
      } finally {
        setLaunching(false);
      }
    },
    [bridgeUrl, controlUrl],
  );

  const handleStop = useCallback(async () => {
    await stop();
    setPhase("finished");
  }, [stop]);

  // Auto-finish detection: when simulation stops running after having started
  useEffect(() => {
    if (phase === "running" && !state.status.running && state.status.step > 0) {
      setPhase("finished");
    }
  }, [phase, state.status.running, state.status.step]);

  const handleNewSimulation = useCallback(() => {
    setPhase("setup");
    setAgentIds([]);
    setLaunchConfig(null);
    setInspectedAgent(null);
  }, []);

  // ========================================================================
  // SETUP phase
  // ========================================================================
  if (phase === "setup") {
    return <SimulationSetup onLaunch={handleLaunch} loading={launching} bridgeUrl={bridgeUrl} />;
  }

  // ========================================================================
  // RUNNING / FINISHED phase
  // ========================================================================
  const inspected =
    inspectedAgent && state.agentStates[inspectedAgent]
      ? state.agentStates[inspectedAgent]
      : null;

  return (
    <div className="flex flex-col h-full bg-black text-green-400 font-mono">
      {/* Controls */}
      <SimulationControls
        status={state.status}
        onPlay={play}
        onPause={pause}
        onStep={step}
        onStop={handleStop}
      />

      {/* Connection + phase status */}
      <div className="flex items-center gap-2 px-2 py-0.5 text-xs border-b border-green-900">
        <span
          className={`w-2 h-2 rounded-full ${
            state.connected ? "bg-green-500" : "bg-red-500"
          }`}
        />
        <span className="text-green-600">
          {state.connected ? "Connected" : "Disconnected"}
        </span>
        {launchConfig && (
          <>
            <span className="text-green-800">|</span>
            <span className="text-green-600">
              World: {launchConfig.worldId}
            </span>
            <span className="text-green-800">|</span>
            <span className="text-green-600">
              {launchConfig.agents.length} agents
            </span>
          </>
        )}
        {phase === "finished" && (
          <>
            <span className="text-green-800">|</span>
            <span className="text-yellow-500">FINISHED</span>
            <button
              onClick={handleNewSimulation}
              className="ml-auto text-green-400 border border-green-700 px-2 hover:bg-green-950"
            >
              New Simulation
            </button>
          </>
        )}
        {state.error && (
          <span className="text-red-500 ml-2">{state.error}</span>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Agent cards */}
        <div className="w-72 shrink-0 border-r border-green-800 overflow-y-auto p-2">
          <div className="text-green-600 text-xs mb-2 font-bold tracking-wider">
            AGENTS ({Object.keys(state.agentStates).length})
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
          {Object.keys(state.agentStates).length === 0 && agentIds.length > 0 && (
            <div className="text-green-800 text-xs p-2">
              Waiting for agent data...
              <div className="text-green-900 mt-1">
                Polling: {agentIds.join(", ")}
              </div>
            </div>
          )}
          {agentIds.length === 0 && (
            <div className="text-green-800 text-xs p-2">
              No agents configured.
            </div>
          )}
        </div>

        {/* Right: Event timeline */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <EventTimeline events={state.events} />
        </div>
      </div>

      {/* Bottom: World state */}
      <WorldStatePanel
        agentStates={state.agentStates}
        worldId={state.status.world_id || launchConfig?.worldId || ""}
      />

      {/* Agent inspector overlay */}
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
