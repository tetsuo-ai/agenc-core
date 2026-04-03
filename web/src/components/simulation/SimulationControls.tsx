/**
 * Simulation play/pause/step controls.
 * Phase 4 of CONCORDIA_TODO.MD.
 */

import type { SimulationStatus } from "./useSimulation";

interface SimulationControlsProps {
  status: SimulationStatus;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onStop: () => void;
}

function formatExecutionPhase(phase: SimulationStatus["execution_phase"]): string | null {
  if (!phase || phase === "idle") {
    return null;
  }
  return phase.replace(/_/g, " ").toUpperCase();
}

export function SimulationControls({
  status,
  onPlay,
  onPause,
  onStep,
  onStop,
}: SimulationControlsProps) {
  const phaseLabel = formatExecutionPhase(status.execution_phase);
  const stepInProgress = status.status === "running" &&
    phaseLabel !== null &&
    status.execution_phase !== "waiting_for_permission" &&
    status.execution_phase !== "step_complete";

  return (
    <div className="flex items-center gap-2 border-b border-green-800 bg-black p-2 font-mono text-sm text-green-400">
      <span className="font-bold">
        {status.world_id || "No simulation"}
      </span>
      <span className="text-green-600">|</span>
      <span>
        Step {status.step}/{status.max_steps}
      </span>
      <span className="text-green-600">|</span>
      <span>{status.status.toUpperCase()}</span>
      {phaseLabel && (
        <>
          <span className="text-green-600">|</span>
          <span className={stepInProgress ? "text-yellow-300" : "text-green-500"}>
            {stepInProgress ? `STEP IN PROGRESS: ${phaseLabel}` : phaseLabel}
          </span>
        </>
      )}

      <div className="ml-auto flex gap-1">
        <button
          onClick={onPlay}
          disabled={status.status !== "paused"}
          className="px-2 py-0.5 border border-green-700 hover:bg-green-900 disabled:opacity-30"
        >
          Play
        </button>
        <button
          onClick={onPause}
          disabled={status.status !== "running"}
          className="px-2 py-0.5 border border-green-700 hover:bg-green-900 disabled:opacity-30"
        >
          Pause
        </button>
        <button
          onClick={onStep}
          disabled={status.status !== "running" && status.status !== "paused"}
          className="px-2 py-0.5 border border-green-700 hover:bg-green-900 disabled:opacity-30"
        >
          Step
        </button>
        <button
          onClick={onStop}
          disabled={status.status === "stopped" || status.status === "finished" || status.status === "failed" || status.status === "archived" || status.status === "deleted"}
          className="px-2 py-0.5 border border-red-700 hover:bg-red-900 disabled:opacity-30"
        >
          Stop
        </button>
      </div>
    </div>
  );
}
